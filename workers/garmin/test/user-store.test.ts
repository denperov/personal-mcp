import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { delay, http, HttpResponse } from "msw";
import { network } from "./setup";
import { fakeJwt, garminMock, TOKEN_URL } from "./garmin-mock";
import { DATASETS } from "../src/garmin/catalog";
import { addDays } from "../src/garmin/dates";
import { GARMIN_BASE } from "../src/garmin/client";
import { importKek, open, seal, type Sealed } from "../src/user/crypto";
import { BACKFILL_FLOOR, BACKFILL_ORDER, HISTORY, nextBackfillStep } from "../src/user/engine";
import { allStates, patchState, upsertRecords } from "../src/user/store";
import { KEY_PAUSE_MS, kickOffset, nextKickTime, ROWS_WRITTEN_BUDGET } from "../src/user/user-store";

// workerd alarms run on the real clock: everything UserStore sets is no earlier than now + STEP_GAP_MS (1 h in tests)
// or nextKickAt, so they never fire on their own and steps are driven only through drain.
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const newStub = () => env.USER_DO.getByName(`t-${crypto.randomUUID()}@x`);
const inDo = <R>(stub: DurableObjectStub, f: (sql: SqlStorage, st: DurableObjectState) => R | Promise<R>) =>
  runInDurableObject(stub, (_i, st) => f(st.storage.sql, st));
const queueKeys = (stub: DurableObjectStub) =>
  inDo(stub, (sql) => sql.exec("SELECT key FROM queue ORDER BY priority, id").toArray().map((r) => r.key as string));
/** Alarm after alarm until the queue is empty (with a key there is always an alarm: the hourly kick) */
const drain = async (stub: DurableObjectStub, n = 200) => {
  for (let i = 0; i < n && (await runDurableObjectAlarm(stub)) && (await queueKeys(stub)).length; i++);
};
/** The next hourly kick is a day away: it never comes during the test */
const kickTomorrow = (st: DurableObjectState) => st.storage.kv.put("nextKickAt", Date.now() + DAY);
const rowsKey = () => `rows:${new Date().toISOString().slice(0, 10)}`;
const kvGet = <T>(stub: DurableObjectStub, k: string) => inDo(stub, (_s, st) => st.storage.kv.get<T>(k));
const alarmAt = (stub: DurableObjectStub) => inDo(stub, (_s, st) => st.storage.getAlarm());
const armAlarm = (stub: DurableObjectStub) => inDo(stub, (_s, st) => st.storage.setAlarm(Date.now() + HOUR));
const keys = (stub: DurableObjectStub, dataset: string) =>
  inDo(stub, (sql) => sql.exec("SELECT key FROM records WHERE dataset = ? ORDER BY key", dataset).toArray().map((r) => r.key));
const state = (stub: DurableObjectStub, id: string) => inDo(stub, (sql) => allStates(sql).get(id));
const nowSec = () => Math.floor(Date.now() / 1000);

/** Key "test-key", sealed the way saveKey does it, but without the Garmin exchange and without a kick */
const putTestKey = (stub: DurableObjectStub) => inDo(stub, async (_s, st) => {
  st.storage.kv.put("garminKey", await seal(await importKek(env.KEY_ENCRYPTION_KEY), "test-key", st.id.toString()));
  st.storage.kv.put("keyExpiresOn", "2028-02-14");
  kickTomorrow(st);
});
const opened = (stub: DurableObjectStub, k: string) => inDo(stub, async (_s, st) =>
  open(await importKek(env.KEY_ENCRYPTION_KEY), st.storage.kv.get<Sealed>(k)!, st.id.toString()));
/** All user SQL tables and all kv values as one string */
const dumpAll = (stub: DurableObjectStub) => inDo(stub, (sql, st) => JSON.stringify({
  sql: sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND lower(substr(name, 1, 4)) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'`).toArray()
    .map(({ name }) => sql.exec(`SELECT * FROM "${name}"`).toArray()),
  kv: [...st.storage.kv.list()],
}));
/** Failed saveKey: no kv, no queue, no alarm */
const nothingStored = async (stub: DurableObjectStub) => {
  expect(await inDo(stub, (_s, st) => [...st.storage.kv.list()].map(([k]) => k))).toEqual([]);
  expect(await queueKeys(stub)).toEqual([]);
  expect(await alarmAt(stub)).toBeNull();
};

