import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { network } from "./setup";
import { garminMock, TOKEN_URL } from "./garmin-mock";
import { ACTIVITY_PAGE, DATASETS, dataset } from "../src/garmin/catalog";
import { addDays, daysBetween } from "../src/garmin/dates";
import {
  GarminClient, GarminHttpError, KeyRejectedError, RateLimitedError, TOKEN_PATH, type CachedToken,
} from "../src/garmin/client";
import { allStates, patchState, upsertRecords } from "../src/user/store";
import {
  BACKFILL_FLOOR, BACKFILL_ORDER, HISTORY, applyStep, fetchStep, nextBackfillStep, recentSteps, stateKey, staticSteps,
  stepKey, stepLabel, userTimeZone, type FetchDeps, type Step,
} from "../src/user/engine";

const TODAY = "2026-10-28";
const NOW = new Date("2026-10-28T12:00:00Z");
const MIN = 60_000;
const newStub = () => env.USER_DO.getByName(`t-${crypto.randomUUID()}@x`);
const inDo = <R>(stub: DurableObjectStub, f: (sql: SqlStorage) => R) =>
  runInDurableObject(stub, (_i, st) => f(st.storage.sql));
const memTokens = () => {
  let v: CachedToken | undefined;
  return { load: () => v, save: (t: CachedToken) => { v = t; } };
};
const newDeps = (): FetchDeps => ({ client: new GarminClient("test-key", memTokens()), today: TODAY });
const caught = (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error("expected rejection"); }, (e) => e);

/** Everything in BACKFILL_ORDER except only is finished; the history start is history (null: not found yet) */
const onlyPending = (sql: SqlStorage, only: string, history: string | null = BACKFILL_FLOOR) => {
  for (const id of BACKFILL_ORDER) if (id !== only) patchState(sql, id, { backfill_done_at: NOW.toISOString() });
  if (history) patchState(sql, HISTORY, { backfill_cursor: history, backfill_done_at: NOW.toISOString() });
};
const runStep = async (stub: DurableObjectStub, deps: FetchDeps, step: Step, now = NOW) => {
  const f = await fetchStep(deps, step);
  return inDo(stub, (sql) => applyStep(sql, step, f, now, TODAY));
};
const state = (stub: DurableObjectStub, id: string) => inDo(stub, (sql) => allStates(sql).get(id));

