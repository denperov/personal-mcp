import { DATASETS } from "../garmin/catalog";
import type { TypedName } from "../user/schema";
import { HISTORY } from "../user/engine";
import { allStates, type SyncState } from "../user/store";
import { compact, INTRADAY_KEYS, stripIntraday } from "./format";

// Read-only and synchronous. Series and search read the typed tables, not a scan of records.

export type Metric = "steps" | "resting_hr" | "rhr_7d" | "stress_avg" | "bb_high" | "bb_low" | "bb_wake" | "intensity_moderate"
  | "intensity_vigorous" | "active_kcal" | "spo2_avg" | "respiration_avg" | "sleep_s" | "deep_s" | "rem_s" | "sleep_score"
  | "sleep_need_min" | "hrv_last_night" | "hrv_weekly_avg" | "hrv_status" | "weight_kg" | "training_load";

type MetricDef = { table: TypedName; column: string; agg?: "sum" };
const of = <M extends Metric>(table: TypedName, metrics: M[], agg?: "sum") =>
  Object.fromEntries(metrics.map((m): [M, MetricDef] => [m, agg ? { table, column: m, agg } : { table, column: m }])) as Record<M, MetricDef>;

/** Metric name = column name; training_load is the sum of activities.training_load for the day */
export const METRICS: Record<Metric, MetricDef> = {
  ...of("daily", ["steps", "resting_hr", "rhr_7d", "stress_avg", "bb_high", "bb_low", "bb_wake", "intensity_moderate",
    "intensity_vigorous", "active_kcal", "spo2_avg", "respiration_avg"]),
  ...of("sleep", ["sleep_s", "deep_s", "rem_s", "sleep_score", "sleep_need_min"]),
  ...of("hrv", ["hrv_last_night", "hrv_weekly_avg", "hrv_status"]),
  ...of("weight", ["weight_kg"]),
  ...of("activities", ["training_load"], "sum"),
};

type Row = Record<string, unknown>;
type Rec = { dataset: string; key: string; data: string };

const DAY_SETS = DATASETS.filter((d) => d.kind !== "static").map((d) => `'${d.id}'`).join(", ");

function record(sql: SqlStorage, dataset: string, key: string): unknown {
  const r = sql.exec<Rec>("SELECT data FROM records WHERE dataset = ? AND key = ?", dataset, key).toArray()[0];
  return r && JSON.parse(r.data);
}

function dayRow(days: Map<string, Row>, day: string): Row {
  let r = days.get(day);
  if (!r) days.set(day, (r = { day }));
  return r;
}

/** All day/range datasets of the day + the day's activities, without intraday arrays */
export function getDay(sql: SqlStorage, date: string): object {
  const out: Row = { day: date };
  for (const r of sql.exec<Rec>(`SELECT dataset, data FROM records WHERE key = ? AND dataset IN (${DAY_SETS})`, date)) {
    out[r.dataset] = JSON.parse(r.data);
  }
  out.activities = sql.exec("SELECT * FROM activities WHERE day = ? ORDER BY start_local", date).toArray();
  return compact(stripIntraday(out)) as object;
}

/** [{day, <metric>…}] in ascending day order; one SELECT per table; days without rows and empty values are skipped */
export function getDailySeries(sql: SqlStorage, from: string, to: string, metrics: Metric[]): Row[] {
  const byTable = new Map<TypedName, Metric[]>();
  for (const m of metrics) byTable.set(METRICS[m].table, [...(byTable.get(METRICS[m].table) ?? []), m]);
  const days = new Map<string, Row>();
  for (const [table, ms] of byTable) {
    const cols = ms.map((m) => METRICS[m].agg ? `SUM(${METRICS[m].column}) AS ${m}` : `${METRICS[m].column} AS ${m}`);
    const group = ms.some((m) => METRICS[m].agg) ? " GROUP BY day" : "";
    for (const r of sql.exec(`SELECT day, ${cols.join(", ")} FROM ${table} WHERE day BETWEEN ? AND ?${group}`, from, to)) {
      const row = dayRow(days, r.day as string);
      for (const m of ms) if (r[m] !== null) row[m] = r[m];
    }
  }
  return [...days.values()].sort((a, b) => (a.day as string).localeCompare(b.day as string));
}

/** Newest first; type is the exact Garmin typeKey */
export function searchActivities(
  sql: SqlStorage, f: { from?: string; to?: string; type?: string; minDistanceKm?: number; limit: number },
): object[] {
  const where: string[] = [], args: SqlStorageValue[] = [];
  const add = (cond: string, v: SqlStorageValue | undefined) => {
    if (v === undefined) return;
    where.push(cond);
    args.push(v);
  };
  add("day >= ?", f.from);
  add("day <= ?", f.to);
  add("type = ?", f.type);
  add("distance_m >= ?", f.minDistanceKm === undefined ? undefined : f.minDistanceKm * 1000);
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return sql.exec(`SELECT * FROM activities${w} ORDER BY day DESC, start_local DESC LIMIT ?`, ...args, f.limit)
    .toArray().map((r) => compact(r) as object);
}