/** backfill is done for every dataset except only */
const backfillDone = (sql: SqlStorage, only?: string) => {
  for (const id of BACKFILL_ORDER) if (id !== only) patchState(sql, id, { backfill_done_at: new Date().toISOString() });
  patchState(sql, HISTORY, { backfill_cursor: BACKFILL_FLOOR, backfill_done_at: new Date().toISOString() });
};
const DAILY = {
  "/usersummary-service/usersummary/daily": (url: URL) =>
    HttpResponse.json({ calendarDate: url.searchParams.get("calendarDate"), totalSteps: 1000 }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("hourly kick syncs local today/yesterday", async () => {
  const m = garminMock({ data: DAILY });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  const at = Date.parse("2026-10-27T18:30:00Z"); // already 2026-10-28 03:30 in Tokyo
  await inDo(stub, (sql, st) => {
    upsertRecords(sql, "profile", [{ key: "current", day: null, data: { timeZone: "Asia/Tokyo" } }], new Date().toISOString());
    backfillDone(sql);
    st.storage.kv.put("lastDailyAt", at); // hourly set only
  });
  await stub.kick(at);
  await inDo(stub, (_s, st) => kickTomorrow(st)); // otherwise the very first alarm is a kick for the real "today"
  await drain(stub);
  expect(await keys(stub, "daily_summary")).toEqual(["2026-10-27", "2026-10-28"]);
  expect(await queueKeys(stub)).toEqual([]);
});

it("kick twice does not duplicate queue", async () => {
  const stub = newStub();
  await stub.kick(Date.now());
  const n = (await queueKeys(stub)).length;
  const rows = (await kvGet<number>(stub, rowsKey()))!;
  await stub.kick(Date.now());
  expect((await queueKeys(stub)).length).toBe(n);
  // counter: 2 rows per insert + lastDailyAt + nextKickAt + setAlarm + counter itself; repeat: nextKickAt and counter
  expect(rows).toBe(2 * n + 4);
  expect(await kvGet(stub, rowsKey())).toBe(rows + 2);
});

it("first kick runs daily tasks", async () => {
  const m = garminMock({ data: { "/userprofile-service/userprofile/settings": { timeZone: "Asia/Tokyo" } } });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql));
  const at = Date.now();
  await stub.kick(at);
  await drain(stub);
  expect(await keys(stub, "profile")).toEqual(["current"]);
  expect(await kvGet(stub, "lastDailyAt")).toBe(at);
  const queuedProfile = async () => (await queueKeys(stub)).filter((k) => k.startsWith("dataset:profile:"));
  await stub.kick(at + HOUR);
  expect(await queuedProfile()).toEqual([]);
  await stub.kick(at + 23 * HOUR + 1);
  expect(await queuedProfile()).toHaveLength(1);
});

it("daily kick re-queues missing pieces of the 20 newest incomplete activities (R27)", async () => {
  const stub = newStub();
  const at = Date.now();
  const T = new Date(at).toISOString();
  const day = (i: number) => addDays("2026-09-01", i);
  await inDo(stub, (sql, st) => {
    backfillDone(sql);
    st.storage.kv.put("lastDailyAt", at);
    // 1…25 one per day; 25 complete, 24 without workouts, 23 workouts only, the rest empty
    upsertRecords(sql, "activity", Array.from({ length: 25 }, (_, i) => ({ key: String(i + 1), day: day(i), data: {} })), T);
    for (const k of ["25", "24"]) upsertRecords(sql, "activity_detail", [{ key: k, day: null, data: {} }], T);
    for (const k of ["25", "23"]) upsertRecords(sql, "activity_workouts", [{ key: k, day: null, data: [] }], T);
  });
  const pieces = async () => (await queueKeys(stub)).filter((k) => k.startsWith("activity_")).sort();
  await stub.kick(at); // the hourly run does not touch them
  expect(await pieces()).toEqual([]);
  await stub.kick(at + 23 * HOUR + 1);
  const full = Array.from({ length: 18 }, (_, i) => String(i + 5)) // 5…22
    .flatMap((k) => ["activity_detail", "activity_workouts"].map((p) => `${p}:${k}`)); // no activity_file pieces
  expect(await pieces()).toEqual(["activity_workouts:24", "activity_detail:23", ...full].sort());
});

it("Garmin requests never overlap", async () => {
  const m = garminMock();
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql));
  await Promise.all([stub.kick(Date.now()), stub.syncNow(["2026-10-20", "2026-10-21"])]);
  await drain(stub);
  expect(m.dataCalls().length).toBeGreaterThan(50);
  expect(m.maxInFlight()).toBe(1);
  expect(await queueKeys(stub)).toEqual([]);
});

it("syncNow queues and returns", async () => {
  const m = garminMock({ data: DAILY });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql));
  const steps = DATASETS.filter((d) => d.kind !== "static").length + 1; // day and range datasets + the activities page
  expect(await stub.syncNow(["2026-10-27"])).toEqual({ queued: steps, etaSeconds: steps });
  expect(await stub.syncNow([])).toEqual({ queued: 0, etaSeconds: steps });
  await drain(stub);
  expect(await keys(stub, "daily_summary")).toEqual(["2026-10-27"]);
  expect(m.dataCalls()).toContain("GET /usersummary-service/stats/steps/daily/2026-10-27/2026-10-27");
  expect(await kvGet(stub, rowsKey())).toBeGreaterThan(0);
});

