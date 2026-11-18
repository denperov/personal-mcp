import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkReadOnlySql, readOnlyQuery } from "../src/mcp/sqlguard";
import { compact, stripIntraday, toolText, warningsFor } from "../src/mcp/format";
import {
  describeSchema, getActivity, getBody, getDailySeries, getDay, getIntraday, getNutrition, getProfile, getWomensHealth,
  searchActivities, syncStatus,
} from "../src/mcp/queries";
import { patchState, upsertRecords } from "../src/user/store";
import { HISTORY } from "../src/user/engine";

const T = "2026-10-28T00:00:00.000Z";
const NOW = new Date("2026-10-28T12:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const inDo = <R>(f: (sql: SqlStorage, st: DurableObjectState) => R | Promise<R>) =>
  runInDurableObject(env.USER_DO.getByName(`t-${crypto.randomUUID()}@x`), (_i, st) => f(st.storage.sql, st));
const day = (key: string, data: unknown) => ({ key, day: key, data });
const count = (sql: SqlStorage) => sql.exec("SELECT COUNT(*) AS n FROM records").one().n;

describe("checkReadOnlySql", () => {
  it("accepts reads", () => {
    for (const s of ["SELECT 1", "WITH x AS (SELECT 2 AS v) SELECT v FROM x -- c", "select 'insert' as s",
      "SELECT replace('a','a','b');", "SELECT data->>'$.a' FROM records",
      "SELECT 'a;b' AS s", "SELECT 1 -- ; DROP TABLE records", "SELECT [delete], \"update\" FROM t", "SELECT 1; -- done",
      "VALUES (1)", "SELECT updated_at FROM t", "SELECT * FROM pragma_table_info('activities')", "SELECT 'it''s'"])
      expect(checkReadOnlySql(s).ok, s).toBe(true);
  });

  it("rejects writes, extra statements and unterminated text", () => {
    for (const s of ["DELETE FROM records", "WITH a AS (SELECT 1) INSERT INTO records VALUES (1,1,1,1,1)",
      "SELECT 1; DROP TABLE records", "PRAGMA table_info(records)",
      "SELECT 1); INSERT INTO files VALUES ('x',NULL,0,0,'t'); SELECT (1", "UPDATE sync_state SET last_error='x'",
      "WITH a AS (SELECT 1) REPLACE INTO records VALUES (1,1,1,1,1)", "SELECT 1;;", "(SELECT 1)", "EXPLAIN SELECT 1",
      "SELECT 1 /* open", "SELECT 'open", "SELECT 1 /* ; */ ; DELETE FROM records", "WITH x AS (DELETE FROM t RETURNING *) SELECT 1",
      "SELECT 1\0", ""])
      expect(checkReadOnlySql(s).ok, s).toBe(false);
  });

  it("strips the trailing semicolon", () => {
    expect(checkReadOnlySql("SELECT replace('a','a','b');")).toEqual({ ok: true, sql: "SELECT replace('a','a','b')" });
  });
});

describe("readOnlyQuery", () => {
  it("limits rows and never leaves a write behind", async () => {
    const r = await inDo((sql, st) => {
      upsertRecords(sql, "steps", ["01", "02", "03", "04", "05"].map((d) => day(`2026-10-${d}`, { totalSteps: 1 })), T);
      const two = readOnlyQuery(st.storage, "SELECT key FROM records", 2, 100_000);
      let bypass: unknown = null;
      try {
        bypass = readOnlyQuery(st.storage, "SELECT 1); DELETE FROM records; SELECT (1", 10, 1000);
      } catch (e) {
        bypass = e;
      }
      expect(() => readOnlyQuery(st.storage, "SELECT * FROM _cf_KV", 10, 1000)).toThrow();
      return { two, bypass: bypass !== null, n: count(sql) };
    });
    expect(r.two.columns).toEqual(["key"]);
    expect(r.two.rows.length).toBe(2);
    expect(r.two.truncated).toBe(true);
    expect(r.bypass).toBe(true);
    expect(r.n).toBe(5);
  });

  it("truncates by size", async () => {
    const r = await inDo((_sql, st) => readOnlyQuery(st.storage,
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) SELECT i FROM n", 5000, 1000));
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(1000);
  });

  it("returns everything when it fits", async () => {
    const r = await inDo((_sql, st) => readOnlyQuery(st.storage, "VALUES (1, 'a'), (2, 'b')", 10, 1000));
    expect(r).toMatchObject({ columns: ["column1", "column2"], rows: [[1, "a"], [2, "b"]], truncated: false });
  });
});

describe("format", () => {
  it("compact and stripIntraday", () => {
    expect(compact({ a: null, b: [], c: { d: {} }, e: 0 })).toEqual({ e: 0 });
    expect(compact({ v: [[1, null]], s: "" })).toEqual({ v: [[1, null]], s: "" }); // array positions do not shift
    expect(stripIntraday({ heartRateValues: [1], restingHeartRate: 58 })).toEqual({ restingHeartRate: 58 });
    expect(stripIntraday([{ x: { hrvReadings: [1], a: 1 } }])).toEqual([{ x: { a: 1 } }]);
  });

  it("toolText truncates", () => {
    const t = toolText("x".repeat(200_000), []);
    expect(t.length).toBeLessThanOrEqual(100_200);
    expect(t).toContain("[truncated: ");
    expect(JSON.parse(toolText({ a: 1 }, ["w"]))).toEqual({ warnings: ["w"], data: { a: 1 } });
    expect(JSON.parse(toolText({ a: 1 }, []))).toEqual({ data: { a: 1 } });
  });

  it("warningsFor", async () => {
    const r = await inDo((sql) => {
      patchState(sql, "daily_summary", { last_success_at: ago(4), last_error: "HTTP 500" });
      patchState(sql, "sleep", { last_success_at: ago(1) });
      patchState(sql, "profile", { last_success_at: ago(4) });
      patchState(sql, "hr_zones", { last_success_at: ago(27) });
      patchState(sql, "hrv", { last_error: "HTTP 500" });
      const key = (expiresAt: string, present = true) => ({ expiresAt, present, settingsUrl: "https://h/garmin/settings" });
      const all = warningsFor(sql, ["daily_summary", "sleep", "profile", "hr_zones", "hrv", "spo2"], NOW, key("2026-11-07"));
      const quiet = warningsFor(sql, [], NOW, key("2026-12-31"));
      patchState(sql, "_key", { last_error: "key_rejected" });
      return { all, quiet, key: warningsFor(sql, [], NOW, key("")), none: warningsFor(sql, ["sleep"], NOW, key("2026-11-07", false)) };
    });
    expect(r.all).toEqual([
      "Garmin API key expires on 2026-11-07; replace it at https://h/garmin/settings",
      "daily_summary: data is stale since 2026-10-28T08:00:00.000Z; last error: HTTP 500",
      "hr_zones: data is stale since 2026-10-27T09:00:00.000Z; last error: none",
      "hrv: not synced yet",
      "spo2: not synced yet",
    ]);
    expect(r.quiet).toEqual([]);
    expect(r.key).toEqual(["Garmin API key: key_rejected; replace it at https://h/garmin/settings"]);
    // no key: only "not connected", no _key or expiry warning, dataset warnings follow
    expect(r.none).toEqual(["Garmin is not connected or the key was deleted; add a key at https://h/garmin/settings"]);
  });
});

describe("queries", () => {
  const seed = (sql: SqlStorage) => {
    upsertRecords(sql, "daily_summary", [day("2026-10-26", { restingHeartRate: 58 }), day("2026-10-27", { restingHeartRate: 61 }),
      day("2026-10-28", { restingHeartRate: 99 })], T);
    upsertRecords(sql, "sleep", [day("2026-10-27", { sleepScores: { overall: { value: 80 } } })], T);
    upsertRecords(sql, "heart_rate", [day("2026-10-27", { restingHeartRate: 58, heartRateValues: [[1, null]], extra: { a: 1 } })], T);
    upsertRecords(sql, "hrv", [day("2026-10-27", { hrvSummary: { lastNightAvg: 40 }, hrvReadings: [{ hrvValue: 41 }] })], T);
    upsertRecords(sql, "activity", [
      { key: "1", day: "2026-10-27", data: { activityTrainingLoad: 30, activityType: { typeKey: "running" }, distance: 6000 } },
      { key: "2", day: "2026-10-27", data: { activityTrainingLoad: 40, activityType: { typeKey: "cycling" }, distance: 20000 } },
      { key: "3", day: "2026-10-25", data: { activityTrainingLoad: 10, activityType: { typeKey: "running" }, distance: 3000 } },
    ], T);
  };

  it("getDailySeries merges typed tables by day", async () => {
    const r = await inDo((sql) => {
      seed(sql);
      return getDailySeries(sql, "2026-10-26", "2026-10-27", ["resting_hr", "training_load", "sleep_score"]);
    });
    expect(r).toEqual([
      { day: "2026-10-26", resting_hr: 58 },
      { day: "2026-10-27", resting_hr: 61, sleep_score: 80, training_load: 70 },
    ]);
  });

  it("searchActivities filters", async () => {
    const r = await inDo((sql) => {
      seed(sql);
      return {
        run5: searchActivities(sql, { type: "running", minDistanceKm: 5, limit: 10 }),
        all: searchActivities(sql, { from: "2026-10-26", limit: 10 }),
      };
    });
    expect(r.run5.map((a) => (a as { activity_id: string }).activity_id)).toEqual(["1"]);
    expect(r.all.map((a) => (a as { activity_id: string }).activity_id).sort()).toEqual(["1", "2"]);
  });

  it("getDay has no intraday arrays", async () => {
    const r = await inDo((sql) => {
      seed(sql);
      return getDay(sql, "2026-10-27") as Record<string, unknown>;
    });
    const s = JSON.stringify(r);
    expect(s).not.toContain("heartRateValues");
    expect(s).not.toContain("hrvReadings");
    expect(r).toMatchObject({ day: "2026-10-27", daily_summary: { restingHeartRate: 61 }, hrv: { hrvSummary: { lastNightAvg: 40 } } });
    expect((r.activities as unknown[]).length).toBe(2);
  });

  it("getIntraday returns arrays and scalars only", async () => {
    const r = await inDo((sql) => {
      seed(sql);
      return [getIntraday(sql, "2026-10-27", "heart_rate"), getIntraday(sql, "2026-10-27", "spo2")];
    });
    expect(r).toEqual([{ restingHeartRate: 58, heartRateValues: [[1, null]] }, null]);
  });

  it("getActivity reads the detail from R2 and drops splits on request", async () => {
    const r2Key = `u/${crypto.randomUUID()}/json/activity_detail/9.json`;
    await env.FILES.put(r2Key, JSON.stringify({ summaryDTO: { distance: 5000 }, splitSummaries: [{ n: 1 }], empty: null }));
    const r = await inDo(async (sql) => {
      upsertRecords(sql, "activity", [{ key: "9", day: "2026-10-27", data: { activityName: "Run" } }], T);
      upsertRecords(sql, "activity_detail", [{ key: "9", day: "2026-10-27", data: { r2_key: r2Key, bytes: 300_000 } }], T);
      upsertRecords(sql, "activity_workouts", [{ key: "9", day: null, data: [{ workoutId: 1 }] }], T);
      return {
        lean: await getActivity(sql, env.FILES, "9", { includeSplits: false, includeWorkout: false }),
        full: await getActivity(sql, env.FILES, "9", { includeSplits: true, includeWorkout: true }),
        none: await getActivity(sql, env.FILES, "404", { includeSplits: true, includeWorkout: true }),
      };
    });
    expect(r.lean).toEqual({ activity_id: "9", summary: { activityName: "Run" }, detail: { summaryDTO: { distance: 5000 } } });
    expect(r.full).toEqual({
      activity_id: "9", summary: { activityName: "Run" }, detail: { summaryDTO: { distance: 5000 }, splitSummaries: [{ n: 1 }] },
      workouts: [{ workoutId: 1 }],
    });
    expect(r.none).toBeNull();
  });

  it("body, nutrition, profile, women's health", async () => {
    const r = await inDo((sql) => {
      upsertRecords(sql, "weight", [day("2026-10-27", { latestWeight: { weight: 82300 } })], T);
      upsertRecords(sql, "weight_goal", [{ key: "current", day: null, data: { goalWeight: 78000 } }], T);
      upsertRecords(sql, "nutrition", [day("2026-10-27", { kcal: 2000 })], T);
      upsertRecords(sql, "hydration", [day("2026-10-27", { valueInML: 1500 }), day("2026-10-28", { valueInML: 900 })], T);
      upsertRecords(sql, "profile", [{ key: "current", day: null, data: { timeZone: "Asia/Tokyo" } }], T);
      upsertRecords(sql, "fitness_age", [day("2026-10-20", { fitnessAge: 44 }), day("2026-10-27", { fitnessAge: 43 })], T);
      upsertRecords(sql, "cycle_day", [day("2026-10-27", { dayInCycle: 3 })], T);
      return {
        body: getBody(sql, "2026-10-01", "2026-10-31"),
        nutrition: getNutrition(sql, "2026-10-27", "2026-10-28"),
        profile: getProfile(sql),
        womens: getWomensHealth(sql, "2026-10-27"),
      };
    });
    expect(r.body).toEqual({ weight: [{ day: "2026-10-27", weight_kg: 82.3 }], goal: { goalWeight: 78000 } });
    expect(r.nutrition).toEqual([
      { day: "2026-10-27", nutrition: { kcal: 2000 }, hydration: { valueInML: 1500 } },
      { day: "2026-10-28", hydration: { valueInML: 900 } },
    ]);
    expect(r.profile).toEqual({ profile: { timeZone: "Asia/Tokyo" }, fitness_age: { day: "2026-10-27", fitnessAge: 43 } });
    expect(r.womens).toEqual({ cycle_day: { dayInCycle: 3 } });
  });

  it("describeSchema hides internal tables", async () => {
    const r = await inDo((sql, st) => {
      st.storage.kv.put("x", 1);
      return {
        all: sql.exec<{ name: string }>("SELECT name FROM sqlite_master").toArray().map((o) => o.name),
        s: describeSchema(sql) as { objects: { name: string }[]; hints: string[] },
      };
    });
    const names = r.s.objects.map((o) => o.name);
    expect(r.all).toContain("_cf_KV");
    expect(names).toContain("activities");
    expect(names).not.toContain("_cf_KV");
    expect(names).not.toContain("_schema");
    expect(r.s.hints.length).toBeGreaterThan(0);
  });

  it("syncStatus", async () => {
    const r = await inDo((sql) => {
      patchState(sql, "_key", { last_error: "key_expires_within_24h" });
      patchState(sql, "steps", { last_success_at: T, backfill_cursor: "2026-01-01" });
      type S = {
        now: string; key: unknown; queue_size: number; paused_until?: string; history_start?: string; datasets: { dataset: string }[];
      };
      const s = (p?: number) => syncStatus(sql, NOW, { expiresAt: "2026-11-07", present: true }, 3, p) as S;
      patchState(sql, HISTORY, { backfill_cursor: "2001-01-01" });
      const searching = "history_start" in s();
      patchState(sql, HISTORY, { backfill_cursor: "2024-02-12", backfill_done_at: T });
      return { ...s(NOW.getTime() + 60_000), past: s(NOW.getTime() - 1).paused_until, none: "paused_until" in s(), searching,
        notConnected: (syncStatus(sql, NOW, { expiresAt: "", present: false }, 0) as S).key };
    });
    expect(r.paused_until).toBe("2026-10-28T12:01:00.000Z");
    expect(r.past).toBeUndefined();
    expect(r.none).toBe(false);
    expect(r.now).toBe(NOW.toISOString());
    expect(r.key).toEqual({ status: "key_expires_within_24h", expires_on: "2026-11-07" });
    expect(r.queue_size).toBe(3);
    expect(r.notConnected).toEqual({ status: "not_connected", expires_on: undefined });
    expect(r.searching).toBe(false);
    expect(r.history_start).toBe("2024-02-12");
    expect(r.datasets.find((d) => d.dataset === "steps")).toEqual({ dataset: "steps", last_success_at: T, backfill_cursor: "2026-01-01" });
    expect(r.datasets.find((d) => d.dataset === "activity")).toEqual({ dataset: "activity" });
    expect(r.datasets.some((d) => d.dataset === "_key" || d.dataset === HISTORY)).toBe(false);
  });
});