describe("engine", () => {
  it("recentSteps shape", () => {
    const s = recentSteps(TODAY, 2);
    expect(s).toHaveLength(25);
    const ds = s.filter((x) => x.kind === "dataset");
    const days = ds.filter((x) => dataset(x.id).kind === "day");
    expect(days).toHaveLength(16);
    expect(new Set(days.map((x) => `${x.start}/${x.end}`))).toEqual(new Set(["2026-10-27/2026-10-27", "2026-10-28/2026-10-28"]));
    const ranges = ds.filter((x) => dataset(x.id).kind === "range");
    expect(ranges).toHaveLength(8);
    for (const r of ranges) expect([r.start, r.end]).toEqual(["2026-10-27", "2026-10-28"]);
    expect(s.filter((x) => x.kind === "activities")).toEqual([{ kind: "activities", start: 0, limit: ACTIVITY_PAGE, backfill: false }]);
    expect(s.every((x) => !("backfill" in x) || x.backfill === false)).toBe(true);
    expect(new Set(s.map(stepKey)).size).toBe(25);
  });

  it("staticSteps, keys, labels and state keys", () => {
    expect(staticSteps(TODAY)).toEqual(["profile", "hr_zones", "weight_goal"].map((id) =>
      ({ kind: "dataset", id, start: TODAY, end: TODAY, backfill: false })));
    const sleep: Step = { kind: "dataset", id: "sleep", start: "2026-10-01", end: "2026-10-28", backfill: false };
    const workouts: Step = { kind: "activity_workouts", activityId: "123" };
    expect(stepKey(sleep)).toBe("dataset:sleep:2026-10-01:2026-10-28");
    expect(stepKey({ ...sleep, backfill: true })).not.toBe(stepKey(sleep));
    expect(stepKey(workouts)).toBe("activity_workouts:123");
    expect(stepKey({ kind: "activity_detail", activityId: "123" })).not.toBe(stepKey(workouts));
    expect(stepKey({ kind: "activities", start: 0, limit: 20, backfill: false }))
      .not.toBe(stepKey({ kind: "activities", start: 20, limit: 20, backfill: false }));
    expect([stepLabel(sleep), stepLabel(workouts), stepLabel({ kind: "activities", start: 0, limit: 20, backfill: true })])
      .toEqual(["dataset:sleep", "activity_workouts", "activities"]);
    expect([stateKey(sleep), stateKey(workouts), stateKey({ kind: "activities", start: 0, limit: 20, backfill: true })])
      .toEqual(["sleep", "activity", "activity"]);
    const hist: Step = { kind: "history_start", start: "2000-01-01", end: "2000-12-31" };
    expect([stepKey(hist), stepLabel(hist), stateKey(hist)]).toEqual(["history_start:2000-01-01:2000-12-31", "history_start", HISTORY]);
    expect(BACKFILL_ORDER).toHaveLength(17);
    expect(new Set(BACKFILL_ORDER)).toEqual(new Set(["activity", ...DATASETS.filter((d) => d.kind !== "static").map((d) => d.id)]));
  });

  it("one Garmin data request per fetchStep", async () => {
    const m = garminMock({
      data: { "/activitylist-service/": [{ activityId: 1, startTimeLocal: "2026-10-27 07:00:00" }] },
    });
    network.use(...m.handlers);
    const deps = newDeps();
    const steps: Step[] = [
      { kind: "dataset", id: "hrv", start: TODAY, end: TODAY, backfill: false },
      { kind: "dataset", id: "steps", start: "2026-10-01", end: TODAY, backfill: false },
      { kind: "activities", start: 40, limit: 20, backfill: true },
      { kind: "activity_detail", activityId: "1" },
      { kind: "activity_workouts", activityId: "1" },
    ];
    const paths: string[] = [];
    for (const s of steps) {
      const before = m.dataCalls().length;
      expect((await fetchStep(deps, s)).ok).toBe(true);
      expect(m.dataCalls().length - before).toBe(1);
      paths.push(m.dataCalls().at(-1)!);
    }
    expect(paths).toEqual([
      "GET /hrv-service/hrv/2026-10-28",
      "GET /usersummary-service/stats/steps/daily/2026-10-01/2026-10-28",
      "GET /activitylist-service/activities/search/activities?start=40&limit=20",
      "GET /activity-service/activity/1",
      "GET /activity-service/activity/1/workouts",
    ]);
  });

  /** daily summaries v2: data from firstDay on, null stubs before it, as Garmin responds */
  const v2 = (firstDay: string | null) => (url: URL) => {
    const s = url.searchParams.get("startDate")!, e = url.searchParams.get("endDate")!;
    const days = Array.from({ length: daysBetween(s, e) + 1 }, (_, i) => addDays(s, i));
    return HttpResponse.json({ data: days.map((d) => ({ calendarDate: d, totalSteps: firstDay && d >= firstDay ? 1000 : null })) });
  };
  const V2 = "/usersummary-service/v2/dailysummaries";
  /** History steps in a row until the start is found (at most 40) */
  const findHistory = async (stub: DurableObjectStub, deps: FetchDeps) => {
    for (let i = 0; i < 40 && !(await state(stub, HISTORY))?.backfill_done_at; i++) {
      const step = (await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))!;
      expect(step.kind).toBe("history_start");
      await runStep(stub, deps, step);
    }
  };

  it("history start: first day with data, scanning calendar years up from 2000", async () => {
    const m = garminMock({ data: { [V2]: v2("2024-02-12") } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => onlyPending(sql, "steps", null));
    expect(await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))
      .toEqual({ kind: "history_start", start: "2000-01-01", end: "2000-12-31" });
    await findHistory(stub, newDeps());
    expect(m.dataCalls()).toEqual(Array.from({ length: 25 }, (_, i) =>
      `GET ${V2}?startDate=${2000 + i}-01-01&endDate=${2000 + i}-12-31`));
    expect(await state(stub, HISTORY)).toMatchObject({ backfill_cursor: "2024-02-12", backfill_done_at: NOW.toISOString() });
    expect(await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))
      .toEqual({ kind: "dataset", id: "steps", start: "2026-09-30", end: "2026-10-27", backfill: true });
  });

  it("history start: no data at all — starts today, nothing to backfill", async () => {
    const m = garminMock({ data: { [V2]: v2(null) } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => onlyPending(sql, "steps", null));
    await findHistory(stub, newDeps());
    expect(m.dataCalls()).toHaveLength(27);
    expect(m.dataCalls().at(-1)).toBe(`GET ${V2}?startDate=2026-01-01&endDate=2026-10-27`);
    expect(await state(stub, HISTORY)).toMatchObject({ backfill_cursor: TODAY, backfill_done_at: NOW.toISOString() });
    expect(await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW))).toBeNull();
  });

  it("history start: 4xx is an empty year, other errors retry the same year after an hour", async () => {
    const ctl = { status: 400 };
    const m = garminMock({ data: { [V2]: () => new HttpResponse(null, { status: ctl.status }) } });
    network.use(...m.handlers);
    const stub = newStub();
    const deps = newDeps();
    await inDo(stub, (sql) => onlyPending(sql, "steps", null));
    const at = (ms: number) => inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, new Date(NOW.getTime() + ms)));
    await runStep(stub, deps, (await at(0))!);
    expect(await at(0)).toEqual({ kind: "history_start", start: "2001-01-01", end: "2001-12-31" });
    ctl.status = 500;
    await runStep(stub, deps, (await at(0))!);
    expect(await state(stub, HISTORY)).toMatchObject({
      backfill_cursor: "2001-01-01", backfill_done_at: null, last_error: "HTTP 500", last_error_at: NOW.toISOString(),
    });
    expect(await at(10 * MIN)).toBeNull(); // other datasets wait for the history start
    expect(await at(61 * MIN)).toEqual({ kind: "history_start", start: "2001-01-01", end: "2001-12-31" });
  });

  it("history start never goes past stored daily summaries, so a bad year response deletes nothing real", async () => {
    const m = garminMock({
      data: { [V2]: (url: URL) => url.searchParams.get("startDate") === "2024-01-01" ? new HttpResponse(null, { status: 404 }) : v2("2024-02-12")(url) },
    });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => {
      onlyPending(sql, "steps", null);
      patchState(sql, HISTORY, { backfill_cursor: "2024-01-01" });
      const T = NOW.toISOString();
      upsertRecords(sql, "daily_summary_v2", [{ key: "2024-02-12", day: "2024-02-12", data: { totalSteps: 1 } }], T);
      upsertRecords(sql, "sleep", [{ key: "2024-03-26", day: "2024-03-26", data: { sleepTimeSeconds: 1 } }], T);
    });
    await findHistory(stub, newDeps());
    expect(m.dataCalls()).toHaveLength(2); // 2024 → 404, 2025 → data from 2025-01-01
    expect(await state(stub, HISTORY)).toMatchObject({ backfill_cursor: "2024-02-12", backfill_done_at: NOW.toISOString() });
    expect(await inDo(stub, (sql) => sql.exec("SELECT dataset, key FROM records ORDER BY dataset").toArray())).toEqual([
      { dataset: "daily_summary_v2", key: "2024-02-12" }, { dataset: "sleep", key: "2024-03-26" },
    ]);
  });

  it("found history start reopens datasets the old empty-day rule finished above it", async () => {
    const m = garminMock({ data: { [V2]: v2("2024-02-12") } });
    network.use(...m.handlers);
    const stub = newStub();
    const DONE = "2026-11-08T00:00:00.000Z";
    await inDo(stub, (sql) => {
      onlyPending(sql, "fitness_age", null);
      patchState(sql, "nutrition", { backfill_cursor: "2026-08-09", backfill_done_at: DONE });
      patchState(sql, "steps", { backfill_cursor: "2023-11-11", backfill_done_at: DONE });
    });
    await runStep(stub, newDeps(), { kind: "history_start", start: "2024-01-01", end: "2024-12-31" });
    const st = await inDo(stub, (sql) => allStates(sql));
    expect(st.get("nutrition")).toMatchObject({ backfill_cursor: "2026-08-09", backfill_done_at: null });
    expect(st.get("steps")).toMatchObject({ backfill_cursor: "2023-11-11", backfill_done_at: DONE });
    expect(await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))
      .toEqual({ kind: "dataset", id: "nutrition", start: "2026-08-09", end: "2026-08-09", backfill: true });
  });

  it("backfill walks down to the history start whatever the data, last window clipped", async () => {
    const m = garminMock({ data: { "/usersummary-service/stats/steps/": [] } });
    network.use(...m.handlers);
    const stub = newStub();
    const deps = newDeps();
    await inDo(stub, (sql) => onlyPending(sql, "steps", "2026-09-15"));
    const next = () => inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW));
    const s1 = (await next())!;
    expect(s1).toEqual({ kind: "dataset", id: "steps", start: "2026-09-30", end: "2026-10-27", backfill: true });
    await runStep(stub, deps, s1);
    expect(await state(stub, "steps")).toMatchObject({ backfill_cursor: "2026-09-29", backfill_done_at: null });
    const s2 = (await next())!;
    expect(s2).toEqual({ kind: "dataset", id: "steps", start: "2026-09-15", end: "2026-09-29", backfill: true });
    await runStep(stub, deps, s2);
    expect(await state(stub, "steps")).toMatchObject({ backfill_cursor: "2026-09-14", backfill_done_at: NOW.toISOString() });
    expect(await next()).toBeNull();
  });

  it("found history start removes earlier day and range records and finishes datasets below it", async () => {
    const m = garminMock({ data: { [V2]: v2("2024-02-12") } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => {
      onlyPending(sql, "fitness_age", null);
      patchState(sql, "fitness_age", { backfill_cursor: "2015-01-02" });
      patchState(sql, "activity", { backfill_cursor: "1000", backfill_done_at: null });
      const rec = (ds: string, day: string | null, key = day ?? "current") => upsertRecords(sql, ds, [{ key, day, data: { v: 1 } }], NOW.toISOString());
      rec("fitness_age", "2015-01-03");
      rec("fitness_age", "2024-02-12");
      rec("body_battery", "1999-12-13");
      rec("weight", "2020-01-01");
      rec("weight", "2024-03-26");
      rec("activity", "2020-01-01", "7");
      rec("profile", null);
    });
    await runStep(stub, newDeps(), { kind: "history_start", start: "2024-01-01", end: "2024-12-31" });
    const r = await inDo(stub, (sql) => ({
      records: sql.exec("SELECT dataset, key FROM records ORDER BY dataset, key").toArray(),
      weight: sql.exec("SELECT day FROM weight ORDER BY day").toArray(),
      states: allStates(sql),
    }));
    expect(r.records).toEqual([
      { dataset: "activity", key: "7" }, { dataset: "fitness_age", key: "2024-02-12" },
      { dataset: "profile", key: "current" }, { dataset: "weight", key: "2024-03-26" },
    ]);
    expect(r.weight).toEqual([{ day: "2024-03-26" }]);
    expect(r.states.get("fitness_age")).toMatchObject({ backfill_cursor: "2015-01-02", backfill_done_at: NOW.toISOString() });
    expect(r.states.get(HISTORY)).toMatchObject({ backfill_cursor: "2024-02-12", backfill_done_at: NOW.toISOString() });
    expect(r.states.get("activity")).toMatchObject({ backfill_cursor: "1000", backfill_done_at: null });
  });

  /** steps → empty body with the current status; only steps is unfinished, cursor 2026-09-29 */
  const emptyStepsSetup = async () => {
    const ctl = { status: 400 };
    const m = garminMock({ data: { "/usersummary-service/stats/steps/": () => new HttpResponse(null, { status: ctl.status }) } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => { onlyPending(sql, "steps"); patchState(sql, "steps", { backfill_cursor: "2026-09-29" }); });
    const next = async () => (await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))!;
    return { ctl, stub, deps: newDeps(), next };
  };

  it("halves window on empty-body 400", async () => {
    const { ctl, stub, deps, next } = await emptyStepsSetup();
    const s1 = await next();
    expect(s1).toEqual({ kind: "dataset", id: "steps", start: "2026-09-02", end: "2026-09-29", backfill: true });
    const r = await runStep(stub, deps, s1);
    expect(r.rowsWritten).toBeGreaterThan(0);
    expect(await state(stub, "steps")).toMatchObject({ window_days: 14, backfill_cursor: "2026-09-29", last_error: null });
    const s2 = await next();
    expect(s2).toMatchObject({ start: "2026-09-16", end: "2026-09-29" });
    ctl.status = 500; // an empty 500 with w > 1 also halves the window
    await runStep(stub, deps, s2);
    expect(await state(stub, "steps")).toMatchObject({ window_days: 7, backfill_cursor: "2026-09-29", last_error: null });
  });

  it("window 1: empty 400 is an empty day, empty 500 is an error", async () => {
    const { ctl, stub, deps, next } = await emptyStepsSetup();
    await inDo(stub, (sql) => patchState(sql, "steps", { window_days: 1 }));
    await runStep(stub, deps, await next());
    expect(await state(stub, "steps")).toMatchObject({
      window_days: 1, backfill_cursor: "2026-09-28", last_error: null, backfill_done_at: null,
    });
    ctl.status = 500;
    await runStep(stub, deps, await next());
    expect(await state(stub, "steps")).toMatchObject({
      window_days: 1, backfill_cursor: "2026-09-28",
      last_error: "HTTP 500", last_error_at: NOW.toISOString(), backfill_done_at: null,
    });
  });

  it("cursor below the floor ends backfill", async () => {
    const m = garminMock({ data: { "/usersummary-service/stats/steps/": [{ calendarDate: "2000-01-10", totalSteps: 1 }] } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => { onlyPending(sql, "steps"); patchState(sql, "steps", { backfill_cursor: "2000-01-10" }); });
    const step = (await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))!;
    expect(step).toMatchObject({ start: BACKFILL_FLOOR, end: "2000-01-10" });
    await runStep(stub, newDeps(), step);
    expect(await state(stub, "steps")).toMatchObject({ backfill_cursor: "1999-12-31", backfill_done_at: NOW.toISOString() });
  });

  it("token-exchange errors are rethrown, never data results", async () => {
    const steps: Step[] = [
      { kind: "dataset", id: "hrv", start: TODAY, end: TODAY, backfill: false },
      { kind: "activity_detail", activityId: "1" },
    ];
    for (const res of [() => HttpResponse.json({ m: "x" }, { status: 404 }), () => new HttpResponse(null, { status: 500 })]) {
      const m = garminMock();
      network.use(http.post(TOKEN_URL, res), ...m.handlers);
      const deps = newDeps();
      for (const s of steps) {
        const e = await caught(fetchStep(deps, s));
        expect(e).toBeInstanceOf(GarminHttpError);
        expect(e.path).toBe(TOKEN_PATH);
      }
      expect(m.dataCalls()).toEqual([]);
      network.resetHandlers();
    }
  });

  it("today 404 is not an error", async () => {
    const m = garminMock({ data: { "/hrv-service/": () => HttpResponse.json({ message: "not found" }, { status: 404 }) } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => patchState(sql, "hrv", { last_error: "HTTP 500" }));
    await runStep(stub, newDeps(), { kind: "dataset", id: "hrv", start: TODAY, end: TODAY, backfill: false });
    expect(await state(stub, "hrv")).toMatchObject({ last_error: null, last_success_at: NOW.toISOString() });
  });

  it("failing dataset is skipped for an hour", async () => {
    const m = garminMock({ data: { "/sleep-service/": () => new HttpResponse("boom", { status: 500 }) } });
    network.use(...m.handlers);
    const stub = newStub();
    await inDo(stub, (sql) => {
      for (const id of BACKFILL_ORDER.slice(0, BACKFILL_ORDER.indexOf("sleep"))) patchState(sql, id, { backfill_done_at: NOW.toISOString() });
      patchState(sql, HISTORY, { backfill_cursor: BACKFILL_FLOOR, backfill_done_at: NOW.toISOString() });
    });
    const step = (await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))!;
    expect(step).toMatchObject({ kind: "dataset", id: "sleep" });
    const r = await runStep(stub, newDeps(), step);
    expect(r).toEqual({ newSteps: [], rowsWritten: 1 });
    const st = await state(stub, "sleep");
    expect(st).toMatchObject({ last_error: "HTTP 500", last_error_at: NOW.toISOString(), backfill_cursor: null });
    expect(st!.last_error).not.toContain("boom");
    const at = (ms: number) => inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, new Date(NOW.getTime() + ms)));
    expect(await at(10 * MIN)).not.toMatchObject({ id: "sleep" });
    expect(await at(61 * MIN)).toMatchObject({ kind: "dataset", id: "sleep" });
  });

  it("rejected key keeps cursor", async () => {
    network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 401 })));
    const stub = newStub();
    await inDo(stub, (sql) => { onlyPending(sql, "daily_summary"); patchState(sql, "daily_summary", { backfill_cursor: "2026-09-01" }); });
    const step = (await inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW)))!;
    expect(await caught(fetchStep(newDeps(), step))).toBeInstanceOf(KeyRejectedError);
    expect(await state(stub, "daily_summary")).toMatchObject({ backfill_cursor: "2026-09-01", last_error: null });
  });

  it("data 401 and 429 are rethrown", async () => {
    const m = garminMock({
      data: {
        "/hrv-service/": () => new HttpResponse(null, { status: 401 }),
        "/sleep-service/": () => new HttpResponse(null, { status: 429 }),
      },
    });
    network.use(...m.handlers);
    const deps = newDeps();
    const e401 = await caught(fetchStep(deps, { kind: "dataset", id: "hrv", start: TODAY, end: TODAY, backfill: false }));
    expect(e401).toBeInstanceOf(GarminHttpError);
    expect(e401.status).toBe(401);
    const e429 = await caught(fetchStep(deps, { kind: "dataset", id: "sleep", start: TODAY, end: TODAY, backfill: false }));
    expect(e429).toBeInstanceOf(RateLimitedError);
  });

  it("activities page spawns only the missing pieces", async () => {
    const m = garminMock({
      data: {
        "/activitylist-service/": [
          { activityId: 1, startTimeLocal: "2026-10-27 07:00:00" },
          { activityId: 2, startTimeLocal: "2026-10-26 08:00:00" },
          { activityId: 3, startTimeLocal: "2026-10-25 08:00:00" },
          { noId: true },
        ],
        "/activity-service/activity/1": { activityId: 1, summaryDTO: { startTimeLocal: "2026-10-27T07:00:00.0" } },
        "/activity-service/activity/1/workouts": () => new HttpResponse(null, { status: 204 }),
        "/activity-service/activity/3/workouts": () => new HttpResponse(null, { status: 204 }),
      },
    });
    network.use(...m.handlers);
    const stub = newStub();
    const deps = newDeps();
    await inDo(stub, (sql) => {
      // 2 is complete; 3 lacks workouts
      for (const k of ["2", "3"]) upsertRecords(sql, "activity_detail", [{ key: k, day: null, data: { activityId: Number(k) } }], NOW.toISOString());
      upsertRecords(sql, "activity_workouts", [{ key: "2", day: null, data: [] }], NOW.toISOString());
    });
    const page: Step = { kind: "activities", start: 0, limit: ACTIVITY_PAGE, backfill: false };
    const r = await runStep(stub, deps, page);
    expect(r.newSteps).toEqual([
      { kind: "activity_detail", activityId: "1" },
      { kind: "activity_workouts", activityId: "1" },
      { kind: "activity_workouts", activityId: "3" },
    ]);
    const rows = await inDo(stub, (sql) => ({
      acts: sql.exec("SELECT key, day FROM records WHERE dataset = 'activity' ORDER BY key").toArray(),
      typed: sql.exec("SELECT activity_id FROM activities ORDER BY activity_id").toArray(),
    }));
    expect(rows).toEqual({
      acts: [{ key: "1", day: "2026-10-27" }, { key: "2", day: "2026-10-26" }, { key: "3", day: "2026-10-25" }],
      typed: [{ activity_id: "1" }, { activity_id: "2" }, { activity_id: "3" }],
    });
    expect(await state(stub, "activity")).toMatchObject({ last_success_at: NOW.toISOString(), last_error: null });

    const d = await runStep(stub, deps, { kind: "activity_detail", activityId: "1" });
    expect(d).toEqual({ newSteps: [], rowsWritten: 1 });
    expect(await inDo(stub, (sql) => sql.exec("SELECT day FROM records WHERE dataset = 'activity_detail' AND key = '1'").one().day))
      .toBe("2026-10-27");
    await runStep(stub, deps, { kind: "activity_workouts", activityId: "1" });
    expect(await inDo(stub, (sql) => sql.exec("SELECT data FROM records WHERE dataset = 'activity_workouts' AND key = '1'").toArray()))
      .toEqual([{ data: "[]" }]);
    // missing after a partial run: only workouts 3
    expect((await runStep(stub, deps, page)).newSteps).toEqual([{ kind: "activity_workouts", activityId: "3" }]);
    await runStep(stub, deps, { kind: "activity_workouts", activityId: "3" });
    expect((await runStep(stub, deps, page)).newSteps).toEqual([]);
  });

  it("a full page of only new activities chains to the next page once history is loaded (R26)", async () => {
    const acts = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ activityId: from - i, startTimeLocal: "2026-10-27 07:00:00" }));
    const m = garminMock({
      data: {
        "/activitylist-service/activities/search/activities?start=0&": acts(130, 20), // all new
        "/activitylist-service/activities/search/activities?start=20&": [...acts(110, 10), ...acts(10, 10)], // 10…1 are known
        "/activitylist-service/activities/search/activities?start=40&": acts(90, 3), // short
      },
    });
    network.use(...m.handlers);
    const stub = newStub();
    const deps = newDeps();
    await inDo(stub, (sql) => upsertRecords(sql, "activity_detail",
      acts(10, 10).map((a) => ({ key: String(a.activityId), day: null, data: {} })), NOW.toISOString()));
    const page = (start: number): Step => ({ kind: "activities", start, limit: ACTIVITY_PAGE, backfill: false });
    const next = async (start: number) => (await runStep(stub, deps, page(start))).newSteps.filter((s) => s.kind === "activities");
    expect(await next(0)).toEqual([]); // history is still loading; backfill will walk its pages
    await inDo(stub, (sql) => patchState(sql, "activity", { backfill_done_at: NOW.toISOString() }));
    expect(await next(0)).toEqual([page(20)]);
    expect(await next(20)).toEqual([]); // the page has a known activity
    expect(await next(40)).toEqual([]); // short page
  });

  it("activities backfill moves by page and stops on a short page", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ activityId: from + i }));
    const m = garminMock({
      data: {
        "/activitylist-service/activities/search/activities?start=0&": page(20, 100),
        "/activitylist-service/activities/search/activities?start=20&": page(3, 200),
      },
    });
    network.use(...m.handlers);
    const stub = newStub();
    const deps = newDeps();
    await inDo(stub, (sql) => onlyPending(sql, "activity"));
    const next = () => inDo(stub, (sql) => nextBackfillStep(allStates(sql), TODAY, NOW));
    const s1 = (await next())!;
    expect(s1).toEqual({ kind: "activities", start: 0, limit: ACTIVITY_PAGE, backfill: true });
    expect((await runStep(stub, deps, s1)).newSteps).toHaveLength(40); // detail and workouts per activity
    expect(await state(stub, "activity")).toMatchObject({ backfill_cursor: "20", backfill_done_at: null });
    const s2 = (await next())!;
    expect(s2).toMatchObject({ kind: "activities", start: 20 });
    await runStep(stub, deps, s2);
    expect(await state(stub, "activity")).toMatchObject({ backfill_cursor: "23", backfill_done_at: NOW.toISOString() });
    expect(await next()).toBeNull();
  });

  it("userTimeZone falls back to UTC", async () => {
    const r = await inDo(newStub(), (sql) => {
      const put = (data: unknown) => upsertRecords(sql, "profile", [{ key: "current", day: null, data }], NOW.toISOString());
      const out = [userTimeZone(sql)];
      put({ timeZone: "Asia/Tokyo" });
      out.push(userTimeZone(sql));
      put({ timeZone: "Mars/Olympus" });
      out.push(userTimeZone(sql));
      put({ timeZone: "" });
      out.push(userTimeZone(sql));
      return out;
    });
    expect(r).toEqual(["UTC", "Asia/Tokyo", "UTC", "UTC"]);
  });
});