it("429 pauses and keeps the step", async () => {
  const m = garminMock({ data: { "/": () => new HttpResponse(null, { status: 429 }) } });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await stub.syncNow(["2026-10-27"]);
  const before = await queueKeys(stub);
  const t0 = Date.now();
  await runDurableObjectAlarm(stub);
  const paused = (await kvGet<number>(stub, "pausedUntil"))!;
  expect(paused).toBeGreaterThanOrEqual(t0 + 900_000);
  expect(await queueKeys(stub)).toEqual(before);
  expect(await alarmAt(stub)).toBe(paused);
  expect(m.dataCalls()).toHaveLength(1);
  await runDurableObjectAlarm(stub); // no requests during the pause
  expect(m.dataCalls()).toHaveLength(1);
  expect(await alarmAt(stub)).toBe(paused);

  // pause is visible (R25): error on the step's dataset, paused_until in sync_status, ETA includes the remaining pause
  expect(await state(stub, "daily_summary")).toMatchObject({ last_error: "HTTP 429", last_error_at: expect.any(String) });
  const status = JSON.parse((await stub.callTool("sync_status", {}, "https://mcp.example.com")).text).data;
  expect(status.paused_until).toBe(new Date(paused).toISOString());
  const t1 = Date.now();
  const { etaSeconds } = await stub.syncNow([]);
  expect(etaSeconds).toBeGreaterThanOrEqual(before.length + Math.floor((paused - Date.now()) / 1000));
  expect(etaSeconds).toBeLessThanOrEqual(before.length + Math.ceil((paused - t1) / 1000));
});

it("rejected key pauses for an hour and keeps cursor", async () => {
  network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 401 })));
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => {
    backfillDone(sql, "daily_summary");
    patchState(sql, "daily_summary", { backfill_cursor: "2026-09-01" });
  });
  await armAlarm(stub);
  const t0 = Date.now();
  await runDurableObjectAlarm(stub);
  expect(await state(stub, "_key")).toMatchObject({ last_error: "key_rejected", last_error_at: expect.any(String) });
  expect(await state(stub, "daily_summary")).toMatchObject({ backfill_cursor: "2026-09-01", last_error: null });
  const paused = (await kvGet<number>(stub, "pausedUntil"))!;
  expect(paused).toBeGreaterThanOrEqual(t0 + KEY_PAUSE_MS);
  expect(await alarmAt(stub)).toBe(paused);

  // a queued step also stays in place when the key is rejected
  await stub.syncNow(["2026-10-27"]);
  const queued = await queueKeys(stub);
  await inDo(stub, (_s, st) => st.storage.kv.delete("pausedUntil"));
  await runDurableObjectAlarm(stub);
  expect(await state(stub, "_key")).toMatchObject({ last_error: "key_rejected" });
  expect(await queueKeys(stub)).toEqual(queued);
  expect(await state(stub, "daily_summary")).toMatchObject({ backfill_cursor: "2026-09-01" });

  // new key: a good exchange clears the error, backfill resumes at the same cursor (queue already checked: drop it)
  network.resetHandlers();
  network.use(...garminMock().handlers);
  await inDo(stub, (sql, st) => {
    st.storage.kv.delete("pausedUntil");
    sql.exec("DELETE FROM queue");
  });
  await runDurableObjectAlarm(stub);
  expect(await state(stub, "_key")).toMatchObject({ last_error: null });
  expect(await state(stub, "daily_summary")).toMatchObject({ backfill_cursor: "2026-08-31" });

  // a token that lives less than a day: the key is expiring
  const now = Math.floor(Date.now() / 1000);
  network.use(http.post(TOKEN_URL, () => new HttpResponse(fakeJwt({ exp: now + 43_200, iat: now }))));
  await inDo(stub, (_s, st) => st.storage.kv.delete("token"));
  await runDurableObjectAlarm(stub);
  expect(await state(stub, "_key")).toMatchObject({ last_error: "key_expires_within_24h" });
});

it("rows budget stops backfill only", async () => {
  const m = garminMock({ data: DAILY });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (_s, st) => {
    st.storage.kv.put(rowsKey(), ROWS_WRITTEN_BUDGET);
    st.storage.kv.put("lastDailyAt", Date.now());
  });
  await stub.kick(Date.now());
  await inDo(stub, (_s, st) => kickTomorrow(st)); // the alarm below is the midnight one, not the hourly kick
  const n = (await queueKeys(stub)).length;
  await drain(stub, n);
  expect(await queueKeys(stub)).toEqual([]);
  expect(m.dataCalls()).toHaveLength(n);
  expect(await keys(stub, "daily_summary")).toContain(new Date().toISOString().slice(0, 10)); // no profile, so UTC
  const moved = () => inDo(stub, (sql) =>
    sql.exec("SELECT dataset FROM sync_state WHERE backfill_cursor IS NOT NULL OR backfill_done_at IS NOT NULL").toArray());
  expect(await moved()).toEqual([]);
  expect(await alarmAt(stub)).toBeGreaterThanOrEqual((Math.floor(Date.now() / DAY) + 1) * DAY);
  await runDurableObjectAlarm(stub); // backfill does not start before midnight
  expect(m.dataCalls()).toHaveLength(n);
  expect(await moved()).toEqual([]);
});

