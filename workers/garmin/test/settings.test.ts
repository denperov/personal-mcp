import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { network } from "./setup";
import { garminMock, TOKEN_URL } from "./garmin-mock";
import { addDays } from "../src/garmin/dates";
import { renderPage } from "../src/settings/page";
import { handleSettings } from "../src/settings/route";
import { patchState, upsertRecords } from "../src/user/store";
import type { SettingsState } from "../src/user/user-store";

// How personal-mcp-gateway calls it: /garmin prefix stripped, email verified; in the browser the page is /garmin/settings
const PAGE = "https://mcp.example.com/settings";
const ORIGIN = "https://mcp.example.com";
const SAVE = { action: "save", key: "test-key", validity: "365" };
const newEmail = () => `t-${crypto.randomUUID()}@x`;
const get = (email: string, url = PAGE, method = "GET") => exports.default.handle(new Request(url, { method }), email);
const html = async (email: string, query = "") => (await get(email, PAGE + query)).text();
const post = (email: string, fields: Record<string, string>) =>
  exports.default.handle(new Request(PAGE, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams(fields) }), email);
const inDo = <R>(email: string, f: (sql: SqlStorage, st: DurableObjectState) => R | Promise<R>) =>
  runInDurableObject(env.USER_DO.getByName(email), (_i, st) => f(st.storage.sql, st));
const kvKeys = (email: string) => inDo(email, (_s, st) => [...st.storage.kv.list()].map(([k]) => k));
const addRecord = (email: string) =>
  inDo(email, (sql) => upsertRecords(sql, "daily_summary", [{ key: "2026-10-27", day: "2026-10-27", data: { a: 1 } }], "t"));
const records = (email: string) => inDo(email, (sql) => sql.exec("SELECT 1 FROM records").toArray().length);
const badges = (page: string) => page.match(/class="badge /g)?.length;

/** A user with a key saved through the page */
async function withKey(): Promise<string> {
  network.use(...garminMock().handlers);
  const email = newEmail();
  expect((await post(email, SAVE)).headers.get("location")).toBe("/garmin/settings");
  return email;
}

it("first visit shows the setup steps", async () => {
  const r = await get(newEmail());
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("content-security-policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  // no-referrer would make the browser send Origin: null in form POSTs — the Origin check would reject every save
  expect(r.headers.get("referrer-policy")).toBe("same-origin");
  const page = await r.text();
  expect(page).toContain("Not connected");
  expect(page).toContain("Create a key in Garmin Connect");
  expect(page).toContain('href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer"');
  expect(page).not.toContain("Delete all data");
  expect(page).toContain("<span>Personal MCP gives no one a way to see another person's data. The owner of this server can still read it "
    + "directly in their Cloudflare account. Save your key here only if you trust the owner.</span></div>");
  expect(badges(page)).toBe(1);
});

it("save then the page shows Connected or Loading history and the connector address", async () => {
  const email = await withKey();
  const page = await html(email);
  expect(page).toMatch(/Connected|Loading history/);
  expect(page).toContain("https://mcp.example.com/garmin/mcp");
  expect(page).toContain("Replace key");
  expect(page).not.toContain("test-key");
  expect(page).not.toContain("only if you trust the owner");
});

it("rejected key shows the error and stores nothing", async () => {
  network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 401 })));
  const email = newEmail();
  const r = await post(email, SAVE);
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/garmin/settings?error=rejected&validity=365");
  expect(await kvKeys(email)).toEqual([]);
  const page = await html(email, "?error=rejected&validity=365");
  expect(page).toContain("Garmin rejected this key. Check that you copied all of it, or create a new one.");
  expect(page).toContain('aria-describedby="key-error"');
  expect(page).toContain("Not connected");
  expect(page).not.toContain("test-key");
});

it("a failed save keeps the chosen validity, only from the list", async () => {
  network.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 401 })));
  const email = newEmail();
  const r = await post(email, { ...SAVE, validity: "90" });
  expect(r.headers.get("location")).toBe("/garmin/settings?error=rejected&validity=90");
  const page = await html(email, "?error=rejected&validity=90");
  expect(page).toContain('<option value="90" selected');
  expect(page).not.toContain('<option value="365" selected');
  expect((await post(email, { ...SAVE, validity: "7" })).headers.get("location")).toBe("/garmin/settings?error=invalid");
  const ignored = await html(email, "?validity=7");
  expect(ignored).toContain('<option value="365" selected');
  expect(ignored).not.toContain('value="7"');
});

