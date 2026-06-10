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
  CartesianGrid,
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
      const values = windowedNumericRecords
        .filter((record) => definition.aliases.includes(record.sensor))
        .map((record) => record.value);

      if (values.length < 2) {
        return {
          ...definition,
          trendArrow: "→",
          trendLabel: "Stable",
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

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Engineering Decision Support Dashboard
          </h1>
          <p className="mt-2 text-sm text-slate-400 sm:text-base">
            Operational telemetry summary for robot health and action prioritization
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
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <p className="text-xs uppercase tracking-wide text-slate-500">Executive Summary</p>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 lg:col-span-2">
              <p className="text-sm text-slate-400">Robot Health Score</p>
              <p className="mt-2 text-4xl font-semibold text-slate-100">
                Robot Health Score: {engineeringDecision.healthScore}/100
              </p>
              <span
                className={`mt-3 inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                  engineeringDecision.healthStatus === "Excellent"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : engineeringDecision.healthStatus === "Good"
                      ? "border-sky-500/40 bg-sky-500/10 text-sky-200"
                      : engineeringDecision.healthStatus === "Warning"
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                        : "border-red-500/40 bg-red-500/10 text-red-200"
                }`}
              >
                {engineeringDecision.healthStatus}
              </span>
            </article>

            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Window Summary</p>
              <div className="mt-2 space-y-2 text-sm">
                <p className="flex items-center justify-between"><span className="text-slate-400">Time Window</span><span className="font-semibold text-slate-200">{selectedTimeWindowLabel}</span></p>
                <p className="flex items-center justify-between"><span className="text-slate-400">Sensor Points</span><span className="font-semibold text-slate-200">{windowedNumericRecords.length}</span></p>
                <p className="flex items-center justify-between"><span className="text-slate-400">Warnings</span><span className="font-semibold text-slate-200">{allSuddenJumps.length}</span></p>
                <p className="flex items-center justify-between"><span className="text-slate-400">Active Sensors</span><span className="font-semibold text-slate-200">{sensorOptions.length}</span></p>
              </div>
            </article>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">System Status</p>
            <p className="mt-2 text-2xl font-semibold text-slate-100">
              {engineeringDecision.systemStatus.icon} {engineeringDecision.systemStatus.label}
            </p>
            <ul className="mt-4 space-y-2 text-sm text-slate-300">
              {engineeringDecision.topIssues.map((issue, index) => (
                <li key={`${issue.text}-${index}`} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-slate-400" />
                  <span>{issue.text}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Key Changes In Current Window</p>
            <div className="mt-3 space-y-2">
              {keyChanges.map((change) => (
                <div key={change.key} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm">
                  <span className="text-slate-300">{change.label}</span>
                  <span className="font-semibold text-slate-100">
                    {change.direction.arrow} {change.deltaPct === null ? "N/A" : `${change.deltaPct >= 0 ? "+" : ""}${change.deltaPct.toFixed(1)}%`}
                  </span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Sensor Overview</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {metricCards.map((card) => {
              const Icon = card.icon;
              return (
                <article key={card.title} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-400">{card.title}</p>
                    <Icon className="h-4 w-4 text-slate-500" />
                  </div>
                  <p className="mt-2 text-2xl font-semibold text-slate-100">
                    {card.latest === null ? "N/A" : `${card.latest.toFixed(2)} ${card.unit}`}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">
                    {card.trendArrow} {card.trendLabel}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Trend Graph</p>
          <div className="mt-4 grid gap-4 lg:grid-cols-4">
            <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 lg:col-span-3">
              <div className="mb-4 flex flex-wrap items-center gap-2">
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

              <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">
                Sensor = {selectedSensor}&nbsp;&nbsp;|&nbsp;&nbsp;Points = {selectedSeries.length}&nbsp;&nbsp;|&nbsp;&nbsp;Time Range = {timeUnit === "all" ? "all" : `${timeAmount} ${timeUnit}`}
              </div>

              <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
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
          <p className="text-xs uppercase tracking-wide text-slate-500">AI Recommendation</p>
          <p className="mt-2 text-lg font-medium text-slate-100">{engineeringDecision.recommendation}</p>
          <p className="mt-1 text-sm text-slate-400">Confidence: {aiAnalysis.confidence}%</p>
        </section>
      </div>
    </main>
  );
}