it("kick pulls the budget-midnight alarm forward, never before the pause", async () => {
  const stub = newStub();
  const nextMidnight = (Math.floor(Date.now() / DAY) + 1) * DAY;
  const budgetAlarm = nextMidnight + 60_000; // what rearm sets when the budget is exhausted
  const reset = (paused?: number) => inDo(stub, async (_s, st) => {
    st.storage.kv.put(rowsKey(), ROWS_WRITTEN_BUDGET);
    st.storage.kv.put("lastDailyAt", Date.now());
    if (paused) st.storage.kv.put("pausedUntil", paused);
    await st.storage.setAlarm(budgetAlarm);
  });
  await reset();
  const t0 = Date.now();
  await stub.kick(t0);
  // alarm = min(previous, max(now + STEP_GAP_MS, pausedUntil)); after 23:01 UTC the previous one is earlier anyway
  const a = (await alarmAt(stub))!;
  expect(a).toBeGreaterThanOrEqual(Math.min(budgetAlarm, t0 + HOUR));
  expect(a).toBeLessThanOrEqual(Math.min(budgetAlarm, Date.now() + HOUR));
  if (t0 + HOUR < nextMidnight) expect(a).toBeLessThan(nextMidnight);

  const paused = Date.now() + 2 * HOUR;
  await reset(paused);
  await stub.kick(Date.now());
  expect(await alarmAt(stub)).toBe(Math.min(budgetAlarm, paused));
});

it("Garmin token never reaches SQL", async () => {
  const m = garminMock({
    data: {
      ...DAILY,
      "/activitylist-service/": [{ activityId: 7, startTimeLocal: "2026-10-27 07:00:00" }],
    },
  });
  network.use(...m.handlers);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql));
  await stub.syncNow(["2026-10-27"]);
  await drain(stub);
  const sealed = await kvGet<Sealed>(stub, "token");
  expect(sealed).toMatchObject({ v: 1, iv: expect.any(String), ct: expect.any(String) }); // not a JWT
  const token = JSON.parse(await opened(stub, "token")).t as string;
  expect(token.split(".")).toHaveLength(3);
  expect(JSON.stringify(sealed)).not.toContain(token.split(".")[1]);
  const dump = await inDo(stub, (sql) =>
    JSON.stringify(["records", "sync_state", "queue"].map((t) => sql.exec(`SELECT * FROM ${t}`).toArray())));
  expect(dump).toContain("2026-10-27 07:00:00"); // the activity is there
  expect(dump).not.toContain(token);
  expect(dump).not.toContain(token.split(".")[1]);
  // one log line per step, only {"step":"<label>"}
  expect(log.mock.calls).toHaveLength(m.dataCalls().length);
  for (const [line] of log.mock.calls) expect(line).toMatch(/^\{"step":"[a-z_:0-9]+"\}$/);
});

it("step failures take the generic error path", async () => {
  const m = garminMock({ data: { "/sleep-service/": () => HttpResponse.error() } });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql, "sleep"));
  await armAlarm(stub);
  const t0 = Date.now();
  await runDurableObjectAlarm(stub);
  const sleep = (await state(stub, "sleep"))!;
  expect(sleep).toMatchObject({ last_error: "TypeError", backfill_cursor: null });
  expect(Date.parse(sleep.last_error_at!)).toBeGreaterThanOrEqual(t0);
  expect(m.dataCalls()).toHaveLength(1);
  expect(await alarmAt(stub)).toBe(await kvGet(stub, "nextKickAt")); // no tight loop: no step within the hour
  const next = (ms: number) => inDo(stub, (sql) => nextBackfillStep(allStates(sql), "2026-10-28", new Date(Date.now() + ms)));
  expect(await next(10 * MIN)).toBeNull();
  expect(await next(61 * MIN)).toMatchObject({ kind: "dataset", id: "sleep" });
  expect(await kvGet(stub, rowsKey())).toBeGreaterThan(0);

  // a data 401 after a repeated exchange is not a key rejection: the step leaves the queue
  network.use(http.get(`${GARMIN_BASE}/hrv-service/*`, () => new HttpResponse(null, { status: 401 })));
  await stub.syncNow(["2026-10-27"]);
  await drain(stub, 2); // daily_summary, then hrv
  expect(await state(stub, "hrv")).toMatchObject({ last_error: "HTTP 401", last_error_at: expect.any(String) });
  expect(await queueKeys(stub)).not.toContain("dataset:hrv:2026-10-27:2026-10-27");
  expect(await state(stub, "_key")).toMatchObject({ last_error: null });
});

it("a failing apply step never blocks the queue", async () => {
  const m = garminMock({ data: DAILY });
  network.use(...m.handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => {
    backfillDone(sql);
    sql.exec("CREATE TRIGGER boom BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'boom'); END");
  });
  await stub.syncNow(["2026-10-27"]);
  const head = (await queueKeys(stub))[0];
  expect(head).toBe("dataset:daily_summary:2026-10-27:2026-10-27");
  const t0 = Date.now();
  expect(await runDurableObjectAlarm(stub)).toBe(true); // no exception out of alarm()
  expect(await queueKeys(stub)).not.toContain(head);
  const st = (await state(stub, "daily_summary"))!;
  expect(st.last_error).toMatch(/^\w*Error$/);
  expect(st.last_error).not.toContain("boom");
  expect(Date.parse(st.last_error_at!)).toBeGreaterThanOrEqual(t0);
  expect(await alarmAt(stub)).not.toBeNull();
  await runDurableObjectAlarm(stub); // the next queued step runs as usual
  expect(await state(stub, "hrv")).toMatchObject({ last_success_at: expect.any(String), last_error: null });
});

