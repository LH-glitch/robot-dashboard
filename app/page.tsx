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
  severity: "High" | "Medium" | "Low";
};

type ChartType = "line" | "area" | "bar" | "scatter" | "step";
type TimeUnit = "seconds" | "minutes" | "hours" | "days" | "all";
type BehaviorScore = "Stable" | "Cautious" | "Warning" | "Critical";
type DataSource = "demo" | "local" | null;

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

function formatTickLabel(timeMs: number, unit: TimeUnit): string {
  const d = new Date(timeMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  const mo = MONTH_NAMES[d.getMonth()];

  if (unit === "seconds") return `${hh}:${mn}:${ss}`;
  if (unit === "minutes" || unit === "hours") return `${hh}:${mn}`;
  if (unit === "days") return `${mo} ${dy} ${hh}:${mn}`;
  return `${mo} ${dy}`;
}

export default function Home() {
  const [records, setRecords] = useState<SensorRecord[]>([]);
  const [dataSource, setDataSource] = useState<DataSource>(null);
  const [dataLoadMessage, setDataLoadMessage] = useState<string | null>(null);
  const [selectedSensor, setSelectedSensor] = useState<string>("distance");
  const [selectedChartType, setSelectedChartType] = useState<ChartType>("line");
  const [timeAmount, setTimeAmount] = useState<string>("10");
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("minutes");

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
    if (n <= 8) return n;
    if (timeUnit === "days") return Math.min(n, 7);
    if (timeUnit === "all") return Math.min(n, 10);
    return 8;
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
                        labelFormatter={(v: number) => formatTickLabel(v, timeUnit)}
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
                        labelFormatter={(v: number) => formatTickLabel(v, timeUnit)}
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
                        labelFormatter={(v: number) => formatTickLabel(v, timeUnit)}
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
                        labelFormatter={(v: number) => formatTickLabel(v, timeUnit)}
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
                        labelFormatter={(v: number) => formatTickLabel(v, timeUnit)}
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