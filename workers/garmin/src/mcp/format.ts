import { DATASETS } from "../garmin/catalog";
import { allStates } from "../user/store";

export const MAX_TOOL_CHARS = 100_000; // tuning knob: change only after a new CPU measurement, see docs/architecture.md, section "Platform limits"

export const INTRADAY_KEYS: string[] = [
  "heartRateValues", "heartRateValueDescriptors", "abnormalHRValuesArray", "bodyBatteryValuesArray",
  "bodyBatteryValueDescriptorDTOList", "spO2SingleValues", "spO2SingleValuesDescriptorList", "spO2HourlyAverages",
  "spO2HourlyAveragesDescriptorList", "monitoringEnvironmentValues", "monitoringEnvironmentValuesDescriptorList", "hrvReadings",
];

const HOUR_MS = 3_600_000, KEY_WARN_MS = 14 * 24 * HOUR_MS;
// static datasets sync once a day, so their threshold is 26 h; for the rest (and activity) it is 3 h
const STATIC: string[] = DATASETS.filter((d) => d.kind === "static").map((d) => d.id);

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "object" && Object.keys(v).length === 0);

/** Recursively removes null/undefined/[]/{} fields; array elements are never dropped, since tuple positions matter */
export function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compact);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const c = compact(x);
    if (!isEmpty(c)) out[k] = c;
  }
  return out;
}

/** Recursively removes the INTRADAY_KEYS keys */
export function stripIntraday(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIntraday);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !INTRADAY_KEYS.includes(k)).map(([k, x]) => [k, stripIntraday(x)]));
}

export function toolText(data: unknown, warnings: string[], maxChars = MAX_TOOL_CHARS): string {
  const s = JSON.stringify(warnings.length ? { warnings, data } : { data });
  return s.length <= maxChars ? s
    : `${s.slice(0, maxChars)}\n…[truncated: ${s.length} chars total; narrow the range or use query_sql]`;
}

export interface KeyInfo { expiresAt: string; present: boolean; settingsUrl: string }

/** One query to sync_state. Always warns about the key; about datasets, only the ones passed in */
export function warningsFor(sql: SqlStorage, datasets: string[], now: Date, key: KeyInfo): string[] {
  const states = allStates(sql);
  const out: string[] = [];
  const keyError = states.get("_key")?.last_error;
  // Without a key, only "not connected": an old _key error left after the key was deleted would contradict it
  if (!key.present) out.push(`Garmin is not connected or the key was deleted; add a key at ${key.settingsUrl}`);
  else {
    if (keyError) out.push(`Garmin API key: ${keyError}; replace it at ${key.settingsUrl}`);
    if (key.expiresAt && Date.parse(key.expiresAt) - now.getTime() <= KEY_WARN_MS) {
      out.push(`Garmin API key expires on ${key.expiresAt}; replace it at ${key.settingsUrl}`);
    }
  }
  for (const ds of datasets) {
    const s = states.get(ds);
    if (!s?.last_success_at) out.push(`${ds}: not synced yet`);
    else if (now.getTime() - Date.parse(s.last_success_at) > (STATIC.includes(ds) ? 26 : 3) * HOUR_MS) {
      out.push(`${ds}: data is stale since ${s.last_success_at}; last error: ${s.last_error ?? "none"}`);
    }
  }
  return out;
}
