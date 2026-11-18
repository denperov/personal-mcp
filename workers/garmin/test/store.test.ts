import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { addDays } from "../src/garmin/dates";
import { migrate, MIGRATIONS } from "../src/user/schema";
import { allStates, incompleteActivities, MAX_RECORD_JSON, missingPieces, patchState, upsertRecords } from "../src/user/store";

const T = "2026-10-28T00:00:00.000Z";
const newStub = () => env.USER_DO.getByName(`t-${crypto.randomUUID()}@x`);
const inDo = <R>(stub: DurableObjectStub, f: (sql: SqlStorage, st: DurableObjectState) => R) =>
  runInDurableObject(stub, (_i, st) => f(st.storage.sql, st));
const day = (key: string, data: unknown) => ({ key, day: key, data });

it("migrate is idempotent across eviction", async () => {
  const stub = newStub();
  expect(await stub.ping()).toBe("pong");
  await inDo(stub, (sql) => upsertRecords(sql, "hrv", [day("2026-10-27", { hrvSummary: { lastNightAvg: 50 } })], T));
  await evictDurableObject(stub);
  const r = await inDo(stub, (sql) => ({
    v: sql.exec("SELECT max(version) AS v FROM _schema").one().v,
    rows: sql.exec("SELECT key FROM records").toArray(),
    hrv: sql.exec("SELECT day, hrv_last_night FROM hrv").toArray(),
  }));
  expect(r).toEqual({ v: MIGRATIONS.length, rows: [{ key: "2026-10-27" }], hrv: [{ day: "2026-10-27", hrv_last_night: 50 }] });
});

it("v2 drops the files table, queued file steps and R2 stubs, and keeps the rest", async () => {
  const r = await inDo(newStub(), (sql, st) => {
    // a v1 store as the old code left it
    sql.exec("DELETE FROM _schema WHERE version > 1");
    sql.exec(MIGRATIONS[0].find((s) => s.includes("TABLE files("))!);
    sql.exec("INSERT INTO files VALUES ('7', 'u/x/activities/7.zip', 200, 4, ?)", T);
    for (const step of [{ kind: "activity_file", activityId: "7" }, { kind: "activity_detail", activityId: "7" }]) {
      sql.exec("INSERT INTO queue(key, priority, step) VALUES (?, 1, ?)", `${step.kind}:7`, JSON.stringify(step));
    }
    upsertRecords(sql, "activity_detail", [{ key: "7", day: null, data: { r2_key: "u/x/json/activity_detail/7.json", bytes: 300_000 } }], T);
    upsertRecords(sql, "activity_detail", [{ key: "8", day: null, data: { activityId: 8 } }], T);
    upsertRecords(sql, "activity_workouts", [{ key: "8", day: null, data: [] }], T);
    upsertRecords(sql, "hrv", [day("2026-10-27", { hrvSummary: { lastNightAvg: 50 } })], T);
    migrate(st.storage);
    return {
      v: sql.exec("SELECT max(version) AS v FROM _schema").one().v,
      files: sql.exec("SELECT name FROM sqlite_master WHERE name = 'files'").toArray(),
      queue: sql.exec("SELECT key FROM queue").toArray(),
      records: sql.exec("SELECT dataset, key FROM records ORDER BY dataset, key").toArray(),
    };
  });
  expect(r).toEqual({
    v: 2, files: [], queue: [{ key: "activity_detail:7" }],
    records: [{ dataset: "activity_detail", key: "8" }, { dataset: "activity_workouts", key: "8" }, { dataset: "hrv", key: "2026-10-27" }],
  });
});

it("an item over MAX_RECORD_JSON is stored as a size marker", async () => {
  const str = (jsonLength: number, ch = "x") => ch.repeat(jsonLength - 2); // JSON.stringify adds two quotes
  const r = await inDo(newStub(), (sql) => {
    upsertRecords(sql, "heart_rate", [day("2026-10-26", str(MAX_RECORD_JSON)), day("2026-10-27", str(MAX_RECORD_JSON + 1, "é"))], T);
    return sql.exec<{ key: string; data: string }>("SELECT key, data FROM records ORDER BY key").toArray()
      .map((x) => [x.key, x.data.length > 100 ? x.data.length : JSON.parse(x.data)]);
  });
  expect(r).toEqual([
    ["2026-10-26", MAX_RECORD_JSON],
    ["2026-10-27", { omitted: "too_large", bytes: 2 * MAX_RECORD_JSON }], // UTF-8 bytes: é is 2 bytes, quotes 1 each
  ]);
});

it("upsert replaces by (dataset,key); unchanged data writes 0 rows", async () => {
  const r = await inDo(newStub(), (sql) => {
    const put = (data: unknown) => upsertRecords(sql, "daily_summary", [day("2026-10-27", data)], T);
    const w = [put({ totalSteps: 1 }), put({ totalSteps: 2 }), put({ totalSteps: 2 })];
    return { w, rows: sql.exec("SELECT data FROM records").toArray(), daily: sql.exec("SELECT steps FROM daily").toArray() };
  });
  expect(r.w[0]).toBeGreaterThan(0);
  expect(r.w[1]).toBeGreaterThan(0);
  expect(r.w[2]).toBe(0);
  expect(r.rows).toEqual([{ data: '{"totalSteps":2}' }]);
  expect(r.daily).toEqual([{ steps: 2 }]);
});

