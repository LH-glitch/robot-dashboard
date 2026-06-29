"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ClipboardCheck,
  Clock3,
  Gauge,
  ScanSearch,
  Thermometer,
  TrendingUp,
  Waves,
  Ruler,
  Activity,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type SensorRecord = {
  topic: string;
  sensor: string;
  value: number | null;
  rawPayload: string;
  time: string;
  timeMs: number;
};

type SuddenJump = {
  sensor: string;
  prevValue: number;
  currValue: number;
  absoluteJump: number;
  percentageJump: number;
  time: string;
  timeMs: number;
  severity: "High" | "Medium" | "Low";
};

type TimeUnit = "seconds" | "minutes" | "hours" | "days" | "all";
type BehaviorScore = "Stable" | "Cautious" | "Warning" | "Critical";
type DataSource = "demo" | "local" | null;
type ComparisonSensorKey = "temperature" | "humidity" | "pressure" | "distance" | "accel";
type ComparisonScaleMode = "raw" | "normalized";
type ComparisonPoint = { timeMs: number } & Partial<Record<ComparisonSensorKey, number>>;
type MainChartPoint = {
  timeMs: number;
  primaryValue?: number;
  forecastValue?: number;
} & Record<string, number | undefined>;

type ComparisonSensorDefinition = {
  key: ComparisonSensorKey;
  label: string;
  aliases: string[];
  unit: string;
  color: string;
  dasharray?: string;
};

type CorrelationPairSummary = {
  left: ComparisonSensorKey;
  right: ComparisonSensorKey;
  coefficient: number;
  sampleCount: number;
};

type TimeValuePoint = {
  timeMs: number;
  value: number;
};

type CorrelationSensorDebug = {
  key: ComparisonSensorKey;
  totalSamples: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
};

type CorrelationPairDebug = {
  left: ComparisonSensorKey;
  right: ComparisonSensorKey;
  pairedSampleCount: number;
  averageAlignmentDeltaSeconds: number | null;
  maximumAlignmentDeltaSeconds: number | null;
};

type PcaComponentSummary = {
  name: string;
  explainedVariance: number;
  cumulativeVariance: number;
  topContributors: ComparisonSensorKey[];
  contributorScores: Array<{ sensor: ComparisonSensorKey; score: number }>;
};

type PcaDiagnostics = {
  alignedObservations: number;
  observationsUsed: number;
  requiredObservations: number;
  usableSensorCount: number;
  sensorsUsed: ComparisonSensorKey[];
  sensorsSkipped: ComparisonSensorKey[];
  zeroVarianceSensors: ComparisonSensorKey[];
  bucketSizeLabel: string;
  failureReason: string | null;
};

type PcaAnalysisResult =
  | {
      status: "ok";
      observations: number;
      sensors: ComparisonSensorKey[];
      components: PcaComponentSummary[];
      diagnostics: PcaDiagnostics;
    }
  | {
      status: "insufficient-observations" | "insufficient-sensors" | "failed";
      message: string;
      diagnostics: PcaDiagnostics;
    };

type CorrelationHeatmapCell = {
  row: ComparisonSensorKey;
  column: ComparisonSensorKey;
  value: number | null;
  observations: number;
};

type AlignedSensorObservation = {
  bucketStartMs: number;
  bucketEndMs: number;
  values: Partial<Record<ComparisonSensorKey, number>>;
};

type AlignedSensorData = {
  rows: AlignedSensorObservation[];
  bucketSizeMs: number;
  bucketSizeLabel: string;
};

type HeatmapCell = {
  sensorKey: ComparisonSensorKey;
  sensorLabel: string;
  bucketIndex: number;
  bucketStartMs: number;
  bucketEndMs: number;
  averageValue: number | null;
  sampleCount: number;
  normalizedValue: number | null;
};

type HeatmapHoverInfo = {
  sensorLabel: string;
  bucketLabel: string;
  averageValue: number | null;
  sampleCount: number;
};

type HeatmapViewMode =
  | "grid"
  | "compact"
  | "stripes"
  | "table"
  | "intensity-cards";

type AnomalySeverityFilter = "All" | SuddenJump["severity"];

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseTime(input: unknown): { text: string; ms: number } {
  const text = typeof input === "string" ? input : String(input ?? "");

  const normalized = text
    .replace(" ", "T")
    .replace(/(\d{2}:\d{2}:\d{2}):(\d{3})$/, "$1.$2");

  const parsed = Date.parse(normalized);
  const fallback = Date.parse(text);
  const ms = Number.isFinite(parsed)
    ? parsed
    : Number.isFinite(fallback)
      ? fallback
      : 0;

  return { text, ms };
}

function extractMessagesRecursively(source: unknown): SensorRecord[] {
  const found: SensorRecord[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown) => {
    if (!node) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const obj = node as Record<string, unknown>;

    if (
      typeof obj.topic === "string" &&
      typeof obj.payload === "string" &&
      obj.createAt !== undefined
    ) {
      const { text, ms } = parseTime(obj.createAt);
      const topic = obj.topic;
      const rawPayload = obj.payload;
      const sensor = topic.split("/").filter(Boolean).pop()?.toLowerCase() ?? "unknown";
      const idPart = typeof obj.id === "string" ? obj.id : "";
      const dedupeKey = `${idPart}|${topic}|${rawPayload}|${text}`;

      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        found.push({
          topic,
          sensor,
          value: parseMaybeNumber(rawPayload),
          rawPayload,
          time: text,
          timeMs: ms,
        });
      }
    }

    Object.values(obj).forEach(walk);
  };

  walk(source);

  return found.sort((a, b) => a.timeMs - b.timeMs);
}

function findLatestValue(records: SensorRecord[], aliases: string[]): number | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const item = records[i];
    if (aliases.includes(item.sensor) && item.value !== null) {
      return item.value;
    }
  }
  return null;
}

function calculateSuddenJumps(records: Array<SensorRecord & { value: number }>): SuddenJump[] {
  const bySensor = new Map<string, Array<SensorRecord & { value: number }>>();

  for (const record of records) {
    const group = bySensor.get(record.sensor) ?? [];
    group.push(record);
    bySensor.set(record.sensor, group);
  }

  const jumps: SuddenJump[] = [];

  for (const [sensor, sensorRecords] of bySensor) {
    const sorted = [...sensorRecords].sort((a, b) => a.timeMs - b.timeMs);

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      if (prev.value === 0) continue;

      const absoluteJump = Math.abs(curr.value - prev.value);
      const percentageJump = (absoluteJump / Math.abs(prev.value)) * 100;
      const severity: "High" | "Medium" | "Low" =
        percentageJump >= 50 ? "High" : percentageJump >= 20 ? "Medium" : "Low";

      jumps.push({
        sensor,
        prevValue: prev.value,
        currValue: curr.value,
        absoluteJump,
        percentageJump,
        time: curr.time,
        timeMs: curr.timeMs,
        severity,
      });
    }
  }

  return jumps.sort((a, b) => b.percentageJump - a.percentageJump);
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const COMPARISON_SENSOR_DEFINITIONS: ComparisonSensorDefinition[] = [
  {
    key: "temperature",
    label: "Temperature (temperature/temp)",
    aliases: ["temperature", "temp"],
    unit: "°C",
    color: "#EA580C",
  },
  {
    key: "humidity",
    label: "Humidity",
    aliases: ["humidity"],
    unit: "%",
    color: "#0E7490",
  },
  {
    key: "pressure",
    label: "Pressure",
    aliases: ["pressure"],
    unit: "hPa",
    color: "#475569",
    dasharray: "5 3",
  },
  {
    key: "distance",
    label: "Distance",
    aliases: ["distance"],
    unit: "cm",
    color: "#15803D",
  },
  {
    key: "accel",
    label: "Accel",
    aliases: ["accel", "acceleration"],
    unit: "m/s²",
    color: "#B91C1C",
    dasharray: "3 3",
  },
];

function formatTickLabel(timeMs: number, unit: TimeUnit): string {
  const d = new Date(timeMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  const mo = MONTH_NAMES[d.getMonth()];

  if (unit === "seconds") return `${hh}:${mn}:${ss}`;
  if (unit === "minutes" || unit === "hours") return `${hh}:${mn}`;
  return `${mo} ${dy}`;
}

function calculatePearsonCoefficient(seriesX: number[], seriesY: number[]): number | null {
  if (seriesX.length !== seriesY.length || seriesX.length < 2) {
    return null;
  }

  const n = seriesX.length;
  const meanX = seriesX.reduce((sum, value) => sum + value, 0) / n;
  const meanY = seriesY.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let i = 0; i < n; i += 1) {
    const deltaX = seriesX[i] - meanX;
    const deltaY = seriesY[i] - meanY;
    numerator += deltaX * deltaY;
    varianceX += deltaX * deltaX;
    varianceY += deltaY * deltaY;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  if (denominator === 0) {
    return null;
  }

  const coefficient = numerator / denominator;
  return Number.isFinite(coefficient) ? Math.max(-1, Math.min(1, coefficient)) : null;
}

function getCorrelationRelationship(coefficient: number | null): string {
  if (coefficient === null) return "Insufficient Data";
  if (coefficient >= 0.7) return "Strong Positive";
  if (coefficient >= 0.3) return "Moderate Positive";
  if (coefficient <= -0.7) return "Strong Negative";
  if (coefficient <= -0.3) return "Moderate Negative";
  return "Weak / No Relationship";
}

function formatSignedCorrelation(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function getCorrelationHeatmapColor(value: number): string {
  const darkBlue: [number, number, number] = [30, 64, 175];
  const lightBlue: [number, number, number] = [191, 219, 254];
  const white: [number, number, number] = [255, 255, 255];
  const lightRed: [number, number, number] = [254, 202, 202];
  const darkRed: [number, number, number] = [185, 28, 28];
  const clamped = clamp(value, -1, 1);

  let color: [number, number, number];
  if (clamped < -0.5) {
    color = interpolateRgb(darkBlue, lightBlue, (clamped + 1) / 0.5);
  } else if (clamped < 0) {
    color = interpolateRgb(lightBlue, white, (clamped + 0.5) / 0.5);
  } else if (clamped < 0.5) {
    color = interpolateRgb(white, lightRed, clamped / 0.5);
  } else {
    color = interpolateRgb(lightRed, darkRed, (clamped - 0.5) / 0.5);
  }

  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function getTypicalTimeStep(points: TimeValuePoint[]): number {
  const gaps = points
    .slice(1)
    .map((point, index) => point.timeMs - points[index].timeMs)
    .filter((gap) => Number.isFinite(gap) && gap > 0);

  return median(gaps) || 60 * 1000;
}

function gaussianWeightedAverage(points: TimeValuePoint[], targetTimeMs: number, sigma: number): number | null {
  if (points.length === 0 || sigma <= 0) return null;

  let weightedSum = 0;
  let weightTotal = 0;

  for (const point of points) {
    const timeDistance = targetTimeMs - point.timeMs;
    const weight = Math.exp(-(timeDistance ** 2) / (2 * sigma ** 2));
    weightedSum += point.value * weight;
    weightTotal += weight;
  }

  return weightTotal === 0 ? null : weightedSum / weightTotal;
}

function getGaussianSigma(points: TimeValuePoint[]): number {
  if (points.length < 2) return 60 * 1000;

  const span = points[points.length - 1].timeMs - points[0].timeMs;
  const typicalStep = getTypicalTimeStep(points);
  return Math.max(typicalStep * 3, span / 2, 60 * 1000);
}

function calculateGaussianForecast(points: TimeValuePoint[]): { value: number | null; direction: string } {
  if (points.length < 3) {
    return { value: null, direction: "Insufficient data" };
  }

  const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
  const newest = sorted[sorted.length - 1];
  const forecast = gaussianWeightedAverage(sorted, newest.timeMs, getGaussianSigma(sorted));

  if (forecast === null) {
    return { value: null, direction: "Insufficient data" };
  }

  const threshold = Math.max(Math.abs(newest.value) * 0.01, 0.05);
  const direction =
    forecast > newest.value + threshold
      ? "Rising"
      : forecast < newest.value - threshold
        ? "Falling"
        : "Stable";

  return { value: forecast, direction };
}

function generateGaussianForecastPoints(points: TimeValuePoint[], count = 10): TimeValuePoint[] {
  if (points.length < 3) return [];

  const history = [...points].sort((a, b) => a.timeMs - b.timeMs);
  const stepMs = getTypicalTimeStep(history);
  const forecastPoints: TimeValuePoint[] = [];

  for (let i = 0; i < count; i += 1) {
    const targetTimeMs = history[history.length - 1].timeMs + stepMs;
    const sigma = getGaussianSigma(history);
    const weightedAverage = gaussianWeightedAverage(history, targetTimeMs, sigma);

    if (weightedAverage === null) break;

    const recent = history.slice(-Math.min(5, history.length));
    const firstRecent = recent[0];
    const lastRecent = recent[recent.length - 1];
    const trendPerMs =
      lastRecent.timeMs === firstRecent.timeMs
        ? 0
        : (lastRecent.value - firstRecent.value) / (lastRecent.timeMs - firstRecent.timeMs);
    const forecastValue = weightedAverage + trendPerMs * stepMs * 0.35;
    const forecastPoint = { timeMs: targetTimeMs, value: forecastValue };

    forecastPoints.push(forecastPoint);
    history.push(forecastPoint);
  }

  return forecastPoints;
}

function normalizeValue(value: number, min: number, max: number): number {
  if (max === min) return 50;
  return ((value - min) / (max - min)) * 100;
}

function calculateStability(points: TimeValuePoint[]): { score: number | null; label: string } {
  if (points.length < 2) {
    return { score: null, label: "Insufficient data" };
  }

  const values = points.map((point) => point.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  const fluctuationRatio = Math.abs(mean) > 0.001
    ? standardDeviation / Math.abs(mean)
    : standardDeviation;

  const jumpCount = points.slice(1).filter((point, index) => {
    const previous = points[index];
    if (previous.value === 0) return Math.abs(point.value) > 0.05;
    return Math.abs(point.value - previous.value) / Math.abs(previous.value) >= 0.2;
  }).length;

  const recent = points.slice(-Math.min(6, points.length));
  const recentDeltas = recent
    .slice(1)
    .map((point, index) => Math.abs(point.value - recent[index].value));
  const recentNoise =
    recentDeltas.length === 0
      ? 0
      : recentDeltas.reduce((sum, value) => sum + value, 0) / recentDeltas.length;
  const valueRange = Math.max(...values) - Math.min(...values);
  const noiseRatio = valueRange > 0 ? recentNoise / valueRange : 0;

  const score = clamp(
    Math.round(
      100 -
        Math.min(35, jumpCount * 8) -
        Math.min(35, fluctuationRatio * 100) -
        Math.min(30, noiseRatio * 60),
    ),
    0,
    100,
  );

  const label = score >= 85 ? "Stable" : score >= 60 ? "Moderate" : "Unstable";
  return { score, label };
}

function lowerBoundByTime(points: TimeValuePoint[], targetTimeMs: number): number {
  let left = 0;
  let right = points.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (points[mid].timeMs < targetTimeMs) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

function alignByNearestNeighbor(
  sourceSeries: TimeValuePoint[],
  targetSeries: TimeValuePoint[],
  maxTimeDeltaMs: number,
): { alignedSource: number[]; alignedTarget: number[]; deltasMs: number[] } {
  if (sourceSeries.length === 0 || targetSeries.length === 0) {
    return { alignedSource: [], alignedTarget: [], deltasMs: [] };
  }

  const alignedSource: number[] = [];
  const alignedTarget: number[] = [];
  const deltasMs: number[] = [];

  for (const sourcePoint of sourceSeries) {
    const insertIndex = lowerBoundByTime(targetSeries, sourcePoint.timeMs);
    const candidateIndices = [insertIndex - 1, insertIndex];

    let bestTargetIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (const candidateIndex of candidateIndices) {
      if (candidateIndex < 0 || candidateIndex >= targetSeries.length) {
        continue;
      }

      const delta = Math.abs(targetSeries[candidateIndex].timeMs - sourcePoint.timeMs);
      if (delta <= maxTimeDeltaMs && delta < bestDelta) {
        bestDelta = delta;
        bestTargetIndex = candidateIndex;
      }
    }

    if (bestTargetIndex !== -1) {
      alignedSource.push(sourcePoint.value);
      alignedTarget.push(targetSeries[bestTargetIndex].value);
      deltasMs.push(bestDelta);
    }
  }

  return { alignedSource, alignedTarget, deltasMs };
}

function findNearestValue(
  series: TimeValuePoint[],
  targetTimeMs: number,
  maxTimeDeltaMs: number,
): number | null {
  const insertIndex = lowerBoundByTime(series, targetTimeMs);
  const candidateIndices = [insertIndex - 1, insertIndex];
  let bestValue: number | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const candidateIndex of candidateIndices) {
    if (candidateIndex < 0 || candidateIndex >= series.length) {
      continue;
    }

    const point = series[candidateIndex];
    const delta = Math.abs(point.timeMs - targetTimeMs);
    if (delta <= maxTimeDeltaMs && delta < bestDelta) {
      bestDelta = delta;
      bestValue = point.value;
    }
  }

  return bestValue;
}

function calculateMean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateSampleStandardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;

  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function createIdentityMatrix(size: number): number[][] {
  return Array.from({ length: size }, (_, rowIndex) =>
    Array.from({ length: size }, (_, columnIndex) => (rowIndex === columnIndex ? 1 : 0)),
  );
}

function jacobiEigenDecomposition(
  matrix: number[][],
): { eigenvalues: number[]; eigenvectors: number[][] } | null {
  const size = matrix.length;
  if (size === 0 || matrix.some((row) => row.length !== size)) {
    return null;
  }

  const a = matrix.map((row) => [...row]);
  const eigenvectors = createIdentityMatrix(size);
  const maxIterations = 100;
  const epsilon = 1e-10;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let p = 0;
    let q = 1;
    let largestOffDiagonal = 0;

    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) {
        const magnitude = Math.abs(a[row][column]);
        if (magnitude > largestOffDiagonal) {
          largestOffDiagonal = magnitude;
          p = row;
          q = column;
        }
      }
    }

    if (largestOffDiagonal < epsilon) {
      break;
    }

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let i = 0; i < size; i += 1) {
      if (i !== p && i !== q) {
        const aip = a[i][p];
        const aiq = a[i][q];
        a[i][p] = cos * aip - sin * aiq;
        a[p][i] = a[i][p];
        a[i][q] = sin * aip + cos * aiq;
        a[q][i] = a[i][q];
      }
    }

    a[p][p] = cos ** 2 * app - 2 * sin * cos * apq + sin ** 2 * aqq;
    a[q][q] = sin ** 2 * app + 2 * sin * cos * apq + cos ** 2 * aqq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let i = 0; i < size; i += 1) {
      const vip = eigenvectors[i][p];
      const viq = eigenvectors[i][q];
      eigenvectors[i][p] = cos * vip - sin * viq;
      eigenvectors[i][q] = sin * vip + cos * viq;
    }
  }

  const eigenvalues = a.map((row, index) => row[index]);
  if (
    eigenvalues.some((value) => !Number.isFinite(value)) ||
    eigenvectors.some((row) => row.some((value) => !Number.isFinite(value)))
  ) {
    return null;
  }

  return { eigenvalues, eigenvectors };
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 60 * 1000) return `${Math.round(durationMs / 1000)} sec`;
  if (durationMs < 60 * 60 * 1000) return `${Math.round(durationMs / (60 * 1000))} min`;
  if (durationMs < 24 * 60 * 60 * 1000) return `${Math.round(durationMs / (60 * 60 * 1000))} hr`;
  return `${Math.round(durationMs / (24 * 60 * 60 * 1000))} day`;
}

