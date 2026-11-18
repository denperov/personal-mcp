import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "agents/mcp/server";
import { afterEach, expect, it, vi } from "vitest";
import { addDays } from "../src/garmin/dates";
import { MAX_TOOL_CHARS } from "../src/mcp/format";
import { createServer } from "../src/mcp/server";
import { upsertRecords } from "../src/user/store";

const T = "2026-10-28T00:00:00.000Z";
const NAMES = ["get_day", "get_daily_series", "search_activities", "get_activity", "get_intraday", "get_body", "get_nutrition",
  "get_profile", "get_womens_health", "describe_schema", "query_sql", "sync_status", "sync_now"];
const newEmail = () => `t-${crypto.randomUUID()}@x`;
const inDo = <R>(email: string, f: (sql: SqlStorage) => R) =>
  runInDurableObject(env.USER_DO.getByName(email), (_i, st) => f(st.storage.sql));
const count = (email: string, table: string) => inDo(email, (sql) => sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);

async function connect(email: string): Promise<Client> {
  const h = createMcpHandler(() => createServer(email, "https://mcp.example.com"), { route: "/mcp" });
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "legacy" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
    fetch: (url, init) => {
      const r = new Request(url, init);
      return h.fetch(r);
    },
  }));
  return client;
}

async function call(email: string, name: string, args: Record<string, unknown> = {}) {
  const r = await (await connect(email)).callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  expect(content.length).toBe(1);
  expect(content[0].type).toBe("text");
  expect(r.structuredContent).toBeUndefined();
  return { isError: r.isError === true, text: content[0].text };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// title is the display name for clients (name stays the identifier)
it("introduces itself as Garmin", async () => {
  expect((await connect(newEmail())).getServerVersion()).toMatchObject({ name: "garmin", title: "Garmin" });
});

it("lists exactly the 13 tools with their annotations", async () => {
  const client = await connect(newEmail());
  expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false }); // the list is static (R22)
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  for (const t of tools) {
    expect(t.icons, t.name).toBeUndefined();
    expect(t.description?.length, t.name).toBeGreaterThan(20);
    expect(t.annotations, t.name).toEqual(t.name === "sync_now"
      ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      : { readOnlyHint: true, openWorldHint: false });
  }
});

it("validates ranges", async () => {
  const email = newEmail();
  const inverted = await call(email, "get_daily_series", { from: "2026-10-27", to: "2026-10-01", metrics: ["steps"] });
  expect(inverted.isError).toBe(true);
  expect(inverted.text).toContain("from");
  expect((await call(email, "get_daily_series", { from: "2025-01-01", to: "2026-02-05", metrics: ["steps"] })).isError).toBe(true);
  expect((await call(email, "get_daily_series", { from: "2026-10-01", to: "2026-10-02", metrics: ["nope"] })).isError).toBe(true);
  expect((await call(email, "get_nutrition", { from: "2026-09-01", to: "2026-10-27" })).isError).toBe(true);
  expect((await call(email, "get_day", { date: "2026-02-30" })).isError).toBe(true);
  const ok = await call(email, "get_daily_series", { from: "2026-10-01", to: "2026-10-27", metrics: ["steps", "sleep_score"] });
  expect(ok.isError).toBe(false);
  expect(JSON.parse(ok.text)).toMatchObject({ data: [], warnings: expect.arrayContaining(["daily_summary: not synced yet"]) });
});

it("coerces numeric strings", async () => {
  const r = await call(newEmail(), "search_activities", { limit: "5" });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).data).toEqual([]);
});

it("search_activities returns at most 100 rows per call (R28)", async () => {
  const email = newEmail();
  const over = await call(email, "search_activities", { limit: 101 });
  expect(over.isError).toBe(true);
  expect(over.text).toContain("limit");
  expect((await call(email, "search_activities", { limit: 100 })).isError).toBe(false);
});

