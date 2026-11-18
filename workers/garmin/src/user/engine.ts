import { ACTIVITY_PAGE, DATASETS, dataset, type DatasetId, type Item } from "../garmin/catalog";
import { addDays } from "../garmin/dates";
import { GarminHttpError, TOKEN_PATH, type GarminClient } from "../garmin/client";
import { TYPED } from "./schema";
import {
  allStates, incompleteActivities, missingPieces, patchState, putFile, upsertRecords, type Pieces, type SyncState,
} from "./store";

// fetchStep: network and R2, no SQL; applyStep: synchronous SQL only. Nothing here logs.

export type Step =
  | { kind: "dataset"; id: DatasetId; start: string; end: string; backfill: boolean }
  | { kind: "activities"; start: number; limit: number; backfill: boolean }
  | { kind: "activity_detail" | "activity_workouts" | "activity_file"; activityId: string }
  | { kind: "history_start"; start: string; end: string };
type DatasetStep = Extract<Step, { kind: "dataset" }>;
type ActivitiesStep = Extract<Step, { kind: "activities" }>;
type HistoryStep = Extract<Step, { kind: "history_start" }>;

/**
 * sync_state row of the history start: backfill_cursor is the day before which there is no data (while the search
 * runs, the start of the next year to check), backfill_done_at means the search is finished
 */
export const HISTORY = "_history";
export const BACKFILL_FLOOR = "2000-01-01", MAX_INLINE_JSON = 256_000;
const ERROR_SKIP_MS = 3_600_000, REPAIR_ACTIVITIES = 20;

export const BACKFILL_ORDER: (DatasetId | "activity")[] = [
  "activity", "daily_summary", "sleep", "hrv", "daily_summary_v2", "body_battery", "stress", "steps", "weight",
  "heart_rate", "spo2", "hydration", "wellness_activity", "nutrition", "fitness_age", "cycle_summary", "cycle_day",
];

export interface FetchDeps { client: GarminClient; files: R2Bucket; prefix: string; today: string }
export type Fetched =
  | { ok: true; items: Item[] }
  | { ok: true; file: { r2Key: string | null; status: number; bytes: number | null } }
  | { ok: false; status: number; emptyBody: boolean };
export interface StepResult { newSteps: Step[]; rowsWritten: number }

/**
 * Queue deduplication key: the same work gets the same key.
 * "dataset:<id>:<start>:<end>[:backfill]", "activities:<start>:<limit>[:backfill]", "<kind>:<activityId>".
 */
export function stepKey(s: Step): string {
  if (s.kind === "dataset") return `dataset:${s.id}:${s.start}:${s.end}${s.backfill ? ":backfill" : ""}`;
  if (s.kind === "activities") return `activities:${s.start}:${s.limit}${s.backfill ? ":backfill" : ""}`;
  if (s.kind === "history_start") return `history_start:${s.start}:${s.end}`;
  return `${s.kind}:${s.activityId}`;
}

/** For logs: "dataset:<id>", "activities", "activity_detail" | "activity_workouts" | "activity_file" */
export function stepLabel(s: Step): string {
  return s.kind === "dataset" ? `dataset:${s.id}` : s.kind;
}

/** The sync_state row the step writes to */
export function stateKey(s: Step): string {
  return s.kind === "dataset" ? s.id : s.kind === "history_start" ? HISTORY : "activity";
}

const ACTIVITY_PATH = {
  activity_detail: (id: string) => `/activity-service/activity/${id}`,
  activity_workouts: (id: string) => `/activity-service/activity/${id}/workouts`,
  activity_file: (id: string) => `/download-service/files/activity/${id}`,
};

type Row = Record<string, unknown>;
const rec = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const day10 = (v: unknown) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);

const activityItems = (json: unknown): Item[] =>
  (Array.isArray(json) ? json : []).flatMap((a) => {
    const id = rec(a).activityId;
    return id === undefined || id === null ? [] : [{ key: String(id), day: day10(rec(a).startTimeLocal), data: a }];
  });

/**
 * Exactly one data request to Garmin. Rethrows RateLimitedError, KeyRejectedError, HTTP 401
 * and any key exchange error: these are not a data endpoint response.
 */
