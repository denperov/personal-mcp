import { exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

const MCP = "https://mcp.example.com/mcp";
const OWNER = "alex@example.com";

// This is how personal-mcp-gateway calls it: RPC handle(request, email) with an already verified email. Rejections are
// decided before the body is read, hence no body: on a direct RPC from a test, workerd cancels an unread body as a "hung"
// request (log noise)
const post = (email: string, url = MCP) => exports.default.handle(new Request(url, { method: "POST" }), email);

let log: MockInstance<typeof console.log>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callTool(email: string, name: string, args: Record<string, unknown> = {}, url = MCP) {
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "legacy" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    fetch: (url, init) => {
      const r = new Request(url, { ...init, signal: null }); // AbortSignal does not pass over RPC
      return exports.default.handle(r, email);
    },
  }));
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0].text;
  return { isError: r.isError, data: JSON.parse(text).data, warnings: JSON.parse(text).warnings };
}

it("any email reaches its own tools", async () => {
  expect((await callTool("a@x", "sync_status")).isError).not.toBe(true);
  expect((await callTool("b@x", "sync_status")).isError).not.toBe(true);
});

it("a sync queued by one email is not visible to another", async () => {
  const date = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  expect((await callTool("a@x", "sync_now", { dates: [date] })).isError).not.toBe(true);
  expect((await callTool("b@x", "sync_status")).data.queue_size).toBe(0);
});

it("tool warnings link to the settings page on the host the gateway forwarded", async () => {
  const r = await callTool("fresh@x", "sync_status", {}, "https://other.example/mcp");
  expect(r.warnings[0]).toBe("Garmin is not connected or the key was deleted; add a key at https://other.example/garmin/settings");
});

it("owner gets 404 outside /mcp", async () => {
  const r = await post(OWNER, "https://mcp.example.com/.well-known/oauth-protected-resource");
  expect(r.status).toBe(404);
  expect(log).not.toHaveBeenCalled();
});

it("no public entry: fetch → 404", async () => {
  const r = await exports.default.fetch(new Request(MCP, { method: "POST" }));
  expect(r.status).toBe(404);
  expect(await r.text()).toBe("Not Found");
});