it("query_sql is read-only", async () => {
  const email = newEmail();
  await inDo(email, (sql) => upsertRecords(sql, "steps", [{ key: "2026-10-27", day: "2026-10-27", data: { totalSteps: 1 } }], T));
  const del = await call(email, "query_sql", { sql: "DELETE FROM records" });
  expect(del.isError).toBe(true);
  expect(await count(email, "records")).toBe(1);
  const kv = await call(email, "query_sql", { sql: "SELECT * FROM _cf_KV" });
  expect(kv.isError).toBe(true);
  expect(kv.text).toMatch(/^query error: /);
  const ok = await call(email, "query_sql", { sql: "SELECT key FROM records", limit: "10" });
  expect(JSON.parse(ok.text).data).toMatchObject({ columns: ["key"], rows: [["2026-10-27"]], truncated: false });
});

it("query_sql output stays valid JSON when rows are cut by size (R21)", async () => {
  const email = newEmail();
  // each result row is exactly 768 chars of JSON: without headroom for the wrapper, rows alone get within 30 chars of
  // MAX_TOOL_CHARS
  await inDo(email, (sql) => upsertRecords(sql, "steps", Array.from({ length: 200 }, (_, i) => {
    const d = addDays("2026-01-01", i);
    return { key: d, day: d, data: { pad: "x".repeat(689) } };
  }), T));
  const r = await call(email, "query_sql", { sql: "SELECT dataset, key, day, data, fetched_at FROM records" });
  expect(r.isError).toBe(false);
  expect(r.text.length).toBeLessThanOrEqual(MAX_TOOL_CHARS);
  const data = JSON.parse(r.text).data;
  expect(data.truncated).toBe(true);
  expect(data.rows.length).toBeGreaterThan(100);
});

it("get_day hides intraday arrays and sees only its own user", async () => {
  const a = newEmail(), b = newEmail();
  await inDo(a, (sql) => upsertRecords(sql, "heart_rate",
    [{ key: "2026-10-27", day: "2026-10-27", data: { restingHeartRate: 58, heartRateValues: [[1, 60]] } }], T));
  await inDo(b, (sql) => upsertRecords(sql, "daily_summary",
    [{ key: "2026-10-27", day: "2026-10-27", data: { totalSteps: 4242 } }], T));
  const r = await call(a.toUpperCase(), "get_day", { date: "2026-10-27" }); // DO name is lower(email)
  expect(r.isError).toBe(false);
  expect(r.text).not.toContain("heartRateValues");
  expect(r.text).not.toContain("4242");
  expect(JSON.parse(r.text).data).toEqual({ day: "2026-10-27", heart_rate: { restingHeartRate: 58 } });
});

it("sync_now queues valid dates", async () => {
  const email = newEmail();
  const r = await call(email, "sync_now", { dates: ["2026-10-27"] });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).data).toMatchObject({ queued: expect.any(Number), eta_seconds: expect.any(Number),
    hint: "call sync_status after eta_seconds" });
  expect(JSON.parse(r.text).data.queued).toBeGreaterThan(0);
  const dflt = await call(newEmail(), "sync_now");
  expect(JSON.parse(dflt.text).data.queued).toBeGreaterThan(JSON.parse(r.text).data.queued); // today and yesterday
});

it("sync_now rejects bad dates and queues nothing (R18)", async () => {
  const email = newEmail();
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const eight = Array.from({ length: 8 }, (_, i) => `2026-10-0${i + 1}`);
  for (const dates of [eight, [tomorrow], ["2026-09-01", "2026-10-01"], ["2026-02-30"], []]) {
    expect((await call(email, "sync_now", { dates })).isError, JSON.stringify(dates)).toBe(true);
  }
  expect(await count(email, "queue")).toBe(0);
});

