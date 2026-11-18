import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preflight, garminState, hostOwner, checkCause, redact, deploy } from "./deploy.mjs";

const AUD = "a".repeat(64), ACC = "0123456789abcdef0123456789abcdef";
const full = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: ACC, ACCESS_AUD: AUD, MCP_HOST: "mcp.example.com" };

describe("preflight", () => {
  it("skips a push with no secrets", () => expect(preflight({}, "push")).toEqual({ action: "skip", message: expect.any(String) }));
  it("fails a manual run with no secrets, naming all four", () => {
    const r = preflight({}, "workflow_dispatch");
    expect(r.action).toBe("fail");
    for (const n of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "ACCESS_AUD", "MCP_HOST"]) expect(r.message).toContain(n);
  });
  it("fails a push with some secrets, naming only the missing", () => {
    const r = preflight({ ...full, ACCESS_AUD: " " }, "push");
    expect(r.action).toBe("fail");
    expect(r.message).toContain("ACCESS_AUD");
    expect(r.message).not.toContain("MCP_HOST");
  });
  it("trims values", () => expect(preflight({ ...full, CLOUDFLARE_API_TOKEN: " tok\n", ACCESS_AUD: AUD + "\n" }, "push").config)
    .toEqual({ token: "tok", accountId: ACC, aud: AUD, host: "mcp.example.com" }));
  it.each(["https://mcp.example.com/", "https://MCP.example.com/garmin/mcp", "mcp.example.com/"])(
    "normalizes host %s", (h) => expect(preflight({ ...full, MCP_HOST: h }, "push").config.host).toBe("mcp.example.com"));
  it.each(["example", "mcp example.com", "", "https://"])("rejects host %j", (h) =>
    expect(preflight({ ...full, MCP_HOST: h }, "push").action).toBe("fail"));
  it("rejects an AUD that is not 64 hex characters", () => {
    const r = preflight({ ...full, ACCESS_AUD: "3f2a9c1e-0000-4000-8000-000000000000" }, "push");
    expect(r.action).toBe("fail");
    expect(r.message).toContain("ACCESS_AUD");
    expect(r.message).not.toContain("3f2a9c1e");
  });
  it("rejects an account ID that is not 32 hex characters", () =>
    expect(preflight({ ...full, CLOUDFLARE_ACCOUNT_ID: "me@example.com" }, "push").message).toContain("CLOUDFLARE_ACCOUNT_ID"));
});

describe("garminState", () => {
  const listed = '[\n  {\n    "name": "KEY_ENCRYPTION_KEY",\n    "type": "secret_text"\n  }\n]';
  it("installed when the key is listed", () => expect(garminState(0, listed).state).toBe("installed"));
  it("stop when the Worker exists without the key", () => expect(garminState(0, "[]").state).toBe("stop"));
  it("new on the not-found error", () =>
    expect(garminState(1, '✘ [ERROR] Worker "personal-mcp-garmin" not found.\n').state).toBe("new"));
  it("new on the coloured not-found error", () =>
    expect(garminState(1, '\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mWorker "personal-mcp-garmin" not found.\x1b[0m').state).toBe("new"));
  it("stop when another Worker is not found", () =>
    expect(garminState(1, 'Worker "personal-mcp-gateway" not found.').state).toBe("stop"));
  it.each([[1, "Authentication error [code: 10000]"], [1, ""], [0, ""], [1, "fetch failed"]])(
    "stop on %i %j", (s, o) => expect(garminState(s, o).state).toBe("stop"));
});

describe("hostOwner", () => {
  it("free", () => expect(hostOwner([], "mcp.example.com")).toBe("free"));
  it("gateway", () => expect(hostOwner([{ hostname: "MCP.example.com", service: "personal-mcp-gateway" }], "mcp.example.com")).toBe("gateway"));
  it("other", () => expect(hostOwner([{ hostname: "mcp.example.com", service: "blog" }], "mcp.example.com")).toBe("other"));
  it("ignores other hostnames", () => expect(hostOwner([{ hostname: "www.example.com", service: "blog" }], "mcp.example.com")).toBe("free"));
});

