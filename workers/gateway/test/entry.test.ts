import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

const OWNER = "Alex@Example.com";
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const blob = (b: object) => ({ "MF-Access-Blob": JSON.stringify(b) });
const as = (email: string, aud = env.ACCESS_AUD) => blob({ app_aud: aud, jwt_claims: { email } });
// Host as in a real request from the edge (the loopback exports.default.fetch does not set it itself)
const post = (path: string, headers: Record<string, string> = {}) => exports.default.fetch(
  new Request(`https://mcp.example.com${path}`, { method: "POST", headers: { host: "mcp.example.com", ...headers }, body: BODY }));

let log: MockInstance<typeof console.log>;
async function expectDenied(r: Response, access: boolean) {
  expect(r.status).toBe(403);
  expect(await r.text()).toBe("Forbidden");
  expect(log.mock.calls).toEqual([[JSON.stringify({ auth: "deny", access })]]); // the only log line, without the email
}
async function expectStub(r: Response) {
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  expect(log).not.toHaveBeenCalled();
  return JSON.parse(await r.text()) as {
    path: string; search: string; method: string; body: string; email: string; host: string | null; urlOrigin: string; headers: Record<string, string>;
  };
}

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("without Access → 403", async () => {
  await expectDenied(await post("/garmin/mcp"), false);
});

it("wrong aud → 403", async () => {
  await expectDenied(await post("/garmin/mcp", as(OWNER, "wrong-aud")), true);
});

// As under the Bypass of the public pages application: there is an Access context, but of another application
it("Access context of another application under /about/… → 403", async () => {
  await expectDenied(await post("/about/garmin/mcp", as(OWNER, "public-aud")), true);
  log.mockClear();
  await expectDenied(await post("/about/x", blob({ app_aud: "public-aud" })), true);
});

it("Access without identity claims → 403", async () => {
  await expectDenied(await post("/garmin/mcp", blob({ app_aud: env.ACCESS_AUD })), true);
});

it("forged Access headers and cookie without Access → 403", async () => {
  const forged = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ email: OWNER, aud: [env.ACCESS_AUD] }))}.`;
  await expectDenied(await post("/garmin/mcp", {
    "cf-access-jwt-assertion": forged, cookie: `CF_Authorization=${forged}`, "cf-access-authenticated-user-email": OWNER,
  }), false);
});

it("unknown server without Access → the same 403 as a known one", async () => {
  await expectDenied(await post("/unknown/mcp"), false);
});

it("routes /garmin/… to MCP_GARMIN over RPC with the prefix stripped and the email lowercased", async () => {
  expect(await expectStub(await post("/garmin/mcp?x=1", as(OWNER)))).toMatchObject({
    path: "/mcp", search: "?x=1", method: "POST", body: BODY, email: "alex@example.com", host: "mcp.example.com",
  });
});

it("Access credentials are not forwarded to the server, other headers are", async () => {
  const { headers } = await expectStub(await post("/garmin/mcp", {
    ...as(OWNER), cookie: "CF_Authorization=t", "cf-access-jwt-assertion": "t", authorization: "Bearer t", accept: "text/event-stream",
    origin: "https://mcp.example.com",
  }));
  expect(["cookie", "cf-access-jwt-assertion", "authorization"].filter((h) => h in headers)).toEqual([]);
  expect(headers.accept).toBe("text/event-stream");
  expect(headers.origin).toBe("https://mcp.example.com"); // the settings page CSRF check relies on it
});

it("admission is the server's call: any Access identity reaches it", async () => {
  expect((await expectStub(await post("/garmin/mcp", as("sam@example.org")))).email).toBe("sam@example.org");
});

it("the server sees the public origin in the request URL", async () => {
  expect((await expectStub(await post("/garmin/mcp", as(OWNER)))).urlOrigin).toBe("https://mcp.example.com");
});

it("/garmin → path /", async () => {
  expect((await expectStub(await post("/garmin", as(OWNER)))).path).toBe("/");
});

it.each(["/unknown/mcp", "/", "/GARMIN/mcp", "/access-aud/mcp", "/garmin-x/mcp"])("%s → 404", async (path) => {
  const r = await post(path, as(OWNER));
  expect(r.status).toBe(404);
  expect(await r.text()).toBe("Not Found");
  expect(log).not.toHaveBeenCalled();
});

// Public pages for Google OAuth (Access Bypass on these two paths): no identity, exact path and GET/HEAD only
const req = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  exports.default.fetch(new Request(`https://mcp.example.com${path}`, { method, headers: { host: "mcp.example.com", ...headers } }));

it.each([
  ["/about", "Private access"],
  ["/privacy", "Privacy policy"],
])("GET %s without Access → public page", async (path, title) => {
  const r = await req(path);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("content-security-policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await r.text();
  expect(html).toContain(`<title>${title}</title>`);
  expect(html).not.toMatch(/<script|<form|https?:\/\//); // loads nothing, sends nothing and links nowhere outside
  // no owner's personal data and no technical details: no name, no address, no providers or products
  expect(html).not.toMatch(/@|cloudflare|claude|anthropic|garmin|server|mcp/i);
  expect(log).not.toHaveBeenCalled();
});

it("the home page links to the privacy policy", async () => {
  expect(await (await req("/about")).text()).toContain('href="/privacy"');
});

it("HEAD /privacy without Access → 200", async () => {
  expect((await req("/privacy", "HEAD")).status).toBe(200);
});

it("a public page wins over Access identity: /about is not routed to a server", async () => {
  const r = await req("/about", "GET", as(OWNER));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
});

it.each([
  ["POST", "/about"], ["GET", "/about/"], ["GET", "/privacy/x"], ["GET", "/About"], ["GET", "/about.html"],
  ["GET", "/privacy%2F"], ["GET", "/garmin/about"],
])("%s %s without Access → 403", async (method, path) => {
  await expectDenied(await req(path, method), false);
});
