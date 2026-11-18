import { DurableObject } from "cloudflare:workers";
import { ACTIVITY_PAGE, DATASETS } from "../garmin/catalog";
import { GarminClient, GarminHttpError, KeyRejectedError, RateLimitedError, type CachedToken } from "../garmin/client";
import { addDays, localDate } from "../garmin/dates";
import { historyStart } from "../mcp/queries";
import { runTool } from "../mcp/tools";
import {
  applyStep, BACKFILL_ORDER, fetchedFiles, fetchStep, nextBackfillStep, recentSteps, repairSteps, stateKey, staticSteps, stepKey, stepLabel, userTimeZone,
  type Fetched, type Step,
} from "./engine";
import { importKek, open, seal, type Sealed } from "./crypto";
import { migrate } from "./schema";
import { allStates, patchState } from "./store";

export const ROWS_WRITTEN_BUDGET = 60_000, KEY_PAUSE_MS = 3_600_000;
export const VALIDITY_DAYS = [30, 90, 180, 365]; // key lifetimes in Garmin Connect; the owner checks them before deploy
const MAX_KEY_LEN = 4096;
const HOUR_MS = 3_600_000, DAILY_EVERY_MS = 23 * HOUR_MS, DAY_MS = 86_400_000, SLEEP_AFTER_MS = 30 * DAY_MS;
// the narrowest window of the range datasets (steps, stress: 28 days): Garmin does not serve wider ones
const RANGE_SPAN = Math.min(...DATASETS.filter((d) => d.kind === "range").map((d) => d.window));
const SHORT_TOKEN_SEC = 86_100; // Garmin shortens the token when the key has less than a day left

export type SettingsState = {
  key: "none" | "ok" | "expiring" | "rejected";
  keyExpiresOn?: string;
  daysLeft?: number;
  hasData: boolean;
  history: { done: boolean; percent: number; from?: string };
  lastSyncAt?: string;
  pausedUntil?: number;
};

interface Job { step: Step; id?: number } // id is the queue row; no id means a backfill step

const rowsKey = (ms: number) => `rows:${new Date(ms).toISOString().slice(0, 10)}`;
// Status or name only: error messages may carry pieces of responses
const errorName = (e: unknown) => e instanceof GarminHttpError ? `HTTP ${e.status}` : e instanceof Error ? e.name : "Error";

/** Minute of the hourly kick: 0–59 from the object id, so users do not hit Garmin all at once */
export function kickOffset(id: string): number {
  return parseInt(id.slice(0, 8), 16) % 60;
}

/** The first hh:offset:00 UTC strictly after now */
export function nextKickTime(now: number, offsetMin: number): number {
  const t = Math.floor(now / HOUR_MS) * HOUR_MS + offsetMin * 60_000;
  return t > now ? t : t + HOUR_MS;
}

/** The free plan's daily write limit is exhausted: no write goes through until 00:00 UTC, setAlarm included */
export function isQuotaError(e: unknown): boolean {
  const m = String(e).toLowerCase();
  return m.includes("free tier") && m.includes("exceed");
}

/** day steps for each date, range datasets as one [min, max] window, the first page of activities */
function datesSteps(dates: string[]): Step[] {
  const days = [...new Set(dates)].sort();
  if (!days.length) return [];
  const start = days[0], end = days[days.length - 1];
  return [
    ...DATASETS.filter((d) => d.kind === "day")
      .flatMap((d) => days.map((x): Step => ({ kind: "dataset", id: d.id, start: x, end: x, backfill: false }))),
    ...DATASETS.filter((d) => d.kind === "range")
      .map((d): Step => ({ kind: "dataset", id: d.id, start, end, backfill: false })),
    { kind: "activities", start: 0, limit: ACTIVITY_PAGE, backfill: false },
  ];
}

