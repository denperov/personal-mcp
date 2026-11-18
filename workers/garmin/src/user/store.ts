import type { Item } from "../garmin/catalog";
import { TYPED } from "./schema";

// All synchronous; one statement per exec. Writes run inside exec itself, so rowsWritten is available right away.

export interface SyncState {
  dataset: string; last_success_at: string | null; last_error: string | null; last_error_at: string | null;
  backfill_cursor: string | null; backfill_done_at: string | null; window_days: number | null;
}
const STATE_COLS = ["last_success_at", "last_error", "last_error_at", "backfill_cursor", "backfill_done_at", "window_days"] as const;

const UPSERT_RECORD = `INSERT INTO records(dataset, key, day, data, fetched_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(dataset, key) DO UPDATE SET day = excluded.day, data = excluded.data, fetched_at = excluded.fetched_at
  WHERE excluded.data IS NOT records.data`;

// dataset → INSERT … SELECT from a single records row (params: dataset, key)
const MATERIALIZE = new Map<string, string>(TYPED.map((t) => {
  const names = t.columns.map(([c]) => c);
  const set = names.filter((c) => c !== t.pk).map((c) => `${c} = excluded.${c}`).join(", ");
  return [t.dataset, `INSERT INTO ${t.name}(${names.join(", ")}) SELECT ${t.columns.map(([, e]) => e).join(", ")}
    FROM records WHERE dataset = ? AND key = ? ON CONFLICT(${t.pk}) DO UPDATE SET ${set}`];
}));

// SQLite caps a row at 8 MB (2M UTF-16 units are at most 6 MB of UTF-8); 2M also keeps reads and CPU sane
export const MAX_RECORD_JSON = 2_000_000;

/** A larger item is kept only as a size marker: the row exists, so the step is not refetched forever */
function recordJson(data: unknown): string {
  const json = JSON.stringify(data);
  if (json.length <= MAX_RECORD_JSON) return json;
  return JSON.stringify({ omitted: "too_large", bytes: new TextEncoder().encode(json).byteLength });
}

/** Σ rowsWritten: records + materialization of the changed ones */
export function upsertRecords(sql: SqlStorage, dataset: string, items: Item[], fetchedAt: string): number {
  const mat = MATERIALIZE.get(dataset);
  let n = 0;
  for (const it of items) {
    const w = sql.exec(UPSERT_RECORD, dataset, it.key, it.day, recordJson(it.data), fetchedAt).rowsWritten;
    n += w;
    if (w > 0 && mat) n += sql.exec(mat, dataset, it.key).rowsWritten;
  }
  return n;
}

export function allStates(sql: SqlStorage): Map<string, SyncState> {
  const rows = sql.exec("SELECT * FROM sync_state").toArray() as unknown as SyncState[];
  return new Map(rows.map((r) => [r.dataset, r]));
}

/** upsert of the passed columns only: undefined skips, null writes NULL */
export function patchState(sql: SqlStorage, dataset: string, patch: Partial<Omit<SyncState, "dataset">>): number {
  const cols = STATE_COLS.filter((c) => patch[c] !== undefined);
  if (!cols.length) return 0;
  return sql.exec(
    `INSERT INTO sync_state(dataset, ${cols.join(", ")}) VALUES (?${", ?".repeat(cols.length)})
      ON CONFLICT(dataset) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    dataset, ...cols.map((c) => patch[c]),
  ).rowsWritten;
}

export type ActivityPiece = "activity_detail" | "activity_workouts";
export interface Pieces { id: string; missing: ActivityPiece[] }

// A piece exists if its row exists (primary key lookup)
const HAS: [ActivityPiece, (id: string) => string][] = [
  ["activity_detail", (id) => `EXISTS (SELECT 1 FROM records r WHERE r.dataset = 'activity_detail' AND r.key = ${id})`],
  ["activity_workouts", (id) => `EXISTS (SELECT 1 FROM records r WHERE r.dataset = 'activity_workouts' AND r.key = ${id})`],
];
const hasCols = (id: string) => HAS.map(([k, has]) => `${has(id)} AS ${k}`).join(", ");
const pieces = (rows: Record<string, SqlStorageValue>[]): Pieces[] =>
  rows.map((r) => ({ id: r.id as string, missing: HAS.map(([k]) => k).filter((k) => !r[k]) }));

/** For each id, in input order, which pieces are missing; one bind parameter for any number of ids */
export function missingPieces(sql: SqlStorage, activityIds: string[]): Pieces[] {
  return pieces(sql.exec(`SELECT j.value AS id, ${hasCols("j.value")} FROM json_each(?) j ORDER BY j.key`,
    JSON.stringify(activityIds)).toArray());
}

/**
 * Up to limit newest activities that lack at least one piece. Primary keys only, no JSON;
 * ponytail: with no gaps it scans the whole activities table (2 PK lookups per row); a cursor if CPU measurements show a problem (docs/architecture.md, section "Platform limits")
 */
export function incompleteActivities(sql: SqlStorage, limit: number): Pieces[] {
  return pieces(sql.exec(`SELECT a.activity_id AS id, ${hasCols("a.activity_id")} FROM activities a
    WHERE NOT (${HAS.map(([, has]) => has("a.activity_id")).join(" AND ")}) ORDER BY a.day DESC, a.start_local DESC LIMIT ?`,
  limit).toArray());
}
