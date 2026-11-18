import { describe, expect, it } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { network } from "./setup";
import { fakeJwt, garminMock, TOKEN_URL } from "./garmin-mock";
import {
  GARMIN_BASE, GarminClient, GarminHttpError, KeyRejectedError, RateLimitedError, parseRetryAfter,
  type CachedToken, type TokenStore,
} from "../src/garmin/client";

const memStore = (init?: CachedToken) => {
  let v = init;
  return { load: () => v, save: (t: CachedToken) => { v = t; }, get: () => v } satisfies TokenStore & { get(): CachedToken | undefined };
};
const caught = (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error("expected rejection"); }, (e) => e);
const nowSec = () => Math.floor(Date.now() / 1000);
const exchanges = (m: { calls: string[] }) => m.calls.filter((c) => c.startsWith("POST")).length;

describe("GarminClient", () => {
  it("exchanges key once and caches token", async () => {
    const m = garminMock({ data: { "/hrv-service": { ok: 1 } } });
    let auth = "", accept = "", bearer = "", dataAccept = "";
    network.use(
      http.post(TOKEN_URL, ({ request }) => {
        auth = request.headers.get("authorization")!; accept = request.headers.get("accept")!;
        return undefined; // fall through to the regular mock
      }),
      http.get(`${GARMIN_BASE}/hrv-service/*`, ({ request }) => {
        bearer = request.headers.get("authorization")!; dataAccept = request.headers.get("accept")!;
        return undefined;
      }),
      ...m.handlers,
    );
    const store = memStore();
    const c = new GarminClient("test-key", store);
    expect(await c.get("/hrv-service/hrv/2026-10-28")).toEqual({ ok: 1 });
    await c.get("/hrv-service/hrv/2026-10-29");
    expect(exchanges(m)).toBe(1);
    expect(auth).toBe("ApiKey test-key");
    expect(accept).toBe("*/*");
    expect(bearer).toBe(`Bearer ${store.get()!.t}`);
    expect(dataAccept).toBe("application/json");
    expect(c.tokenLifetimeSec()).toBe(86400);
  });

  it("re-exchanges when < 1h left", async () => {
    const m = garminMock();
    network.use(...m.handlers);
    const store = memStore({ t: fakeJwt({ exp: nowSec() + 1800, iat: nowSec() - 100 }), exp: nowSec() + 1800, iat: nowSec() - 100 });
    await new GarminClient("test-key", store).get("/x");
    expect(m.calls[0]).toMatch(/^POST /);
    expect(store.get()!.exp).toBeGreaterThan(nowSec() + 80000);
  });

  it("reuses a stored token with > 1h left", async () => {
    const m = garminMock();
    network.use(...m.handlers);
    const store = memStore({ t: "jwt", exp: nowSec() + 7200, iat: nowSec() });
    await new GarminClient("test-key", store).get("/x");
    expect(exchanges(m)).toBe(0);
  });

  it("replays once on 401, then fails", async () => {
    const m = garminMock();
    let n = 0;
    network.use(
      http.get(`${GARMIN_BASE}/a/*`, () => (++n === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json({ v: 1 }))),
      http.get(`${GARMIN_BASE}/b/*`, () => new HttpResponse("secret body", { status: 401 })),
      ...m.handlers,
    );
    const c = new GarminClient("test-key", memStore());
    expect(await c.get("/a/1")).toEqual({ v: 1 });
    expect(exchanges(m)).toBe(2);
    const c2 = new GarminClient("test-key", memStore());
    const before = exchanges(m);
    const err = await caught(c2.get("/b/1"));
    expect(err).toBeInstanceOf(GarminHttpError);
    expect(err.status).toBe(401);
    expect(exchanges(m) - before).toBe(2);
    expect(err.message).not.toContain("secret body");
  });

  it("204 and empty body are null", async () => {
    network.use(
      http.get(`${GARMIN_BASE}/hrv-service/*`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${GARMIN_BASE}/empty/*`, () => new HttpResponse("", { status: 200 })),
      ...garminMock().handlers,
    );
    const c = new GarminClient("test-key", memStore());
    expect(await c.get("/hrv-service/hrv/2026-10-28")).toBeNull();
    expect(await c.get("/empty/1")).toBeNull();
  });

  it("429 → RateLimitedError with floor", async () => {
    let ra = "120";
    network.use(
      http.get(`${GARMIN_BASE}/limited`, () => new HttpResponse(null, { status: 429, headers: { "retry-after": ra } })),
      ...garminMock().handlers,
    );
    const c = new GarminClient("test-key", memStore());
    const e1 = await caught(c.get("/limited"));
    expect(e1).toBeInstanceOf(RateLimitedError);
    expect(e1.retryAfterMs).toBe(900_000);
    ra = "3600";
    expect((await caught(c.get("/limited"))).retryAfterMs).toBe(3_600_000);
  });

  it("429 on token exchange is RateLimitedError; missing header → 900_000", async () => {
    network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 429 })));
    const e = await caught(new GarminClient("test-key", memStore()).get("/x"));
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.retryAfterMs).toBe(900_000);
  });

  it("parseRetryAfter handles seconds and HTTP-date", () => {
    const now = Date.parse("2026-10-28T00:00:00Z");
    expect(parseRetryAfter("7200", now)).toBe(7_200_000);
    expect(parseRetryAfter(new Date(now + 2 * 3600_000).toUTCString(), now)).toBe(7_200_000);
    expect(parseRetryAfter("garbage", now)).toBe(900_000);
    expect(parseRetryAfter(null, now)).toBe(900_000);
  });

  it("rejected key", async () => {
    network.use(http.post(TOKEN_URL, () => new HttpResponse("bad", { status: 401 })), ...garminMock().handlers);
    const err = await caught(new GarminClient("test-key", memStore()).get("/x"));
    expect(err).toBeInstanceOf(KeyRejectedError);
    expect(err.status).toBe(401);
    expect(String(err)).not.toContain("test-key");
    expect(err.message).not.toContain("bad");
  });

  it("empty-body 400", async () => {
    network.use(http.get(`${GARMIN_BASE}/bad`, () => new HttpResponse(null, { status: 400 })), ...garminMock().handlers);
    const err = await caught(new GarminClient("test-key", memStore()).get("/bad"));
    expect(err).toBeInstanceOf(GarminHttpError);
    expect(err).toMatchObject({ status: 400, emptyBody: true, path: "/bad" });
  });

  it("errors never contain key or JWT", async () => {
    const jwt = fakeJwt({ exp: nowSec() + 86400, iat: nowSec() });
    network.use(
      http.post(TOKEN_URL, () => new HttpResponse(jwt, { headers: { "content-type": "text/plain" } })),
      http.get(`${GARMIN_BASE}/boom`, () => new HttpResponse("body with details", { status: 500 })),
    );
    const err = await caught(new GarminClient("test-key", memStore()).get("/boom"));
    expect(err).toMatchObject({ status: 500, emptyBody: false });
    for (const s of [String(err), err.message]) {
      expect(s).not.toContain("test-key");
      expect(s).not.toContain(jwt);
      expect(s).not.toContain("body with details");
    }
  });

  it("non-JSON 2xx body → GarminHttpError without body text", async () => {
    network.use(http.get(`${GARMIN_BASE}/proxy`, () => new HttpResponse("<html>x", { status: 200 })), ...garminMock().handlers);
    const err = await caught(new GarminClient("test-key", memStore()).get("/proxy"));
    expect(err).toBeInstanceOf(GarminHttpError);
    expect(err.status).toBe(200);
    expect(String(err)).not.toContain("html");
    expect(err.message).not.toContain("html");
  });

  it("non-JWT token response → GarminHttpError, not saved", async () => {
    network.use(http.post(TOKEN_URL, () => new HttpResponse("not-a-jwt", { headers: { "content-type": "text/plain" } })));
    const store = memStore();
    const err = await caught(new GarminClient("test-key", store).get("/x"));
    expect(err).toBeInstanceOf(GarminHttpError);
    expect(err.status).toBe(200);
    expect(store.get()).toBeUndefined();
  });

  it("download sends zip Accept", async () => {
    let accept = "";
    network.use(
      http.get(`${GARMIN_BASE}/download-service/*`, ({ request }) => {
        accept = request.headers.get("accept")!;
        return new HttpResponse(new Uint8Array([80, 75, 3, 4]));
      }),
      ...garminMock().handlers,
    );
    const buf = await new GarminClient("test-key", memStore()).download("/download-service/files/activity/1");
    expect([...new Uint8Array(buf)]).toEqual([80, 75, 3, 4]);
    expect(accept).toBe("application/zip, application/x-zip-compressed, application/octet-stream");
  });

  it("hung request times out", async () => {
    network.use(http.get(`${GARMIN_BASE}/hang`, async () => { await delay("infinite"); }), ...garminMock().handlers);
    const t0 = Date.now();
    await expect(new GarminClient("test-key", memStore(), Date.now, 50).get("/hang")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("verify forces one exchange despite a fresh cached token", async () => {
    const m = garminMock();
    network.use(...m.handlers);
    const store = memStore({ t: "old", exp: nowSec() + 7200, iat: nowSec() });
    await new GarminClient("test-key", store).verify();
    expect(m.calls).toEqual([`POST ${new URL(TOKEN_URL).pathname}`]);
    expect(store.get()!.t).not.toBe("old");
  });

  it("verify times out on a slow token exchange", async () => {
    network.use(http.post(TOKEN_URL, async () => {
      await delay(2000);
      return new HttpResponse(fakeJwt({ exp: nowSec() + 86400, iat: nowSec() }));
    }));
    const err = await caught(new GarminClient("test-key", memStore(), Date.now, 50).verify());
    expect(err.name).toBe("TimeoutError");
  });
});
