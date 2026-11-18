# Personal MCP: architecture

Why Personal MCP is built the way it is: decisions, rules that span files, measured behavior of Garmin and
Cloudflare, platform limits and the security model. For people and coding agents who change the code; values
live in the code, setup steps in the [README](../README.md).

Placeholders: `<host>` is the public host of your copy, `<team>` is your Zero Trust team name.

## Overview

Remote MCP servers on Cloudflare Workers that give Claude (desktop, web, phone, Claude Code) the personal data
of you and the people you invite.

| Server | Path | Worker | Section |
|---|---|---|---|
| Garmin Connect | `/garmin/mcp` | `personal-mcp-garmin` | [Garmin server](#garmin-server) |

- **Multi-user through the Access list.** Whoever is on the Access Email list gets in. Each server keys data by
  the verified email, so users never see each other's data.
- **Do not reveal which servers exist.** One host; servers differ by path, so names never reach DNS or
  certificate logs. Without login Access answers every path but the public pages with the same `401`; behind
  it the gateway checks identity before routing, so a server and an unknown path look alike.
- **Servers know nothing about login, the gateway knows nothing about tools.** Changing tools never needs a
  gateway deploy.
- **No host in code or configs.** Servers take their public origin from the request, so a fork deploys without
  editing any config.
- **Secrets never leak** into git, logs or tool responses.
- **Fit Workers Free** ([Platform limits](#platform-limits)).

## Architecture

```
Claude ──OAuth 2.1──▶ Cloudflare Access (self-hosted application, the whole <host>)
   │                                   │ Google or One-time PIN, policy on an Email list
   └──Streamable HTTP https://<host>/<name>/mcp
                                       ▼
                  Worker personal-mcp-gateway (Custom Domain <host>)
                    │ ctx.access: application AUD → email
                    │ /<name>/… → service binding MCP_<NAME>, prefix stripped
                    ▼ RPC handle(request, email) → Response
                  Worker personal-mcp-<name> (no routes, no workers.dev)
                    │ the server decides admission
                    ▼ /mcp (MCP, stateless), /settings (HTML page)
```

One Claude connector per server: `https://<host>/<name>/mcp`, with no trailing `/` (the MCP route matches
exactly). Setup: [README](../README.md#3-connect).

## Login (Cloudflare Access Managed OAuth)

Access Managed OAuth is the whole authorization server for Claude (discovery, client registration, tokens;
issuer `https://<team>.cloudflareaccess.com`), so the Workers contain no OAuth code.

- **Main application: the whole host, no path.** Access discovery lives at the host root, so a per-path
  application cannot work. Hence one Claude token works for every server, and Access cannot set per-server
  policies: a server that needs a narrower audience keeps its own allow list.
- **Google sign-in (optional).** The Google OAuth app must be published, which needs a home page and a privacy
  policy: hence `/about` and `/privacy`. Its name is neutral so the consent screen does not reveal what is
  behind it; no logo, which would need Google verification. Access asks for `openid email profile` (all
  non-sensitive), so Google also returns the name and picture, as `/privacy` says; only the email is used.
- **Public pages application:** Bypass → Everyone on `<host>/about` and `<host>/privacy`. A destination with a
  path outranks the main application and covers its subpaths, so everything under them skips login.
- **Claude Code uses the fixed `--callback-port 48765`:** Managed OAuth accepts only registered redirect URIs.
- **Lifetimes:** grant and application session 1 month, global session "same as application", so Claude asks
  to sign in about once a month.
- **Without login** the `401` carries `resource_metadata` whose `resource` is the full server URL with its path.
- **Zone settings:** Bot Fight Mode is off and AI bot blocking does not block Claude, otherwise Claude's cloud
  client (egress `160.79.104.0/21`) is challenged. Both are zone-wide, with no per-host exemption.

## Gateway

- **Public pages first.** `GET` or `HEAD` on exactly `/about` or `/privacy` returns a page before any identity
  check; anything under them gets `403`. The pages are strings in code, not Static Assets, because a Worker
  with Static Assets gets no `ctx.access`; so `about` and `privacy` are never server names. The pages name no
  owner, provider, product or server; a test enforces this.
- **Identity only from `ctx.access`**, never from headers or cookies. Its `aud` must equal `ACCESS_AUD`, because
  requests under the Bypass application also carry a `ctx.access` ([Security](#security)). Any failure is `403`.
- **Routing:** any env key starting with `MCP_` counts as a server (`/<name>/…` → `MCP_<NAME>`, `-` → `_`), so
  only service bindings may use that prefix.
- **Forwarding:** `cookie`, `authorization` and `cf-access-jwt-assertion` are removed, so a server sees no
  cookies or Authorization header. `ctx.access` does not cross a service binding: a server gets identity only
  as the `email` argument. `new Request(url, req)` changes only the path, keeping the public origin.
- **The host is not in `wrangler.jsonc`.** `deploy --domain <host>` attaches it as a Custom Domain (replacing a
  plain DNS record); a later deploy without `routes` or `--domain` leaves it attached, so never add `routes`.
  The GitHub deploy passes `--domain` on every run, after checking that no other Worker owns the host.

## Server contract

Each server's default export is a `WorkerEntrypoint` with
`handle(request: Request, email: string): Promise<Response>`.

- `email` is verified and lowercased; the server decides admission.
- `request` arrives without `/<name>`; the server serves `/mcp` and optionally `/settings`. Its links hard-code
  its own mount path (`/garmin/…`), so the directory name, the gateway path and the links must agree.
- **The public origin is `new URL(request.url).origin`**, used for links and the settings page's Origin (CSRF)
  check; there is no `PUBLIC_HOST`. Safe because the gateway answers only on its Custom Domain (`workers_dev`
  and `preview_urls` stay explicitly `false` in every Worker; with no routes, workers.dev defaults to on), a
  server is reachable only through the service binding (its `fetch` answers `404`), and the gateway keeps the
  origin.
- Without `allowedHostnames`, `createMcpHandler` (agents 0.31.0) skips the Host check unless the host is
  localhost or `*.workers.dev`; the Origin check stays. Re-check when upgrading `agents`.
- Identity never comes from tool arguments; user data is addressed by it.

## Repository

Worker code lives under `workers/`, one directory per Worker; everything else stays outside it. Naming:
`workers/<name>/` ↔ Worker `personal-mcp-<name>`; for an MCP server also path `/<name>/mcp` ↔ binding
`MCP_<NAME>`.

- `workers/gateway/`, `workers/garmin/`: the gateway and the Garmin server; a new server gets its own.
- `.github/scripts/`: the GitHub deploy job (`deploy.mjs`) and its tests.
- `.github/workflows/deploy.yml`: tests on a push to `main`, on pull requests and on manual runs; deploys on a
  push to `main` or a manual run of the picked branch.
- `docs/`: this document, the terminal and agent install guides, README images.

Rules:

- Worker tests run in the Workers runtime through each Worker's `vitest.config.ts`, `.github/scripts/` tests in Node;
  Garmin is mocked with msw. After editing a `wrangler.jsonc`, run `npm run types`, or `typecheck` fails.
- Dependencies are pinned exactly (no `^`), so every upgrade is deliberate.
- Configs have no `account_id`: wrangler uses `wrangler login` or `CLOUDFLARE_ACCOUNT_ID` from `.env` in the
  current directory, so commands run from the repo root; an exported shell `CLOUDFLARE_ACCOUNT_ID` overrides it.
- Secrets live only as Worker secrets and in git-ignored `.dev.vars`. Each Worker lists them in
  `secrets.required`; a deploy fails unless each is in `--secrets-file` or already set. `--secrets-file` is
  additive: secrets not in the file are kept. `--dry-run` checks no secrets.
- The GitHub deploy's logs are public, so `deploy.mjs` masks values and cuts wrangler's account details.

## Platform limits

Workers Free quotas are shared by the whole account and all servers; daily quotas reset at 00:00 UTC.

- per invocation: 10 ms CPU (soft limit), 50 external subrequests and 1,000 to Cloudflare services;
- per day: 100,000 Workers requests, 100,000 Durable Object requests (every alarm and RPC), 13,000 GB-s of
  Durable Object duration, Durable Object SQLite 5 million rows read and 100,000 rows written (once exhausted,
  every write fails until 00:00 UTC);
- 5 GB of Durable Object storage per account;
- Zero Trust Free: up to 50 users.

A service binding call is not a separate request, but CPU counts per invocation: gateway `fetch`, RPC `handle`,
each Durable Object call. The code does not depend on the Workers plan and uses no cron triggers. Each server
keeps its own budget under these shared quotas (Garmin: [Sync](#sync)).

Measured once, on 2026-11-08 (CPU per invocation): gateway `fetch` 0–1 ms; RPC `handle` p50 3 ms, max 7 ms;
Garmin sync steps 1–2 ms, a 20-activity page 6 ms (wall time up to 20 s, the client's timeout); tools
0–5 ms, heaviest `get_daily_series` over a year and `search_activities` with 100 rows. `ACTIVITY_PAGE`,
`MAX_TOOL_CHARS` and the tool limits rest on these numbers: measure again (`wrangler tail --format json`,
field `cpuTime`) before raising them.

## Security

- Only the gateway is reachable from outside, and only after Access login; servers have no public address.
  Under the Bypass (`/about`, `/privacy`, their subpaths) the gateway's identity check is the only guard: the
  Worker still gets a `ctx.access` there (production denies log `access: true`), but not the main
  application's with an email, so the check rejects it. Forged `Cf-Access-Jwt-Assertion`, `CF_Authorization`
  and `Cf-Access-Authenticated-User-Email` under `/about/…` got `403` in a live test.
- A blank `ACCESS_AUD` matches nothing, so it denies everyone instead of admitting everyone.
- Isolation: both entry points (`mcp/server.ts`, `settings/route.ts`) open only the Durable Object named by the
  verified email, so no tool or page reaches another person's data, the account owner's included. The owner can
  still read any object in the dashboard's Durable Objects Data Studio (needs Workers Platform Admin; queries are
  audit-logged). Garmin keys stay encrypted there.
- Garmin has a single admission layer, the Access policy: a wrong policy would let any Google account in.
- Errors go out without internals: an HTTP status or an error name. The exceptions are input-validation
  messages and SQLite's message about the caller's own `query_sql` query. Logs are structured lines without
  secrets or response bodies.
- Risks: the gateway is a single point of failure for all servers; the zone's security settings apply to the
  MCP host ([Login](#login-cloudflare-access-managed-oauth)); Access Managed OAuth is in beta.

## Adding a server

For a server `<name>`:

1. Create `workers/<name>/` from `workers/garmin/` (`wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`):
   Worker name `personal-mcp-<name>`, no `routes`, `workers_dev: false`, `preview_urls: false`, secrets in
   `secrets.required`. `<name>` is lowercase letters and digits with single hyphens, never `about` or `privacy`.
2. Export a `WorkerEntrypoint` with `handle(request, email)` per the [Server contract](#server-contract). Tests
   go in `test/` (the root vitest config picks up every `workers/*`). Add the Worker to the root `types`,
   `typecheck` and `dev` scripts, and add `deploy:<name>`.
3. Deploy the server, then add `{ "binding": "MCP_<NAME>", "service": "personal-mcp-<name>" }` to
   `workers/gateway/wrangler.jsonc`, run `npm run types` and deploy the gateway. For the GitHub path, also
   extend `.github/scripts/deploy.mjs` and its test: it deploys only Garmin and the gateway and checks only
   `/garmin/mcp`.
4. Add a row to the server table and a section to this document; add a Claude connector for `/<name>/mcp`.
5. A settings page, if needed, follows the [Settings UI](#settings-ui).

## Garmin server

### Purpose

Claude plans training with you and the people you invite and reviews the results. The server copies everything
the official Garmin Connect Personal API offers into its own store on a schedule and answers tools from that
store, without calling Garmin for every question.

Out of scope: derived metrics (ATL/CTL/TSB, readiness, FIT parsing), other sources, records written by Claude,
writing to Garmin, the unofficial Garmin API, a view across users.

### Components

```
gateway ─RPC handle(request, email)─▶ personal-mcp-garmin: /mcp, /settings
  ─▶ Durable Object UserStore per lower(email): SQLite, kv, alarm() for all sync traffic
```

### Source: Garmin Connect Personal API

- Docs: https://developer.garmin.com/gc-developer-program/personal/personal-api
- Each person creates a key in Garmin Connect, valid up to 365 days and shown once. The key is exchanged for a
  24-hour JWT; there are no refresh tokens. When the key has less than a day left, the token is shorter.
- Rate limits are not published. Measured window limits (`end - start + 1` days): steps, stress ≤ 28;
  hydration, Body Battery ≤ 32; sleep ≥ 33; daily summaries v2,
  wellness activities ≥ 366; weight ≥ 1826.
- Empty days are not errors: Garmin answers `200` with `null` fields, `204`, `200 []` or placeholder records,
  so "no data" is decided by content.

Datasets are day (one request per date), range (a window of days, one record per day) or static (one `current`
record). History windows stay within Garmin's limits and small enough to parse within 10 ms CPU. Endpoints
and windows: `workers/garmin/src/garmin/catalog.ts`.

### Storage

One SQLite Durable Object `UserStore` per user, named `lower(email)`, holds all of the user's data. There is no
other storage, so an install needs no R2 checkout, which asks for payment details.

- `records` keeps Garmin's JSON with no field selection, one row per dataset and key. A row is rewritten only
  when its data changed, so refetching unchanged days writes no rows.
- An item whose JSON is longer than `MAX_RECORD_JSON` (`store.ts`) is stored as
  `{"omitted":"too_large","bytes":…}`. The row still exists, so the step is not refetched forever. SQLite allows
  8 MB per row; the lower cap limits the CPU of reading and parsing one row.
- Activity files (FIT) are not stored: they hold GPS tracks, device serial numbers and the daily routine, no
  tool read them, and Garmin keeps the originals.
- Typed tables (`daily`, `sleep`, `hrv`, `weight`, `activities`) are a projection of `records`, rewritten in the
  same transaction; their columns are defined once, in `TYPED` (`schema.ts`). Migration 1 is generated from the
  current `TYPED`, so before changing a typed table freeze migration 1 as literal DDL, then add a migration that
  alters the table. Otherwise existing objects lack the column (every write of that dataset fails) or new
  objects create it twice (the `ALTER` fails).
- `sync_state` stores errors as an HTTP status or error name only: messages can carry pieces of Garmin
  responses. Its column `empty_streak_days` is unused.
- Migration 2 removes what earlier versions kept for R2: it drops `files`, deletes queued file steps and deletes
  `records` rows that held an `r2_key` stub. The daily repair refetches the activity pieces among them, up to 20
  activities a day; other stubs (any other item over 256 KB) were never seen and return only if sync loads that
  day again.

The sealed key, the token and the counters live in `ctx.storage.kv`, which SQL cannot reach. Sealing is
AES-GCM-256 under the secret `KEY_ENCRYPTION_KEY` with the Durable Object id as additional data, so a ciphertext
copied into another user's object does not open. The key is never logged, rendered or returned.

### Sync

All sync traffic runs in the user's Durable Object alarm, one step per run (one data request, plus a token
exchange when needed and one retry after a `401`); the only other Garmin call is the key check on Save. The
hourly kick, `sync_now` and a wake-up only enqueue steps; nothing runs without a saved key. Cron cannot
enumerate users, so each object schedules its own alarm, at a per-user minute so users do not hit Garmin at
once.

- Each kick refetches today, yesterday and the first activity page. Once a day it also refetches the last 7
  days, because Garmin recalculates sleep and HRV with a delay, plus the static datasets and the missing pieces
  of recent incomplete activities (the retry for failed activity steps).
- "Today" uses the Garmin profile's time zone (UTC until it is synced); budgets and quotas count UTC days.
- Every tool call and settings visit is a visit: recorded at most hourly, and it re-arms a missing alarm. After
  30 days without a visit the user sleeps (no alarm), so a dead key stops costing token exchanges. The next
  visit wakes the user and queues the missed days.
- An unexpected error in `alarm()` re-arms the alarm one hour ahead and rethrows, so the runtime's own retries
  (up to 6) run first and the hourly alarm keeps sync alive after them.
- When the account's write quota is exhausted (`setAlarm` fails too), the alarm and the visit handler stop
  writing without recording an error, so tools keep answering; the first visit after 00:00 UTC restarts sync.
  This assumes the storage call throws the quota error, as the tests mock it; if it surfaced at commit, tool
  calls would fail until 00:00 UTC.

**History** starts at the first real `daily_summary_v2` year, probed from 2000 upward (earlier records are
Garmin placeholders and get deleted), and loads each dataset newest first; activities do not wait for the
start. Limits are unpublished, so an empty-body `400` or `500` on a history range halves that dataset's
window; at one day an empty `400` means no data, while an empty `500` stays an error so it never closes the
history.

**Write budget.** History stops for the UTC day once the user's object has written 60,000 rows (SQL, kv and
`setAlarm`); queued work runs first and is never limited. The budget is per user but the 100,000-row quota is
per account, so it keeps one history load under the quota, not two: hence the README's rule to connect
[people](../README.md#people) one at a time.

**Errors.** `429` pauses the whole queue for `Retry-After` (at least 15 minutes) and keeps the step. A key
rejected at token exchange pauses the queue for an hour, keeps the step and sets `_key` to `key_rejected`; the
exchange is retried after each pause, and a new key or any later successful exchange clears the mark. A `4xx`
on a day dataset means no data. Any other error drops the step and pauses that dataset's history for an hour.
The token is cached sealed and reused while more than an hour remains; a token issued for less than 24 hours
(the key has under a day left) sets `_key` to `key_expires_within_24h`.

### MCP tools

Tools only read SQLite; only `sync_now` queues work. Every call is a visit, so even reads may write a few
rows. Arguments and limits are in `workers/garmin/src/mcp/tools.ts`, whose descriptions are what Claude sees.

- `get_day`: one day's synced data, without intraday arrays.
- `get_daily_series`: chosen metrics, one row per day.
- `search_activities`: activities by date range, type and distance.
- `get_activity`: one activity with detail and its linked workout.
- `get_intraday`: one day's heart rate, Body Battery, SpO2 or HRV samples.
- `get_body`: weight, body composition, weight goal.
- `get_nutrition`: food log and hydration.
- `get_profile`: profile, heart-rate zones, fitness age.
- `get_womens_health`: menstrual cycle data for one day.
- `describe_schema`: tables, columns and hints for `query_sql`.
- `query_sql`: one read-only SQL query.
- `sync_status`: sync, key, queue and pause state.
- `sync_now`: queue a fresh sync of up to 7 dates within 28 days (default yesterday and today).

Tool answers are where a person learns that sync needs them, so responses carry warnings: about the key
(missing, any `_key` error, or expiring soon) with the settings link, and about the datasets the tool reads
(not synced yet, or stale, with the last error). A call that hits the CPU limit or a Durable Object reset
fails, and the answer asks Claude to narrow the request and retry.

`query_sql` cannot change data: a guard admits one `SELECT`, `WITH` or `VALUES` statement (literals and comments
blanked first), and the query runs in a transaction that is always rolled back, so even a guard bypass leaves
nothing behind.

### Settings page

Server-rendered, behind the same Access login as MCP, with JavaScript only for the copy button and the delete
confirmation. Actions are form POSTs, accepted only when `Origin` equals the request's own origin exactly.

- Save validates the key with one token exchange and stores nothing on failure. The person also picks the
  validity chosen in Garmin Connect: expiry warnings come from that choice, not from Garmin.
- Delete key stops sync and keeps the data. Delete all erases all of the object's storage and its alarm in one
  press. A step waiting on Garmin meanwhile finds the key gone and writes nothing.

### Encryption key and operations

`KEY_ENCRYPTION_KEY` is created once, by the Deploy workflow for a new Garmin Worker or by hand, and never
printed. It must never change: a new value makes every stored key unreadable, and everyone must paste their key
again. There is no rotation tooling; the sealed format's version field leaves room for one. An unreadable key
shows as Key rejected, and saving the key again reseals it. If the secret is missing on an existing Worker, the
workflow stops; restore it as in [install-manual.md](install-manual.md#restore-the-encryption-key).

Keys expire and renewal is manual: Garmin emails about a week ahead, tool answers warn earlier. Health:
`sync_status` and the Worker logs.

### Limitations and risks

- The Personal API is new: limits are unpublished and may change, and a field in its spec does not guarantee
  the watch fills it.
- Garmin's FAQ: the API is "not intended for commercial applications serving multiple end users". Accepted: a
  small non-commercial circle, each person with their own key.
- A user's data is about 70–130 MB, all of it in Durable Object storage; one Durable Object is budgeted for up to
  1 GB. 5 GB holds about 40–70 people, possibly fewer than the 50 Zero Trust seats.
- Health data lives in the Durable Objects of your Cloudflare account; encryption at rest is Cloudflare's.

## Settings UI

`SETTINGS_CSS` (`workers/garmin/src/settings/style.ts`) is the only copy of the settings CSS and `page.ts`
beside it is the reference page: new pages compose their classes, and anything new goes into `SETTINGS_CSS`
first (a shared module once a second server needs it). The gateway's public pages
(`workers/gateway/src/pages.ts`) copy its colors and font; change both together.

- **Familiar, not a copy.** Users live in Claude, so the pages follow Claude's own settings (measured from
  claude.ai on 2026-11-08, both themes) and its color tokens, which also give the contrast: do not invent
  colors. No Anthropic logo or font; the header reads "Personal MCP › <Server>", never claude.ai.
- **Theme follows the system** through `light-dark()`; there is no theme switch.
- **Phone first.** Buttons are taller than Claude's, since these pages open on phones more often; touch-screen
  inputs use a 16 px font so iOS does not zoom.
- **Everything inline.** The CSP `default-src 'none'` blocks anything external. `<summary>` allows only
  phrasing content, so a disclosure row's text uses `<span>` and `<br>`, not `<div>`. Icons are `<symbol>`s in
  `SPRITE` (`page.ts`), drawn in `currentColor` so they follow the theme.
- **Components.** One state line under the title: a badge of one to four words (`idle` not set up, `info`
  working, `ok` fine, `warn` action soon, `err` action now) and a short sentence with a time, count or date.
  At most one primary button per view. `.danger` only for irreversible actions, which confirm first and name
  what will be lost; reversible ones use `.danger-soft`. Numbered steps only for first-time setup; a step not
  yet available says when it will be. One control per row. A `.note` (bordered box, warning icon, 13 px) holds
  a fact the person must know before acting, such as who can read the data before the key is saved.
- **Secrets** go in `type="password"` fields and are never echoed back in the page, the URL or the redirect.
- **Accessibility.** Every input has a label; every icon button has an `aria-label` and a `title`; an error is
  linked to its control by `aria-describedby`; state is shown by icon or text, never by color alone; the
  `:focus-visible` rule must cover every interactive element; no motion.
- **Copy.** English, sentence case, plain verbs; one verb runs through a flow ("Delete" on the Delete all button
  and in its confirmation). Errors say what happened and what to do next, never apologize. No middle dots,
  arrows, all caps or exclamation marks. Times carry a "UTC" suffix: the page does not know the person's time
  zone.
