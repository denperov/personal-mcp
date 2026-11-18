import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { addDays } from "../src/garmin/dates";
import { MIGRATIONS } from "../src/user/schema";
import { allStates, incompleteActivities, missingPieces, patchState, putFile, upsertRecords } from "../src/user/store";

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

const ALL = ["activity_detail", "activity_workouts", "activity_file"];

it("missingPieces", async () => {
  const r = await inDo(newStub(), (sql) => {
    upsertRecords(sql, "activity_detail", [{ key: "2", day: null, data: { activityId: 2 } }], T);
    upsertRecords(sql, "activity_workouts", [{ key: "3", day: null, data: [] }], T);
    putFile(sql, { activityId: "3", r2Key: null, status: 404, bytes: null, fetchedAt: T }); // 4xx: no file is an answer
    putFile(sql, { activityId: "4", r2Key: "u/x/activities/4.zip", status: 200, bytes: 1, fetchedAt: T });
    upsertRecords(sql, "activity_detail", [{ key: "4", day: null, data: {} }], T);
    upsertRecords(sql, "activity_workouts", [{ key: "4", day: null, data: [] }], T);
    return [missingPieces(sql, ["1", "2", "3", "4"]), missingPieces(sql, ["3", "1"]), missingPieces(sql, [])];
  });
  expect(r).toEqual([
    [{ id: "1", missing: ALL }, { id: "2", missing: ["activity_workouts", "activity_file"] },
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
      putFile(sql, { activityId: k, r2Key: null, status: 404, bytes: null, fetchedAt: T });
    }
    putFile(sql, { activityId: "4", r2Key: null, status: 500, bytes: null, fetchedAt: T });
    return [incompleteActivities(sql, 3), incompleteActivities(sql, 10).map((a) => a.id)];
  });
  expect(r).toEqual([
    [{ id: "6", missing: ALL }, { id: "4", missing: ["activity_detail", "activity_workouts"] }, { id: "2", missing: ALL }],
    ["6", "4", "2", "1"],
  ]);
});

it("files upsert by activity_id", async () => {
  const r = await inDo(newStub(), (sql) => {
    putFile(sql, { activityId: "1", r2Key: null, status: 404, bytes: null, fetchedAt: T });
    putFile(sql, { activityId: "1", r2Key: "u/x/activities/1.zip", status: 200, bytes: 10, fetchedAt: T });
    return sql.exec("SELECT * FROM files").toArray();
  });
  expect(r).toEqual([{ activity_id: "1", r2_key: "u/x/activities/1.zip", status: 200, bytes: 10, fetched_at: T }]);
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
