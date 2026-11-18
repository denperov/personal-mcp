import { addDays } from "./dates";

export type DatasetId =
  | "daily_summary" | "hrv" | "heart_rate" | "spo2" | "nutrition" | "cycle_summary" | "cycle_day" | "fitness_age"
  | "daily_summary_v2" | "steps" | "stress" | "hydration" | "sleep" | "body_battery" | "wellness_activity" | "weight"
  | "profile" | "hr_zones" | "weight_goal";

export interface Item { key: string; day: string | null; data: unknown }
export interface Dataset {
  id: DatasetId;
  kind: "day" | "range" | "static";
  window: number;
  path(start: string, end: string, today: string): string;
  items(json: unknown, start: string, end: string): Item[];
}

/** Tuning knob: change only after a new CPU measurement, see docs/architecture.md, section "Platform limits" */
export const ACTIVITY_PAGE = 20;

const META_EXACT = new Set([
  "userProfileId", "userProfilePk", "userProfilePK", "displayName", "calendarDate", "date", "summaryDate", "uuid", "id",
  "source", "includesWellnessData", "includesActivityData", "includesCalorieConsumedData", "deviceRemCapable", "retro",
  "mealDate", "dayStartTime", "dayEndTime", "dailyNutritionGoals", "userDailySummaryId", "lastSyncTimestampGMT",
  "durationInMilliseconds",
]);
const META_RE = [/^(start|end)\w*Timestamp\w*(GMT|Local)$/, /^wellness(Start|End)Time(Gmt|Local)$/];
const isMeta = (k: string) => META_EXACT.has(k) || META_RE.some((r) => r.test(k));

export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Has a non-empty top-level field that is not metadata (see isMeta) */
export function hasData(item: unknown): boolean {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  return Object.entries(item).some(([k, v]) => !isMeta(k) && hasValue(v));
}

type Row = Record<string, unknown>;
const rec = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});

const dayItems = (json: unknown, start: string): Item[] =>
  hasData(json) ? [{ key: start, day: start, data: json }] : [];

const rangeItems = (rows: unknown, field: string): Item[] =>
  (Array.isArray(rows) ? rows : []).flatMap((r) => {
    const d = rec(r)[field];
    return typeof d === "string" && hasData(r) ? [{ key: d, day: d, data: r }] : [];
  });

const staticItems = (json: unknown): Item[] => (hasValue(json) ? [{ key: "current", day: null, data: json }] : []);

// Day of a wellness_activity item: first 10 characters of calendarDate | calendarDate.localDate | calendarDate.date
function wellnessDay(r: unknown): string | null {
  const c = rec(r).calendarDate;
  for (const v of [c, rec(c).localDate, rec(c).date]) if (typeof v === "string" && v.length >= 10) return v.slice(0, 10);
  return null;
}

function wellnessItems(rows: unknown): Item[] {
  const groups = new Map<string, unknown[]>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = wellnessDay(r);
    if (d) groups.set(d, [...(groups.get(d) ?? []), r]);
  }
  return [...groups].filter(([, g]) => g.some(hasData)).map(([d, g]) => ({ key: d, day: d, data: g }));
}

const day = (id: DatasetId, path: (d: string, t: string) => string): Dataset => ({
  id, kind: "day", window: 1, path: (s, _e, t) => path(s, t), items: (j, s) => dayItems(j, s),
});
const range = (id: DatasetId, window: number, path: (s: string, e: string) => string, items: (j: unknown) => Item[]): Dataset => ({
  id, kind: "range", window, path: (s, e) => path(s, e), items: (j) => items(j),
});
const fixed = (id: DatasetId, path: (t: string) => string): Dataset => ({
  id, kind: "static", window: 0, path: (_s, _e, t) => path(t), items: (j) => staticItems(j),
});

// Not synced: dailySleep (same shape as sleep), hrv/daily (a subset of hrv), weight/all (always 400).
// Activities are not here: their endpoints and steps live in user/engine.ts.
export const DATASETS: Dataset[] = [
  day("daily_summary", (d) => `/usersummary-service/usersummary/daily?calendarDate=${d}`),
  day("hrv", (d) => `/hrv-service/hrv/${d}`),
  day("heart_rate", (d) => `/wellness-service/wellness/dailyHeartRate?date=${d}`),
  day("spo2", (d) => `/wellness-service/wellness/daily/spo2acclimation/${d}`),
  day("nutrition", (d) => `/nutrition-service/food/logs/${d}`),
  day("cycle_summary", (d) => `/periodichealth-service/menstrualcycle/summary/${d}`),
  day("cycle_day", (d, t) => `/periodichealth-service/menstrualcycle/dayview/${d}?todayDate=${t}`),
  day("fitness_age", (d) => `/fitnessage-service/fitnessage/v2/${d}`),
  range("daily_summary_v2", 31, (s, e) => `/usersummary-service/v2/dailysummaries?startDate=${s}&endDate=${e}`,
    (j) => rangeItems(rec(j).data, "calendarDate")),
  range("steps", 28, (s, e) => `/usersummary-service/stats/steps/daily/${s}/${e}`, (j) => rangeItems(j, "calendarDate")),
  range("stress", 28, (s, e) => `/usersummary-service/stats/stress/daily/${s}/${e}`, (j) => rangeItems(j, "calendarDate")),
  range("hydration", 31, (s, e) => `/usersummary-service/stats/hydration/daily/${s}/${e}`, (j) => rangeItems(j, "calendarDate")),
  range("sleep", 31, (s, e) => `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${s}&endDate=${e}`,
    (j) => rangeItems(j, "calendarDate")),
  range("body_battery", 31, (s, e) => `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${s}&endDate=${e}`,
    (j) => rangeItems(j, "date")),
  range("wellness_activity", 31, (s, e) => `/wellnessactivity-service/activity/summary/range/${s}/${e}`, wellnessItems),
  range("weight", 365, (s, e) => `/weight-service/weight/range/${s}/${e}?includeAll=true`,
    (j) => rangeItems(rec(j).dailyWeightSummaries, "summaryDate")),
  fixed("profile", () => "/userprofile-service/userprofile/settings"),
  fixed("hr_zones", () => "/biometric-service/heartRateZones/v2"),
  fixed("weight_goal", (t) => `/goal-service/goal/user/effective/weightgoal/${addDays(t, -365)}/${t}`),
];

export function dataset(id: DatasetId): Dataset {
  const d = DATASETS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown dataset ${id}`);
  return d;
}