it("365 items in one call", async () => {
  const items = Array.from({ length: 365 }, (_, i) => day(addDays("2025-10-28", i), { totalSteps: i }));
  const r = await inDo(newStub(), (sql) => ({
    w: upsertRecords(sql, "daily_summary", items, T),
    records: sql.exec("SELECT COUNT(*) AS n FROM records").one().n,
    daily: sql.exec("SELECT COUNT(*) AS n FROM daily").one().n,
  }));
  expect(r).toEqual({ w: 730, records: 365, daily: 365 }); // a record write + a materialization per item
});

it("typed tables are materialized", async () => {
  const r = await inDo(newStub(), (sql) => {
    upsertRecords(sql, "sleep", [day("2026-10-27", { sleepScores: { overall: { value: 70 } } })], T);
    upsertRecords(sql, "sleep", [day("2026-10-27", { sleepScores: { overall: { value: 80 } } })], T);
    upsertRecords(sql, "weight", [day("2026-10-27", { latestWeight: { weight: 82300 } })], T);
    upsertRecords(sql, "activity", [{ key: "1", day: "2026-10-27", data: { activityTrainingLoad: 120.5, activityType: { typeKey: "running" } } }], T);
    return {
      sleep: sql.exec("SELECT day, sleep_score FROM sleep").toArray(),
      weight: sql.exec("SELECT day, weight_kg FROM weight").toArray(),
      activities: sql.exec("SELECT activity_id, day, type, training_load FROM activities").toArray(),
    };
  });
  expect(r).toEqual({
    sleep: [{ day: "2026-10-27", sleep_score: 80 }],
    weight: [{ day: "2026-10-27", weight_kg: 82.3 }],
    activities: [{ activity_id: "1", day: "2026-10-27", type: "running", training_load: 120.5 }],
  });
});

it("states", async () => {
  const r = await inDo(newStub(), (sql) => {
    const before = allStates(sql);
    patchState(sql, "steps", { last_success_at: T, backfill_cursor: "2026-01-01", window_days: 14 });
    patchState(sql, "steps", { last_error: "boom", backfill_cursor: null, window_days: undefined });
    return { had: before.has("steps"), state: allStates(sql).get("steps") };
  });
  expect(r).toEqual({
    had: false,
    state: {
      dataset: "steps", last_success_at: T, last_error: "boom", last_error_at: null,
      backfill_cursor: null, backfill_done_at: null, empty_streak_days: 0, window_days: 14,
    },
  });
});

const ALL = ["activity_detail", "activity_workouts"];

it("missingPieces", async () => {
  const r = await inDo(newStub(), (sql) => {
    upsertRecords(sql, "activity_detail", [{ key: "2", day: null, data: { activityId: 2 } }], T);
    upsertRecords(sql, "activity_workouts", [{ key: "3", day: null, data: [] }], T);
    upsertRecords(sql, "activity_detail", [{ key: "4", day: null, data: {} }], T);
    upsertRecords(sql, "activity_workouts", [{ key: "4", day: null, data: [] }], T);
    return [missingPieces(sql, ["1", "2", "3", "4"]), missingPieces(sql, ["3", "1"]), missingPieces(sql, [])];
  });
  expect(r).toEqual([
    [{ id: "1", missing: ALL }, { id: "2", missing: ["activity_workouts"] },
      { id: "3", missing: ["activity_detail"] }, { id: "4", missing: [] }],
    [{ id: "3", missing: ["activity_detail"] }, { id: "1", missing: ALL }],
    [],
  ]);
});

it("incompleteActivities: newest first, complete ones skipped, bounded", async () => {
  const r = await inDo(newStub(), (sql) => {
    upsertRecords(sql, "activity", ["1", "2", "3", "4", "5"].map((k) =>
      ({ key: k, day: `2026-10-0${k}`, data: { startTimeLocal: `2026-10-0${k} 07:00:00` } })), T);
    upsertRecords(sql, "activity", [{ key: "6", day: "2026-10-05", data: { startTimeLocal: "2026-10-05 18:00:00" } }], T);
    for (const k of ["5", "3"]) {
      upsertRecords(sql, "activity_detail", [{ key: k, day: null, data: {} }], T);
      upsertRecords(sql, "activity_workouts", [{ key: k, day: null, data: [] }], T);
    }
    upsertRecords(sql, "activity_workouts", [{ key: "4", day: null, data: [] }], T);
    return [incompleteActivities(sql, 3), incompleteActivities(sql, 10).map((a) => a.id)];
  });
  expect(r).toEqual([
    [{ id: "6", missing: ALL }, { id: "4", missing: ["activity_detail"] }, { id: "2", missing: ALL }],
    ["6", "4", "2", "1"],
  ]);
});

it("kv is not reachable from SQL", async () => {
  const r = await inDo(newStub(), (sql, st) => {
    st.storage.kv.put("token", { t: "jwt", exp: 1 });
    let threw = false;
    try { sql.exec("SELECT * FROM _cf_KV").toArray(); } catch { threw = true; }
    return { threw, kv: st.storage.kv.get("token") };
  });
  expect(r).toEqual({ threw: true, kv: { t: "jwt", exp: 1 } });
});