it("nextKickTime is the next hh:offset strictly after now", () => {
  for (const [now, offset, next] of [
    ["2026-10-27T10:06:59.999Z", 7, "2026-10-27T10:07:00.000Z"],
    ["2026-10-27T10:07:00.000Z", 7, "2026-10-27T11:07:00.000Z"], // exactly on the minute: already the next hour
    ["2026-10-27T10:07:00.001Z", 7, "2026-10-27T11:07:00.000Z"],
    ["2026-10-27T10:00:00.000Z", 0, "2026-10-27T11:00:00.000Z"],
    ["2026-10-27T10:00:00.000Z", 59, "2026-10-27T10:59:00.000Z"],
    ["2026-10-27T23:30:00.000Z", 15, "2026-10-28T00:15:00.000Z"],
  ] as const) {
    expect(new Date(nextKickTime(Date.parse(now), offset)).toISOString(), `${now} +${offset}`).toBe(next);
  }
});

it("kickOffset is stable and within 0–59", () => {
  expect(kickOffset("ffffffff" + "0".repeat(56))).toBe(0xffffffff % 60);
  const offsets = Array.from({ length: 200 }, (_, i) => env.USER_DO.idFromName(`u${i}@x`).toString())
    .map((id) => {
      expect(kickOffset(id)).toBe(kickOffset(id));
      return kickOffset(id);
    });
  for (const o of offsets) expect(Number.isInteger(o) && o >= 0 && o <= 59, String(o)).toBe(true);
  expect(new Set(offsets).size).toBeGreaterThan(30); // users spread across minutes
});

it("alarm runs the hourly kick when due and re-arms at nextKickAt", async () => {
  network.use(...garminMock({ data: DAILY }).handlers);
  const stub = newStub();
  await putTestKey(stub);
  const t0 = Date.now();
  await inDo(stub, async (sql, st) => {
    backfillDone(sql);
    st.storage.kv.put("lastDailyAt", t0); // hourly set only
    st.storage.kv.put("nextKickAt", t0 - MIN);
    await st.storage.setAlarm(t0 + HOUR);
  });
  await drain(stub);
  const today = new Date().toISOString().slice(0, 10); // no profile, so UTC
  expect(await keys(stub, "daily_summary")).toEqual([addDays(today, -1), today]);
  expect(await queueKeys(stub)).toEqual([]);
  const next = (await kvGet<number>(stub, "nextKickAt"))!;
  expect(next).toBeGreaterThan(t0);
  expect(new Date(next).getUTCMinutes()).toBe(kickOffset(await inDo(stub, (_s, st) => st.id.toString())));
  expect(await alarmAt(stub)).toBe(next);
});

it("alarm re-arms after a throw", async () => {
  const stub = newStub();
  await putTestKey(stub);
  // hourly kick in 10 min: a normal rearm would aim at it (min with the step); a retry after a throw waits a full hour
  await inDo(stub, (sql, st) => {
    sql.exec("INSERT INTO queue(key, priority, step) VALUES ('bad', 0, 'not json')");
    st.storage.kv.put("nextKickAt", Date.now() + 10 * MIN);
  });
  await armAlarm(stub);
  const t0 = Date.now();
  await expect(runDurableObjectAlarm(stub)).rejects.toThrow(SyntaxError);
  expect(await alarmAt(stub)).toBeGreaterThanOrEqual(t0 + HOUR);
  expect(await alarmAt(stub)).toBeLessThanOrEqual(Date.now() + HOUR);
});

it("asleep: a throw does not re-arm", async () => {
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql, st) => {
    sql.exec("INSERT INTO queue(key, priority, step) VALUES ('bad', 0, 'not json')");
    st.storage.kv.put("lastSeenAt", Date.now() - 31 * DAY);
  });
  await armAlarm(stub);
  await expect(runDurableObjectAlarm(stub)).rejects.toThrow(SyntaxError);
  expect(await alarmAt(stub)).toBeNull();
});

it("asleep after 30 days: no alarm", async () => {
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql, st) => {
    backfillDone(sql);
    st.storage.kv.put("lastSeenAt", Date.now() - 31 * DAY);
  });
  await armAlarm(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await alarmAt(stub)).toBeNull();
});

