import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATASETS } from "../garmin/catalog";
import { addDays, daysBetween, localDate } from "../garmin/dates";
import { userTimeZone } from "../user/engine";
import { TYPED } from "../user/schema";
import { MAX_TOOL_CHARS, toolText, warningsFor } from "./format";
import {
  describeSchema, getActivity, getBody, getDailySeries, getDay, getIntraday, getNutrition, getProfile, getWomensHealth,
  METRICS, searchActivities, syncStatus, type Metric,
} from "./queries";
import { checkReadOnlySql, readOnlyQuery } from "./sqlguard";

// Runs inside the user's DO. Arguments are validated here (the RPC boundary), even if McpServer has already parsed them.

export interface ToolContext {
  storage: DurableObjectStorage; sql: SqlStorage; files: R2Bucket; now: Date; keyExpiresAt: string; hasKey: boolean; settingsUrl: string;
  syncNow(dates: string[]): Promise<{ queued: number; etaSeconds: number }>; queueSize(): number;
}
export interface ToolDef {
  name: string; description: string; input: z.ZodRawShape; annotations: ToolAnnotations;
  /** datasets for warningsFor; the key warning is always there */
  warn?(a: Record<string, unknown>): string[];
  run(c: ToolContext, a: Record<string, unknown>): unknown;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const SYNC: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

class BadInput extends Error {}
const bad = (reason: string): never => {
  throw new BadInput(reason);
};

/** A real calendar date: addDays/daysBetween are never called before this check */
const isDay = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").refine(isDay, "not a calendar date");
const span = { from: date, to: date };

/** from ≤ to and at most maxDays days, inclusive */
function checkSpan(a: { from: string; to: string }, maxDays: number): void {
  if (a.from > a.to) bad("from must not be after to");
  if (daysBetween(a.from, a.to) >= maxDays) bad(`from..to must span at most ${maxDays} days`);
}

const DAY_SETS = DATASETS.filter((d) => d.kind !== "static").map((d) => d.id as string);
const METRIC_NAMES = Object.keys(METRICS) as [Metric, ...Metric[]];
const metricSet = (m: Metric) => TYPED.find((t) => t.name === METRICS[m].table)!.dataset as string;

type In<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;
const tool = <S extends z.ZodRawShape>(t: {
  name: string; description: string; input: S; annotations?: ToolAnnotations;
  warn?(a: In<S>): string[]; run(c: ToolContext, a: In<S>): unknown;
}): ToolDef => ({ annotations: READ, ...t }) as ToolDef;

export const TOOLS: ToolDef[] = [
  tool({
    name: "get_day",
    description: "Everything synced for one local day (daily summary, sleep, HRV, stress, body battery, SpO2, nutrition, " +
      "activities), without intraday arrays. Raw Garmin units: durations in seconds, distances in meters.",
    input: { date },
    warn: () => DAY_SETS,
    run: (c, a) => getDay(c.sql, a.date),
  }),
  tool({
    name: "get_daily_series",
    description: "Daily values of up to 10 metrics over a date range of at most 366 days, one row per day. " +
      "Units: *_s seconds, *_min minutes, *_kcal kilocalories, weight_kg kilograms, heart rates in bpm, HRV in ms.",
    input: { ...span, metrics: z.array(z.enum(METRIC_NAMES)).min(1).max(10) },
    warn: (a) => [...new Set(a.metrics.map(metricSet))],
    run: (c, a) => {
      checkSpan(a, 366);
      return getDailySeries(c.sql, a.from, a.to, a.metrics);
    },
  }),
  tool({
    name: "search_activities",
    description: "Activities filtered by local date range, exact Garmin type key (e.g. running, cycling) and minimum " +
      "distance in km, newest first, at most limit rows (default 50, max 100; narrow from/to for more). " +
      "Rows: distance_m meters, duration_s seconds, avg_speed m/s, calories kcal.",
    input: {
      from: date.optional(), to: date.optional(), type: z.string().optional(),
      // 200 rows with Garmin's fractional fields do not fit in MAX_TOOL_CHARS (R28)
      min_distance_km: z.coerce.number().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    },
    warn: () => ["activity"],
    run: (c, a) => {
      if (a.from && a.to && a.from > a.to) bad("from must not be after to");
      return searchActivities(c.sql, { from: a.from, to: a.to, type: a.type, minDistanceKm: a.min_distance_km, limit: a.limit });
    },
  }),
  tool({
    name: "get_activity",
    description: "One activity by activity_id: summary, full detail (optionally with splits) and the linked workout. " +
      "Raw Garmin units: distance in meters, duration in seconds, speed in m/s; data is null for an unknown id.",
    input: { activity_id: z.string().min(1), include_splits: z.boolean().default(true), include_workout: z.boolean().default(true) },
    warn: () => ["activity"],
    run: (c, a) => getActivity(c.sql, c.files, a.activity_id, { includeSplits: a.include_splits, includeWorkout: a.include_workout }),
  }),
  tool({
    name: "get_intraday",
    description: "Intraday samples of one local day: heart rate (bpm), body battery, SpO2 (%) or HRV (ms) readings, " +
      "as Garmin's [timestamp in ms, value] arrays plus the day's scalar fields.",
    input: { date, kind: z.enum(["heart_rate", "body_battery", "spo2", "hrv"]) },
    warn: (a) => [a.kind],
    run: (c, a) => getIntraday(c.sql, a.date, a.kind),
  }),
  tool({
    name: "get_body",
    description: "Weight entries over a date range of at most 366 days (weight_kg and muscle_mass_kg in kilograms, " +
      "body_fat in %, bmi) and the current weight goal.",
    input: span,
    warn: () => ["weight", "weight_goal"],
    run: (c, a) => {
      checkSpan(a, 366);
      return getBody(c.sql, a.from, a.to);
    },
  }),
  tool({
    name: "get_nutrition",
    description: "Food log (calories in kcal, macronutrients in grams) and hydration (ml) per local day, " +
      "over a date range of at most 31 days.",
    input: span,
    warn: () => ["nutrition", "hydration"],
    run: (c, a) => {
      checkSpan(a, 31);
      return getNutrition(c.sql, a.from, a.to);
    },
  }),
  tool({
    name: "get_profile",
    description: "User profile (time zone, height in cm, weight in grams as Garmin stores it), heart-rate zones in bpm " +
      "and the latest fitness age in years.",
    input: {},
    warn: () => ["profile", "hr_zones", "fitness_age"],
    run: (c) => getProfile(c.sql),
  }),
  tool({
    name: "get_womens_health",
    description: "Menstrual cycle summary and cycle-day data for one local day (cycle and phase lengths in days).",
    input: { date },
    warn: () => ["cycle_summary", "cycle_day"],
    run: (c, a) => getWomensHealth(c.sql, a.date),
  }),
  tool({
    name: "describe_schema",
    description: "Tables, columns and query hints of the user's SQLite store, including column units; read it before query_sql.",
    input: {},
    run: (c) => describeSchema(c.sql),
  }),
  tool({
    name: "query_sql",
    description: "Run one read-only SELECT, WITH or VALUES query on the user's SQLite store and return at most limit rows. " +
      "Column units follow their suffixes: _s seconds, _min minutes, _m meters, _kg kilograms, _kcal kilocalories.",
    input: { sql: z.string(), limit: z.coerce.number().int().min(1).max(1000).default(200) },
    run: (c, a) => {
      const g = checkReadOnlySql(a.sql);
      if (!g.ok) return bad(g.reason);
      try {
        return readOnlyQuery(c.storage, g.sql, a.limit, MAX_TOOL_CHARS - 10_000); // headroom for the toolText wrapper (R21)
      } catch (e) {
        return bad(`query error: ${e instanceof Error ? e.message : String(e)}`); // SQLite describes the caller's own query
      }
    },
  }),
  tool({
    name: "sync_status",
    description: "Sync state of every dataset (last success, last error, history backfill progress), " +
      "the Garmin API key status and expiry date, the number of queued sync steps, and paused_until while sync is paused " +
      "(Garmin rate limit or rejected key).",
    input: {},
    run: (c) => syncStatus(c.sql, c.now, { expiresAt: c.keyExpiresAt, present: c.hasKey }, c.queueSize(), c.storage.kv.get<number>("pausedUntil")),
  }),
  tool({
    name: "sync_now",
    description: "Queue a fresh sync from Garmin for up to 7 local dates within 28 days (default: today and yesterday); " +
      "data arrives in the background, check sync_status after eta_seconds seconds.",
    input: { dates: z.array(date).min(1).max(7).optional() },
    annotations: SYNC,
    run: async (c, a) => {
      const today = localDate(userTimeZone(c.sql), c.now);
      const dates = a.dates ?? [addDays(today, -1), today];
      const sorted = [...dates].sort();
      const first = sorted[0], last = sorted[sorted.length - 1];
      if (last > today) bad(`dates: ${last} is after today (${today})`);
      if (daysBetween(first, last) > 27) bad("dates: the latest and the earliest date must be at most 27 days apart");
      const r = await c.syncNow(dates);
      return { queued: r.queued, eta_seconds: r.etaSeconds, hint: "call sync_status after eta_seconds" };
    },
  }),
];

const issue = (i: z.core.$ZodIssue) => `${i.path.join(".") || "arguments"}: ${i.message}`;

/** Bad input gives isError with the reason; no data changes. Other exceptions report only their name */
export async function runTool(c: ToolContext, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { isError: true, text: "unknown tool" };
  const p = z.object(t.input).safeParse(args ?? {});
  if (!p.success) return { isError: true, text: p.error.issues.map(issue).join("; ") };
  try {
    const data = await t.run(c, p.data);
    return { isError: false, text: toolText(data, warningsFor(c.sql, t.warn?.(p.data) ?? [], c.now,
      { expiresAt: c.keyExpiresAt, present: c.hasKey, settingsUrl: c.settingsUrl })) };
  } catch (e) {
    return { isError: true, text: e instanceof BadInput ? e.message : `internal error (${e instanceof Error ? e.name : "Error"})` };
  }
}
