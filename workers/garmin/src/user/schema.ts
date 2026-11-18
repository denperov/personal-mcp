import type { DatasetId } from "../garmin/catalog";

export type TypedName = "daily" | "sleep" | "hrv" | "weight" | "activities";
export interface TypedTable {
  name: TypedName;
  dataset: DatasetId | "activity";
  pk: "day" | "activity_id";
  columns: [column: string, sqlExpr: string][]; // sqlExpr: over records columns
}

const j = (path: string) => `data->>'$.${path}'`;
const paths = (spec: Record<string, string>): [string, string][] => Object.entries(spec).map(([c, p]) => [c, j(p)]);
const DAY: [string, string] = ["day", "key"];

export const TYPED: TypedTable[] = [
  { name: "daily", dataset: "daily_summary", pk: "day", columns: [DAY, ...paths({
    steps: "totalSteps", resting_hr: "restingHeartRate", rhr_7d: "lastSevenDaysAvgRestingHeartRate",
    stress_avg: "averageStressLevel", bb_high: "bodyBatteryHighestValue", bb_low: "bodyBatteryLowestValue",
    bb_wake: "bodyBatteryAtWakeTime", bb_charged: "bodyBatteryChargedValue", bb_drained: "bodyBatteryDrainedValue",
    intensity_moderate: "moderateIntensityMinutes", intensity_vigorous: "vigorousIntensityMinutes",
    active_kcal: "activeKilocalories", total_kcal: "totalKilocalories", spo2_avg: "averageSpo2",
    respiration_avg: "avgWakingRespirationValue", floors: "floorsAscended",
  })] },
  { name: "sleep", dataset: "sleep", pk: "day", columns: [DAY, ...paths({
    sleep_s: "sleepTimeSeconds", deep_s: "deepSleepSeconds", light_s: "lightSleepSeconds",
    rem_s: "remSleepSeconds", awake_s: "awakeSleepSeconds", sleep_score: "sleepScores.overall.value",
    avg_hr: "avgHeartRate", avg_stress: "avgSleepStress", respiration: "averageRespirationValue", spo2: "averageSpO2Value",
    sleep_need_min: "sleepNeed.actual", start_local: "sleepStartTimestampLocal", end_local: "sleepEndTimestampLocal",
  })] },
  { name: "hrv", dataset: "hrv", pk: "day", columns: [DAY, ...paths({
    hrv_last_night: "hrvSummary.lastNightAvg", hrv_weekly_avg: "hrvSummary.weeklyAvg",
    hrv_5min_high: "hrvSummary.lastNight5MinHigh", hrv_status: "hrvSummary.status",
    baseline_low: "hrvSummary.baseline.balancedLow", baseline_high: "hrvSummary.baseline.balancedUpper",
  })] },
  { name: "weight", dataset: "weight", pk: "day", columns: [
    DAY, ["weight_kg", `(${j("latestWeight.weight")}) / 1000.0`], // API returns grams
    ...paths({ bmi: "latestWeight.bmi", body_fat: "latestWeight.bodyFat" }),
    ["muscle_mass_kg", `(${j("latestWeight.muscleMass")}) / 1000.0`],
  ] },
  { name: "activities", dataset: "activity", pk: "activity_id", columns: [
    ["activity_id", "key"], ["day", "day"],
    ...paths({
      start_local: "startTimeLocal", type: "activityType.typeKey", name: "activityName", duration_s: "duration",
      moving_s: "movingDuration", distance_m: "distance", avg_speed: "averageSpeed", avg_hr: "averageHR", max_hr: "maxHR",
      calories: "calories", elevation_gain: "elevationGain", training_load: "activityTrainingLoad",
      aerobic_te: "aerobicTrainingEffect", anaerobic_te: "anaerobicTrainingEffect", te_label: "trainingEffectLabel",
      vo2max: "vO2MaxValue", avg_power: "avgPower", norm_power: "normPower", tss: "trainingStressScore",
      hr_z1: "hrTimeInZone_1", hr_z2: "hrTimeInZone_2", hr_z3: "hrTimeInZone_3", hr_z4: "hrTimeInZone_4",
      hr_z5: "hrTimeInZone_5", gct: "avgGroundContactTime", stride: "avgStrideLength", vertical_ratio: "avgVerticalRatio",
    }),
  ] },
];

// TEXT for keys and Garmin string fields; everything else NUMERIC: integers stay INTEGER, fractions become REAL
// (sleep start_local/end_local is epoch ms, activities start_local is a "YYYY-MM-DD HH:MM:SS" string).
const isText = (t: TypedName, c: string) =>
  ["day", "activity_id", "type", "name", "te_label", "hrv_status"].includes(c) || (t === "activities" && c === "start_local");

const typedDdl = (t: TypedTable) =>
  `CREATE TABLE ${t.name}(${t.columns.map(([c]) =>
    `${c} ${isText(t.name, c) ? "TEXT" : "NUMERIC"}${c === t.pk ? " PRIMARY KEY" : ""}`).join(", ")}) WITHOUT ROWID`;

// Version number = index + 1; a shipped version never changes, fixes go into a new one
export const MIGRATIONS: string[][] = [[
  `CREATE TABLE records(dataset TEXT NOT NULL, key TEXT NOT NULL, day TEXT, data TEXT NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY(dataset, key)) WITHOUT ROWID`,
  `CREATE TABLE sync_state(dataset TEXT PRIMARY KEY, last_success_at TEXT, last_error TEXT, last_error_at TEXT,
    backfill_cursor TEXT, backfill_done_at TEXT, empty_streak_days INTEGER NOT NULL DEFAULT 0, window_days INTEGER) WITHOUT ROWID`,
  "CREATE TABLE files(activity_id TEXT PRIMARY KEY, r2_key TEXT, status INTEGER, bytes INTEGER, fetched_at TEXT) WITHOUT ROWID",
  "CREATE TABLE queue(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, priority INTEGER NOT NULL, step TEXT NOT NULL)",
  ...TYPED.map(typedDdl),
  "CREATE INDEX activities_day ON activities(day)",
], [
  // Activity files and R2 are gone: the files table, queued file steps (queue.step is JSON.stringify of the Step)
  // and {"r2_key","bytes"} stubs of JSON moved to R2. Repair re-queues activity_detail/activity_workouts (up to
  // 20 activities a day); other items over 256 KB were never seen and return only if sync loads that day again.
  "DROP TABLE files",
  `DELETE FROM queue WHERE step LIKE '%"kind":"activity_file"%'`,
  // Runs in the constructor under the 10 ms CPU limit: octet_length reads only the row header, so large rows are
  // not loaded or parsed; a stub {"r2_key":"u/<64 hex>/json/<ds>/<key>.json","bytes":N} is under 200 bytes
  `DELETE FROM records WHERE octet_length(data) < 300 AND data LIKE '{"r2_key":%'`,
]];

export function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec("CREATE TABLE IF NOT EXISTS _schema(version INTEGER PRIMARY KEY) WITHOUT ROWID");
    const done = sql.exec<{ v: number | null }>("SELECT max(version) AS v FROM _schema").one().v ?? 0;
    for (let v = done + 1; v <= MIGRATIONS.length; v++) {
      for (const s of MIGRATIONS[v - 1]) sql.exec(s);
      sql.exec("INSERT INTO _schema(version) VALUES (?)", v);
    }
  });
}