it("asleep with a dead key and a queued step: no kick, no alarm (R24)", async () => {
  network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 401 })));
  const stub = newStub();
  await putTestKey(stub);
  await stub.syncNow(["2026-10-27"]); // queue and alarm
  const queued = await queueKeys(stub);
  await inDo(stub, (_s, st) => {
    st.storage.kv.put("lastSeenAt", Date.now() - 31 * DAY);
    st.storage.kv.put("pausedUntil", Date.now() - MIN); // the key-rejection pause is over
    st.storage.kv.put("nextKickAt", Date.now() - MIN);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await kvGet<number>(stub, "pausedUntil")).toBeGreaterThan(Date.now()); // the step ran into the key rejection
  expect(await queueKeys(stub)).toEqual(queued); // kick queued no steps
  expect(await alarmAt(stub)).toBeNull();
});

it("touch wakes and fills missed days", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql, st) => {
    backfillDone(sql);
    st.storage.kv.put("lastSeenAt", Date.now() - 31 * DAY);
    st.storage.kv.put("lastDailyAt", Date.now() - 40 * DAY);
  });
  await stub.callTool("sync_status", {}, "https://mcp.example.com");
  const day = (i: number) => addDays(new Date().toISOString().slice(0, 10), i - 40); // no profile, so UTC
  const queued = await queueKeys(stub);
  expect(queued.filter((k) => k.startsWith("dataset:daily_summary:")))
    .toEqual(Array.from({ length: 41 }, (_, i) => `dataset:daily_summary:${day(i)}:${day(i)}`));
  // range datasets go in windows of at most 28 days (steps and stress reject wider ones)
  expect(queued.filter((k) => k.startsWith("dataset:steps:")))
    .toEqual([`dataset:steps:${day(0)}:${day(27)}`, `dataset:steps:${day(28)}:${day(40)}`]);
  expect(await alarmAt(stub)).not.toBeNull();
  expect(await kvGet<number>(stub, "nextKickAt")).toBeLessThanOrEqual(Date.now() + HOUR);
  expect(await kvGet<number>(stub, "lastSeenAt")).toBeGreaterThan(Date.now() - MIN);
});

it("touch is best-effort when the write quota is exhausted", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const quota = () => {
    throw new Error("Your account has exceeded Durable Objects' free tier daily row write limit.");
  };
  // asleep: wakes via submit → transactionSync; awake: lastSeenAt via kv.put; no alarm: arm (kv.put, setAlarm)
  for (const seen of [Date.now() - 31 * DAY, Date.now() - 2 * HOUR, Date.now() - MIN]) {
    log.mockClear();
    const stub = newStub();
    await putTestKey(stub);
    await inDo(stub, (_s, st) => {
      st.storage.kv.put("lastSeenAt", seen);
      vi.spyOn(st.storage, "transactionSync").mockImplementation(quota);
      vi.spyOn(st.storage.kv, "put").mockImplementation(quota);
    });
    expect((await stub.callTool("sync_status", {}, "https://mcp.example.com")).isError).toBe(false);
    expect(log.mock.calls).toEqual([[JSON.stringify({ quota: "exhausted" })], [JSON.stringify({ tool: "sync_status" })]]);
    expect(await kvGet(stub, "lastSeenAt")).toBe(seen);
    expect(await alarmAt(stub)).toBeNull();
  }
});

it("touch writes lastSeenAt at most hourly", async () => {
  const stub = newStub();
  const t0 = Date.parse("2026-10-27T12:00:00Z"), rows = () => kvGet<number>(stub, "rows:2026-10-27");
  await stub.touch(t0);
  const first = (await rows())!;
  expect(first).toBeGreaterThan(0);
  expect(await kvGet(stub, "lastSeenAt")).toBe(t0);
  await stub.touch(t0 + MIN);
  expect(await rows()).toBe(first);
  expect(await kvGet(stub, "lastSeenAt")).toBe(t0);
});

it("quota error in alarm writes nothing and does not throw", async () => {
  network.use(...garminMock({ data: DAILY }).handlers);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql));
  await stub.syncNow(["2026-10-27"]);
  const before = await dumpAll(stub);
  await inDo(stub, (_s, st) => {
    vi.spyOn(st.storage, "transactionSync").mockImplementation(() => {
      throw new Error("Your account has exceeded Durable Objects' free tier daily row write limit.");
    });
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify({ quota: "exhausted" }));
  expect(await dumpAll(stub)).toBe(before); // including last_error on _key and daily_summary
  expect(await alarmAt(stub)).toBeNull();
});

it("saveKey stores a sealed key and queues a daily kick", async () => {
  const jwt = fakeJwt({ exp: nowSec() + 86400, iat: nowSec(), sub: "token-payload-marker" });
  network.use(http.post(TOKEN_URL, () => new HttpResponse(jwt)));
  const stub = newStub();
  await inDo(stub, (_s, st) => st.storage.kv.put("lastDailyAt", Date.now())); // saveKey resets it: next kick is daily
  expect(await stub.saveKey("test-key", 365)).toEqual({ ok: true });
  expect(await kvGet(stub, "garminKey")).toMatchObject({ v: 1 });
  expect(await opened(stub, "garminKey")).toBe("test-key");
  expect(JSON.parse(await opened(stub, "token")).t).toBe(jwt);
  expect(await kvGet(stub, "keyExpiresOn")).toBe(addDays(new Date().toISOString().slice(0, 10), 365));
  expect(Date.parse((await kvGet<string>(stub, "keySavedAt"))!)).toBeGreaterThan(Date.now() - MIN);
  expect(await kvGet<number>(stub, "lastSeenAt")).toBeGreaterThan(Date.now() - MIN);
  const dump = await dumpAll(stub);
  for (const secret of ["test-key", jwt, jwt.split(".")[1]]) expect(dump).not.toContain(secret);
  const queued = await queueKeys(stub);
  expect(queued.some((k) => k.startsWith("dataset:profile:"))).toBe(true);
  expect(await alarmAt(stub)).not.toBeNull();
});