describe("checkCause", () => {
  it("healthy", () => expect(checkCause(401, 200)).toBeNull());
  it("Managed OAuth off", () => expect(checkCause(302, 200)).toMatch(/Managed OAuth/));
  it("no Access app or Bot Fight Mode", () => expect(checkCause(403, 200)).toMatch(/Bot Fight Mode/));
  it("Access app has a path", () => expect(checkCause(401, 403)).toMatch(/whole host/));
  it("zeros come first", () => {
    expect(checkCause(302, 0)).toMatch(/not ready/);
    expect(checkCause(0, 403)).toMatch(/not ready/);
    expect(checkCause(403, 0)).toMatch(/not ready/);
  });
  it("302 beats a 403 on the second probe", () => expect(checkCause(302, 403)).toMatch(/Managed OAuth/));
  it("403 on the first probe beats a 403 on the second", () => expect(checkCause(403, 403)).toMatch(/Bot Fight Mode/));
  it("not ready", () => { expect(checkCause(0, 0)).toMatch(/not ready/); expect(checkCause(401, 0)).toMatch(/not ready/); });
});

describe("redact", () => {
  it("keeps the stderr error and cuts the whoami block of stdout", () => {
    const stdout = "Getting User settings...\n👋 You are logged in with an User API Token, associated with the email me@example.com.\n│ Account Name │ Account ID │\n";
    const stderr = "✘ [ERROR] Authentication error [code: 10000]\n";
    const r = redact(stdout) + redact(stderr);
    expect(r).toContain("Authentication error");
    expect(r).not.toContain("me@example.com");
    expect(r).not.toContain("Account Name");
  });
  it("leaves ordinary output alone", () => expect(redact("Uploaded personal-mcp-garmin\n")).toBe("Uploaded personal-mcp-garmin\n"));
});

const INSTALLED = { status: 0, output: '[{"name": "KEY_ENCRYPTION_KEY", "type": "secret_text"}]' };
const NEW = { status: 1, output: 'Worker "personal-mcp-garmin" not found.' };
const TOKEN = "tok-secret-123";

function setup({ list = INSTALLED, env = {}, event = "workflow_dispatch", domains = { success: true, result: [] }, domainsOk = true, health, runStatus = () => 0 } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  const calls = [], files = [], masks = [], logs = [], keys = [];
  let t = 0, healthN = 0;
  const deps = {
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACC, ACCESS_AUD: AUD, MCP_HOST: "https://mcp.example.com/", ...env },
    event,
    run(cmd, args, cfEnv) {
      const i = args.indexOf("--secrets-file");
      calls.push({ cmd, args, cfEnv, masksBefore: masks.length });
      files.push(i >= 0 ? fs.readFileSync(args[i + 1], "utf8") : null);
      if (args.includes("list")) return list;
      return { status: runStatus(args), output: "" };
    },
    async fetch(url, opts) {
      if (url.includes("/workers/domains")) {
        return { ok: domainsOk, status: domainsOk ? 200 : 500, json: async () => domains };
      }
      const status = health ? health(url, healthN++) : url.includes("well-known") ? 200 : 401;
      return { status };
    },
    log: (l) => logs.push(l),
    mask: (v) => masks.push(v),
    randomKey: () => (keys.push("KEYKEYKEY"), "KEYKEYKEY"),
    tmpDir,
    sleep: async (ms) => { t += ms; },
    now: () => t,
  };
  return { deps, calls, files, masks, logs, keys, tmpDir, deploy: () => deploy(deps) };
}
const gw = (c) => c.calls.find((x) => x.args.includes("deploy:gateway"));