function getAdaptiveAlignmentBucketSizeMs(
  records: Array<SensorRecord & { value: number }>,
  timeUnit: TimeUnit,
): number {
  if (records.length === 0) return 1000;

  const firstTimeMs = records[0].timeMs;
  const lastTimeMs = records[records.length - 1].timeMs;
  const rangeMs = Math.max(0, lastTimeMs - firstTimeMs);

  if (timeUnit === "seconds") return 1000;
  if (timeUnit === "minutes") return rangeMs <= 2 * 60 * 1000 ? 1000 : 5 * 1000;
  if (timeUnit === "hours") return 60 * 1000;
  if (timeUnit === "days") return rangeMs <= 3 * 24 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return rangeMs <= 2 * 24 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

function buildAlignedSensorObservations(
  records: Array<SensorRecord & { value: number }>,
  timeUnit: TimeUnit,
): AlignedSensorData {
  const bucketSizeMs = getAdaptiveAlignmentBucketSizeMs(records, timeUnit);
  const bucketMap = new Map<
    number,
    Partial<Record<ComparisonSensorKey, { value: number; deltaFromCenterMs: number }>>
  >();

  for (const record of records) {
    const sensorDef = COMPARISON_SENSOR_DEFINITIONS.find((definition) =>
      definition.aliases.includes(record.sensor),
    );

    if (!sensorDef) {
      continue;
    }

    const bucketIndex = Math.floor(record.timeMs / bucketSizeMs);
    const bucketStartMs = bucketIndex * bucketSizeMs;
    const bucketCenterMs = bucketStartMs + bucketSizeMs / 2;
    const deltaFromCenterMs = Math.abs(record.timeMs - bucketCenterMs);
    const bucket = bucketMap.get(bucketStartMs) ?? {};
    const previous = bucket[sensorDef.key];

    if (!previous || deltaFromCenterMs < previous.deltaFromCenterMs) {
      bucket[sensorDef.key] = {
        value: record.value,
        deltaFromCenterMs,
      };
    }

    bucketMap.set(bucketStartMs, bucket);
  }

  const rows = Array.from(bucketMap.entries())
    .map(([bucketStartMs, bucket]) => {
      const values = Object.fromEntries(
        Object.entries(bucket).map(([sensorKey, point]) => [
          sensorKey,
          point?.value,
        ]),
      ) as Partial<Record<ComparisonSensorKey, number>>;

      return {
        bucketStartMs,
        bucketEndMs: bucketStartMs + bucketSizeMs,
        values,
      };
    })
    .filter((row) => Object.values(row.values).filter((value) => typeof value === "number").length >= 2)
    .sort((a, b) => a.bucketStartMs - b.bucketStartMs);

  return {
    rows,
    bucketSizeMs,
    bucketSizeLabel: formatDurationMs(bucketSizeMs),
  };
}

function createPcaDiagnosticMessage(diagnostics: PcaDiagnostics): string {
  const zeroVarianceText =
    diagnostics.zeroVarianceSensors.length > 0
      ? diagnostics.zeroVarianceSensors.join(", ")
      : "none";
  const reasonText = diagnostics.failureReason ? ` Reason: ${diagnostics.failureReason}` : "";

  return `PCA diagnostics: ${diagnostics.alignedObservations} aligned observations created; ${diagnostics.observationsUsed} observations used, ${diagnostics.requiredObservations} required; ${diagnostics.usableSensorCount} usable sensors; bucket size: ${diagnostics.bucketSizeLabel}; zero-variance sensors removed: ${zeroVarianceText}.${reasonText}`;
}

function calculatePcaAnalysis(
  alignedData: AlignedSensorData,
): PcaAnalysisResult {
  const REQUIRED_OBSERVATIONS = 3;
  const allSensorKeys = COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => sensorDef.key);
  const valueCounts = allSensorKeys.reduce<Record<ComparisonSensorKey, number>>(
    (acc, sensorKey) => {
      acc[sensorKey] = alignedData.rows.filter(
        (row) => typeof row.values[sensorKey] === "number",
      ).length;
      return acc;
    },
    {
      temperature: 0,
      humidity: 0,
      pressure: 0,
      distance: 0,
      accel: 0,
    },
  );
  const candidateSensors = allSensorKeys.filter(
    (key) => valueCounts[key] >= REQUIRED_OBSERVATIONS,
  );

  if (candidateSensors.length < 2) {
    const diagnostics: PcaDiagnostics = {
      alignedObservations: alignedData.rows.length,
      observationsUsed: 0,
      requiredObservations: REQUIRED_OBSERVATIONS,
      usableSensorCount: candidateSensors.length,
      sensorsUsed: candidateSensors,
      sensorsSkipped: allSensorKeys.filter((key) => !candidateSensors.includes(key)),
      zeroVarianceSensors: [],
      bucketSizeLabel: alignedData.bucketSizeLabel,
      failureReason: "PCA requires at least two sensors with three aligned values.",
    };

    return {
      status: "insufficient-sensors",
      message: createPcaDiagnosticMessage(diagnostics),
      diagnostics,
    };
  }

  const pcaRows = alignedData.rows.filter(
    (row) =>
      candidateSensors.filter((sensorKey) => typeof row.values[sensorKey] === "number").length >=
      2,
  );

  if (pcaRows.length < REQUIRED_OBSERVATIONS) {
    const diagnostics: PcaDiagnostics = {
      alignedObservations: alignedData.rows.length,
      observationsUsed: pcaRows.length,
      requiredObservations: REQUIRED_OBSERVATIONS,
      usableSensorCount: candidateSensors.length,
      sensorsUsed: candidateSensors,
      sensorsSkipped: allSensorKeys.filter((key) => !candidateSensors.includes(key)),
      zeroVarianceSensors: [],
      bucketSizeLabel: alignedData.bucketSizeLabel,
      failureReason: "Not enough bucketed rows contain at least two usable sensor values.",
    };

    return {
      status: "insufficient-observations",
      message: createPcaDiagnosticMessage(diagnostics),
      diagnostics,
    };
  }

  const presentValuesBySensor = candidateSensors.map((sensorKey) =>
    pcaRows
      .map((row) => row.values[sensorKey])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
  const means = presentValuesBySensor.map((values) => calculateMean(values));
  const standardDeviations = presentValuesBySensor.map((values, columnIndex) =>
    calculateSampleStandardDeviation(values, means[columnIndex]),
  );
  const validColumnIndexes = standardDeviations
    .map((standardDeviation, index) => ({ standardDeviation, index }))
    .filter(({ standardDeviation }) => standardDeviation > 0 && Number.isFinite(standardDeviation))
    .map(({ index }) => index);
  const zeroVarianceSensors = standardDeviations
    .map((standardDeviation, index) => ({ standardDeviation, sensor: candidateSensors[index] }))
    .filter(({ standardDeviation }) => standardDeviation === 0 || !Number.isFinite(standardDeviation))
    .map(({ sensor }) => sensor);

  if (validColumnIndexes.length < 2) {
    const sensorsUsed = validColumnIndexes.map((columnIndex) => candidateSensors[columnIndex]);
    const diagnostics: PcaDiagnostics = {
      alignedObservations: alignedData.rows.length,
      observationsUsed: pcaRows.length,
      requiredObservations: REQUIRED_OBSERVATIONS,
      usableSensorCount: sensorsUsed.length,
      sensorsUsed,
      sensorsSkipped: allSensorKeys.filter((key) => !sensorsUsed.includes(key)),
      zeroVarianceSensors,
      bucketSizeLabel: alignedData.bucketSizeLabel,
      failureReason: "Fewer than two usable sensors remain after removing zero-variance columns.",
    };

    return {
      status: "insufficient-sensors",
      message: createPcaDiagnosticMessage(diagnostics),
      diagnostics,
    };
  }

  const sensors = validColumnIndexes.map((columnIndex) => candidateSensors[columnIndex]);
  const diagnostics: PcaDiagnostics = {
    alignedObservations: alignedData.rows.length,
    observationsUsed: pcaRows.length,
    requiredObservations: REQUIRED_OBSERVATIONS,
    usableSensorCount: sensors.length,
    sensorsUsed: sensors,
    sensorsSkipped: allSensorKeys.filter((key) => !sensors.includes(key)),
    zeroVarianceSensors,
    bucketSizeLabel: alignedData.bucketSizeLabel,
    failureReason: null,
  };
  const standardizedRows = pcaRows.map((row) =>
    validColumnIndexes.map((columnIndex) => {
      const value = row.values[candidateSensors[columnIndex]];
      // Bucketed telemetry can be sparse; mean-fill keeps rows usable after sensor selection.
      const filledValue = typeof value === "number" ? value : means[columnIndex];
      return (filledValue - means[columnIndex]) / standardDeviations[columnIndex];
    }),
  );

  const covarianceMatrix = sensors.map((_, rowIndex) =>
    sensors.map((__, columnIndex) => {
      const covariance =
        standardizedRows.reduce(
          (sum, row) => sum + row[rowIndex] * row[columnIndex],
          0,
        ) /
        (standardizedRows.length - 1);
      return Number.isFinite(covariance) ? covariance : 0;
    }),
  );

  const decomposition = jacobiEigenDecomposition(covarianceMatrix);
  if (!decomposition) {
    const failedDiagnostics = {
      ...diagnostics,
      failureReason: "Eigenvalue calculation failed for the covariance matrix.",
    };

    return {
      status: "failed",
      message: createPcaDiagnosticMessage(failedDiagnostics),
      diagnostics: failedDiagnostics,
    };
  }

  const eigenPairs = decomposition.eigenvalues
    .map((eigenvalue, componentIndex) => ({
      eigenvalue: Math.max(0, eigenvalue),
      eigenvector: decomposition.eigenvectors.map((row) => row[componentIndex]),
    }))
    .sort((left, right) => right.eigenvalue - left.eigenvalue);

  const totalEigenvalue = eigenPairs.reduce((sum, pair) => sum + pair.eigenvalue, 0);
  if (totalEigenvalue <= 0 || !Number.isFinite(totalEigenvalue)) {
    const failedDiagnostics = {
      ...diagnostics,
      failureReason: "PCA variance was zero or invalid after covariance calculation.",
    };

    return {
      status: "failed",
      message: createPcaDiagnosticMessage(failedDiagnostics),
      diagnostics: failedDiagnostics,
    };
  }

  let cumulativeVariance = 0;
  const components = eigenPairs.slice(0, 3).map((pair, index) => {
    const explainedVariance = pair.eigenvalue / totalEigenvalue;
    cumulativeVariance += explainedVariance;

    const contributorScores = pair.eigenvector
      .map((loading, sensorIndex) => ({
        sensor: sensors[sensorIndex],
        score: Math.abs(loading),
      }))
      .sort((left, right) => right.score - left.score);
    const topContributors = contributorScores
      .slice(0, 3)
      .map((item) => item.sensor);

    return {
      name: `PC${index + 1}`,
      explainedVariance,
      cumulativeVariance,
      topContributors,
      contributorScores,
    };
  });

  return {
    status: "ok",
    observations: standardizedRows.length,
    sensors,
    components,
    diagnostics,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function interpolateRgb(start: [number, number, number], end: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(start[0] + (end[0] - start[0]) * t),
    Math.round(start[1] + (end[1] - start[1]) * t),
    Math.round(start[2] + (end[2] - start[2]) * t),
  ];
}

function heatmapColorFromNormalized(value: number | null): string {
  if (value === null) {
    return "#0f172a";
  }

  const clamped = clamp(value, 0, 100);
  const darkBlue: [number, number, number] = [13, 42, 148];
  const cyan: [number, number, number] = [34, 211, 238];
  const yellow: [number, number, number] = [250, 204, 21];

  const rgb =
    clamped <= 50
      ? interpolateRgb(darkBlue, cyan, clamped / 50)
      : interpolateRgb(cyan, yellow, (clamped - 50) / 50);

  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export default function Home() {
  const [records, setRecords] = useState<SensorRecord[]>([]);
  const [dataSource, setDataSource] = useState<DataSource>(null);
  const [dataLoadMessage, setDataLoadMessage] = useState<string | null>(null);
  const [selectedSensor, setSelectedSensor] = useState<string>("distance");
  const [timeAmount, setTimeAmount] = useState<string>("10");
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("minutes");
  const [selectedComparisonSensors, setSelectedComparisonSensors] = useState<ComparisonSensorKey[]>([
    "temperature",
    "humidity",
  ]);
  const [comparisonScaleMode, setComparisonScaleMode] = useState<ComparisonScaleMode>("raw");
  const [anomalySeverityFilter, setAnomalySeverityFilter] = useState<AnomalySeverityFilter>("All");
  const [hoveredHeatmapCell, setHoveredHeatmapCell] = useState<HeatmapHoverInfo | null>(null);
  const [heatmapViewMode, setHeatmapViewMode] = useState<HeatmapViewMode>("grid");
  const [showPcaAnalysis, setShowPcaAnalysis] = useState(false);
  const [showSensorImportanceRanking, setShowSensorImportanceRanking] = useState(false);
  const [showCorrelationHeatmap, setShowCorrelationHeatmap] = useState(false);
  const [selectedOverlaySensors, setSelectedOverlaySensors] = useState<ComparisonSensorKey[]>([]);
  const [normalizeOverlay, setNormalizeOverlay] = useState(false);
  const [showFuturePrediction, setShowFuturePrediction] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    const fetchJson = async (path: string): Promise<unknown> => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load ${path} (${response.status})`);
      }
      return response.json();
    };

    const loadTelemetry = async () => {
      try {
        const demoData = await fetchJson("/data/demo-connections.json");
        if (isCancelled) return;

        setRecords(extractMessagesRecursively(demoData));
        setDataSource("demo");
        setDataLoadMessage(null);
        return;
      } catch (demoError) {
        console.warn("Demo telemetry file unavailable:", demoError);
      }

      try {
        const localData = await fetchJson("/data/all-connections.json");
        if (isCancelled) return;

        setRecords(extractMessagesRecursively(localData));
        setDataSource("local");
        setDataLoadMessage(null);
      } catch (localError) {
        console.error("Telemetry files unavailable:", localError);
        if (isCancelled) return;

        setRecords([]);
        setDataSource(null);
        setDataLoadMessage(
          "No telemetry data file found. Add public/data/all-connections.json locally or provide a sanitized demo file.",
        );
      }
    };

    void loadTelemetry();

    return () => {
      isCancelled = true;
    };
  }, []);

  const sensorOptions = useMemo(() => {
    return Array.from(new Set(records.map((r) => r.sensor))).sort();
  }, [records]);

  useEffect(() => {
    if (sensorOptions.length > 0 && !sensorOptions.includes(selectedSensor)) {
      setSelectedSensor(sensorOptions[0]);
    }
  }, [selectedSensor, sensorOptions]);

  const numericRecords = useMemo(() => {
    return records.filter((r) => r.value !== null) as Array<SensorRecord & { value: number }>;
  }, [records]);

  const availableComparisonSensorKeys = useMemo(() => {
    const availableSensors = new Set(numericRecords.map((record) => record.sensor));

    return COMPARISON_SENSOR_DEFINITIONS
      .filter((sensorDef) => sensorDef.aliases.some((alias) => availableSensors.has(alias)))
      .map((sensorDef) => sensorDef.key);
  }, [numericRecords]);

  useEffect(() => {
    const filtered = selectedComparisonSensors.filter((sensor) =>
      availableComparisonSensorKeys.includes(sensor),
    );

    if (filtered.length !== selectedComparisonSensors.length) {
      setSelectedComparisonSensors(filtered);
      return;
    }

    if (filtered.length === 0 && availableComparisonSensorKeys.length > 0) {
      setSelectedComparisonSensors(availableComparisonSensorKeys.slice(0, 2));
    }
  }, [availableComparisonSensorKeys, selectedComparisonSensors]);

  const windowedNumericRecords = useMemo(() => {
    if (timeUnit === "all") return numericRecords;

    const amount = Number(timeAmount);
    if (!Number.isFinite(amount) || amount <= 0) return numericRecords;

    const multiplierByUnit: Record<Exclude<TimeUnit, "all">, number> = {
      seconds: 1000,
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
    };

    const newestTimestamp =
      numericRecords.length > 0 ? numericRecords[numericRecords.length - 1].timeMs : 0;
    const cutoff = newestTimestamp - amount * multiplierByUnit[timeUnit];

    return numericRecords.filter((r) => r.timeMs >= cutoff);
  }, [numericRecords, timeAmount, timeUnit]);

  const selectedSensorNumericRecords = useMemo(() => {
    return numericRecords.filter((r) => r.sensor === selectedSensor);
  }, [numericRecords, selectedSensor]);

  const selectedSeries = useMemo(() => {
    const baseRecords = selectedSensorNumericRecords;

    const toPoint = (r: SensorRecord & { value: number }) => ({
      timeMs: r.timeMs,
      value: r.value,
      topic: r.topic,
    });

    if (baseRecords.length === 0 || timeUnit === "all") {
      return baseRecords.map(toPoint);
    }

    const amount = Number(timeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return baseRecords.map(toPoint);
    }

    const multiplierByUnit: Record<Exclude<TimeUnit, "all">, number> = {
      seconds: 1000,
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
    };

    const newestTimestamp = baseRecords[baseRecords.length - 1]?.timeMs ?? 0;
    const windowMs = amount * multiplierByUnit[timeUnit];
    const cutoff = newestTimestamp - windowMs;

    return baseRecords
      .filter((r) => r.timeMs >= cutoff)
      .map(toPoint);
  }, [selectedSensorNumericRecords, timeAmount, timeUnit]);

  const xAxisTickCount = useMemo(() => {
    const n = selectedSeries.length;
    if (n <= 6) return n;
    if (timeUnit === "seconds" || timeUnit === "minutes" || timeUnit === "hours") return 8;
    return 7;
  }, [selectedSeries.length, timeUnit]);

  const chartStats = useMemo(() => {
    if (selectedSeries.length === 0) {
      return {
        min: null as number | null,
        max: null as number | null,
        avg: null as number | null,
        points: 0,
      };
    }

    const values = selectedSeries.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((sum, current) => sum + current, 0) / values.length;

    return {
      min,
      max,
      avg,
      points: values.length,
    };
  }, [selectedSeries]);

  const primaryComparisonSensor = useMemo(() => {
    return COMPARISON_SENSOR_DEFINITIONS.find((sensorDef) =>
      sensorDef.aliases.includes(selectedSensor),
    ) ?? null;
  }, [selectedSensor]);

  const mainChartSensorDefinitions = useMemo(() => {
    const sensorMap = new Map<ComparisonSensorKey, ComparisonSensorDefinition>();

    if (primaryComparisonSensor) {
      sensorMap.set(primaryComparisonSensor.key, primaryComparisonSensor);
    }

    for (const sensorKey of selectedOverlaySensors) {
      const definition = COMPARISON_SENSOR_DEFINITIONS.find((sensorDef) => sensorDef.key === sensorKey);
      if (definition) {
        sensorMap.set(sensorKey, definition);
      }
    }

    return Array.from(sensorMap.values());
  }, [primaryComparisonSensor, selectedOverlaySensors]);

  const selectedSeriesValueRange = useMemo(() => {
    const values = selectedSeries.map((point) => point.value);
    return values.length === 0
      ? null
      : { min: Math.min(...values), max: Math.max(...values) };
  }, [selectedSeries]);

  const futurePredictionSeries = useMemo(() => {
    return showFuturePrediction
      ? generateGaussianForecastPoints(selectedSeries, 10)
      : [];
  }, [selectedSeries, showFuturePrediction]);

  const mainChartData = useMemo<MainChartPoint[]>(() => {
    const primaryTimeline = selectedSeries.length > 0
      ? selectedSeries
      : windowedNumericRecords
          .map((record) => ({ timeMs: record.timeMs, value: record.value }))
          .sort((a, b) => a.timeMs - b.timeMs);

    if (primaryTimeline.length === 0) {
      return [];
    }

    const byTime = new Map<number, MainChartPoint>(
      primaryTimeline.map((point) => [point.timeMs, { timeMs: point.timeMs }]),
    );

    const getOrCreatePoint = (timeMs: number) => {
      const existing = byTime.get(timeMs);
      if (existing) return existing;

      const point: MainChartPoint = { timeMs };
      byTime.set(timeMs, point);
      return point;
    };

    const ranges = new Map<ComparisonSensorKey | "primary", { min: number; max: number }>();

    if (selectedSeriesValueRange) {
      ranges.set("primary", selectedSeriesValueRange);
    }

    for (const sensorDef of mainChartSensorDefinitions) {
      const values = windowedNumericRecords
        .filter((record) => sensorDef.aliases.includes(record.sensor))
        .map((record) => record.value);

      if (values.length > 0) {
        ranges.set(sensorDef.key, {
          min: Math.min(...values),
          max: Math.max(...values),
        });
      }
    }

    for (const point of primaryTimeline) {
      const range = ranges.get("primary");
      getOrCreatePoint(point.timeMs).primaryValue =
        normalizeOverlay && range
          ? normalizeValue(point.value, range.min, range.max)
          : point.value;
    }

    for (const sensorDef of mainChartSensorDefinitions) {
      if (primaryComparisonSensor?.key === sensorDef.key) {
        continue;
      }

      const range = ranges.get(sensorDef.key);
      const sensorSeries = windowedNumericRecords
        .filter((record) => sensorDef.aliases.includes(record.sensor))
        .map((record) => ({ timeMs: record.timeMs, value: record.value }))
        .sort((a, b) => a.timeMs - b.timeMs);

      if (sensorSeries.length === 0) {
        continue;
      }

      let nearestIndex = 0;

      for (const point of primaryTimeline) {
        while (
          nearestIndex < sensorSeries.length - 1 &&
          Math.abs(sensorSeries[nearestIndex + 1].timeMs - point.timeMs) <=
            Math.abs(sensorSeries[nearestIndex].timeMs - point.timeMs)
        ) {
          nearestIndex += 1;
        }

        const nearestValue = sensorSeries[nearestIndex].value;
        getOrCreatePoint(point.timeMs)[`overlay_${sensorDef.key}`] =
          normalizeOverlay && range
            ? normalizeValue(nearestValue, range.min, range.max)
            : nearestValue;
      }
    }

    for (const point of futurePredictionSeries) {
      const range = ranges.get("primary");
      getOrCreatePoint(point.timeMs).forecastValue =
        normalizeOverlay && range
          ? normalizeValue(point.value, range.min, range.max)
          : point.value;
    }

    if (futurePredictionSeries.length > 0 && selectedSeries.length > 0) {
      const lastRealPoint = selectedSeries[selectedSeries.length - 1];
      const range = ranges.get("primary");
      getOrCreatePoint(lastRealPoint.timeMs).forecastValue =
        normalizeOverlay && range
          ? normalizeValue(lastRealPoint.value, range.min, range.max)
          : lastRealPoint.value;
    }

    return Array.from(byTime.values()).sort((a, b) => a.timeMs - b.timeMs);
  }, [
    futurePredictionSeries,
    mainChartSensorDefinitions,
    normalizeOverlay,
    primaryComparisonSensor,
    selectedSeries,
    selectedSeriesValueRange,
    windowedNumericRecords,
  ]);

  const mainChartTickCount = useMemo(() => {
    const n = mainChartData.length;
    if (n <= 6) return n;
    if (timeUnit === "seconds" || timeUnit === "minutes" || timeUnit === "hours") return 8;
    return 7;
  }, [mainChartData.length, timeUnit]);

  const selectedComparisonDefinitions = useMemo(() => {
    return COMPARISON_SENSOR_DEFINITIONS.filter((sensorDef) =>
      selectedComparisonSensors.includes(sensorDef.key),
    );
  }, [selectedComparisonSensors]);

  const comparisonChartData = useMemo<ComparisonPoint[]>(() => {
    if (selectedComparisonSensors.length === 0) {
      return [];
    }

    const selectedKeySet = new Set(selectedComparisonSensors);
    const byTime = new Map<number, ComparisonPoint>();

    for (const record of windowedNumericRecords) {
      const definition = COMPARISON_SENSOR_DEFINITIONS.find((sensorDef) =>
        sensorDef.aliases.includes(record.sensor),
      );

      if (!definition || !selectedKeySet.has(definition.key)) {
        continue;
      }

      const existing = byTime.get(record.timeMs);
      if (existing) {
        existing[definition.key] = record.value;
      } else {
        byTime.set(record.timeMs, {
          timeMs: record.timeMs,
          [definition.key]: record.value,
        });
      }
    }

    const ordered = Array.from(byTime.values()).sort((a, b) => a.timeMs - b.timeMs);

    if (comparisonScaleMode === "raw") {
      return ordered;
    }

    const ranges: Partial<Record<ComparisonSensorKey, { min: number; max: number }>> = {};

    for (const sensorDef of selectedComparisonDefinitions) {
      const values = ordered
        .map((point) => point[sensorDef.key])
        .filter((value): value is number => typeof value === "number");

      if (values.length > 0) {
        ranges[sensorDef.key] = {
          min: Math.min(...values),
          max: Math.max(...values),
        };
      }
    }

    return ordered.map((point) => {
      const normalizedPoint: ComparisonPoint = { timeMs: point.timeMs };

      for (const sensorDef of selectedComparisonDefinitions) {
        const value = point[sensorDef.key];
        const range = ranges[sensorDef.key];

        if (typeof value !== "number" || !range) {
          continue;
        }

        if (range.max === range.min) {
          normalizedPoint[sensorDef.key] = 100;
          continue;
        }

        normalizedPoint[sensorDef.key] = ((value - range.min) / (range.max - range.min)) * 100;
      }

      return normalizedPoint;
    });
  }, [comparisonScaleMode, selectedComparisonDefinitions, selectedComparisonSensors, windowedNumericRecords]);

  const comparisonXAxisTickCount = useMemo(() => {
    const n = comparisonChartData.length;
    if (n <= 6) return n;
    if (timeUnit === "seconds" || timeUnit === "minutes" || timeUnit === "hours") return 8;
    return 7;
  }, [comparisonChartData.length, timeUnit]);

  const correlationSensorLabelByKey = useMemo(() => {
    const entries = COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => [
      sensorDef.key,
      sensorDef.label.split(" (")[0],
    ]);

    return Object.fromEntries(entries) as Record<ComparisonSensorKey, string>;
  }, []);

  const correlationAnalysis = useMemo(() => {
    const MAX_ALIGNMENT_DELTA_MS = 60 * 1000;
    const MIN_PAIRED_SAMPLES = 5;
    const keys = COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => sensorDef.key);

    const seriesBySensor = keys.reduce<Record<ComparisonSensorKey, TimeValuePoint[]>>(
      (acc, key) => {
        acc[key] = [];
        return acc;
      },
      {
        temperature: [],
        humidity: [],
        pressure: [],
        distance: [],
        accel: [],
      },
    );

    for (const record of windowedNumericRecords) {
      const sensorDef = COMPARISON_SENSOR_DEFINITIONS.find((definition) =>
        definition.aliases.includes(record.sensor),
      );

      if (!sensorDef) {
        continue;
      }

      seriesBySensor[sensorDef.key].push({
        timeMs: record.timeMs,
        value: record.value,
      });
    }

    for (const key of keys) {
      seriesBySensor[key].sort((a, b) => a.timeMs - b.timeMs);
    }

    const coefficientMatrix = keys.reduce<Record<ComparisonSensorKey, Record<ComparisonSensorKey, number | null>>>(
      (acc, rowKey) => {
        acc[rowKey] = {
          temperature: null,
          humidity: null,
          pressure: null,
          distance: null,
          accel: null,
        };
        return acc;
      },
      {
        temperature: { temperature: null, humidity: null, pressure: null, distance: null, accel: null },
        humidity: { temperature: null, humidity: null, pressure: null, distance: null, accel: null },
        pressure: { temperature: null, humidity: null, pressure: null, distance: null, accel: null },
        distance: { temperature: null, humidity: null, pressure: null, distance: null, accel: null },
        accel: { temperature: null, humidity: null, pressure: null, distance: null, accel: null },
      },
    );

    const sampleMatrix = keys.reduce<Record<ComparisonSensorKey, Record<ComparisonSensorKey, number>>>(
      (acc, rowKey) => {
        acc[rowKey] = {
          temperature: 0,
          humidity: 0,
          pressure: 0,
          distance: 0,
          accel: 0,
        };
        return acc;
      },
      {
        temperature: { temperature: 0, humidity: 0, pressure: 0, distance: 0, accel: 0 },
        humidity: { temperature: 0, humidity: 0, pressure: 0, distance: 0, accel: 0 },
        pressure: { temperature: 0, humidity: 0, pressure: 0, distance: 0, accel: 0 },
        distance: { temperature: 0, humidity: 0, pressure: 0, distance: 0, accel: 0 },
        accel: { temperature: 0, humidity: 0, pressure: 0, distance: 0, accel: 0 },
      },
    );

    const sensorDebugRows: CorrelationSensorDebug[] = keys.map((key) => {
      const series = seriesBySensor[key];
      return {
        key,
        totalSamples: series.length,
        firstTimestampMs: series[0]?.timeMs ?? null,
        lastTimestampMs: series[series.length - 1]?.timeMs ?? null,
      };
    });

    const pairDebugRows: CorrelationPairDebug[] = [];
    const pairSummaries: CorrelationPairSummary[] = [];

    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i; j < keys.length; j += 1) {
        const left = keys[i];
        const right = keys[j];
        const leftSeries = seriesBySensor[left];
        const rightSeries = seriesBySensor[right];

        if (left === right) {
          const diagonalSamples = leftSeries.length;
          coefficientMatrix[left][right] = diagonalSamples >= MIN_PAIRED_SAMPLES ? 1 : null;
          sampleMatrix[left][right] = diagonalSamples;
          continue;
        }

        const useLeftAsSource = leftSeries.length <= rightSeries.length;
        const sourceSeries = useLeftAsSource ? leftSeries : rightSeries;
        const targetSeries = useLeftAsSource ? rightSeries : leftSeries;

        const aligned = alignByNearestNeighbor(sourceSeries, targetSeries, MAX_ALIGNMENT_DELTA_MS);
        const sampleCount = aligned.alignedSource.length;
        const coefficient =
          sampleCount >= MIN_PAIRED_SAMPLES
            ? calculatePearsonCoefficient(aligned.alignedSource, aligned.alignedTarget)
            : null;

        const averageDeltaMs =
          aligned.deltasMs.length > 0
            ? aligned.deltasMs.reduce((sum, delta) => sum + delta, 0) / aligned.deltasMs.length
            : null;
        const maximumDeltaMs =
          aligned.deltasMs.length > 0 ? Math.max(...aligned.deltasMs) : null;

        coefficientMatrix[left][right] = coefficient;
        coefficientMatrix[right][left] = coefficient;
        sampleMatrix[left][right] = sampleCount;
        sampleMatrix[right][left] = sampleCount;

        pairDebugRows.push({
          left,
          right,
          pairedSampleCount: sampleCount,
          averageAlignmentDeltaSeconds:
            averageDeltaMs === null ? null : averageDeltaMs / 1000,
          maximumAlignmentDeltaSeconds:
            maximumDeltaMs === null ? null : maximumDeltaMs / 1000,
        });

        if (coefficient !== null) {
          pairSummaries.push({
            left,
            right,
            coefficient,
            sampleCount,
          });
        }
      }
    }

    const strongestPositivePair =
      [...pairSummaries]
        .filter((pair) => pair.coefficient > 0)
        .sort((a, b) => b.coefficient - a.coefficient)[0] ?? null;

    const strongestNegativePair =
      [...pairSummaries]
        .filter((pair) => pair.coefficient < 0)
        .sort((a, b) => a.coefficient - b.coefficient)[0] ?? null;

    const interpretationRows = [...pairSummaries].sort(
      (a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient),
    );

    const interpretations = interpretationRows.slice(0, 6).map((pair) => {
      const leftLabel = correlationSensorLabelByKey[pair.left];
      const rightLabel = correlationSensorLabelByKey[pair.right];
      const absCoefficient = Math.abs(pair.coefficient);

      if (absCoefficient < 0.15) {
        return `${leftLabel} and ${rightLabel} appear independent in the current window.`;
      }

      const strength =
        absCoefficient >= 0.7
          ? "strongly"
          : absCoefficient >= 0.4
            ? "moderately"
            : "weakly";

      const direction = pair.coefficient > 0 ? "positively" : "negatively";
      return `${leftLabel} and ${rightLabel} are ${strength} ${direction} correlated.`;
    });

    return {
      keys,
      coefficientMatrix,
      sampleMatrix,
      sensorDebugRows,
      pairDebugRows,
      strongestPositivePair,
      strongestNegativePair,
      interpretations,
    };
  }, [correlationSensorLabelByKey, windowedNumericRecords]);

  const alignedSensorData = useMemo(() => {
    return buildAlignedSensorObservations(windowedNumericRecords, timeUnit);
  }, [timeUnit, windowedNumericRecords]);

  const pcaAnalysis = useMemo(() => {
    return calculatePcaAnalysis(alignedSensorData);
  }, [alignedSensorData]);

  const correlationHeatmapData = useMemo(() => {
    const MIN_PAIR_OBSERVATIONS = 3;
    const keys = COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => sensorDef.key);
    const pairMatrix = keys.reduce<Record<ComparisonSensorKey, Record<ComparisonSensorKey, CorrelationHeatmapCell>>>(
      (acc, row) => {
        acc[row] = {
          temperature: { row, column: "temperature", value: null, observations: 0 },
          humidity: { row, column: "humidity", value: null, observations: 0 },
          pressure: { row, column: "pressure", value: null, observations: 0 },
          distance: { row, column: "distance", value: null, observations: 0 },
          accel: { row, column: "accel", value: null, observations: 0 },
        };
        return acc;
      },
      {
        temperature: {
          temperature: { row: "temperature", column: "temperature", value: null, observations: 0 },
          humidity: { row: "temperature", column: "humidity", value: null, observations: 0 },
          pressure: { row: "temperature", column: "pressure", value: null, observations: 0 },
          distance: { row: "temperature", column: "distance", value: null, observations: 0 },
          accel: { row: "temperature", column: "accel", value: null, observations: 0 },
        },
        humidity: {
          temperature: { row: "humidity", column: "temperature", value: null, observations: 0 },
          humidity: { row: "humidity", column: "humidity", value: null, observations: 0 },
          pressure: { row: "humidity", column: "pressure", value: null, observations: 0 },
          distance: { row: "humidity", column: "distance", value: null, observations: 0 },
          accel: { row: "humidity", column: "accel", value: null, observations: 0 },
        },
        pressure: {
          temperature: { row: "pressure", column: "temperature", value: null, observations: 0 },
          humidity: { row: "pressure", column: "humidity", value: null, observations: 0 },
          pressure: { row: "pressure", column: "pressure", value: null, observations: 0 },
          distance: { row: "pressure", column: "distance", value: null, observations: 0 },
          accel: { row: "pressure", column: "accel", value: null, observations: 0 },
        },
        distance: {
          temperature: { row: "distance", column: "temperature", value: null, observations: 0 },
          humidity: { row: "distance", column: "humidity", value: null, observations: 0 },
          pressure: { row: "distance", column: "pressure", value: null, observations: 0 },
          distance: { row: "distance", column: "distance", value: null, observations: 0 },
          accel: { row: "distance", column: "accel", value: null, observations: 0 },
        },
        accel: {
          temperature: { row: "accel", column: "temperature", value: null, observations: 0 },
          humidity: { row: "accel", column: "humidity", value: null, observations: 0 },
          pressure: { row: "accel", column: "pressure", value: null, observations: 0 },
          distance: { row: "accel", column: "distance", value: null, observations: 0 },
          accel: { row: "accel", column: "accel", value: null, observations: 0 },
        },
      },
    );

    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i; j < keys.length; j += 1) {
        const left = keys[i];
        const right = keys[j];

        if (left === right) {
          const observations = alignedSensorData.rows.filter(
            (row) => typeof row.values[left] === "number",
          ).length;
          pairMatrix[left][right] = { row: left, column: right, value: 1, observations };
          continue;
        }

        const leftValues: number[] = [];
        const rightValues: number[] = [];

        for (const row of alignedSensorData.rows) {
          const leftValue = row.values[left];
          const rightValue = row.values[right];
          if (typeof leftValue === "number" && typeof rightValue === "number") {
            leftValues.push(leftValue);
            rightValues.push(rightValue);
          }
        }

        const observations = leftValues.length;
        const coefficient =
          observations >= MIN_PAIR_OBSERVATIONS
            ? calculatePearsonCoefficient(leftValues, rightValues)
            : null;
        const cellValue = coefficient === null ? null : coefficient;

        pairMatrix[left][right] = { row: left, column: right, value: cellValue, observations };
        pairMatrix[right][left] = { row: right, column: left, value: cellValue, observations };
      }
    }

    const sensors = keys.filter((sensorKey) =>
      keys.some((otherSensorKey) => {
        if (sensorKey === otherSensorKey) return false;
        return pairMatrix[sensorKey][otherSensorKey].value !== null;
      }),
    );

    const cells: CorrelationHeatmapCell[] = sensors.flatMap((row) =>
      sensors.map((column) =>
        row === column
          ? { row, column, value: 1, observations: pairMatrix[row][column].observations }
          : pairMatrix[row][column],
      ),
    );

    return {
      sensors,
      cells,
      bucketSizeLabel: alignedSensorData.bucketSizeLabel,
    };
  }, [alignedSensorData]);

  const toggleComparisonSensor = (sensorKey: ComparisonSensorKey) => {
    setSelectedComparisonSensors((previous) => {
      if (previous.includes(sensorKey)) {
        return previous.filter((key) => key !== sensorKey);
      }

      return [...previous, sensorKey];
    });
  };

  const latestTemperature = findLatestValue(numericRecords, ["temperature", "temp"]);
  const latestHumidity = findLatestValue(numericRecords, ["humidity"]);
  const latestPressure = findLatestValue(numericRecords, ["pressure"]);
  const latestDistance = findLatestValue(numericRecords, ["distance"]);
  const latestAccel = findLatestValue(numericRecords, ["accel", "acceleration"]);

  const recentRecords = useMemo(() => {
    return [...records].sort((a, b) => b.timeMs - a.timeMs).slice(0, 20);
  }, [records]);

  const allSuddenJumps = useMemo((): SuddenJump[] => {
    return calculateSuddenJumps(windowedNumericRecords);
  }, [windowedNumericRecords]);

  const suddenJumps = useMemo((): SuddenJump[] => {
    return allSuddenJumps.slice(0, 10);
  }, [allSuddenJumps]);

  const anomalyTimelineEvents = useMemo((): SuddenJump[] => {
    const filtered =
      anomalySeverityFilter === "All"
        ? allSuddenJumps
        : allSuddenJumps.filter((jump) => jump.severity === anomalySeverityFilter);

    return [...filtered].sort((a, b) => b.timeMs - a.timeMs).slice(0, 20);
  }, [allSuddenJumps, anomalySeverityFilter]);

  const heatmapAnalysis = useMemo(() => {
    const sensorRows = COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => ({
      key: sensorDef.key,
      label: sensorDef.label.split(" (")[0],
      aliases: sensorDef.aliases,
    }));

    if (windowedNumericRecords.length === 0) {
      return {
        sensorRows,
        bucketCount: 0,
        totalSamplesUsed: 0,
        bucketStartMsList: [] as number[],
        bucketEndMsList: [] as number[],
        cellsBySensor: {} as Record<ComparisonSensorKey, HeatmapCell[]>,
        insights: ["No numeric values in the current filter window. Heatmap cannot be computed."],
      };
    }

    const minTimeMs = windowedNumericRecords[0].timeMs;
    const maxTimeMs = windowedNumericRecords[windowedNumericRecords.length - 1].timeMs;
    const rawWindowMs = Math.max(1, maxTimeMs - minTimeMs);

    let bucketCount = 12;
    if (timeUnit === "all") {
      bucketCount = 30;
    } else if (timeUnit === "days") {
      bucketCount = 24;
    } else {
      const minutesInWindow = rawWindowMs / (60 * 1000);
      bucketCount = clamp(Math.round(minutesInWindow / 2), 8, 30);
    }

    const bucketSizeMs = Math.max(1, Math.ceil(rawWindowMs / bucketCount));
    const bucketStartMsList = Array.from({ length: bucketCount }, (_, index) => minTimeMs + index * bucketSizeMs);
    const bucketEndMsList = Array.from({ length: bucketCount }, (_, index) => {
      const nextStart = minTimeMs + (index + 1) * bucketSizeMs;
      return index === bucketCount - 1 ? maxTimeMs : Math.max(minTimeMs, nextStart - 1);
    });

    const sumsBySensor = sensorRows.reduce<Record<ComparisonSensorKey, number[]>>(
      (acc, row) => {
        acc[row.key] = Array(bucketCount).fill(0);
        return acc;
      },
      {
        temperature: [],
        humidity: [],
        pressure: [],
        distance: [],
        accel: [],
      },
    );

    const countsBySensor = sensorRows.reduce<Record<ComparisonSensorKey, number[]>>(
      (acc, row) => {
        acc[row.key] = Array(bucketCount).fill(0);
        return acc;
      },
      {
        temperature: [],
        humidity: [],
        pressure: [],
        distance: [],
        accel: [],
      },
    );

    for (const record of windowedNumericRecords) {
      const matchingSensor = sensorRows.find((row) => row.aliases.includes(record.sensor));
      if (!matchingSensor) {
        continue;
      }

      const relativeMs = record.timeMs - minTimeMs;
      const bucketIndex = clamp(Math.floor(relativeMs / bucketSizeMs), 0, bucketCount - 1);
      sumsBySensor[matchingSensor.key][bucketIndex] += record.value;
      countsBySensor[matchingSensor.key][bucketIndex] += 1;
    }

    const averagesBySensor = sensorRows.reduce<Record<ComparisonSensorKey, Array<number | null>>>(
      (acc, row) => {
        acc[row.key] = Array.from({ length: bucketCount }, (_, index) => {
          const count = countsBySensor[row.key][index];
          if (count === 0) {
            return null;
          }
          return sumsBySensor[row.key][index] / count;
        });
        return acc;
      },
      {
        temperature: [],
        humidity: [],
        pressure: [],
        distance: [],
        accel: [],
      },
    );

    const normalizedBySensor = sensorRows.reduce<Record<ComparisonSensorKey, Array<number | null>>>(
      (acc, row) => {
        const values = averagesBySensor[row.key].filter((v): v is number => typeof v === "number");
        const min = values.length > 0 ? Math.min(...values) : null;
        const max = values.length > 0 ? Math.max(...values) : null;

        acc[row.key] = averagesBySensor[row.key].map((value) => {
          if (value === null || min === null || max === null) {
            return null;
          }
          if (max === min) {
            return 50;
          }
          return ((value - min) / (max - min)) * 100;
        });
        return acc;
      },
      {
        temperature: [],
        humidity: [],
        pressure: [],
        distance: [],
        accel: [],
      },
    );

    const cellsBySensor = sensorRows.reduce<Record<ComparisonSensorKey, HeatmapCell[]>>(
      (acc, row) => {
        acc[row.key] = Array.from({ length: bucketCount }, (_, bucketIndex) => ({
          sensorKey: row.key,
          sensorLabel: row.label,
          bucketIndex,
          bucketStartMs: bucketStartMsList[bucketIndex],
          bucketEndMs: bucketEndMsList[bucketIndex],
          averageValue: averagesBySensor[row.key][bucketIndex],
          sampleCount: countsBySensor[row.key][bucketIndex],
          normalizedValue: normalizedBySensor[row.key][bucketIndex],
        }));
        return acc;
      },
      {
        temperature: [],
        humidity: [],
        pressure: [],
        distance: [],
        accel: [],
      },
    );

    const totalSamplesUsed = sensorRows.reduce(
      (sum, row) => sum + countsBySensor[row.key].reduce((rowSum, count) => rowSum + count, 0),
      0,
    );

    const insights: string[] = [];
    for (const row of sensorRows) {
      const values = averagesBySensor[row.key].filter((v): v is number => typeof v === "number");
      if (values.length < 2) {
        continue;
      }

      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
      const span = max - min;

      const normalizedValues = normalizedBySensor[row.key].filter((v): v is number => typeof v === "number");
      const normalizedAvg =
        normalizedValues.length > 0
          ? normalizedValues.reduce((sum, value) => sum + value, 0) / normalizedValues.length
          : 50;

      if (span <= Math.max(0.05, Math.abs(avg) * 0.1)) {
        insights.push(`${row.label} remained stable across the selected timeline.`);
      } else if (normalizedAvg >= 70) {
        insights.push(`${row.label} remained consistently high across most buckets.`);
      } else if (normalizedAvg <= 30) {
        insights.push(`${row.label} remained consistently low across most buckets.`);
      } else if (span >= Math.max(0.2, Math.abs(avg) * 0.5)) {
        insights.push(`${row.label} showed large variation across time buckets.`);
      }
    }

    return {
      sensorRows,
      bucketCount,
      totalSamplesUsed,
      bucketStartMsList,
      bucketEndMsList,
      cellsBySensor,
      insights: insights.slice(0, 6),
    };
  }, [timeUnit, windowedNumericRecords]);

  const heatmapViewModes: Array<{ key: HeatmapViewMode; label: string }> = [
    { key: "grid", label: "Grid Heatmap" },
    { key: "compact", label: "Compact Heatmap" },
    { key: "stripes", label: "Sensor Stripes" },
    { key: "table", label: "Bucket Table" },
    { key: "intensity-cards", label: "Intensity Cards" },
  ];

  const heatmapIntensityCards = useMemo(() => {
    return heatmapAnalysis.sensorRows.map((row) => {
      const cells = heatmapAnalysis.cellsBySensor[row.key] ?? [];
      const values = cells
        .map((cell) => cell.averageValue)
        .filter((value): value is number => typeof value === "number");

      const min = values.length > 0 ? Math.min(...values) : null;
      const max = values.length > 0 ? Math.max(...values) : null;
      const avg =
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;

      const variation =
        min !== null && max !== null && avg !== null
          ? max - min
          : null;

      let variationLevel = "Low";
      if (variation !== null && avg !== null) {
        const threshold = Math.max(Math.abs(avg), 0.1);
        const ratio = variation / threshold;
        variationLevel = ratio >= 0.8 ? "High" : ratio >= 0.35 ? "Medium" : "Low";
      }

      return {
        key: row.key,
        label: row.label,
        cells,
        min,
        max,
        avg,
        variationLevel,
      };
    });
  }, [heatmapAnalysis]);

  const aiAnalysis = useMemo(() => {
    const insights: string[] = [];

    if (windowedNumericRecords.length === 0) {
      return {
        score: "Stable" as BehaviorScore,
        confidence: 0,
        totalWarnings: 0,
        insights: ["No numeric sensor data available in the selected time window."],
      };
    }

    const grouped = new Map<string, Array<SensorRecord & { value: number }>>();
    for (const item of windowedNumericRecords) {
      const group = grouped.get(item.sensor) ?? [];
      group.push(item);
      grouped.set(item.sensor, group);
    }

    const getLatestByAliases = (aliases: string[]): number | null => {
      for (let i = windowedNumericRecords.length - 1; i >= 0; i -= 1) {
        const record = windowedNumericRecords[i];
        if (aliases.includes(record.sensor)) return record.value;
      }
      return null;
    };

    const distanceLatest = getLatestByAliases(["distance"]);
    const accelJumps = allSuddenJumps.filter(
      (j) => ["accel", "acceleration"].includes(j.sensor) && j.percentageJump >= 20,
    );
    const highRiskJumps = allSuddenJumps.filter((j) => j.percentageJump >= 50);
    const warningJumps = allSuddenJumps.filter((j) => j.percentageJump >= 20);

    const tempJumps = allSuddenJumps.filter(
      (j) => ["temperature", "temp"].includes(j.sensor) && j.currValue - j.prevValue >= 3,
    );
    const humiditySeries = (grouped.get("humidity") ?? []).sort((a, b) => a.timeMs - b.timeMs);
    const pressureSeries = (grouped.get("pressure") ?? []).sort((a, b) => a.timeMs - b.timeMs);

    const humidityRapidIncrease =
      humiditySeries.length >= 2 &&
      humiditySeries[humiditySeries.length - 1].value - humiditySeries[0].value >= 8;

    const pressureValues = pressureSeries.map((p) => p.value);
    const pressureRange =
      pressureValues.length > 0
        ? Math.max(...pressureValues) - Math.min(...pressureValues)
        : Number.POSITIVE_INFINITY;
    const pressureStable = pressureSeries.length >= 4 && pressureRange <= 2;

    const noisySensors = new Set<string>();
    const jumpCountBySensor = new Map<string, number>();
    for (const jump of warningJumps) {
      jumpCountBySensor.set(jump.sensor, (jumpCountBySensor.get(jump.sensor) ?? 0) + 1);
    }
    for (const [sensor, count] of jumpCountBySensor) {
      if (count >= 3) noisySensors.add(sensor);
    }

    if (distanceLatest !== null && distanceLatest <= 12) {
      insights.push("Sudden obstacle detected nearby.");
    }

    if (distanceLatest !== null && distanceLatest <= 8 && accelJumps.length >= 2) {
      insights.push("Robot possibly stuck near obstacle.");
    }

    if (accelJumps.length >= 3) {
      insights.push("Robot movement became unstable.");
      insights.push("Acceleration spikes detected.");
    }

    if (humidityRapidIncrease) {
      insights.push("Environment humidity increasing rapidly.");
    }

    if (pressureStable) {
      insights.push("Pressure stable for the selected time range.");
    }

    if (tempJumps.length > 0) {
      insights.push("Temperature anomaly detected.");
    }

    if (noisySensors.size > 0) {
      insights.push("Repeated spikes suggest noisy sensor behavior.");
    }

    if (warningJumps.length === 0 && pressureStable) {
      insights.push("Sensor values are stable.");
    }

    if (warningJumps.length <= 1 && (distanceLatest === null || distanceLatest > 12)) {
      insights.push("Robot operating normally.");
    }

    let riskScore = 0;
    if (distanceLatest !== null && distanceLatest <= 8) riskScore += 3;
    else if (distanceLatest !== null && distanceLatest <= 12) riskScore += 2;

    if (accelJumps.length >= 3) riskScore += 2;
    else if (accelJumps.length > 0) riskScore += 1;

    if (highRiskJumps.length >= 4) riskScore += 2;
    else if (highRiskJumps.length >= 2) riskScore += 1;

    if (humidityRapidIncrease) riskScore += 1;
    if (tempJumps.length > 0) riskScore += 1;
    if (noisySensors.size > 0) riskScore += 1;
    if (pressureStable) riskScore -= 1;

    const clampedRisk = Math.max(0, riskScore);

    const score: BehaviorScore =
      clampedRisk >= 6
        ? "Critical"
        : clampedRisk >= 4
          ? "Warning"
          : clampedRisk >= 2
            ? "Cautious"
            : "Stable";

    const confidence = Math.min(
      98,
      Math.max(
        55,
        55 +
          Math.min(20, Math.floor(windowedNumericRecords.length / 25) * 5) +
          Math.min(18, grouped.size * 3),
      ),
    );

    return {
      score,
      confidence,
      totalWarnings: warningJumps.length,
      insights: insights.slice(0, 8),
    };
  }, [windowedNumericRecords, allSuddenJumps]);

  const selectedTimeWindowLabel =
    timeUnit === "all" ? "All available data" : `${timeAmount || "-"} ${timeUnit}`;

  const formatPcaSensorList = (sensorKeys: ComparisonSensorKey[]) =>
    sensorKeys.length > 0
      ? sensorKeys.map((sensorKey) => correlationSensorLabelByKey[sensorKey]).join(", ")
      : "None";

  const formatPcaSentenceList = (sensorKeys: ComparisonSensorKey[]) => {
    const labels = sensorKeys.map((sensorKey) => correlationSensorLabelByKey[sensorKey]);
    if (labels.length === 0) return "available sensors";
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  };

  const pcaInterpretation =
    pcaAnalysis.status === "ok"
      ? `Most system variability is explained by ${formatPcaSentenceList(
          pcaAnalysis.components[0]?.topContributors.slice(0, 2) ?? [],
        )}.`
      : null;

  const pcaSensorImportance = useMemo(() => {
    if (pcaAnalysis.status !== "ok") return [];

    const pc1Scores = pcaAnalysis.components[0]?.contributorScores ?? [];
    const maxScore = Math.max(...pc1Scores.map((item) => item.score), 0);

    return pc1Scores.map((item) => ({
      sensor: item.sensor,
      scorePercent: maxScore > 0 ? Math.round((item.score / maxScore) * 100) : 0,
    }));
  }, [pcaAnalysis]);

  const getDirectionColorClass = (label: string) => {
    if (label === "Rising") return "text-[#2E7D32]";
    if (label === "Falling") return "text-[#C62828]";
    return "text-[#607D8B]";
  };

  const sensorDefinitions: Array<{
    key: string;
    title: string;
    aliases: string[];
    unit: string;
    icon: typeof Thermometer;
    latest: number | null;
  }> = [
    { key: "temperature", title: "Temperature", aliases: ["temperature", "temp"], unit: "°C", icon: Thermometer, latest: latestTemperature },
    { key: "humidity", title: "Humidity", aliases: ["humidity"], unit: "%", icon: Waves, latest: latestHumidity },
    { key: "pressure", title: "Pressure", aliases: ["pressure"], unit: "hPa", icon: Gauge, latest: latestPressure },
    { key: "distance", title: "Distance", aliases: ["distance"], unit: "cm", icon: Ruler, latest: latestDistance },
    { key: "accel", title: "Accel", aliases: ["accel", "acceleration"], unit: "m/s²", icon: Activity, latest: latestAccel },
  ];

  const getDirection = (first: number, last: number) => {
    const delta = last - first;
    const threshold = Math.max(Math.abs(first) * 0.01, 0.05);

    if (Math.abs(delta) <= threshold) {
      return { arrow: "→", label: "Stable" };
    }

    return delta > 0
      ? { arrow: "↑", label: "Rising" }
      : { arrow: "↓", label: "Falling" };
  };

  const metricCards = useMemo(() => {
    return sensorDefinitions.map((definition) => {
      const sensorWindowRecords = windowedNumericRecords
        .filter((record) => definition.aliases.includes(record.sensor))
        .sort((a, b) => a.timeMs - b.timeMs);
      const values = sensorWindowRecords.map((record) => record.value);
      const points = sensorWindowRecords.map((record) => ({
        timeMs: record.timeMs,
        value: record.value,
      }));
      const stability = calculateStability(points);
      const forecast = calculateGaussianForecast(points);

      if (values.length < 2) {
        return {
          ...definition,
          trendArrow: "→",
          trendLabel: "Stable",
          stability,
          forecast,
        };
      }

      const sampleSize = Math.min(3, values.length);
      const first = values[values.length - sampleSize];
      const last = values[values.length - 1];
      const trend = getDirection(first, last);

      return {
        ...definition,
        trendArrow: trend.arrow,
        trendLabel: trend.label,
        stability,
        forecast,
      };
    });
  }, [windowedNumericRecords, latestTemperature, latestHumidity, latestPressure, latestDistance, latestAccel]);

  const keyChanges = useMemo(() => {
    return sensorDefinitions.map((definition) => {
      const values = windowedNumericRecords
        .filter((record) => definition.aliases.includes(record.sensor))
        .map((record) => record.value);

      if (values.length < 2) {
        return {
          key: definition.key,
          label: definition.title,
          deltaPct: null as number | null,
          direction: { arrow: "→", label: "Stable" },
        };
      }

      const first = values[0];
      const latest = values[values.length - 1];
      const deltaPct = first === 0 ? null : ((latest - first) / Math.abs(first)) * 100;
      const direction = getDirection(first, latest);

      return {
        key: definition.key,
        label: definition.title,
        deltaPct,
        direction,
      };
    });
  }, [windowedNumericRecords]);

  const engineeringDecision = useMemo(() => {
    const warningJumps = allSuddenJumps.filter((jump) => jump.percentageJump >= 20);
    const highJumps = allSuddenJumps.filter((jump) => jump.percentageJump >= 50);
    const tempAnomalies = allSuddenJumps.filter(
      (jump) => ["temperature", "temp"].includes(jump.sensor) && jump.currValue - jump.prevValue >= 3,
    );
    const distanceWarnings = allSuddenJumps.filter(
      (jump) => jump.sensor === "distance" && jump.percentageJump >= 20,
    );

    const pressureSeries = windowedNumericRecords
      .filter((record) => record.sensor === "pressure")
      .map((record) => record.value);
    const pressureRange =
      pressureSeries.length > 0 ? Math.max(...pressureSeries) - Math.min(...pressureSeries) : 0;
    const pressureAnomaly =
      latestPressure !== null && (latestPressure < 970 || latestPressure > 1035 || pressureRange > 8);

    const distanceAnomaly = latestDistance !== null && (latestDistance <= 12 || distanceWarnings.length >= 2);

    const warningCountBySensor = new Map<string, number>();
    for (const jump of warningJumps) {
      warningCountBySensor.set(jump.sensor, (warningCountBySensor.get(jump.sensor) ?? 0) + 1);
    }

    const unstableSensorCount = Array.from(warningCountBySensor.values()).filter((count) => count >= 3).length;
    const sensorStability = sensorOptions.length === 0
      ? 1
      : (sensorOptions.length - unstableSensorCount) / sensorOptions.length;

    const penalty =
      Math.min(35, warningJumps.length * 2) +
      Math.min(22, highJumps.length * 6) +
      Math.max(0, Math.round((1 - sensorStability) * 25)) +
      (distanceAnomaly ? 14 : 0) +
      (tempAnomalies.length > 0 ? 10 : 0) +
      (pressureAnomaly ? 12 : 0);

    const healthScore = clamp(100 - penalty, 0, 100);
    const healthStatus =
      healthScore >= 90
        ? "Excellent"
        : healthScore >= 75
          ? "Good"
          : healthScore >= 50
            ? "Warning"
            : "Critical";

    const issues: Array<{ severity: number; text: string }> = [];

    if (distanceAnomaly) {
      issues.push({ severity: 3, text: "Distance sensor reports obstacle-proximity risk." });
    }

    if (pressureAnomaly) {
      issues.push({ severity: 3, text: "Pressure outside normal operating behavior." });
    }

    if (tempAnomalies.length > 0) {
      issues.push({ severity: 2, text: "Temperature anomalies detected in current window." });
    }

    if (unstableSensorCount > 0) {
      issues.push({ severity: 2, text: "Repeated sensor spikes indicate instability." });
    }

    if (warningJumps.length >= 4) {
      issues.push({ severity: 2, text: "Warning-level jumps increased across telemetry channels." });
    }

    if (issues.length === 0) {
      issues.push({ severity: 1, text: "No immediate issues detected in the selected time window." });
    }

    const topIssues = issues.sort((a, b) => b.severity - a.severity).slice(0, 3);

    const systemStatus =
      healthScore < 50 || highJumps.length >= 3
        ? { icon: "🔴", label: "CRITICAL" }
        : healthScore < 75 || topIssues[0]?.severity >= 2
          ? { icon: "🟡", label: "ATTENTION NEEDED" }
          : { icon: "🟢", label: "HEALTHY" };

    const recommendation =
      systemStatus.label === "HEALTHY"
        ? "System operating normally. No action required."
        : distanceAnomaly
          ? "Inspect distance sensor path for obstruction and verify clearance."
          : pressureAnomaly
            ? "Check pressure sensor calibration and local environmental conditions."
            : tempAnomalies.length > 0
              ? "Monitor temperature behavior over the next hour for persistence."
              : "Monitor warning spikes and validate sensor stability in next cycle.";

    return {
      healthScore,
      healthStatus,
      systemStatus,
      topIssues,
      recommendation,
    };
  }, [allSuddenJumps, latestDistance, latestPressure, sensorOptions.length, windowedNumericRecords]);

  const recommendedPriority =
    engineeringDecision.healthScore < 50 || engineeringDecision.topIssues[0]?.severity >= 3
      ? "HIGH"
      : engineeringDecision.healthScore < 75 || engineeringDecision.topIssues[0]?.severity >= 2
        ? "MEDIUM"
        : "LOW";

  const recommendedImpact = recommendedPriority === "LOW" ? "MODERATE" : "HIGH";

  return (
    <main className="min-h-screen bg-[#F6F8FB] text-[#0F172A]">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <header className="rounded-lg border border-[#D8E0EA] bg-white px-6 py-7">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#1F4E8C]">
            Robot Telemetry Research Dashboard
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[#0F172A] sm:text-5xl">
            Engineering Decision Support Dashboard
          </h1>
          <p className="mt-3 max-w-4xl text-base font-medium leading-7 text-[#475569] sm:text-lg">
            Real-Time Robot Telemetry Analysis using Statistical &amp; Machine Learning Techniques
          </p>

          {dataLoadMessage && (
            <div className="mt-4 rounded-lg border border-[#D8E0EA] bg-[#FFF7ED] px-3 py-2 text-sm text-[#B45309]">
              {dataLoadMessage}
            </div>
          )}

          {dataSource === "demo" && !dataLoadMessage && (
            <div className="mt-4 rounded-lg border border-[#D8E0EA] bg-[#EFF6FF] px-3 py-2 text-sm text-[#1F4E8C]">
              Showing sanitized demo telemetry data.
            </div>
          )}
        </header>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">Executive Summary</p>
          <div className="mt-4 grid gap-5 lg:grid-cols-3">
            <article className="flex flex-col items-center justify-center rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] p-5 text-center lg:col-span-2">
              <p className="text-sm font-semibold uppercase tracking-wide text-[#475569]">Health Score</p>
              <p className="mt-2 text-[64px] font-semibold leading-none tracking-tight text-[#0F172A] sm:text-[72px]">
                {engineeringDecision.healthScore}
              </p>
              <span
                className={`mt-3 inline-flex rounded-full border px-4 py-1.5 text-xs font-bold uppercase tracking-wide ${
                  engineeringDecision.healthStatus === "Excellent"
                    ? "border-[#A5D6A7] bg-[#F1F8E9] text-[#2E7D32]"
                    : engineeringDecision.healthStatus === "Good"
                      ? "border-[#BBD4F0] bg-[#EFF6FF] text-[#1F4E8C]"
                      : engineeringDecision.healthStatus === "Warning"
                        ? "border-[#F9D66B] bg-[#FFF8E1] text-[#B45309]"
                        : "border-[#F0B4B4] bg-[#FDECEC] text-[#C62828]"
                }`}
              >
                {engineeringDecision.healthStatus}
              </span>
            </article>

            <article className="rounded-lg border border-[#D8E0EA] bg-white p-6">
              <p className="text-[13px] font-semibold uppercase tracking-wide text-[#475569]">Window Summary</p>
              <div className="mt-3 space-y-2.5 text-sm">
                <p className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] pb-2"><span className="font-medium text-[#475569]">Time Window</span><span className="font-bold text-[#1F4E8C]">{selectedTimeWindowLabel}</span></p>
                <p className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] pb-2"><span className="font-medium text-[#475569]">Sensor Points</span><span className="font-bold text-[#1F4E8C]">{windowedNumericRecords.length}</span></p>
                <p className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] pb-2"><span className="font-medium text-[#475569]">Warnings</span><span className="font-bold text-[#1F4E8C]">{allSuddenJumps.length}</span></p>
                <p className="flex items-center justify-between gap-3"><span className="font-medium text-[#475569]">Active Sensors</span><span className="font-bold text-[#1F4E8C]">{sensorOptions.length}</span></p>
              </div>
            </article>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <article className="rounded-lg border border-[#D8E0EA] bg-white p-6">
            <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">System Status</p>
            <p
              className={`mt-2 text-2xl font-semibold ${
                engineeringDecision.healthStatus === "Critical"
                  ? "text-[#C62828]"
                  : engineeringDecision.healthStatus === "Warning"
                    ? "text-[#B45309]"
                    : "text-[#0F172A]"
              }`}
            >
              {engineeringDecision.systemStatus.label}
            </p>
            <ul className="mt-5 space-y-3.5 text-sm text-[#475569]">
              {engineeringDecision.topIssues.map((issue, index) => (
                <li key={`${issue.text}-${index}`} className="flex items-start gap-3 rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#F9A825]" />
                  <span>{issue.text}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="rounded-lg border border-[#D8E0EA] bg-white p-6">
            <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">Key Changes In Current Window</p>
            <div className="mt-4 space-y-2.5">
              {keyChanges.map((change) => (
                <div key={change.key} className="flex items-center justify-between rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3 text-sm">
                  <span className="text-[#475569]">{change.label}</span>
                  <span className={`font-bold ${getDirectionColorClass(change.direction.label)}`}>
                    {change.direction.arrow} {change.deltaPct === null ? "N/A" : `${change.deltaPct >= 0 ? "+" : ""}${change.deltaPct.toFixed(1)}%`}
                  </span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">Sensor Overview</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {metricCards.map((card) => {
              const Icon = card.icon;
              return (
                <article key={card.title} className="rounded-lg border border-[#D8E0EA] bg-white p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-[#475569]">{card.title}</p>
                    <Icon className="h-6 w-6 text-[#1F4E8C]" />
                  </div>
                  <p className="mt-3 text-2xl font-semibold text-[#0F172A]">
                    {card.latest === null ? "N/A" : `${card.latest.toFixed(2)} ${card.unit}`}
                  </p>
                  <p className="mt-2 text-sm font-medium text-[#475569]">
                    {card.trendArrow} {card.trendLabel}
                  </p>
                  <div className="mt-4 border-t border-[#E2E8F0] pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#607D8B]">Forecast</p>
                    {card.forecast.value === null ? (
                      <p className="mt-1 text-sm font-semibold text-[#607D8B]">Insufficient data</p>
                    ) : (
                      <>
                        <p className="mt-1 text-lg font-semibold text-[#0F172A]">
                          {card.forecast.value.toFixed(1)}{card.unit}
                        </p>
                        <p className={`mt-0.5 text-sm font-semibold ${getDirectionColorClass(card.forecast.direction)}`}>
                          {card.forecast.direction === "Rising" ? "↑" : card.forecast.direction === "Falling" ? "↓" : "→"} {card.forecast.direction}
                        </p>
                      </>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-[#475569]">
                    Stability: {card.stability.score === null ? "N/A" : `${card.stability.score}%`} · {card.stability.label}
                  </p>
                  <p className="hidden">
                    Forecast: {card.forecast.value === null
                      ? "Insufficient data"
                      : `${card.forecast.value.toFixed(1)}${card.unit} · ${card.forecast.direction}`}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">Sensor Trend Comparison</p>
          <div className="mt-4 grid gap-5 lg:grid-cols-4">
            <article className="rounded-lg border border-[#D8E0EA] bg-white p-5 lg:col-span-3">
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <select
                  value={selectedSensor}
                  onChange={(event) => setSelectedSensor(event.target.value)}
                  className="rounded-lg border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#1F4E8C] focus:ring-2 focus:ring-blue-100"
                >
                  {sensorOptions.map((sensor) => (
                    <option key={sensor} value={sensor}>
                      {sensor}
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  min="1"
                  step="1"
                  value={timeAmount}
                  onChange={(event) => setTimeAmount(event.target.value)}
                  disabled={timeUnit === "all"}
                  className="w-24 rounded-lg border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#1F4E8C] focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-[#F1F5F9] disabled:text-[#64748B]"
                  placeholder="Amount"
                  aria-label="Time amount"
                />

                <select
                  value={timeUnit}
                  onChange={(event) => setTimeUnit(event.target.value as TimeUnit)}
                  className="rounded-lg border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#1F4E8C] focus:ring-2 focus:ring-blue-100"
                  aria-label="Time unit"
                >
                  <option value="seconds">seconds</option>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                  <option value="all">all</option>
                </select>

                <label className="inline-flex items-center gap-2 rounded-lg border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#475569]">
                  <input
                    type="checkbox"
                    checked={showFuturePrediction}
                    onChange={(event) => setShowFuturePrediction(event.target.checked)}
                    className="h-4 w-4 rounded border-[#D8E0EA] text-[#1F4E8C]"
                  />
                  Future Prediction
                </label>

                <label className="inline-flex items-center gap-2 rounded-lg border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#475569]">
                  <input
                    type="checkbox"
                    checked={normalizeOverlay}
                    onChange={(event) => setNormalizeOverlay(event.target.checked)}
                    className="h-4 w-4 rounded border-[#D8E0EA] text-[#1F4E8C]"
                  />
                  Normalize overlay
                </label>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-[#475569]">
                  Overlay sensors
                </span>
                {COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => (
                  <label
                    key={sensorDef.key}
                    className="inline-flex items-center gap-2 rounded-full border border-[#D8E0EA] bg-white px-3 py-1.5 text-xs font-medium text-[#475569]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedOverlaySensors.includes(sensorDef.key)}
                      onChange={(event) => {
                        setSelectedOverlaySensors((previous) =>
                          event.target.checked
                            ? Array.from(new Set([...previous, sensorDef.key]))
                            : previous.filter((key) => key !== sensorDef.key),
                        );
                      }}
                      className="h-3.5 w-3.5 rounded border-[#D8E0EA] text-[#1F4E8C]"
                    />
                    {sensorDef.label.split(" (")[0]}
                  </label>
                ))}
              </div>

              <div className="mb-4 space-y-1 text-xs text-[#475569]">
                <p>Use normalized overlay to compare sensor patterns across different units.</p>
                <p>Forecast uses Gaussian weighting: recent readings influence prediction more than older readings.</p>
                {showFuturePrediction && futurePredictionSeries.length === 0 && (
                  <p className="font-medium text-[#B45309]">
                    Future prediction requires at least 3 data points.
                  </p>
                )}
              </div>

              <div className="mb-4 rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2 font-mono text-[11px] text-[#475569]">
                Sensor = {selectedSensor}&nbsp;&nbsp;|&nbsp;&nbsp;Points = {selectedSeries.length}&nbsp;&nbsp;|&nbsp;&nbsp;Time Range = {timeUnit === "all" ? "all" : `${timeAmount} ${timeUnit}`}
              </div>

              <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={mainChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#D8E0EA" />
                    <XAxis
                      dataKey="timeMs"
                      type="number"
                      scale="time"
                      domain={["dataMin", "dataMax"]}
                      tickCount={mainChartTickCount}
                      tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                      tick={{ fill: "#475569", fontSize: 11 }}
                      minTickGap={40}
                    />
                    <YAxis
                      tick={{ fill: "#475569", fontSize: 11 }}
                      width={50}
                      domain={normalizeOverlay ? [0, 100] : ["auto", "auto"]}
                    />
                    <Tooltip
                      labelFormatter={(label) => {
                        const timeMs =
                          typeof label === "number"
                            ? label
                            : typeof label === "string"
                              ? Number(label)
                              : NaN;
                        return Number.isFinite(timeMs)
                          ? formatTickLabel(timeMs, timeUnit)
                          : String(label ?? "");
                      }}
                      formatter={(value, name) => [
                        typeof value === "number" ? value.toFixed(2) : value,
                        name,
                      ]}
                      contentStyle={{
                        backgroundColor: "#ffffff",
                        border: "1px solid #D8E0EA",
                        borderRadius: "0.5rem",
                        color: "#0f172a",
                      }}
                    />
                    <Legend verticalAlign="top" height={38} wrapperStyle={{ fontSize: 12, paddingBottom: 8 }} />
                    <Line
                      type="monotone"
                      dataKey="primaryValue"
                      name={primaryComparisonSensor?.label.split(" (")[0] ?? selectedSensor}
                      stroke="#1F4E8C"
                      strokeWidth={2.8}
                      dot={false}
                      activeDot={{ r: 4 }}
                      isAnimationActive
                      connectNulls={false}
                    />
                    {mainChartSensorDefinitions
                      .filter((sensorDef) => sensorDef.key !== primaryComparisonSensor?.key)
                      .map((sensorDef) => (
                        <Line
                          key={sensorDef.key}
                          type="monotone"
                          dataKey={`overlay_${sensorDef.key}`}
                          name={sensorDef.label.split(" (")[0]}
                          stroke={sensorDef.color}
                          strokeWidth={2.2}
                          strokeDasharray={sensorDef.dasharray}
                          dot={false}
                          activeDot={{ r: 3 }}
                          isAnimationActive
                          connectNulls={false}
                        />
                      ))}
                    {futurePredictionSeries.length > 0 && (
                      <Line
                        type="monotone"
                        dataKey="forecastValue"
                        name="Gaussian Forecast"
                        stroke="#EA580C"
                        strokeWidth={2.6}
                        strokeDasharray="7 5"
                        dot={false}
                        activeDot={{ r: 3 }}
                        isAnimationActive
                        connectNulls={false}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>

            <aside className="rounded-lg border border-[#D8E0EA] bg-white p-5">
              <h3 className="text-base font-medium text-[#0F172A]">Current Chart Statistics</h3>
              <p className="mt-1 text-xs text-[#475569]">Computed from visible points in the active chart window</p>
              <p className="mt-1 text-xs text-[#64748B]">Statistics shown for primary selected sensor.</p>
              <div className="mt-3 space-y-2">
                <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-[#475569]">Min</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">
                    {chartStats.min === null ? "No data" : chartStats.min.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-[#475569]">Max</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">
                    {chartStats.max === null ? "No data" : chartStats.max.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-[#475569]">Average</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">
                    {chartStats.avg === null ? "No data" : chartStats.avg.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-[#475569]">Points</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">
                    {chartStats.points === 0 ? "No data" : chartStats.points}
                  </p>
                </div>
              </div>
            </aside>
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <div className="max-w-3xl">
            <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">
              Sensor Relationship Analysis
            </p>
            <p className="mt-2 text-sm text-[#475569]">
              Correlation helps identify whether changes in one sensor are related to changes in another.
            </p>
          </div>

          <div className="mt-5 overflow-hidden rounded-lg border border-[#D8E0EA]">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#D8E0EA] text-left text-sm">
                <thead className="bg-[#F8FAFC]">
                  <tr>
                    <th className="px-4 py-3 font-semibold text-[#475569]" scope="col">
                      Sensor Pair
                    </th>
                    <th className="px-4 py-3 font-semibold text-[#475569]" scope="col">
                      Correlation
                    </th>
                    <th className="px-4 py-3 font-semibold text-[#475569]" scope="col">
                      Relationship
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0] bg-white">
                  {[
                    { left: "temperature", right: "humidity" },
                    { left: "temperature", right: "pressure" },
                    { left: "distance", right: "accel" },
                    { left: "humidity", right: "pressure" },
                  ].map((pair) => {
                    const left = pair.left as ComparisonSensorKey;
                    const right = pair.right as ComparisonSensorKey;
                    const coefficient = correlationAnalysis.coefficientMatrix[left][right];

                    return (
                      <tr key={`${left}-${right}`}>
                        <td className="px-4 py-4 font-medium text-[#0F172A]">
                          {correlationSensorLabelByKey[left]} and {correlationSensorLabelByKey[right]}
                        </td>
                        <td className="px-4 py-4 font-mono font-semibold tabular-nums text-[#0F172A]">
                          {coefficient === null
                            ? "N/A"
                            : `${coefficient >= 0 ? "+" : ""}${coefficient.toFixed(2)}`}
                        </td>
                        <td className="px-4 py-4 text-[#475569]">
                          {getCorrelationRelationship(coefficient)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">
                PCA Analysis
              </p>
              <p className="mt-2 text-sm text-[#475569]">
                Dimensionality reduction of current sensor window
              </p>
              <p className="mt-3 text-sm leading-6 text-[#475569]">
                PCA reduces multiple sensor variables into principal components that capture the
                dominant behavior of the robot.
              </p>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2 text-xs text-[#475569] lg:max-w-xs">
              Based on PCA lecture: standardization {">"} covariance matrix {">"} eigenvalues/eigenvectors {">"} explained variance.
            </div>
            <button
              type="button"
              onClick={() => setShowPcaAnalysis((previous) => !previous)}
              className={`inline-flex shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-blue-100 focus:ring-offset-2 ${
                showPcaAnalysis
                  ? "border-[#1F4E8C] bg-[#1F4E8C] text-white hover:bg-[#173B69]"
                  : "border-[#1F4E8C] bg-white text-[#1F4E8C] hover:bg-[#EFF6FF]"
              }`}
              aria-expanded={showPcaAnalysis}
            >
              {showPcaAnalysis ? "Hide PCA Analysis" : "Show PCA Analysis"}
            </button>
          </div>

          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              showPcaAnalysis ? "mt-5 max-h-[980px] opacity-100" : "mt-0 max-h-0 opacity-0"
            }`}
          >
            <div className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
              <p className="uppercase tracking-wide text-[#475569]">Aligned observations</p>
              <p className="mt-1 font-semibold text-[#0F172A]">
                {pcaAnalysis.diagnostics.alignedObservations}
              </p>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
              <p className="uppercase tracking-wide text-[#475569]">Observations used</p>
              <p className="mt-1 font-semibold text-[#0F172A]">
                {pcaAnalysis.diagnostics.observationsUsed}
              </p>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
              <p className="uppercase tracking-wide text-[#475569]">Bucket size</p>
              <p className="mt-1 font-semibold text-[#0F172A]">
                {pcaAnalysis.diagnostics.bucketSizeLabel}
              </p>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
              <p className="uppercase tracking-wide text-[#475569]">Sensors used</p>
              <p className="mt-1 font-semibold text-[#0F172A]">
                {formatPcaSensorList(pcaAnalysis.diagnostics.sensorsUsed)}
              </p>
            </div>
          </div>

            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
              <p className="uppercase tracking-wide text-[#475569]">Sensors skipped</p>
              <p className="mt-1 font-semibold text-[#0F172A]">
                {formatPcaSensorList(pcaAnalysis.diagnostics.sensorsSkipped)}
              </p>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2">
              <p className="uppercase tracking-wide text-[#475569]">Time window used</p>
              <p className="mt-1 font-semibold text-[#0F172A]">{selectedTimeWindowLabel}</p>
            </div>
          </div>

            {pcaAnalysis.status === "ok" ? (
            <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.1fr]">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                {pcaAnalysis.components.slice(0, 2).map((component, index) => {
                  const percent = component.explainedVariance * 100;

                  return (
                    <div key={component.name} className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3">
                      <p className="text-[12px] font-semibold uppercase tracking-wide text-[#475569]">
                        Principal Component {index + 1}
                      </p>
                      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#E2E8F0]">
                        <div
                          className="h-full rounded-full bg-[#1F4E8C]"
                          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                        />
                      </div>
                      <p className="mt-2 text-lg font-semibold text-[#0F172A]">
                        {percent.toFixed(1)}%
                      </p>
                    </div>
                  );
                })}
                <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-[#475569]">Cumulative</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">
                    PC1 + PC2 capture {(pcaAnalysis.components[1]?.cumulativeVariance ?? pcaAnalysis.components[0]?.cumulativeVariance ?? 0).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                      style: "percent",
                    })}{" "}
                    of system behavior
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-[#D8E0EA]">
                <table className="min-w-full divide-y divide-[#D8E0EA] text-left text-sm">
                  <thead className="bg-[#F8FAFC]">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-[#475569]" scope="col">
                        Component
                      </th>
                      <th className="px-4 py-3 font-semibold text-[#475569]" scope="col">
                        Top Contributors
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0] bg-white">
                    {pcaAnalysis.components.slice(0, 2).map((component) => (
                      <tr key={component.name}>
                        <td className="px-4 py-4 font-mono font-semibold text-[#0F172A]">
                          {component.name}
                        </td>
                        <td className="px-4 py-4 text-[#475569]">
                          <div className="flex flex-wrap gap-2">
                            {component.topContributors.map((sensorKey) => (
                              <span
                                key={`${component.name}-${sensorKey}`}
                                className="rounded-full border border-[#D8E0EA] bg-[#F8FAFC] px-2.5 py-1 text-xs font-medium text-[#475569]"
                              >
                                {correlationSensorLabelByKey[sensorKey]}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pcaInterpretation && (
                  <p className="border-t border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3 text-sm font-medium text-[#475569]">
                    {pcaInterpretation}
                  </p>
                )}
              </div>
            </div>
            ) : (
            <div className="mt-5 rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-4 text-sm font-medium text-[#475569]">
              {pcaAnalysis.message}
            </div>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">
                Sensor Importance Ranking
              </p>
              <p className="mt-2 text-sm text-[#475569]">
                Ranked from the existing PCA loading contributions for the current sensor window.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowSensorImportanceRanking((previous) => !previous)}
              className={`inline-flex shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-blue-100 focus:ring-offset-2 ${
                showSensorImportanceRanking
                  ? "border-[#1F4E8C] bg-[#1F4E8C] text-white hover:bg-[#173B69]"
                  : "border-[#1F4E8C] bg-white text-[#1F4E8C] hover:bg-[#EFF6FF]"
              }`}
              aria-expanded={showSensorImportanceRanking}
            >
              {showSensorImportanceRanking ? "Hide Sensor Importance Ranking" : "Show Sensor Importance Ranking"}
            </button>
          </div>

          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              showSensorImportanceRanking ? "mt-5 max-h-[560px] opacity-100" : "mt-0 max-h-0 opacity-0"
            }`}
          >
          {pcaSensorImportance.length > 0 ? (
            <div className="space-y-3">
              {pcaSensorImportance.map((item) => (
                <div key={`importance-${item.sensor}`} className="grid gap-2 rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3 sm:grid-cols-[160px_1fr_56px] sm:items-center">
                  <p className="font-semibold text-[#0F172A]">
                    {correlationSensorLabelByKey[item.sensor]}
                  </p>
                  <div className="h-2.5 overflow-hidden rounded-full bg-[#E2E8F0]">
                    <div
                      className="h-full rounded-full bg-[#1F4E8C]"
                      style={{ width: `${item.scorePercent}%` }}
                    />
                  </div>
                  <p className="text-right font-mono text-sm font-semibold text-[#1F4E8C]">
                    {item.scorePercent}%
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-4 text-sm font-medium text-[#475569]">
              Sensor importance ranking requires a valid PCA result.
            </div>
          )}
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2">
                <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">
                  Correlation Heatmap
                </p>
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#D8E0EA] bg-[#F8FAFC] text-[11px] font-bold text-[#607D8B]"
                  title={`Bucket size: ${correlationHeatmapData.bucketSizeLabel}`}
                  aria-label={`Bucket size: ${correlationHeatmapData.bucketSizeLabel}`}
                >
                  i
                </span>
              </div>
              <p className="mt-2 text-sm text-[#475569]">
                The heatmap provides an immediate visual summary of relationships between all sensors.
                It complements the correlation table by making patterns easier to recognize.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowCorrelationHeatmap((previous) => !previous)}
              className={`inline-flex shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-blue-100 focus:ring-offset-2 ${
                showCorrelationHeatmap
                  ? "border-[#1F4E8C] bg-[#1F4E8C] text-white hover:bg-[#173B69]"
                  : "border-[#1F4E8C] bg-white text-[#1F4E8C] hover:bg-[#EFF6FF]"
              }`}
              aria-expanded={showCorrelationHeatmap}
            >
              {showCorrelationHeatmap ? "Hide Correlation Heatmap" : "Show Correlation Heatmap"}
            </button>
          </div>

          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              showCorrelationHeatmap ? "mt-5 max-h-[760px] opacity-100" : "mt-0 max-h-0 opacity-0"
            }`}
          >
            {correlationHeatmapData.sensors.length < 2 ? (
              <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-4 text-sm font-medium text-[#475569]">
                Not enough data to generate heatmap.
              </div>
            ) : (
              <div className="space-y-5">
                <div className="overflow-x-auto rounded-lg border border-[#D8E0EA]">
                  <div
                    className="grid min-w-[540px] gap-px bg-[#D8E0EA] text-xs"
                    style={{
                      gridTemplateColumns: `minmax(92px, 0.9fr) repeat(${correlationHeatmapData.sensors.length}, minmax(78px, 1fr))`,
                    }}
                  >
                    <div className="bg-[#F8FAFC] px-3 py-2 font-semibold text-[#475569]" />
                    {correlationHeatmapData.sensors.map((sensorKey) => (
                      <div
                        key={`heatmap-column-${sensorKey}`}
                        className="bg-[#F8FAFC] px-3 py-2 text-center font-semibold text-[#475569]"
                      >
                        {correlationSensorLabelByKey[sensorKey]}
                      </div>
                    ))}

                    {correlationHeatmapData.sensors.map((rowKey) => (
                      <div key={`heatmap-row-${rowKey}`} className="contents">
                        <div className="bg-[#F8FAFC] px-3 py-4 font-semibold text-[#475569]">
                          {correlationSensorLabelByKey[rowKey]}
                        </div>
                        {correlationHeatmapData.sensors.map((columnKey) => {
                          const cell = correlationHeatmapData.cells.find(
                            (item) => item.row === rowKey && item.column === columnKey,
                          );
                          const value = cell?.value ?? null;
                          const isStrong = value !== null && Math.abs(value) >= 0.75;
                          const displayValue =
                            rowKey === columnKey
                              ? "1.00"
                              : value === null
                                ? "N/A"
                                : formatSignedCorrelation(value);
                          const tooltipValue =
                            value === null ? "N/A" : rowKey === columnKey ? "1.00" : formatSignedCorrelation(value);

                          return (
                            <div
                              key={`heatmap-cell-${rowKey}-${columnKey}`}
                              className={`flex min-h-14 items-center justify-center px-2 py-3 text-center font-mono text-sm font-semibold tabular-nums transition-transform duration-150 hover:relative hover:z-10 hover:scale-[1.03] hover:ring-2 hover:ring-[#1F4E8C]/30 ${
                                isStrong ? "text-white" : "text-[#0F172A]"
                              }`}
                              style={{
                                backgroundColor:
                                  value === null ? "rgb(248, 250, 252)" : getCorrelationHeatmapColor(value),
                              }}
                              title={`${correlationSensorLabelByKey[rowKey]} ↔ ${correlationSensorLabelByKey[columnKey]}\nCorrelation = ${tooltipValue}\nObservations used = ${cell?.observations ?? 0}`}
                            >
                              {displayValue}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2 text-xs text-[#475569] sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#475569]">Strong Negative</span>
                    <span>{"<-"}</span>
                    <span>Blue</span>
                  </div>
                  <div className="h-2 min-w-36 rounded-full bg-gradient-to-r from-blue-800 via-white to-red-700 ring-1 ring-[#D8E0EA]" />
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#475569]">No Correlation</span>
                    <span>{"<-"}</span>
                    <span>White</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#475569]">Strong Positive</span>
                    <span>{"<-"}</span>
                    <span>Red</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <div className="max-w-3xl">
            <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">
              Research Methods Used
            </p>
            <p className="mt-2 text-sm text-[#475569]">
              Scientific methods applied to the selected telemetry and decision-support outputs.
            </p>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {[
              {
                title: "Descriptive Statistics",
                description:
                  "Min, Max, Average and Sample Count are calculated from the currently selected sensor and time window.",
                icon: BarChart3,
              },
              {
                title: "Time Series Analysis",
                description:
                  "Sensor behavior is analyzed over time to identify trends and changes.",
                icon: Clock3,
              },
              {
                title: "Trend Detection",
                description:
                  "Sensors are classified as Rising, Falling or Stable using recent observations.",
                icon: TrendingUp,
              },
              {
                title: "Anomaly Detection",
                description:
                  "Sudden jumps between consecutive readings are automatically detected and ranked.",
                icon: ScanSearch,
              },
              {
                title: "Decision Support",
                description:
                  "Robot Health Score and Recommended Action summarize system status.",
                icon: ClipboardCheck,
              },
            ].map((method) => {
              const Icon = method.icon;

              return (
                <article
                  key={method.title}
                  className="rounded-lg border border-[#D8E0EA] bg-white p-5"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#D8E0EA] bg-[#F8FAFC]">
                    <Icon className="h-4 w-4 text-[#1F4E8C]" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-[#0F172A]">
                    {method.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#475569]">
                    {method.description}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-[#D8E0EA] bg-white p-6">
          <p className="text-[15px] font-semibold uppercase tracking-wide text-[#1F4E8C]">Recommended Action</p>
          <p className="mt-3 text-xl font-semibold text-[#0F172A]">{engineeringDecision.recommendation}</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#607D8B]">Priority</p>
              <span
                className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-bold ${
                  recommendedPriority === "HIGH"
                    ? "border-[#F0B4B4] bg-[#FDECEC] text-[#C62828]"
                    : recommendedPriority === "MEDIUM"
                      ? "border-[#F9D66B] bg-[#FFF8E1] text-[#B45309]"
                      : "border-[#A5D6A7] bg-[#F1F8E9] text-[#2E7D32]"
                }`}
              >
                {recommendedPriority}
              </span>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#607D8B]">Confidence</p>
              <p className="mt-2 text-lg font-bold text-[#1F4E8C]">{aiAnalysis.confidence}%</p>
            </div>
            <div className="rounded-lg border border-[#D8E0EA] bg-[#F8FAFC] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#607D8B]">Estimated Impact</p>
              <span className="mt-2 inline-flex rounded-full border border-[#BBD4F0] bg-[#EFF6FF] px-3 py-1 text-xs font-bold text-[#1F4E8C]">
                {recommendedImpact}
              </span>
            </div>
          </div>
        </section>
        <footer className="pb-2 pt-1 text-center text-xs leading-6 text-[#607D8B]">
          <p className="font-semibold text-[#475569]">Robot Engineering Decision Support Dashboard</p>
          <p>Research Prototype · Version 1.0 · 2026</p>
        </footer>
      </div>
    </main>
  );
}