it("saveKey trims surrounding whitespace", async () => {
  let auth = "";
  network.use(
    http.post(TOKEN_URL, ({ request }) => {
      auth = request.headers.get("authorization")!;
      return undefined; // fall through to the regular mock
    }),
    ...garminMock().handlers,
  );
  expect(await newStub().saveKey("  test-key\n", 365)).toEqual({ ok: true });
  expect(auth).toBe("ApiKey test-key");
});

it("saveKey rejected stores nothing", async () => {
  network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 401 })));
  const stub = newStub();
  expect(await stub.saveKey("test-key", 365)).toEqual({ ok: false, reason: "rejected" });
  await nothingStored(stub);
});

// the exchange timeout is tested in client.test.ts ("verify times out…"): saveKey builds the client itself
it("saveKey unavailable stores nothing", async () => {
  for (const status of [503, 429]) {
    network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status })));
    const stub = newStub();
    expect(await stub.saveKey("test-key", 365)).toEqual({ ok: false, reason: "unavailable" });
    await nothingStored(stub);
  }
});

it("saveKey invalid input", async () => {
  const m = garminMock();
  network.use(...m.handlers);
  const stub = newStub();
  for (const [key, days] of [["", 365], [" \n ", 365], ["k".repeat(4097), 365], ["test-key", 7]] as const) {
    expect(await stub.saveKey(key, days)).toEqual({ ok: false, reason: "invalid" });
  }
  expect(m.calls).toEqual([]);
  await nothingStored(stub);
});

it("saveKey rejects a key with an inner newline or non-ASCII text", async () => {
  const m = garminMock();
  network.use(...m.handlers);
  const stub = newStub();
  for (const key of ["test-\r\nkey", "test key", "ключ"]) {
    expect(await stub.saveKey(key, 365)).toEqual({ ok: false, reason: "invalid" });
  }
  expect(m.calls).toEqual([]);
  await nothingStored(stub);
});

it("replacing the key clears a key pause", async () => {
  network.use(...garminMock().handlers);
  const stub = newStub();
  await putTestKey(stub);
  // pause beyond STEP_GAP_MS (1 h in tests): otherwise the kick alarm is after the pause end anyway
  const pauseEnd = Date.now() + 2 * HOUR;
  await inDo(stub, async (sql, st) => {
    st.storage.kv.put("pausedUntil", pauseEnd);
    patchState(sql, "_key", { last_error: "key_rejected", last_error_at: new Date().toISOString() });
    await st.storage.setAlarm(pauseEnd);
  });
  expect(await stub.saveKey("new-key", 90)).toEqual({ ok: true });
  expect(await opened(stub, "garminKey")).toBe("new-key");
  expect(await kvGet(stub, "pausedUntil")).toBeUndefined();
  expect(await state(stub, "_key")).toMatchObject({ last_error: null });
  expect(await alarmAt(stub)).toBeLessThan(pauseEnd);
});

it("deleteKey keeps data, clears queue and alarm", async () => {
  network.use(...garminMock({ data: DAILY }).handlers);
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => backfillDone(sql));
  await stub.syncNow(["2026-10-27"]);
  await runDurableObjectAlarm(stub); // daily_summary written, token in kv
  await inDo(stub, (_s, st) => {
    st.storage.kv.put("keySavedAt", new Date().toISOString());
    st.storage.kv.put("pausedUntil", Date.now() + HOUR);
    st.storage.kv.put("nextKickAt", Date.now() + HOUR);
  });
  expect(await kvGet(stub, "token")).toBeDefined();
  expect(await queueKeys(stub)).not.toEqual([]);
  expect(await alarmAt(stub)).not.toBeNull();
  await stub.deleteKey();
  for (const k of ["garminKey", "token", "keyExpiresOn", "keySavedAt", "pausedUntil", "nextKickAt"]) {
    expect(await kvGet(stub, k)).toBeUndefined();
  }
  expect(await queueKeys(stub)).toEqual([]);
  expect(await alarmAt(stub)).toBeNull();
  expect(await keys(stub, "daily_summary")).toEqual(["2026-10-27"]);
});