/** summary is the activity list item; without includeSplits, detail.splitSummaries is removed; null means an unknown id */
export function getActivity(
  sql: SqlStorage, id: string, o: { includeSplits: boolean; includeWorkout: boolean },
): object | null {
  const recs = new Map(sql.exec<Rec>(
    "SELECT dataset, data FROM records WHERE key = ? AND dataset IN ('activity', 'activity_detail', 'activity_workouts')", id,
  ).toArray().map((r) => [r.dataset, JSON.parse(r.data) as unknown]));
  if (!recs.size) return null;
  const detail = recs.get("activity_detail");
  if (!o.includeSplits && detail && typeof detail === "object") delete (detail as Row).splitSummaries;
  return compact({
    activity_id: id,
    summary: recs.get("activity"),
    detail,
    workouts: o.includeWorkout ? recs.get("activity_workouts") : undefined,
  }) as object;
}

/** The day's intraday arrays + top-level scalar fields as context; null if there is no record */
export function getIntraday(sql: SqlStorage, date: string, kind: "heart_rate" | "body_battery" | "spo2" | "hrv"): object | null {
  const d = record(sql, kind, date);
  if (!d || typeof d !== "object") return null;
  return compact(Object.fromEntries(Object.entries(d)
    .filter(([k, v]) => INTRADAY_KEYS.includes(k) || v === null || typeof v !== "object"))) as object;
}

export function getBody(sql: SqlStorage, from: string, to: string): object {
  return compact({
    weight: sql.exec("SELECT * FROM weight WHERE day BETWEEN ? AND ? ORDER BY day", from, to).toArray(),
    goal: record(sql, "weight_goal", "current"),
  }) as object;
}

/** [{day, nutrition?, hydration?}] in ascending day order */
export function getNutrition(sql: SqlStorage, from: string, to: string): object {
  const days = new Map<string, Row>();
  for (const r of sql.exec<Rec>(
    "SELECT dataset, key, data FROM records WHERE dataset IN ('nutrition', 'hydration') AND key BETWEEN ? AND ? ORDER BY key",
    from, to,
  )) dayRow(days, r.key)[r.dataset] = JSON.parse(r.data);
  return compact([...days.values()]) as object;
}

export function getProfile(sql: SqlStorage): object {
  const fa = sql.exec<Rec>("SELECT key, data FROM records WHERE dataset = 'fitness_age' ORDER BY key DESC LIMIT 1").toArray()[0];
  return compact({
    profile: record(sql, "profile", "current"),
    hr_zones: record(sql, "hr_zones", "current"),
    fitness_age: fa && { day: fa.key, ...JSON.parse(fa.data) },
  }) as object;
}

export function getWomensHealth(sql: SqlStorage, date: string): object {
  return compact({ cycle_summary: record(sql, "cycle_summary", date), cycle_day: record(sql, "cycle_day", date) }) as object;
}

const HINTS = [
  "Typed tables daily, sleep, hrv, weight (key day = 'YYYY-MM-DD', user's local date) and activities (key activity_id, indexed by day) are cheap: prefer them.",
  "records(dataset, key, day, data, fetched_at) holds raw Garmin JSON in data: read it with data->>'$.path' or json_extract(data, '$.path'). Always filter by dataset (and key/day range): a full scan of records can exceed the per-call CPU limit.",
  "Items over 2 MB of JSON are not stored: their records.data is only {\"omitted\":\"too_large\",\"bytes\":…}.",
  "SQLite here: at most 5 terms in one compound SELECT (UNION/INTERSECT/EXCEPT); no REGEXP, median, percentile or log10 (log(x) is base 10, ln(x) natural); LIKE patterns ≤ 50 bytes.",
  "Columns of a table: SELECT * FROM pragma_table_info('activities') (PRAGMA statements are rejected).",
  "Units: *_s seconds, *_min minutes, distance_m meters, weight_kg kilograms, avg_speed m/s, *_kcal kilocalories.",
];

export function describeSchema(sql: SqlStorage): object {
  return {
    objects: sql.exec(`SELECT type, name, sql FROM sqlite_master
      WHERE lower(substr(name,1,4)) <> '_cf_' AND substr(name,1,7) <> 'sqlite_' AND name <> '_schema'`).toArray(),
    hints: HINTS,
  };
}

/** History start: the HISTORY cursor once the search for the start has finished */
export function historyStart(states: Map<string, SyncState>): string | null | undefined {
  return states.get(HISTORY)?.backfill_done_at ? states.get(HISTORY)!.backfill_cursor : undefined;
}

/**
 * No secrets: per dataset, the last success, error and history progress; key status, key expiry, queue size;
 * paused_until only while the pause (kv pausedUntil, ms) has not ended
 */
export function syncStatus(sql: SqlStorage, now: Date, key: { expiresAt: string; present: boolean }, queueSize: number, pausedUntil?: number): object {
  const states = allStates(sql);
  return {
    now: now.toISOString(),
    key: compact({ status: key.present ? states.get("_key")?.last_error ?? "ok" : "not_connected", expires_on: key.expiresAt || undefined }),
    queue_size: queueSize,
    ...(pausedUntil && pausedUntil > now.getTime() ? { paused_until: new Date(pausedUntil).toISOString() } : {}),
    ...(historyStart(states) ? { history_start: historyStart(states) } : {}),
    datasets: [...DATASETS.map((d) => d.id as string), "activity"].map((id) => {
      const s = states.get(id);
      return compact({
        dataset: id, last_success_at: s?.last_success_at, last_error: s?.last_error, last_error_at: s?.last_error_at,
        backfill_cursor: s?.backfill_cursor, backfill_done_at: s?.backfill_done_at,
      });
    }),
  };
}