export async function fetchStep(deps: FetchDeps, step: Step): Promise<Fetched> {
  try {
    return await fetchOk(deps, step);
  } catch (e) {
    if (!(e instanceof GarminHttpError) || e.status === 401 || e.path === TOKEN_PATH) throw e;
    if (step.kind === "activity_file" && e.status >= 400 && e.status < 500) {
      return { ok: true, file: { r2Key: null, status: e.status, bytes: null } };
    }
    return { ok: false, status: e.status, emptyBody: e.emptyBody };
  }
}

async function fetchOk(deps: FetchDeps, step: Step): Promise<Fetched> {
  const { client } = deps;
  switch (step.kind) {
    case "dataset": {
      const d = dataset(step.id);
      const json = await client.get(d.path(step.start, step.end, deps.today));
      return { ok: true, items: await offload(deps, step.id, d.items(json, step.start, step.end)) };
    }
    case "history_start": {
      const d = dataset("daily_summary_v2");
      return { ok: true, items: d.items(await client.get(d.path(step.start, step.end, deps.today)), step.start, step.end) };
    }
    case "activities": {
      const json = await client.get(`/activitylist-service/activities/search/activities?start=${step.start}&limit=${step.limit}`);
      return { ok: true, items: await offload(deps, "activity", activityItems(json)) };
    }
    case "activity_detail": {
      const json = (await client.get(ACTIVITY_PATH.activity_detail(step.activityId))) ?? {};
      const item = { key: step.activityId, day: day10(rec(rec(json).summaryDTO).startTimeLocal), data: json };
      return { ok: true, items: await offload(deps, step.kind, [item]) };
    }
    case "activity_workouts": {
      const json = (await client.get(ACTIVITY_PATH.activity_workouts(step.activityId))) ?? [];
      return { ok: true, items: await offload(deps, step.kind, [{ key: step.activityId, day: null, data: json }]) };
    }
    case "activity_file": {
      const buf = await client.download(ACTIVITY_PATH.activity_file(step.activityId));
      const r2Key = `${deps.prefix}activities/${step.activityId}.zip`;
      await deps.files.put(r2Key, buf, { httpMetadata: { contentType: "application/zip" } });
      return { ok: true, file: { r2Key, status: 200, bytes: buf.byteLength } };
    }
  }
}

/** R2 objects written by fetchStep: the activity file and JSON moved out by offload */
export function fetchedFiles(f: Fetched): string[] {
  if (!f.ok) return [];
  if ("file" in f) return f.file.r2Key ? [f.file.r2Key] : [];
  return f.items.map((i) => rec(i.data).r2_key).filter((k): k is string => typeof k === "string");
}

/** JSON longer than MAX_INLINE_JSON goes to R2; items keep a stub { r2_key, bytes } */
async function offload(deps: FetchDeps, ds: string, items: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const it of items) {
    const json = JSON.stringify(it.data);
    if (json.length <= MAX_INLINE_JSON) {
      out.push(it);
      continue;
    }
    const r2_key = `${deps.prefix}json/${ds}/${it.key}.json`;
    await deps.files.put(r2_key, json, { httpMetadata: { contentType: "application/json" } });
    out.push({ ...it, data: { r2_key, bytes: new TextEncoder().encode(json).byteLength } });
  }
  return out;
}

/** Synchronous, SQL only; rowsWritten is the total of all the step's writes. */
export function applyStep(sql: SqlStorage, step: Step, f: Fetched, now: Date, today: string): StepResult {
  const at = now.toISOString();
  if (step.kind === "dataset") return applyDataset(sql, step, f, at);
  if (step.kind === "history_start") return applyHistory(sql, step, f, at, today);
  if (!f.ok) return failed(sql, step, f.status, at);
  if (step.kind === "activity_file") {
    return done("file" in f ? putFile(sql, { activityId: step.activityId, ...f.file, fetchedAt: at }) : 0);
  }
  const items = "items" in f ? f.items : [];
  if (step.kind === "activities") return applyActivities(sql, step, items, at);
  return done(upsertRecords(sql, step.kind, items, at));
}

const done = (rowsWritten: number, newSteps: Step[] = []): StepResult => ({ newSteps, rowsWritten });