describe("deploy", () => {
  it("installed: garmin deploys plainly and randomKey is never called", async () => {
    const c = setup();
    expect(await c.deploy()).toBe(0);
    expect(c.calls[1].args).toEqual(["run", "deploy:garmin"]);
    expect(c.keys).toEqual([]);
  });
  it("new: generates the key once, masks it first, passes it by file, removes the file", async () => {
    const c = setup({ list: NEW });
    expect(await c.deploy()).toBe(0);
    expect(c.keys.length).toBe(1);
    const g = c.calls[1];
    expect(g.args.slice(0, 3)).toEqual(["run", "deploy:garmin", "--"]);
    expect(c.files[1]).toBe("KEY_ENCRYPTION_KEY=KEYKEYKEY\n");
    expect(c.masks).toContain("KEYKEYKEY");
    expect(g.masksBefore).toBe(5);
    expect(fs.existsSync(g.args[g.args.indexOf("--secrets-file") + 1])).toBe(false);
  });
  it("stop: no key, one run call", async () => {
    const c = setup({ list: { status: 1, output: "Authentication error [code: 10000]" } });
    expect(await c.deploy()).toBe(1);
    expect(c.calls.length).toBe(1);
    expect(c.keys).toEqual([]);
  });
  it("garmin deploy failure stops before the gateway", async () => {
    const c = setup({ runStatus: (a) => (a.includes("deploy:garmin") ? 1 : 0) });
    expect(await c.deploy()).toBe(1);
    expect(gw(c)).toBeUndefined();
  });
  it("garmin deploy failure with a new key still removes the file", async () => {
    const c = setup({ list: NEW, runStatus: () => 1 });
    expect(await c.deploy()).toBe(1);
    expect(fs.readdirSync(c.tmpDir)).toEqual([]);
  });
  it("host owned by another Worker stops", async () => {
    const c = setup({ domains: { success: true, result: [{ hostname: "mcp.example.com", service: "other" }] } });
    expect(await c.deploy()).toBe(1);
    expect(gw(c)).toBeUndefined();
    expect(c.logs.join("\n")).toContain("already a custom domain of another Worker");
  });
  it("domains API not success stops", async () => {
    for (const o of [{ domains: { success: false, result: [] } }, { domainsOk: false }]) {
      const c = setup(o);
      expect(await c.deploy()).toBe(1);
      expect(gw(c)).toBeUndefined();
    }
  });
  it("gateway call shape, file content, file removed", async () => {
    const c = setup();
    await c.deploy();
    const i = c.calls.indexOf(gw(c));
    const g = c.calls[i];
    expect(g.args).toEqual(["run", "deploy:gateway", "--", "--secrets-file", g.args[4], "--domain", "mcp.example.com"]);
    expect(c.files[i]).toBe(`ACCESS_AUD=${AUD}\n`);
    expect(fs.existsSync(g.args[4])).toBe(false);
  });
  it("masks token, account, AUD and host before the first run", async () => {
    const c = setup();
    await c.deploy();
    expect(c.calls[0].masksBefore).toBe(4);
    expect(c.masks.slice(0, 4)).toEqual([TOKEN, ACC, AUD, "mcp.example.com"]);
  });
  it("every run gets cfEnv and no arg holds the token", async () => {
    const c = setup({ env: { CLOUDFLARE_API_TOKEN: ` ${TOKEN}\n` } });
    await c.deploy();
    for (const x of c.calls) {
      expect(x.cfEnv).toEqual({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACC });
      expect(x.args.join(" ")).not.toContain(TOKEN);
    }
  });
  it("the log never contains a secret", async () => {
    const c = setup({ list: NEW });
    await c.deploy();
    const log = c.logs.join("\n");
    for (const v of [TOKEN, ACC, AUD, "mcp.example.com", "KEYKEYKEY"]) expect(log).not.toContain(v);
  });
  it("check retries until healthy", async () => {
    const c = setup({ health: (url, n) => (n < 2 ? 0 : url.includes("well-known") ? 200 : 401) });
    expect(await c.deploy()).toBe(0);
  });
  it("probes the mcp path and the host-root OAuth metadata", async () => {
    const c = setup();
    const urls = [];
    const f = c.deps.fetch;
    c.deps.fetch = (u, o) => (urls.push(u), f(u, o));
    await c.deploy();
    expect(urls).toContain("https://mcp.example.com/garmin/mcp");
    expect(urls).toContain("https://mcp.example.com/.well-known/oauth-authorization-server");
  });
  it("check gives up after 15 minutes", async () => {
    const c = setup({ health: () => 302 });
    expect(await c.deploy()).toBe(1);
    expect(c.deps.now()).toBeGreaterThanOrEqual(15 * 60_000);
    expect(c.logs.join("\n")).toContain("Managed OAuth");
  });
  it("no secrets on push is a no-op; on dispatch a failure", async () => {
    const a = setup({ env: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ACCESS_AUD: "", MCP_HOST: "" }, event: "push" });
    expect(await a.deploy()).toBe(0);
    expect(a.calls).toEqual([]);
    const b = setup({ env: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ACCESS_AUD: "", MCP_HOST: "" } });
    expect(await b.deploy()).toBe(1);
    expect(b.calls).toEqual([]);
  });
});
