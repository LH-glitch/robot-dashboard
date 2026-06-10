"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Gauge,
  Thermometer,
  Waves,
  Ruler,
  Activity,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
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

type ChartType = "line" | "area" | "bar" | "scatter" | "step";
type TimeUnit = "seconds" | "minutes" | "hours" | "days" | "all";
type BehaviorScore = "Stable" | "Cautious" | "Warning" | "Critical";
type DataSource = "demo" | "local" | null;
type ComparisonSensorKey = "temperature" | "humidity" | "pressure" | "distance" | "accel";
type ComparisonScaleMode = "raw" | "normalized";
type ComparisonPoint = { timeMs: number } & Partial<Record<ComparisonSensorKey, number>>;

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
    color: "#f59e0b",
  },
  {
    key: "humidity",
    label: "Humidity",
    aliases: ["humidity"],
    unit: "%",
    color: "#38bdf8",
  },
  {
    key: "pressure",
    label: "Pressure",
    aliases: ["pressure"],
    unit: "hPa",
    color: "#c084fc",
    dasharray: "5 3",
  },
  {
    key: "distance",
    label: "Distance",
    aliases: ["distance"],
    unit: "cm",
    color: "#34d399",
  },
  {
    key: "accel",
    label: "Accel",
    aliases: ["accel", "acceleration"],
    unit: "m/s²",
    color: "#f87171",
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
  const [selectedChartType, setSelectedChartType] = useState<ChartType>("line");
  const [timeAmount, setTimeAmount] = useState<string>("10");
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("minutes");
  const [selectedComparisonSensors, setSelectedComparisonSensors] = useState<ComparisonSensorKey[]>([
    "temperature",
    "humidity",
  ]);
  const [comparisonScaleMode, setComparisonScaleMode] = useState<ComparisonScaleMode>("raw");
  const [anomalySeverityFilter, setAnomalySeverityFilter] = useState<AnomalySeverityFilter>("All");
  const [hoveredHeatmapCell, setHoveredHeatmapCell] = useState<HeatmapHoverInfo | null>(null);

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
  }, [selectedSeries, selectedChartType]);

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

  const metricCards = [
    {
      title: "Temperature",
      value: latestTemperature,
      unit: "°C",
      icon: Thermometer,
    },
    {
      title: "Humidity",
      value: latestHumidity,
      unit: "%",
      icon: Waves,
    },
    {
      title: "Pressure",
      value: latestPressure,
      unit: "hPa",
      icon: Gauge,
    },
    {
      title: "Distance",
      value: latestDistance,
      unit: "cm",
      icon: Ruler,
    },
    {
      title: "Accel",
      value: latestAccel,
      unit: "m/s²",
      icon: Activity,
    },
  ];

  const chartTypes: Array<{ key: ChartType; label: string }> = [
    { key: "line", label: "Line Chart" },
    { key: "area", label: "Area Chart" },
    { key: "bar", label: "Bar Chart" },
    { key: "scatter", label: "Scatter Chart" },
    { key: "step", label: "Step Line Chart" },
  ];

  const selectedTimeWindowLabel =
    timeUnit === "all" ? "All available data" : `${timeAmount || "-"} ${timeUnit}`;

  const highestSeverityWarning = useMemo(() => {
    const rank: Record<SuddenJump["severity"], number> = {
      High: 3,
      Medium: 2,
      Low: 1,
    };

    return [...suddenJumps].sort((a, b) => {
      if (rank[b.severity] !== rank[a.severity]) {
        return rank[b.severity] - rank[a.severity];
      }
      return b.percentageJump - a.percentageJump;
    })[0] ?? null;
  }, [suddenJumps]);

  const renderComparisonTooltip = (props: { active?: boolean; label?: string | number }) => {
    if (!props.active) {
      return null;
    }

    const timeMs =
      typeof props.label === "number"
        ? props.label
        : typeof props.label === "string"
          ? Number(props.label)
          : NaN;

    if (!Number.isFinite(timeMs)) {
      return null;
    }

    const pointAtTimestamp = comparisonChartData.find((point) => point.timeMs === timeMs);

    return (
      <div className="rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200">
        <p className="mb-2 border-b border-slate-800 pb-1 text-slate-400">
          {formatTickLabel(timeMs, timeUnit)}
        </p>
        <div className="space-y-1.5">
          {selectedComparisonDefinitions.map((sensorDef) => {
            const rawValue = pointAtTimestamp?.[sensorDef.key];
            const displayValue =
              typeof rawValue === "number"
                ? `${rawValue.toFixed(2)} ${comparisonScaleMode === "normalized" ? "%" : sensorDef.unit}`
                : "--";

            return (
              <div key={sensorDef.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-slate-300">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: sensorDef.color }} />
                  {sensorDef.label}
                </span>
                <span className="font-mono text-slate-100">{displayValue}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const getCorrelationCellClassName = (coefficient: number | null): string => {
    if (coefficient === null) {
      return "bg-slate-950/70 text-slate-500";
    }

    if (coefficient >= 0.7) {
      return "bg-emerald-500/20 text-emerald-200";
    }

    if (coefficient <= -0.7) {
      return "bg-red-500/20 text-red-200";
    }

    if (Math.abs(coefficient) <= 0.2) {
      return "bg-slate-700/50 text-slate-200";
    }

    return coefficient > 0 ? "bg-emerald-500/10 text-emerald-100" : "bg-red-500/10 text-red-100";
  };

  const formatCorrelationPair = (pair: CorrelationPairSummary | null): string => {
    if (!pair) {
      return "No statistically valid pair in current time window.";
    }

    return `${correlationSensorLabelByKey[pair.left]} and ${correlationSensorLabelByKey[pair.right]} (${pair.coefficient.toFixed(2)}, n=${pair.sampleCount})`;
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Robot Telemetry Research Dashboard
          </h1>
          <p className="mt-2 text-sm text-slate-400 sm:text-base">
            Real-time and historical analysis of robot sensor data
          </p>

          {dataLoadMessage && (
            <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              {dataLoadMessage}
            </div>
          )}

          {dataSource === "demo" && !dataLoadMessage && (
            <div className="mt-4 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
              Showing sanitized demo telemetry data.
            </div>
          )}

          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-500">Total Records</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{records.length}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-500">Active Sensors</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{sensorOptions.length}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-500">Selected Time Window</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{selectedTimeWindowLabel}</p>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">AI Robot Behavior Analyzer</h2>
                <p className="text-xs text-slate-500">Local model-free reasoning from telemetry patterns</p>
              </div>
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                  aiAnalysis.score === "Critical"
                    ? "border-red-500/40 bg-red-500/10 text-red-200"
                    : aiAnalysis.score === "Warning"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                      : aiAnalysis.score === "Cautious"
                        ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-200"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    aiAnalysis.score === "Critical"
                      ? "bg-red-400"
                      : aiAnalysis.score === "Warning"
                        ? "bg-amber-300"
                        : aiAnalysis.score === "Cautious"
                          ? "bg-yellow-300"
                          : "bg-emerald-300"
                  }`}
                />
                {aiAnalysis.score}
              </span>
            </div>

            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">System Confidence</p>
                <p className="mt-1 text-xl font-semibold text-slate-100">{aiAnalysis.confidence}%</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Warnings Detected</p>
                <p className="mt-1 text-xl font-semibold text-slate-100">{aiAnalysis.totalWarnings}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Window Sensor Points</p>
                <p className="mt-1 text-xl font-semibold text-slate-100">{windowedNumericRecords.length}</p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <p className="mb-2 text-sm font-medium text-slate-200">Generated Insights</p>
              <ul className="space-y-1.5 text-sm text-slate-300">
                {aiAnalysis.insights.map((insight, index) => (
                  <li key={`${insight}-${index}`} className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-sky-400" />
                    <span>{insight}</span>
                  </li>
                ))}
              </ul>
            </div>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-lg font-semibold text-slate-100">Warning Summary</h2>
            <p className="mt-1 text-xs text-slate-500">Highest severity event in selected time window</p>

            {highestSeverityWarning ? (
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold capitalize text-slate-200">
                    {highestSeverityWarning.sensor}
                  </p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      highestSeverityWarning.severity === "High"
                        ? "bg-red-500/20 text-red-300"
                        : highestSeverityWarning.severity === "Medium"
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {highestSeverityWarning.severity}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-400">Time: {highestSeverityWarning.time}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Change: {highestSeverityWarning.percentageJump.toFixed(1)}% (±
                  {highestSeverityWarning.absoluteJump.toFixed(2)})
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-500">No warnings in the selected time window.</p>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                <p className="uppercase tracking-wide text-slate-500">Total Listed Warnings</p>
                <p className="mt-1 text-sm font-semibold text-slate-200">{suddenJumps.length}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                <p className="uppercase tracking-wide text-slate-500">Current Behavior</p>
                <p className="mt-1 text-sm font-semibold text-slate-200">{aiAnalysis.score}</p>
              </div>
            </div>
          </article>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-slate-100">Latest Sensor Overview</h2>
            <p className="text-xs text-slate-500">Most recent numeric readings per key telemetry channel</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {metricCards.map((card) => {
              const Icon = card.icon;
              return (
                <article
                  key={card.title}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-400">{card.title}</p>
                    <Icon className="h-4 w-4 text-slate-500" />
                  </div>
                  <p className="mt-2 text-2xl font-semibold text-slate-100">
                    {card.value === null ? "N/A" : `${card.value.toFixed(2)} ${card.unit}`}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Main Analysis</h2>
            <p className="text-xs text-slate-500">Sensor-specific trend analysis with configurable chart methodology</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 lg:col-span-3">
              <div className="mb-4 space-y-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-base font-medium text-slate-200">Sensor Trend</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={selectedSensor}
                      onChange={(event) => setSelectedSensor(event.target.value)}
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
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
                      className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
                      placeholder="Amount"
                      aria-label="Time amount"
                    />

                    <select
                      value={timeUnit}
                      onChange={(event) => setTimeUnit(event.target.value as TimeUnit)}
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
                      aria-label="Time unit"
                    >
                      <option value="seconds">seconds</option>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                      <option value="all">all</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {chartTypes.map((chartType) => {
                    const isActive = selectedChartType === chartType.key;
                    return (
                      <button
                        key={chartType.key}
                        type="button"
                        onClick={() => setSelectedChartType(chartType.key)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                          isActive
                            ? "border-sky-500/60 bg-sky-500/10 text-sky-200"
                            : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
                        }`}
                      >
                        {chartType.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">
                Sensor = {selectedSensor}&nbsp;&nbsp;|&nbsp;&nbsp;Points = {selectedSeries.length}&nbsp;&nbsp;|&nbsp;&nbsp;Time Range = {timeUnit === "all" ? "all" : `${timeAmount} ${timeUnit}`}
                {selectedSeries.length > 0 && (
                  <>
                    &nbsp;&nbsp;|&nbsp;&nbsp;First Point = {formatTickLabel(selectedSeries[0].timeMs, "days")}
                    &nbsp;&nbsp;|&nbsp;&nbsp;Last Point = {formatTickLabel(selectedSeries[selectedSeries.length - 1].timeMs, "days")}
                  </>
                )}
              </div>

              <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  {selectedChartType === "line" && (
                    <LineChart data={selectedSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis
                        dataKey="timeMs"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        tickCount={xAxisTickCount}
                        tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        minTickGap={40}
                      />
                      <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} width={50} />
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
                        contentStyle={{
                          backgroundColor: "#020617",
                          border: "1px solid #334155",
                          borderRadius: "0.5rem",
                          color: "#e2e8f0",
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#34d399"
                        strokeWidth={2.2}
                        dot={false}
                        activeDot={{ r: 4 }}
                        isAnimationActive
                      />
                    </LineChart>
                  )}

                  {selectedChartType === "area" && (
                    <AreaChart data={selectedSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis
                        dataKey="timeMs"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        tickCount={xAxisTickCount}
                        tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        minTickGap={40}
                      />
                      <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} width={50} />
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
                        contentStyle={{
                          backgroundColor: "#020617",
                          border: "1px solid #334155",
                          borderRadius: "0.5rem",
                          color: "#e2e8f0",
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#34d399"
                        fill="#34d399"
                        fillOpacity={0.2}
                        strokeWidth={2}
                        isAnimationActive
                      />
                    </AreaChart>
                  )}

                  {selectedChartType === "bar" && (
                    <BarChart data={selectedSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis
                        dataKey="timeMs"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        tickCount={xAxisTickCount}
                        tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        minTickGap={40}
                      />
                      <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} width={50} />
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
                        contentStyle={{
                          backgroundColor: "#020617",
                          border: "1px solid #334155",
                          borderRadius: "0.5rem",
                          color: "#e2e8f0",
                        }}
                      />
                      <Bar dataKey="value" fill="#34d399" radius={[4, 4, 0, 0]} isAnimationActive />
                    </BarChart>
                  )}

                  {selectedChartType === "scatter" && (
                    <ScatterChart data={selectedSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis
                        dataKey="timeMs"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        tickCount={xAxisTickCount}
                        tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        minTickGap={40}
                      />
                      <YAxis dataKey="value" tick={{ fill: "#94a3b8", fontSize: 11 }} width={50} />
                      <Tooltip
                        cursor={{ strokeDasharray: "3 3", stroke: "#64748b" }}
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
                        contentStyle={{
                          backgroundColor: "#020617",
                          border: "1px solid #334155",
                          borderRadius: "0.5rem",
                          color: "#e2e8f0",
                        }}
                      />
                      <Scatter data={selectedSeries} dataKey="value" fill="#34d399" />
                    </ScatterChart>
                  )}

                  {selectedChartType === "step" && (
                    <LineChart data={selectedSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis
                        dataKey="timeMs"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        tickCount={xAxisTickCount}
                        tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        minTickGap={40}
                      />
                      <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} width={50} />
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
                        contentStyle={{
                          backgroundColor: "#020617",
                          border: "1px solid #334155",
                          borderRadius: "0.5rem",
                          color: "#e2e8f0",
                        }}
                      />
                      <Line
                        type="stepAfter"
                        dataKey="value"
                        stroke="#34d399"
                        strokeWidth={2.2}
                        dot={false}
                        activeDot={{ r: 4 }}
                        isAnimationActive
                      />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </div>
            </article>

            <aside className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <h3 className="text-base font-medium text-slate-200">Current Chart Statistics</h3>
              <p className="mt-1 text-xs text-slate-500">Computed from visible points in the active chart window</p>

              <div className="mt-3 space-y-2">
                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Min</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    {chartStats.min === null ? "No data" : chartStats.min.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Max</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    {chartStats.max === null ? "No data" : chartStats.max.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Average</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    {chartStats.avg === null ? "No data" : chartStats.avg.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Points</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    {chartStats.points === 0 ? "No data" : chartStats.points}
                  </p>
                </div>
              </div>
            </aside>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Multi-Sensor Comparison</h2>
            <p className="text-xs text-slate-500">
              Comparative trend inspection across selected sensors using the active time window filter
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 lg:col-span-3">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-base font-medium text-slate-200">Sensor Trend Overlay</h3>

                <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-1">
                  <button
                    type="button"
                    onClick={() => setComparisonScaleMode("raw")}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                      comparisonScaleMode === "raw"
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-300 hover:text-slate-100"
                    }`}
                  >
                    Raw Values
                  </button>
                  <button
                    type="button"
                    onClick={() => setComparisonScaleMode("normalized")}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                      comparisonScaleMode === "normalized"
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-300 hover:text-slate-100"
                    }`}
                  >
                    Normalized 0-100
                  </button>
                </div>
              </div>

              <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">
                Selected Sensors = {selectedComparisonSensors.length}&nbsp;&nbsp;|&nbsp;&nbsp;Points = {comparisonChartData.length}&nbsp;&nbsp;|&nbsp;&nbsp;Scale = {comparisonScaleMode === "raw" ? "raw" : "normalized_0_100"}&nbsp;&nbsp;|&nbsp;&nbsp;Time Range = {timeUnit === "all" ? "all" : `${timeAmount} ${timeUnit}`}
              </div>

              <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparisonChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis
                      dataKey="timeMs"
                      type="number"
                      scale="time"
                      domain={["dataMin", "dataMax"]}
                      tickCount={comparisonXAxisTickCount}
                      tickFormatter={(v: number) => formatTickLabel(v, timeUnit)}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      minTickGap={40}
                    />
                    <YAxis
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      width={comparisonScaleMode === "normalized" ? 60 : 70}
                      domain={comparisonScaleMode === "normalized" ? [0, 100] : ["auto", "auto"]}
                    />
                    <Tooltip
                      filterNull={false}
                      content={renderComparisonTooltip}
                    />
                    <Legend
                      verticalAlign="top"
                      align="right"
                      wrapperStyle={{ color: "#cbd5e1", fontSize: "12px" }}
                    />
                    {selectedComparisonDefinitions.map((sensorDef) => (
                      <Line
                        key={sensorDef.key}
                        type="monotone"
                        dataKey={sensorDef.key}
                        name={sensorDef.label}
                        stroke={sensorDef.color}
                        strokeWidth={2.2}
                        strokeDasharray={sensorDef.dasharray}
                        dot={false}
                        activeDot={{ r: 4 }}
                        connectNulls
                        isAnimationActive
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>

            <aside className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <h3 className="text-base font-medium text-slate-200">Comparison Controls</h3>
              <p className="mt-1 text-xs text-slate-500">
                Select one or more sensors to overlay on the shared timeline
              </p>

              <div className="mt-3 space-y-2">
                {COMPARISON_SENSOR_DEFINITIONS.map((sensorDef) => {
                  const isAvailable = availableComparisonSensorKeys.includes(sensorDef.key);
                  const isChecked = selectedComparisonSensors.includes(sensorDef.key);

                  return (
                    <label
                      key={sensorDef.key}
                      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                        isAvailable
                          ? "border-slate-800 bg-slate-950 text-slate-200"
                          : "border-slate-800/70 bg-slate-950/40 text-slate-500"
                      }`}
                    >
                      <span className="mr-3 flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: sensorDef.color }}
                        />
                        {sensorDef.label}
                      </span>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!isAvailable}
                        onChange={() => toggleComparisonSensor(sensorDef.key)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                        aria-label={`Toggle ${sensorDef.label}`}
                      />
                    </label>
                  );
                })}
              </div>

              <p className="mt-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-[11px] text-slate-500">
                Sensors without numeric observations in the selected dataset are shown but unavailable.
              </p>
            </aside>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Sensor Correlation Analysis</h2>
            <p className="text-xs text-slate-500">
              Pearson correlation matrix computed from the active time window across numeric sensors
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Coefficient reference: +1 strong positive relationship, 0 no linear relationship, -1 strong negative relationship.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 lg:col-span-2">
              <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">
                Time Range = {timeUnit === "all" ? "all" : `${timeAmount} ${timeUnit}`}&nbsp;&nbsp;|&nbsp;&nbsp;Window Points = {windowedNumericRecords.length}
              </div>

              <div className="mb-4 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-amber-100">Correlation Debug Panel (Temporary)</h3>
                  <span className="rounded-full border border-amber-400/35 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-100">
                    diagnostics
                  </span>
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/70">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-950/80 text-left text-slate-400">
                        <tr className="border-b border-slate-800">
                          <th className="px-3 py-2 font-medium">Sensor</th>
                          <th className="px-3 py-2 font-medium">Total Samples</th>
                          <th className="px-3 py-2 font-medium">First Timestamp</th>
                          <th className="px-3 py-2 font-medium">Last Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {correlationAnalysis.sensorDebugRows.map((row) => (
                          <tr key={`sensor-debug-${row.key}`} className="border-b border-slate-800/70">
                            <td className="whitespace-nowrap px-3 py-2 text-slate-200">
                              {correlationSensorLabelByKey[row.key]}
                            </td>
                            <td className="px-3 py-2 text-slate-300">{row.totalSamples}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                              {row.firstTimestampMs === null
                                ? "N/A"
                                : new Date(row.firstTimestampMs).toLocaleString()}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                              {row.lastTimestampMs === null
                                ? "N/A"
                                : new Date(row.lastTimestampMs).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/70">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-950/80 text-left text-slate-400">
                        <tr className="border-b border-slate-800">
                          <th className="px-3 py-2 font-medium">Sensor Pair</th>
                          <th className="px-3 py-2 font-medium">Paired n</th>
                          <th className="px-3 py-2 font-medium">Avg Δ (s)</th>
                          <th className="px-3 py-2 font-medium">Max Δ (s)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {correlationAnalysis.pairDebugRows.map((row) => (
                          <tr key={`pair-debug-${row.left}-${row.right}`} className="border-b border-slate-800/70">
                            <td className="whitespace-nowrap px-3 py-2 text-slate-200">
                              {correlationSensorLabelByKey[row.left]} vs {correlationSensorLabelByKey[row.right]}
                            </td>
                            <td className="px-3 py-2 text-slate-300">{row.pairedSampleCount}</td>
                            <td className="px-3 py-2 text-slate-400">
                              {row.averageAlignmentDeltaSeconds === null
                                ? "N/A"
                                : row.averageAlignmentDeltaSeconds.toFixed(2)}
                            </td>
                            <td className="px-3 py-2 text-slate-400">
                              {row.maximumAlignmentDeltaSeconds === null
                                ? "N/A"
                                : row.maximumAlignmentDeltaSeconds.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-950/80 text-left text-slate-400">
                    <tr className="border-b border-slate-800">
                      <th className="px-3 py-2 font-medium">Sensor</th>
                      {correlationAnalysis.keys.map((columnKey) => (
                        <th key={columnKey} className="px-3 py-2 text-center font-medium">
                          {correlationSensorLabelByKey[columnKey]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {correlationAnalysis.keys.map((rowKey) => (
                      <tr key={rowKey} className="border-b border-slate-800/70">
                        <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-200">
                          {correlationSensorLabelByKey[rowKey]}
                        </td>
                        {correlationAnalysis.keys.map((columnKey) => {
                          const coefficient = correlationAnalysis.coefficientMatrix[rowKey][columnKey];
                          const sampleCount = correlationAnalysis.sampleMatrix[rowKey][columnKey];

                          return (
                            <td key={`${rowKey}-${columnKey}`} className="px-2 py-2">
                              <div
                                className={`rounded-md border border-slate-800 px-2 py-1 text-center text-xs font-medium ${getCorrelationCellClassName(coefficient)}`}
                              >
                                <p className="font-semibold">
                                  {coefficient === null ? "N/A" : coefficient.toFixed(2)}
                                </p>
                                <p className="text-[10px] opacity-80">n={sampleCount}</p>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-emerald-200">
                  strong positive
                </span>
                <span className="rounded-full border border-slate-500/40 bg-slate-700/40 px-2 py-0.5 text-slate-200">
                  near zero
                </span>
                <span className="rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-red-200">
                  strong negative
                </span>
              </div>
            </article>

            <aside className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <h3 className="text-base font-medium text-slate-200">Interpretation Panel</h3>
              <p className="mt-1 text-xs text-slate-500">
                Relationship summaries derived from coefficient magnitude and direction
              </p>

              <div className="mt-3 space-y-2">
                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Strongest Positive Pair</p>
                  <p className="mt-1 text-sm text-slate-200">
                    {formatCorrelationPair(correlationAnalysis.strongestPositivePair)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Strongest Negative Pair</p>
                  <p className="mt-1 text-sm text-slate-200">
                    {formatCorrelationPair(correlationAnalysis.strongestNegativePair)}
                  </p>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Interpretations</p>
                {correlationAnalysis.interpretations.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Not enough paired samples to infer sensor relationships in this time window.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm text-slate-300">
                    {correlationAnalysis.interpretations.map((text, index) => (
                      <li key={`${text}-${index}`} className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-slate-400" />
                        <span>{text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Sensor Heatmap Analysis</h2>
            <p className="text-xs text-slate-500">
              Heatmaps help researchers identify patterns, clusters, and abnormal behavior across multiple sensors over time.
            </p>
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Total Sensors</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{heatmapAnalysis.sensorRows.length}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Total Buckets</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{heatmapAnalysis.bucketCount}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Total Samples Used</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{heatmapAnalysis.totalSamplesUsed}</p>
            </div>
          </div>

          <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">
            Time Range = {selectedTimeWindowLabel}&nbsp;&nbsp;|&nbsp;&nbsp;Heatmap Mode = per_sensor_normalized
          </div>

          {heatmapAnalysis.bucketCount === 0 ? (
            <p className="text-sm text-slate-500">No numeric telemetry available for heatmap generation.</p>
          ) : (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="min-w-[900px] space-y-2">
                  {heatmapAnalysis.sensorRows.map((row) => (
                    <div key={row.key} className="grid items-center gap-2" style={{ gridTemplateColumns: `11rem repeat(${heatmapAnalysis.bucketCount}, minmax(0, 1fr))` }}>
                      <div className="pr-2 text-xs font-medium text-slate-300">{row.label}</div>
                      {heatmapAnalysis.cellsBySensor[row.key].map((cell) => {
                        const bucketLabel =
                          `${formatTickLabel(cell.bucketStartMs, timeUnit)} - ${formatTickLabel(cell.bucketEndMs, timeUnit)}`;
                        return (
                          <button
                            key={`${row.key}-${cell.bucketIndex}`}
                            type="button"
                            className="h-7 rounded-sm border border-slate-900/70 transition hover:scale-[1.02]"
                            style={{ backgroundColor: heatmapColorFromNormalized(cell.normalizedValue) }}
                            title={`Sensor: ${row.label}\nTime bucket: ${bucketLabel}\nAverage: ${cell.averageValue === null ? "N/A" : cell.averageValue.toFixed(2)}\nSamples: ${cell.sampleCount}`}
                            onMouseEnter={() =>
                              setHoveredHeatmapCell({
                                sensorLabel: row.label,
                                bucketLabel,
                                averageValue: cell.averageValue,
                                sampleCount: cell.sampleCount,
                              })
                            }
                            onFocus={() =>
                              setHoveredHeatmapCell({
                                sensorLabel: row.label,
                                bucketLabel,
                                averageValue: cell.averageValue,
                                sampleCount: cell.sampleCount,
                              })
                            }
                            onMouseLeave={() => setHoveredHeatmapCell(null)}
                            onBlur={() => setHoveredHeatmapCell(null)}
                            aria-label={`${row.label} ${bucketLabel} average ${cell.averageValue === null ? "N/A" : cell.averageValue.toFixed(2)} samples ${cell.sampleCount}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span>Low</span>
                  <div className="h-3 w-48 rounded-full" style={{ background: "linear-gradient(90deg, rgb(13, 42, 148) 0%, rgb(34, 211, 238) 50%, rgb(250, 204, 21) 100%)" }} />
                  <span>Medium</span>
                  <span>High</span>
                </div>

                <div className="text-xs text-slate-400">
                  {hoveredHeatmapCell ? (
                    <div className="space-y-0.5 text-right">
                      <p>Sensor: <span className="text-slate-200">{hoveredHeatmapCell.sensorLabel}</span></p>
                      <p>Time Bucket: <span className="text-slate-200">{hoveredHeatmapCell.bucketLabel}</span></p>
                      <p>Average Value: <span className="text-slate-200">{hoveredHeatmapCell.averageValue === null ? "N/A" : hoveredHeatmapCell.averageValue.toFixed(2)}</span></p>
                      <p>Sample Count: <span className="text-slate-200">{hoveredHeatmapCell.sampleCount}</span></p>
                    </div>
                  ) : (
                    <p>Hover a heatmap cell to view bucket details.</p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Automatic Insights</p>
                {heatmapAnalysis.insights.length === 0 ? (
                  <p className="text-sm text-slate-500">Insufficient variation to generate heatmap insights for this time window.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm text-slate-300">
                    {heatmapAnalysis.insights.map((insight, index) => (
                      <li key={`${insight}-${index}`} className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-cyan-300" />
                        <span>{insight}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Anomaly Timeline</h2>
            <p className="text-xs text-slate-500">
              Chronological event log of sudden telemetry jumps across all numeric sensors
            </p>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            {(["All", "High", "Medium", "Low"] as AnomalySeverityFilter[]).map((filterKey) => {
              const isActive = anomalySeverityFilter === filterKey;
              return (
                <button
                  key={filterKey}
                  type="button"
                  onClick={() => setAnomalySeverityFilter(filterKey)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                    isActive
                      ? filterKey === "High"
                        ? "border-red-500/60 bg-red-500/15 text-red-200"
                        : filterKey === "Medium"
                          ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                          : filterKey === "Low"
                            ? "border-slate-500/60 bg-slate-700/40 text-slate-200"
                            : "border-sky-500/60 bg-sky-500/10 text-sky-200"
                      : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {filterKey}
                </button>
              );
            })}
          </div>

          <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">
            Severity Filter = {anomalySeverityFilter}&nbsp;&nbsp;|&nbsp;&nbsp;Events Shown = {anomalyTimelineEvents.length}&nbsp;&nbsp;|&nbsp;&nbsp;Order = newest_to_oldest
          </div>

          {anomalyTimelineEvents.length === 0 ? (
            <p className="text-sm text-slate-500">No anomaly events found for the selected severity filter.</p>
          ) : (
            <div className="space-y-0">
              {anomalyTimelineEvents.map((event, index) => {
                const isLast = index === anomalyTimelineEvents.length - 1;
                const severityColorClass =
                  event.severity === "High"
                    ? "bg-red-400"
                    : event.severity === "Medium"
                      ? "bg-amber-300"
                      : "bg-slate-300";

                const severityBadgeClass =
                  event.severity === "High"
                    ? "bg-red-500/20 text-red-300"
                    : event.severity === "Medium"
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-slate-700 text-slate-300";

                return (
                  <article key={`${event.sensor}-${event.time}-${index}`} className="relative pl-10">
                    {!isLast && <span className="absolute left-[0.8rem] top-6 h-[calc(100%-0.25rem)] w-px bg-slate-700" />}
                    <span className={`absolute left-0 top-5 h-3 w-3 rounded-full border border-slate-900 ${severityColorClass}`} />

                    <div className="mb-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium capitalize text-slate-200">{event.sensor}</p>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${severityBadgeClass}`}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {event.severity}
                        </span>
                      </div>

                      <p className="mt-1 text-xs text-slate-400">{new Date(event.timeMs).toLocaleString()}</p>

                      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
                        <div className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-slate-300">
                          <p className="uppercase tracking-wide text-slate-500">Previous</p>
                          <p className="mt-1 font-mono text-slate-200">{event.prevValue.toFixed(2)}</p>
                        </div>
                        <div className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-slate-300">
                          <p className="uppercase tracking-wide text-slate-500">Current</p>
                          <p className="mt-1 font-mono text-slate-200">{event.currValue.toFixed(2)}</p>
                        </div>
                        <div className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-slate-300">
                          <p className="uppercase tracking-wide text-slate-500">Abs. Jump</p>
                          <p className="mt-1 font-mono text-slate-200">{event.absoluteJump.toFixed(2)}</p>
                        </div>
                        <div className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-slate-300">
                          <p className="uppercase tracking-wide text-slate-500">% Jump</p>
                          <p className="mt-1 font-mono text-slate-200">{event.percentageJump.toFixed(1)}%</p>
                        </div>
                        <div className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-slate-300">
                          <p className="uppercase tracking-wide text-slate-500">Timestamp</p>
                          <p className="mt-1 font-mono text-slate-200">{event.time}</p>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Warnings Section</h2>
            <p className="text-xs text-slate-500">
              Sudden jumps across all sensors within the selected time window
            </p>
          </div>

          {suddenJumps.length === 0 ? (
            <p className="text-sm text-slate-500">No sudden jumps detected in this time window.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-950/70 text-left text-slate-400">
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2 font-medium">Sensor</th>
                    <th className="px-3 py-2 font-medium">Severity</th>
                    <th className="px-3 py-2 font-medium">Previous</th>
                    <th className="px-3 py-2 font-medium">Current</th>
                    <th className="px-3 py-2 font-medium">Abs. Jump</th>
                    <th className="px-3 py-2 font-medium">% Jump</th>
                    <th className="px-3 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {suddenJumps.map((jump, index) => (
                    <tr key={`${jump.sensor}-${jump.time}-${index}`} className="border-b border-slate-800/70">
                      <td className="px-3 py-2 text-slate-200 capitalize">{jump.sensor}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            jump.severity === "High"
                              ? "bg-red-500/20 text-red-300"
                              : jump.severity === "Medium"
                                ? "bg-amber-500/20 text-amber-300"
                                : "bg-slate-700 text-slate-300"
                          }`}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {jump.severity}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-300">{jump.prevValue.toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-300">{jump.currValue.toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-300">±{jump.absoluteJump.toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-200">{jump.percentageJump.toFixed(1)}%</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{jump.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-500">
            Distance represents distance from the robot sensor to the nearest detected obstacle/object, not the robot&apos;s room coordinates.
          </p>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Recent Readings Section</h2>
            <p className="text-xs text-slate-500">Latest 20 incoming messages across all topics and payload types</p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-950/70 text-left text-slate-400">
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Topic</th>
                  <th className="px-3 py-2 font-medium">Sensor</th>
                  <th className="px-3 py-2 font-medium">Payload</th>
                  <th className="px-3 py-2 font-medium">Numeric</th>
                </tr>
              </thead>
              <tbody>
                {recentRecords.map((record, index) => (
                  <tr key={`${record.topic}-${record.time}-${index}`} className="border-b border-slate-800/70">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-300">{record.time}</td>
                    <td className="px-3 py-2 text-slate-300">{record.topic}</td>
                    <td className="px-3 py-2 text-slate-200">{record.sensor}</td>
                    <td className="px-3 py-2 text-slate-200">{record.rawPayload}</td>
                    <td className="px-3 py-2 text-slate-400">
                      {record.value === null ? "-" : record.value.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}