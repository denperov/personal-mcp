import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const GARMIN = "personal-mcp-garmin";
export const GATEWAY = "personal-mcp-gateway";
export const REQUIRED = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "ACCESS_AUD", "MCP_HOST"];

// Checks the secrets before any Cloudflare call. Messages never contain secret values.
export function preflight(env, event) {
  const v = Object.fromEntries(REQUIRED.map((n) => [n, (env[n] ?? "").trim()]));
  const missing = REQUIRED.filter((n) => !v[n]);
  if (missing.length === REQUIRED.length && event === "push") {
    return { action: "skip", message: "Deploy skipped: this repository has no deploy secrets." };
  }
  if (missing.length) {
    return {
      action: "fail",
      message: `Missing secrets: ${missing.join(", ")}. Add them in Settings → Secrets and variables → Actions.`,
    };
  }
  if (!/^[0-9a-f]{32}$/i.test(v.CLOUDFLARE_ACCOUNT_ID)) {
    return { action: "fail", message: "CLOUDFLARE_ACCOUNT_ID must be 32 hexadecimal characters." };
  }
  if (!/^[0-9a-f]{64}$/i.test(v.ACCESS_AUD)) {
    return { action: "fail", message: "ACCESS_AUD must be 64 hexadecimal characters." };
  }
  // Host: lowercase, no scheme, everything up to the first "/"
  const host = v.MCP_HOST.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { action: "fail", message: "MCP_HOST must be a host name with a dot, such as mcp.example.com." };
  }
  return {
    action: "go",
    config: { token: v.CLOUDFLARE_API_TOKEN, accountId: v.CLOUDFLARE_ACCOUNT_ID, aud: v.ACCESS_AUD, host },
  };
}

// Decides from the `wrangler secret list` output what to do with the garmin Worker.
export function garminState(status, output) {
  const out = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (status === 0 && /"name":\s*"KEY_ENCRYPTION_KEY"/.test(out)) return { state: "installed" };
  if (status !== 0 && out.includes(`Worker "${GARMIN}" not found.`)) return { state: "new" };
  const reason =
    status === 0
      ? "The Garmin Worker exists but has no KEY_ENCRYPTION_KEY secret."
      : "Could not tell whether the Garmin Worker is installed.";
  return { state: "stop", reason };
}

export function hostOwner(domains, host) {
  const d = domains.find((x) => x.hostname.toLowerCase() === host.toLowerCase());
  if (!d) return "free";
  return d.service === GATEWAY ? "gateway" : "other";
}

// null = all good. Zeros first (host not ready), then 302/403.
export function checkCause(mcp, wellKnown) {
  if (mcp === 0 || wellKnown === 0) return "Your host or its certificate is not ready yet.";
  if (mcp === 302) return "Managed OAuth is off in your Access application.";
  if (mcp === 403) return "No Access application covers your host, or Bot Fight Mode challenged the request.";
  if (wellKnown === 403) return "Your Access application has a path. Change it to cover the whole host.";
  if (mcp === 401 && wellKnown === 200) return null;
  return `Unexpected answers from your host: ${mcp} and ${wellKnown}.`;
}

// wrangler prints whoami (email, accounts) on an authentication error — cut it off.
export function redact(output) {
  const i = output.indexOf("Getting User settings...");
  if (i < 0) return output;
  return output.slice(0, output.lastIndexOf("\n", i) + 1) + "[account details removed]\n";
}

// Orchestrator. Returns the exit code. Stops at the first error with one log line, without secret values.
export async function deploy(d) {
  const pf = preflight(d.env, d.event);
  if (pf.action !== "go") {
    d.log(pf.message);
    return pf.action === "skip" ? 0 : 1;
  }
  const { token, accountId, aud, host } = pf.config;
  // Mask before the first command so the values never reach the public log
  for (const v of [token, accountId, aud, host]) d.mask(v);
  const cfEnv = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
  const stop = (msg) => (d.log(msg), 1);

  // The secrets file exists only for the duration of the call
  const withSecretsFile = (name, content, args, tail = []) => {
    const file = path.join(d.tmpDir, name);
    fs.writeFileSync(file, content, { mode: 0o600 });
    try {
      return d.run("npm", [...args, "--secrets-file", file, ...tail], cfEnv);
    } finally {
      fs.rmSync(file, { force: true });
    }
  };

  const list = d.run("npx", ["wrangler", "secret", "list", "-c", "workers/garmin/wrangler.jsonc"], cfEnv);
  const g = garminState(list.status, list.output);
  if (g.state === "stop") return stop(g.reason);

  let r;
  if (g.state === "installed") {
    r = d.run("npm", ["run", "deploy:garmin"], cfEnv);
  } else {
    // The key is created only for a new Worker: otherwise every stored Garmin key would become unreadable
    const key = d.randomKey();
    d.mask(key);
    r = withSecretsFile("garmin.env", `KEY_ENCRYPTION_KEY=${key}\n`, ["run", "deploy:garmin", "--"]);
  }
  if (r.status !== 0) return stop("Deploying the Garmin Worker failed.");

  let domains;
  try {
    const res = await d.fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = res.ok ? await res.json() : null;
    if (!body || body.success !== true) throw new Error();
    domains = body.result;
  } catch {
    return stop("Could not check your host through the Cloudflare API.");
  }
  if (hostOwner(domains, host) === "other") {
    return stop("Your host is already a custom domain of another Worker. Choose an unused host.");
  }

  r = withSecretsFile("gateway.env", `ACCESS_AUD=${aud}\n`, ["run", "deploy:gateway", "--"], ["--domain", host]);
  if (r.status !== 0) return stop("Deploying the Gateway Worker failed.");
  return check(d, host);
}

async function check(d, host) {
  const status = async (p) => {
    try {
      return (await d.fetch(`https://${host}${p}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) })).status;
    } catch {
      return 0;
    }
  };
  const start = d.now();
  for (;;) {
    const cause = checkCause(await status("/garmin/mcp"), await status("/.well-known/oauth-authorization-server"));
    if (cause === null) {
      d.log("Deployed. Open /garmin/settings on your host and sign in.");
      return 0;
    }
    if (d.now() - start >= 15 * 60_000) {
      d.log(`Deployed, but the host does not answer correctly yet: ${cause}`);
      return 1;
    }
    await d.sleep(30_000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await deploy({
    env: process.env,
    event: process.env.GITHUB_EVENT_NAME,
    run(cmd, args, cfEnv) {
      const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...cfEnv } });
      const stdout = r.stdout ?? "", stderr = r.stderr ?? "";
      // Redact each stream separately: whoami is in stdout, while an API error in stderr must stay in the log
      process.stdout.write(redact(stdout) + redact(stderr));
      const output = stdout + stderr;
      return { status: r.status ?? 1, output };
    },
    fetch,
    log: console.log,
    mask: (v) => console.log("::add-mask::" + v),
    randomKey: () => crypto.randomBytes(32).toString("base64"),
    tmpDir: process.env.RUNNER_TEMP ?? os.tmpdir(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
}