it("deleteKey during a step: the step writes nothing back", async () => {
  // flags, not promises: a promise resolved from the object's context drags the rest of the test in there too
  let inFetch = false, released = false;
  network.use(
    http.get(`${GARMIN_BASE}/*`, async () => {
      inFetch = true;
      while (!released) await delay(5);
      return HttpResponse.json([]);
    }),
    ...garminMock().handlers,
  );
  const stub = newStub();
  await putTestKey(stub);
  await armAlarm(stub);
  const run = runDurableObjectAlarm(stub);
  while (!inFetch) await new Promise((r) => setTimeout(r, 5)); // the exchange is done, the new token is not written yet
  await stub.deleteKey();
  released = true;
  await run;
  expect(await kvGet(stub, "token")).toBeUndefined();
  expect(await alarmAt(stub)).toBeNull();
  expect(await inDo(stub, (sql) => sql.exec("SELECT dataset FROM sync_state").toArray())).toEqual([]);
});

it("delete all during a step: the step writes nothing back", async () => {
  let inFetch = false, released = false; // flags, as in "deleteKey during a step"
  network.use(
    http.get(`${GARMIN_BASE}/*`, async () => {
      inFetch = true;
      while (!released) await delay(5);
      return HttpResponse.json({ activityId: 7 });
    }),
    ...garminMock().handlers,
  );
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, (sql) => sql.exec("INSERT INTO queue(key, priority, step) VALUES ('activity_detail:7', 0, ?)",
    JSON.stringify({ kind: "activity_detail", activityId: "7" })));
  await armAlarm(stub);
  const run = runDurableObjectAlarm(stub);
  while (!inFetch) await new Promise((r) => setTimeout(r, 5));
  await stub.deleteAllData();
  released = true;
  await run;
  expect(await inDo(stub, (sql, st) => ({
    kv: [...st.storage.kv.list()], // no token, no row counter
    rows: sql.exec("SELECT (SELECT COUNT(*) FROM records) + (SELECT COUNT(*) FROM sync_state) AS n").one().n,
  }))).toEqual({ kv: [], rows: 0 });
  expect(await alarmAt(stub)).toBeNull();
});

it("no key: alarm does nothing", async () => {
  const m = garminMock();
  network.use(...m.handlers);
  const stub = newStub();
  await stub.syncNow(["2026-10-27"]);
  const queued = await queueKeys(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(m.calls).toEqual([]);
  expect(await alarmAt(stub)).toBeNull();
  expect(await queueKeys(stub)).toEqual(queued);
});

it("sealed key does not open in another user's object", async () => {
  const m = garminMock();
  network.use(...m.handlers);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const a = newStub(), b = newStub();
  await putTestKey(a);
  const sealed = await kvGet<Sealed>(a, "garminKey");
  await inDo(b, (_s, st) => st.storage.kv.put("garminKey", sealed));
  await armAlarm(b);
  expect(await runDurableObjectAlarm(b)).toBe(true);
  expect(m.calls).toEqual([]);
  expect((await state(b, "_key"))?.last_error ?? null).toBeNull();
  expect(log.mock.calls).toEqual([[JSON.stringify({ key: "unreadable" })]]); // not silently
  // a KEY_ENCRYPTION_KEY change looks the same: the page asks to replace the key, and saving seals it again
  expect((await b.settingsState()).key).toBe("rejected");
});

it("touch arms a missing alarm", async () => {
  const stub = newStub();
  await putTestKey(stub);
  await inDo(stub, async (_s, st) => {
    st.storage.kv.put("lastSeenAt", Date.now());
    await st.storage.deleteAlarm();
  });
  const before = Date.now();
  await stub.callTool("sync_status", {}, "https://mcp.example.com");
  const at = (await alarmAt(stub))!;
  const gap = Number(env.STEP_GAP_MS);
  expect(at).toBeGreaterThanOrEqual(before + gap);
  expect(at).toBeLessThan(Date.now() + gap + 1000);
});

it("deleteAllData clears everything in one call", async () => {
  const stub = newStub();
  await putTestKey(stub);
  await stub.syncNow(["2026-10-27"]); // queue and alarm
  await inDo(stub, (sql) => upsertRecords(sql, "daily_summary", [{ key: "2026-10-27", day: "2026-10-27", data: { a: 1 } }], "t"));
  await stub.deleteAllData();
  expect(await inDo(stub, (sql, st) => ({
    kv: [...st.storage.kv.list()],
    rows: sql.exec("SELECT (SELECT COUNT(*) FROM records) + (SELECT COUNT(*) FROM daily) + (SELECT COUNT(*) FROM queue) AS n").one().n,
  }))).toEqual({ kv: [], rows: 0 });
  expect(await alarmAt(stub)).toBeNull();
});

it("settingsState maps key states", async () => {
  const stub = newStub();
  expect((await stub.settingsState()).key).toBe("none");
  await putTestKey(stub);
  const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
  await inDo(stub, (_s, st) => st.storage.kv.put("keyExpiresOn", day(10)));
  expect(await stub.settingsState()).toMatchObject({ key: "expiring", daysLeft: 10, keyExpiresOn: day(10), hasData: false });
  await inDo(stub, (_s, st) => st.storage.kv.put("keyExpiresOn", day(100)));
  expect((await stub.settingsState()).key).toBe("ok");
  await inDo(stub, (sql) => patchState(sql, "_key", { last_error: "key_rejected" }));
  expect((await stub.settingsState()).key).toBe("rejected");
});