it("callTool validates its own arguments over RPC", async () => {
  const stub = env.USER_DO.getByName(newEmail());
  expect(await stub.callTool("get_day", { date: "2026-02-30" }, "https://mcp.example.com")).toEqual({ isError: true, text: "date: not a calendar date" });
  expect(await stub.callTool("nope", {}, "https://mcp.example.com")).toEqual({ isError: true, text: "unknown tool" });
  expect((await stub.callTool("get_daily_series", { from: "2026-10-01", to: "2026-10-02", metrics: ["x) AS y"] }, "https://mcp.example.com")).isError)
    .toBe(true);
  expect((await stub.callTool("sync_now", { dates: ["2026-10-01", "2026-10-29"] }, "https://mcp.example.com")).isError).toBe(true); // 28 days
  expect((await stub.callTool("sync_now", { dates: ["2026-10-01", "2026-10-28"] }, "https://mcp.example.com")).isError).toBe(false); // 27 days
});

it("logs only the tool name", async () => {
  const log = vi.spyOn(console, "log");
  await call(newEmail(), "sync_status");
  expect(log.mock.calls).toEqual([[JSON.stringify({ tool: "sync_status" })]]);
});

it("an RPC failure never leaks its text", async () => {
  vi.spyOn(env.USER_DO, "getByName").mockReturnValue({
    callTool: () => Promise.reject(new Error("Durable Object exceeded its CPU time limit: secret@x")),
  } as unknown as ReturnType<typeof env.USER_DO.getByName>);
  expect(await call(newEmail(), "get_profile")).toEqual({ isError: true,
    text: "temporary error or query too heavy for the Free CPU limit; narrow the range and retry" });
});

const SETTINGS = "https://mcp.example.com/garmin/settings";
const NOT_CONNECTED = `Garmin is not connected or the key was deleted; add a key at ${SETTINGS}`;
const putKey = (email: string, expiresOn: string) => runInDurableObject(env.USER_DO.getByName(email), (_i, st) => {
  st.storage.kv.put("garminKey", { stub: true }); // hasKey checks only that it exists
  st.storage.kv.put("keyExpiresOn", expiresOn);
});

it("no key: every tool returns data plus the not-connected warning", async () => {
  const email = newEmail();
  const args: Record<string, Record<string, unknown>> = {
    get_day: { date: "2026-10-27" }, get_daily_series: { from: "2026-10-01", to: "2026-10-02", metrics: ["steps"] },
    search_activities: {}, get_activity: { activity_id: "1" }, get_intraday: { date: "2026-10-27", kind: "heart_rate" },
    get_body: { from: "2026-10-01", to: "2026-10-02" }, get_nutrition: { from: "2026-10-01", to: "2026-10-02" },
    get_profile: {}, get_womens_health: { date: "2026-10-01" }, describe_schema: {},
    query_sql: { sql: "SELECT 1" }, sync_status: {}, sync_now: {},
  };
  expect(Object.keys(args).sort()).toEqual([...NAMES].sort());
  for (const name of NAMES) {
    const r = await call(email, name, args[name]);
    expect(r.isError, `${name}: ${r.text}`).toBe(false);
    expect(JSON.parse(r.text).warnings[0], name).toBe(NOT_CONNECTED);
  }
});

it("expiry warning uses the per-user date", async () => {
  const email = newEmail();
  await putKey(email, addDays(new Date().toISOString().slice(0, 10), 10));
  const w = JSON.parse((await call(email, "get_profile")).text).warnings as string[];
  expect(w[0]).toMatch(new RegExp(`^Garmin API key expires on \\d{4}-\\d\\d-\\d\\d; replace it at ${SETTINGS}$`));
  expect(w).not.toContain(NOT_CONNECTED);
});

it("sync_status reports not_connected", async () => {
  const email = newEmail();
  expect(JSON.parse((await call(email, "sync_status")).text).data.key).toEqual({ status: "not_connected" });
  await putKey(email, "2099-01-01");
  expect(JSON.parse((await call(email, "sync_status")).text).data.key).toEqual({ status: "ok", expires_on: "2099-01-01" });
});