it("POST without or with a foreign Origin is 403", async () => {
  // no body: the request is refused before the form is read
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }] as Record<string, string>[]) {
    const email = newEmail();
    const r = await exports.default.handle(new Request(PAGE, { method: "POST", headers }), email);
    expect(r.status).toBe(403);
    expect(await kvKeys(email)).toEqual([]);
  }
});

it("the page and its form follow the host the request came to", async () => {
  const email = await withKey();
  expect(await (await get(email, "https://other.example/settings")).text()).toContain("https://other.example/garmin/mcp");
  const del = (origin: string) => exports.default.handle(new Request("https://other.example/settings",
    { method: "POST", headers: { origin }, body: new URLSearchParams({ action: "delete-key" }) }), email);
  for (const foreign of [ORIGIN, "http://other.example", "https://other.example:8443"]) expect((await del(foreign)).status).toBe(403);
  expect((await del("https://other.example")).headers.get("location")).toBe("/garmin/settings");
});

it("saving the same key twice is idempotent and always redirects 303", async () => {
  const email = await withKey();
  const first = await html(email);
  const queue = await inDo(email, (sql) => sql.exec("SELECT key FROM queue ORDER BY id").toArray());
  const r = await post(email, SAVE);
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/garmin/settings");
  expect(await html(email)).toBe(first);
  expect(await inDo(email, (sql) => sql.exec("SELECT key FROM queue ORDER BY id").toArray())).toEqual(queue);
});

it("email is HTML-escaped", async () => {
  const page = await html("o'neil+x@example.org<b>");
  expect(page).toContain("o&#39;neil+x@example.org&lt;b&gt;");
  expect(page).not.toContain("o'neil+x@example.org<b>");
});

it("expiring and rejected badges", async () => {
  const email = await withKey();
  const today = new Date().toISOString().slice(0, 10);
  await inDo(email, (_s, st) => st.storage.kv.put("keyExpiresOn", addDays(today, 9)));
  let page = await html(email);
  expect(page).toContain("Key expires in 9 days");
  expect(badges(page)).toBe(1);
  await inDo(email, (sql) => patchState(sql, "_key", { last_error: "key_rejected" }));
  page = await html(email);
  expect(page).toContain("Key rejected");
  expect(page).toMatch(/<details[^>]* open/); // "replace it below": the form is already visible
  expect(page).not.toContain("Key expires");
  expect(badges(page)).toBe(1);
});

it("delete-key keeps the data and shows the setup steps plus the Delete all data row", async () => {
  const email = await withKey();
  await addRecord(email);
  const r = await post(email, { action: "delete-key" });
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/garmin/settings");
  expect(await records(email)).toBe(1);
  const page = await html(email);
  expect(page).toContain("Not connected");
  expect(page).toContain("Create a key in Garmin Connect");
  expect(page).toContain("Delete all data");
  expect(page).not.toContain('value="delete-key"');
  expect(page).not.toContain("Connect Claude");
});

it("delete-all returns to the first-visit page", async () => {
  const email = await withKey();
  await addRecord(email);
  const prefix = await inDo(email, (_s, st) => `u/${st.id.toString()}/`);
  await env.FILES.put(`${prefix}file`, "x");
  const r = await post(email, { action: "delete-all" });
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/garmin/settings");
  expect((await env.FILES.list({ prefix })).objects).toEqual([]);
  const page = await html(email);
  expect(page).toContain("Not connected");
  expect(page).toContain("Create a key in Garmin Connect");
  expect(page).not.toContain("Delete all data");
});

it("unknown error code in the query is ignored", async () => {
  const email = newEmail();
  for (const q of ["?error=bogus", "?error=toString", "?error=%3Cscript%3E"]) {
    const page = await html(email, q);
    expect(page).toContain("Not connected");
    expect(page).not.toContain('class="error"');
    expect(page).not.toMatch(/bogus|toString|<script>/);
  }
});