// Error text is the status only: Garmin response bodies are never stored
const failed = (sql: SqlStorage, s: Step, status: number, at: string) =>
  done(patchState(sql, stateKey(s), { last_error: `HTTP ${status}`, last_error_at: at }));

function applyDataset(sql: SqlStorage, s: DatasetStep, f: Fetched, at: string): StepResult {
  const d = dataset(s.id);
  const states = s.backfill ? allStates(sql) : undefined;
  const st = states?.get(s.id);
  const w = st?.window_days ?? d.window;
  // 401/429 never get here: fetchStep rethrows them
  const dayMiss = !f.ok && d.kind === "day" && f.status >= 400 && f.status < 500;
  const rangeMiss = !f.ok && s.backfill && d.kind === "range" && f.emptyBody && (f.status === 400 || f.status === 500);
  if (rangeMiss && w > 1) return done(patchState(sql, s.id, { window_days: Math.max(1, Math.floor(w / 2)) }));
  // w == 1: an empty 400 is a day without data; an empty 500 is a failure and must not "finish" the backfill
  if (!f.ok && !dayMiss && !(rangeMiss && f.status === 400)) return failed(sql, s, f.status, at);

  const items = f.ok && "items" in f ? f.items : [];
  let n = upsertRecords(sql, s.id, items, at);
  if (!s.backfill) return done(n + patchState(sql, s.id, { last_success_at: at, last_error: null }));
  const cursor = addDays(s.start, -1);
  const floor = states?.get(HISTORY)?.backfill_cursor ?? BACKFILL_FLOOR;
  return done(n + patchState(sql, s.id, { backfill_cursor: cursor, backfill_done_at: cursor < floor ? at : undefined }));
}

const HISTORY_SETS = JSON.stringify(DATASETS.filter((d) => d.kind !== "static").map((d) => d.id));

/**
 * A year of the history start search: the first day with data is the start; an empty year (or 4xx) moves on to the
 * next year; reaching yesterday without data makes today the start. Other errors retry the same year after an hour.
 * The start is no later than an already stored daily summary v2 (records holds only days with data): a bad response
 * for a year will not move the start forward or delete real records.
 */
function applyHistory(sql: SqlStorage, s: HistoryStep, f: Fetched, at: string, today: string): StepResult {
  if (!f.ok && (f.status < 400 || f.status >= 500)) return failed(sql, s, f.status, at);
  const first = f.ok && "items" in f ? f.items.map((i) => i.day!).sort()[0] : undefined;
  const found = first ?? (s.end >= addDays(today, -1) ? today : undefined);
  if (!found) return done(patchState(sql, HISTORY, { backfill_cursor: addDays(s.end, 1) }));
  const stored = sql.exec<{ d: string | null }>("SELECT min(day) AS d FROM records WHERE dataset = 'daily_summary_v2'").one().d;
  const start = stored && stored < found ? stored : found;
  return done(patchState(sql, HISTORY, { backfill_cursor: start, backfill_done_at: at }) + trimBefore(sql, start, at));
}

/**
 * Records of day and range datasets before the history start are Garmin stubs. Datasets with a cursor below the
 * start are done; those above it are reopened (the old empty-day rule may have stopped them).
 */
function trimBefore(sql: SqlStorage, start: string, at: string): number {
  const inSets = "dataset IN (SELECT value FROM json_each(?))";
  let n = sql.exec(`DELETE FROM records WHERE ${inSets} AND day < ?`, HISTORY_SETS, start).rowsWritten;
  for (const t of TYPED) if (t.pk === "day") n += sql.exec(`DELETE FROM ${t.name} WHERE day < ?`, start).rowsWritten;
  return n + sql.exec(`UPDATE sync_state SET backfill_done_at = CASE WHEN backfill_cursor < ? THEN coalesce(backfill_done_at, ?) END
    WHERE ${inSets} AND backfill_cursor IS NOT NULL`, start, at, HISTORY_SETS).rowsWritten;
}

const pieceSteps = (ps: Pieces[]): Step[] => ps.flatMap((p) => p.missing.map((kind): Step => ({ kind, activityId: p.id })));