// All Garmin work happens in alarm(), one step per call; kick/syncNow only enqueue steps.
// No cron: the hourly kick is an alarm too (nextKickAt); after 30 days without the user no alarm is set, touch wakes it.
// The rows:<UTC-day> counter accumulates all writes (SQL, kv, setAlarm): the backfill budget.
export class UserStore extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;
  private readonly kv = this.ctx.storage.kv;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  ping(): string {
    return "pong";
  }

  /**
   * Hourly kick: today and yesterday; if the daily run was > 23 h ago, also 7 days, the static datasets
   * and the missing pieces of incomplete activities (repairSteps). The next one is at nextKickAt.
   */
  async kick(at: number): Promise<void> {
    const today = localDate(userTimeZone(this.sql), new Date(at));
    const daily = (this.kv.get<number>("lastDailyAt") ?? 0) < at - DAILY_EVERY_MS;
    const steps = recentSteps(today, 2);
    if (daily) steps.push(...recentSteps(today, 7), ...staticSteps(today), ...repairSteps(this.sql));
    await this.submit(steps, { nextKickAt: this.nextKick(at), ...(daily ? { lastDailyAt: at } : {}) });
  }

  /**
   * The user showed up (tool call, settings page). If asleep, wake up: day steps for the dates from the last daily
   * kick through today, and nextKickAt. lastSeenAt is written at most once an hour. Key present but no alarm: set one.
   * Quota exhausted: skip; reads work anyway, and a touch after 00:00 UTC will wake the sync.
   */
  async touch(now: number): Promise<void> {
    try {
      if (this.asleep(now)) {
        const tz = userTimeZone(this.sql), today = localDate(tz, new Date(now)), last = this.kv.get<number>("lastDailyAt");
        const dates: string[] = [], steps: Step[] = [];
        // without lastDailyAt there are no missed dates: the next kick is a daily one anyway
        if (last !== undefined) for (let d = localDate(tz, new Date(last)); d <= today; d = addDays(d, 1)) dates.push(d);
        for (let i = 0; i < dates.length; i += RANGE_SPAN) steps.push(...datesSteps(dates.slice(i, i + RANGE_SPAN)));
        await this.submit(steps, { nextKickAt: this.nextKick(now) });
      }
      if (now - (this.kv.get<number>("lastSeenAt") ?? 0) > HOUR_MS) {
        this.kv.put("lastSeenAt", now);
        this.addRows(now, 1);
      }
      if (this.hasKey() && (await this.ctx.storage.getAlarm()) === null) await this.arm(now, now + this.gap());
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      console.log(JSON.stringify({ quota: "exhausted" }));
    }
  }

  /**
   * queued: how many steps were submitted for these dates (ones already in the queue count too);
   * etaSeconds: rest of the pause (429, key rejected) + the whole queue, ~1 s per step. An empty list enqueues nothing.
   */
  async syncNow(dates: string[]): Promise<{ queued: number; etaSeconds: number }> {
    const steps = datesSteps(dates);
    if (steps.length) await this.submit(steps);
    const pause = Math.max(0, Math.ceil(((this.kv.get<number>("pausedUntil") ?? 0) - Date.now()) / 1000));
    return { queued: steps.length, etaSeconds: pause + this.queueSize() };
  }

  /**
   * One RPC per tool call; the writes come from touch and sync_now (via syncNow).
   * The name goes to the log as is: only createServer calls this, and only with registered names.
   */
  async callTool(name: string, args: Record<string, unknown>, origin: string): Promise<{ text: string; isError: boolean }> {
    await this.touch(Date.now());
    console.log(JSON.stringify({ tool: name }));
    return runTool({
      storage: this.ctx.storage, sql: this.sql, files: this.env.FILES, now: new Date(),
      keyExpiresAt: this.kv.get<string>("keyExpiresOn") ?? "", hasKey: this.hasKey(),
      settingsUrl: `${origin}/garmin/settings`, syncNow: (d) => this.syncNow(d), queueSize: () => this.queueSize(),
    }, name, args);
  }

  /**
   * Key from the form: one exchange with Garmin; on failure nothing is written. On success, in one transaction:
   * key and token (sealed), expiry, lastSeenAt, reset of pause, _key error and lastDailyAt (the next kick is daily);
   * then kick.
   */
  async saveKey(apiKey: string, validityDays: number):
    Promise<{ ok: true } | { ok: false; reason: "invalid" | "rejected" | "unavailable" }> {
    const key = apiKey.trim();
    // printable ASCII without spaces (and non-empty): otherwise the key will not fit into the Authorization header
    if (key.length > MAX_KEY_LEN || !/^[\x21-\x7e]+$/.test(key) || !VALIDITY_DAYS.includes(validityDays)) {
      return { ok: false, reason: "invalid" };
    }
    const kek = await this.kek(), aad = this.ctx.id.toString(); // a bad KEY_ENCRYPTION_KEY throws before Garmin
    let token: CachedToken | undefined;
    try {
      await new GarminClient(key, { load: () => undefined, save: (v) => { token = v; } }).verify();
    } catch (e) {
      return { ok: false, reason: e instanceof KeyRejectedError ? "rejected" : "unavailable" }; // 429, 5xx, timeout, network
    }
    const sealedKey = await seal(kek, key, aad), sealedToken = await seal(kek, JSON.stringify(token), aad);
    const now = new Date();
    this.ctx.storage.transactionSync(() => {
      this.kv.put("garminKey", sealedKey);
      this.kv.put("token", sealedToken);
      this.kv.put("keyExpiresOn", addDays(now.toISOString().slice(0, 10), validityDays));
      this.kv.put("keySavedAt", now.toISOString());
      this.kv.put("lastSeenAt", now.getTime());
      const n = 5 + Number(this.kv.delete("pausedUntil")) + Number(this.kv.delete("lastDailyAt"))
        + patchState(this.sql, "_key", { last_error: null });
      this.addRows(now.getTime(), n);
    });
    await this.kick(Date.now());
    return { ok: true };
  }

  /** Key, token, expiry, pause, queue and alarm; the data stays */
  async deleteKey(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let n = this.sql.exec("DELETE FROM queue").rowsWritten + 1; // + deleteAlarm
      for (const k of ["garminKey", "token", "keyExpiresOn", "keySavedAt", "pausedUntil", "nextKickAt"]) {
        n += Number(this.kv.delete(k));
      }
      this.addRows(Date.now(), n);
    });
    await this.ctx.storage.deleteAlarm();
  }

  /** All user data: R2 files, SQL, kv, alarm. Over 20×1000 files: done: false, calling again continues */
  async deleteAllData(): Promise<{ done: boolean }> {
    const prefix = `u/${this.ctx.id.toString()}/`;
    // ponytail: 20×1000 files per call; pressing Delete all again continues
    for (let i = 0; i < 20; i++) {
      const { objects } = await this.env.FILES.list({ prefix, limit: 1000 });
      if (!objects.length) break;
      await this.env.FILES.delete(objects.map((o) => o.key));
    }
    if ((await this.env.FILES.list({ prefix, limit: 1 })).objects.length) return { done: false };
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    migrate(this.ctx.storage); // the object lives until eviction: later calls need the empty tables
    return { done: true };
  }

  /**
   * Settings page state: key (none > rejected > expiring > ok), history progress, last sync, pause.
   * rejected also covers a key that will not open: saving seals it again with the current KEY_ENCRYPTION_KEY.
   */
  async settingsState(): Promise<SettingsState> {
    const now = Date.now();
    await this.touch(now);
    const sealed = this.kv.get<Sealed>("garminKey");
    const unreadable = sealed !== undefined && (await this.openKey(await this.kek(), sealed)) === null;
    const states = allStates(this.sql), expires = this.kv.get<string>("keyExpiresOn");
    const daysLeft = expires === undefined ? undefined
      : Math.round((Date.parse(expires) - Date.parse(new Date(now).toISOString().slice(0, 10))) / DAY_MS);
    const done = BACKFILL_ORDER.filter((id) => states.get(id)?.backfill_done_at).length;
    const lastSyncAt = [...states.values()].map((s) => s.last_success_at).filter((v): v is string => !!v).sort().at(-1);
    const paused = this.kv.get<number>("pausedUntil");
    const from = historyStart(states) ?? undefined;
    return {
      key: !sealed ? "none" : unreadable || states.get("_key")?.last_error === "key_rejected" ? "rejected"
        : daysLeft !== undefined && daysLeft <= 14 ? "expiring" : "ok",
      ...(this.hasKey() && expires !== undefined ? { keyExpiresOn: expires, daysLeft } : {}),
      hasData: this.sql.exec("SELECT 1 FROM records LIMIT 1").toArray().length > 0,
      history: { done: done === BACKFILL_ORDER.length, percent: Math.round(100 * done / BACKFILL_ORDER.length), ...(from ? { from } : {}) },
      ...(lastSyncAt ? { lastSyncAt } : {}),
      ...(paused && paused > now ? { pausedUntil: paused } : {}),
    };
  }

  /**
   * A run, then rearm. Quota exhausted: write nothing more, touch wakes it. Any other error (a broken
   * KEY_ENCRYPTION_KEY, a corrupted queue row): retry in an hour rather than after STEP_GAP_MS, and rethrow.
   */
  async alarm(): Promise<void> {
    try {
      if (await this.tick()) await this.rearm();
    } catch (e) {
      if (isQuotaError(e)) {
        console.log(JSON.stringify({ quota: "exhausted" }));
        return;
      }
      try {
        const ms = Date.now();
        if (this.hasKey() && !this.asleep(ms)) await this.arm(ms, ms + HOUR_MS); // touch wakes a sleeping user
      } catch {
        // the retry is best effort: its failure must not mask the original error
      }
      throw e;
    }
  }

  /**
   * Hourly kick if it is due and the user is not asleep; then a step unless paused.
   * false: leave the alarm alone; there is no key, or it was replaced or deleted
   */
  private async tick(): Promise<boolean> {
    const g = await this.garmin();
    if (!g) return false; // no key, no sync; saveKey starts it
    const now = new Date();
    if (!this.asleep(now.getTime()) && now.getTime() >= (this.kv.get<number>("nextKickAt") ?? 0)) await this.kick(now.getTime());
    if (now.getTime() < (this.kv.get<number>("pausedUntil") ?? 0)) return true;
    const today = localDate(userTimeZone(this.sql), now);
    const job = this.take(today, now);
    if (!job) return true;
    console.log(JSON.stringify({ step: stepLabel(job.step) }));

    let f: Fetched;
    try {
      f = await fetchStep({ client: g.client, files: this.env.FILES, prefix: `u/${this.ctx.id.toString()}/`, today }, job.step);
    } catch (e) {
      if (!(await g.afterFetch())) return false; // key replaced or deleted: skip the step write; alarm is up to saveKey/deleteKey
      if (e instanceof RateLimitedError) {
        this.pause(now, now.getTime() + e.retryAfterMs, () =>
          g.keyRows() + patchState(this.sql, stateKey(job.step), { last_error: "HTTP 429", last_error_at: now.toISOString() }));
      } else if (e instanceof KeyRejectedError) {
        this.pause(now, now.getTime() + KEY_PAUSE_MS, () =>
          g.putToken() + patchState(this.sql, "_key", { last_error: "key_rejected", last_error_at: now.toISOString() }));
      } else this.fail(now, job, e, g.keyRows);
      return true;
    }
    if (!(await g.afterFetch())) {
      // and the step's files: Delete all may have run while the step waited for Garmin, and its list will not see them
      const files = fetchedFiles(f);
      if (files.length) await this.env.FILES.delete(files);
      return false;
    }
    try {
      this.write(now, () => {
        const r = applyStep(this.sql, job.step, f, now, today);
        return r.rowsWritten + this.dequeue(job) + this.enqueue(r.newSteps, 1) + g.keyRows();
      });
    } catch (e) {
      this.fail(now, job, e, g.keyRows); // a rolled-back step write must not hold the head of the queue forever
    }
    return true;
  }

  /**
   * Step failure: the error goes to sync_state (an hour without backfill for this dataset), the step leaves the queue.
   * If this write fails too (for example, quota exhausted), the exception propagates.
   */
  private fail(now: Date, job: Job, e: unknown, rows: () => number): void {
    this.write(now, () => patchState(this.sql, stateKey(job.step), { last_error: errorName(e), last_error_at: now.toISOString() })
      + this.dequeue(job) + rows());
  }

  /** The first queue step (priority, id); otherwise backfill, until the row budget is exhausted */
  private take(today: string, now: Date): Job | null {
    const row = this.sql.exec<{ id: number; step: string }>("SELECT id, step FROM queue ORDER BY priority, id LIMIT 1").toArray()[0];
    if (row) return { id: row.id, step: JSON.parse(row.step) as Step };
    if (this.rowsOn(now.getTime()) >= ROWS_WRITTEN_BUDGET) return null;
    const step = nextBackfillStep(allStates(this.sql), today, now);
    return step && { step };
  }

  /** A key is saved (garmin() checks whether it opens) */
  private hasKey(): boolean {
    return this.kv.get("garminKey") !== undefined;
  }

  private kek(): Promise<CryptoKey> {
    return importKek(this.env.KEY_ENCRYPTION_KEY);
  }

  /**
   * Client from the sealed key; null when there is no key or it will not open (e.g. copied from another object).
   * TokenStore is synchronous: the kv token is opened up front, a new one is caught in memory. afterFetch(), after the
   * request and before the transaction, seals the new token; false means the key was replaced or deleted during the
   * request. In the transaction: putToken() writes the token, keyRows() the token and the _key state (error reset or
   * "key expiring") if there was an exchange.
   */
  private async garmin() {
    const sealedKey = this.kv.get<Sealed>("garminKey");
    if (!sealedKey) return null;
    const kek = await this.kek(), aad = this.ctx.id.toString();
    const apiKey = await this.openKey(kek, sealedKey);
    if (apiKey === null) return null;
    const stored = this.kv.get<Sealed>("token");
    let token: CachedToken | undefined = stored && await open(kek, stored, aad).then(JSON.parse, () => undefined);
    let saved = false, sealedToken: Sealed | undefined;
    const client = new GarminClient(apiKey, {
      load: () => token,
      save: (v) => {
        token = v;
        saved = true;
      },
    });
    const putToken = () => {
      if (!sealedToken) return 0;
      this.kv.put("token", sealedToken);
      return 1;
    };
    return {
      client,
      putToken,
      afterFetch: async () => {
        if (saved) sealedToken = await seal(kek, JSON.stringify(token), aad);
        return this.kv.get<Sealed>("garminKey")?.ct === sealedKey.ct;
      },
      keyRows: () => sealedToken ? putToken() + patchState(this.sql, "_key", {
        last_error: (client.tokenLifetimeSec() ?? 0) < SHORT_TOKEN_SEC ? "key_expires_within_24h" : null,
      }) : 0,
    };
  }

  /** Key will not open (KEY_ENCRYPTION_KEY changed, copied from another object): null and {"key":"unreadable"} to the log */
  private async openKey(kek: CryptoKey, sealed: Sealed): Promise<string | null> {
    const key = await open(kek, sealed, this.ctx.id.toString()).catch(() => null);
    if (key === null) console.log(JSON.stringify({ key: "unreadable" }));
    return key;
  }

  /** The step's writes in one transaction together with the counter (rearm counts setAlarm) */
  private write(now: Date, rows: () => number): void {
    this.ctx.storage.transactionSync(() => this.addRows(now.getTime(), rows()));
  }

  /** Pauses the whole queue; the step stays in place, rearm sets the alarm for the end of the pause */
  private pause(now: Date, until: number, rows: () => number): void {
    this.write(now, () => {
      this.kv.put("pausedUntil", until);
      return rows() + 1;
    });
  }

  /**
   * Alarm from the fresh state, at the earliest of: the next step (queue: after STEP_GAP_MS or at the end of the pause;
   * backfill: same, or 00:00 UTC + 60 s with no budget) and nextKickAt. No key or asleep: nothing (touch wakes it).
   */
  private async rearm(): Promise<void> {
    const now = new Date(), ms = now.getTime(), paused = this.kv.get<number>("pausedUntil") ?? 0;
    if (!this.hasKey() || this.asleep(ms)) return;
    const next = paused > ms ? paused : ms + this.gap();
    let at = Infinity;
    if (this.sql.exec("SELECT 1 FROM queue LIMIT 1").toArray().length) at = next;
    else if (nextBackfillStep(allStates(this.sql), localDate(userTimeZone(this.sql), now), now)) {
      at = this.rowsOn(ms) < ROWS_WRITTEN_BUDGET ? next : (Math.floor(ms / DAY_MS) + 1) * DAY_MS + 60_000;
    }
    at = Math.min(at, this.kv.get<number>("nextKickAt") ?? Infinity);
    if (at !== Infinity) await this.arm(ms, at);
  }

  /** setAlarm and its row in the counter */
  private async arm(now: number, at: number): Promise<void> {
    this.addRows(now, 1);
    await this.ctx.storage.setAlarm(at);
  }

  /** Asleep: there is a key, but 30 days without calls or settings page visits (no lastSeenAt means not asleep) */
  private asleep(now: number): boolean {
    return this.hasKey() && now - (this.kv.get<number>("lastSeenAt") ?? now) > SLEEP_AFTER_MS;
  }

  private nextKick(at: number): number {
    return nextKickTime(at, kickOffset(this.ctx.id.toString()));
  }

  /** Steps into the queue (priority 0) and the alarm; kv writes from puts go in the same transaction */
  private async submit(steps: Step[], puts: Record<string, unknown> = {}): Promise<void> {
    const now = Date.now();
    const wake = await this.wakeAt(now);
    this.ctx.storage.transactionSync(() => {
      let n = this.enqueue(steps, 0) + (wake === null ? 0 : 1);
      for (const [k, v] of Object.entries(puts)) {
        this.kv.put(k, v);
        n++;
      }
      this.addRows(now, n);
    });
    if (wake !== null) await this.ctx.storage.setAlarm(wake);
  }

  /**
   * When to wake: max(now + STEP_GAP_MS, pausedUntil) if there is no alarm or it is later
   * (otherwise new steps would wait for the midnight alarm of an exhausted budget). null: no change needed.
   */
  private async wakeAt(now: number): Promise<number | null> {
    const want = Math.max(now + this.gap(), this.kv.get<number>("pausedUntil") ?? 0);
    const cur = await this.ctx.storage.getAlarm();
    return cur === null || cur > want ? want : null;
  }

  /** INSERT OR IGNORE: 2 rows for a new step, 0 for a duplicate */
  private enqueue(steps: Step[], priority: 0 | 1): number {
    let n = 0;
    for (const s of steps) {
      n += this.sql.exec("INSERT OR IGNORE INTO queue(key, priority, step) VALUES (?, ?, ?)", stepKey(s), priority,
        JSON.stringify(s)).rowsWritten;
    }
    return n;
  }

  private dequeue(job: Job): number {
    return job.id === undefined ? 0 : this.sql.exec("DELETE FROM queue WHERE id = ?", job.id).rowsWritten;
  }

  private queueSize(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue").one().n;
  }

  private rowsOn(ms: number): number {
    return this.kv.get<number>(rowsKey(ms)) ?? 0;
  }

  /** rows:<UTC-day> += n + 1 (the counter write itself) */
  private addRows(ms: number, n: number): void {
    this.kv.put(rowsKey(ms), this.rowsOn(ms) + n + 1);
  }

  private gap(): number {
    return Number(this.env.STEP_GAP_MS);
  }
}