it("a failing Durable Object call redirects with error=unavailable, not a 1101 page", async () => {
  const fail = () => Promise.reject(new Error("Durable Object reset because its code was updated."));
  const broken = { USER_DO: { getByName: () => ({ saveKey: fail, deleteKey: fail, deleteAllData: fail }) } };
  for (const [fields, location] of [
    [{ ...SAVE, validity: "90" }, "/garmin/settings?error=unavailable&validity=90"],
    [{ action: "delete-key" }, "/garmin/settings?error=unavailable"],
    [{ action: "delete-all" }, "/garmin/settings?error=unavailable"],
  ] as const) {
    const r = await handleSettings(new Request(PAGE, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams(fields) }),
      newEmail(), broken as unknown as Env);
    expect(r.status, fields.action).toBe(303);
    expect(r.headers.get("location")).toBe(location);
  }
});

it("unknown action redirects without changes", async () => {
  const email = newEmail();
  const r = await post(email, { action: "bogus", key: "test-key", validity: "365" });
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/garmin/settings");
  expect(await kvKeys(email)).toEqual([]);
});

it("other paths 404, PUT 405", async () => {
  const email = newEmail();
  expect((await get(email, "https://mcp.example.com/settings/x")).status).toBe(404);
  expect((await get(email, "https://mcp.example.com/garmin/settings")).status).toBe(404);
  expect((await get(email, PAGE, "PUT")).status).toBe(405);
});

it("state line follows the badge precedence", () => {
  const base: SettingsState = { key: "ok", keyExpiresOn: "2028-02-14", daysLeft: 364, hasData: true, history: { done: true, percent: 100 } };
  const render = (s: Partial<SettingsState>, error?: "invalid" | "rejected" | "unavailable" | "deleting") =>
    renderPage({ ...base, ...s }, { email: "a@x", origin: "https://mcp.example.com", error });
  const loading = { history: { done: false, percent: 62, from: "2024-02-12" } };
  const pause = { pausedUntil: Date.parse("2026-11-08T15:30:00Z") };

  expect(render({ lastSyncAt: "2026-11-07T14:07:12Z" })).toContain("Connected</span><p>Last sync November 7, 14:07 UTC</p>");
  expect(render({})).toContain("Connected</span></div>");
  expect(render({})).toContain("Valid until February 14, 2028");
  expect(render({})).not.toContain('class="bar"');
  const l = render(loading);
  expect(l).toContain("Loading history</span><p>62% done, from February 12, 2024</p>");
  expect(l).toContain('<i style="width:62%">');
  const p = render({ ...loading, ...pause });
  expect(p).toContain("Paused</span><p>until 15:30 UTC</p>");
  expect(p).toContain('class="bar"');
  expect(render({ ...loading, ...pause, key: "expiring", daysLeft: 1 })).toContain("Key expires in 1 day</span>");
  const expired = render({ ...pause, key: "expiring", daysLeft: 0 });
  expect(expired).toContain("Key expired</span>");
  expect(expired).toContain("Expired on February 14, 2028");
  expect(expired).toContain("<details open>");
  expect(render({ key: "expiring", daysLeft: 3 })).toContain("<details>");
  expect(render({ ...loading, key: "rejected", daysLeft: 0 })).toContain("Key rejected</span>");
  for (const s of [{}, loading, pause, { key: "rejected" as const }]) expect(badges(render(s))).toBe(1);

  const failed = render({}, "unavailable");
  expect(failed).toContain("<details open>");
  expect(failed).toContain('aria-describedby="key-error"><p class="error" id="key-error">Garmin is not responding. Try again in a few minutes.</p>');
  expect(render({})).toContain('<details><summary class="row"><span>Working<br><span class="desc">Valid until February 14, 2028</span></span>');
  expect(render({})).toContain('<span class="btn">Replace key</span></summary>');
  const deleting = render({}, "deleting");
  expect(deleting).toContain('aria-describedby="delete-error"');
  expect(deleting).toContain("Some files are still being deleted. Press Delete all again.");
  expect(deleting).toContain("<details>");
  expect(render({ key: "none", hasData: false }, "invalid")).toContain("Paste the key and choose its validity.");
});