/** Missing pieces of up to REPAIR_ACTIVITIES newest incomplete activities: the daily retry of failed steps */
export const repairSteps = (sql: SqlStorage): Step[] => pieceSteps(incompleteActivities(sql, REPAIR_ACTIVITIES));

/**
 * Outside backfill: a full page of only new activities (none has activity_detail) once history is loaded means
 * a gap longer than a page, so the next page follows; the chain ends at a known activity or a short page
 */
function applyActivities(sql: SqlStorage, s: ActivitiesStep, items: Item[], at: string): StepResult {
  let n = upsertRecords(sql, "activity", items, at);
  const pieces = missingPieces(sql, items.map((i) => i.key));
  const newSteps = pieceSteps(pieces);
  if (s.backfill) {
    n += patchState(sql, "activity", {
      backfill_cursor: String(s.start + items.length), backfill_done_at: items.length < s.limit ? at : undefined,
    });
    return done(n, newSteps);
  }
  n += patchState(sql, "activity", { last_success_at: at, last_error: null });
  if (items.length === s.limit && pieces.every((p) => p.missing.includes("activity_detail"))
    && allStates(sql).get("activity")?.backfill_done_at) {
    newSteps.push({ kind: "activities", start: s.start + s.limit, limit: s.limit, backfill: false });
  }
  return done(n, newSteps);
}

/** Profile time zone; "UTC" without a profile or with an invalid zone */
export function userTimeZone(sql: SqlStorage): string {
  const tz = sql.exec("SELECT data->>'$.timeZone' AS tz FROM records WHERE dataset = 'profile' AND key = 'current'")
    .toArray()[0]?.tz;
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** day datasets × dates [today-days+1 … today]; range datasets in one window; the first page of activities */
export function recentSteps(today: string, days: number): Step[] {
  const start = addDays(today, 1 - days);
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  return [
    ...DATASETS.filter((d) => d.kind === "day")
      .flatMap((d) => dates.map((x): Step => ({ kind: "dataset", id: d.id, start: x, end: x, backfill: false }))),
    ...DATASETS.filter((d) => d.kind === "range")
      .map((d): Step => ({ kind: "dataset", id: d.id, start, end: today, backfill: false })),
    { kind: "activities", start: 0, limit: ACTIVITY_PAGE, backfill: false },
  ];
}

export function staticSteps(today: string): Step[] {
  return DATASETS.filter((d) => d.kind === "static")
    .map((d): Step => ({ kind: "dataset", id: d.id, start: today, end: today, backfill: false }));
}

/**
 * The first in BACKFILL_ORDER without backfill_done_at and without an error in the last hour. Day-keyed datasets need
 * the history start: until it is known, a search step (a calendar year, from BACKFILL_FLOOR up); then windows from
 * yesterday down to the start.
 */
export function nextBackfillStep(states: Map<string, SyncState>, today: string, now: Date): Step | null {
  const failing = (st?: SyncState) => !!st?.last_error_at && now.getTime() - Date.parse(st.last_error_at) < ERROR_SKIP_MS;
  const hist = states.get(HISTORY);
  for (const id of BACKFILL_ORDER) {
    const st = states.get(id);
    if (st?.backfill_done_at || failing(st)) continue;
    if (id === "activity") return { kind: "activities", start: Number(st?.backfill_cursor ?? 0), limit: ACTIVITY_PAGE, backfill: true };
    if (!hist?.backfill_done_at) return failing(hist) ? null : yearStep(hist?.backfill_cursor ?? BACKFILL_FLOOR, today);
    const floor = hist.backfill_cursor!;
    const end = st?.backfill_cursor ?? addDays(today, -1);
    if (end < floor) continue;
    const start = addDays(end, 1 - (st?.window_days ?? dataset(id).window));
    return { kind: "dataset", id, start: start < floor ? floor : start, end, backfill: true };
  }
  return null;
}

/** A year of the history start search: from start to December 31, no later than yesterday */
function yearStep(start: string, today: string): HistoryStep {
  const yearEnd = `${start.slice(0, 4)}-12-31`, yesterday = addDays(today, -1);
  return { kind: "history_start", start, end: yearEnd < yesterday ? yearEnd : yesterday };
}
