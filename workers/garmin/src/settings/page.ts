import { VALIDITY_DAYS, type SettingsState } from "../user/user-store";
import { SETTINGS_CSS } from "./style";

export type PageError = "invalid" | "rejected" | "unavailable" | "deleting";
/** validity is the key lifetime chosen in a failed save (already checked against VALIDITY_DAYS) */
type View = { email: string; origin: string; error?: PageError; validity?: number };
export const ERRORS: Record<PageError, string> = {
  invalid: "Paste the key and choose its validity.",
  rejected: "Garmin rejected this key. Check that you copied all of it, or create a new one.",
  unavailable: "Garmin is not responding. Try again in a few minutes.",
  deleting: "Some files are still being deleted. Press Delete all again.",
};

const ACTION = "/garmin/settings"; // page address in the browser: gateway strips /garmin
const GARMIN_KEY_PAGE = "https://connect.garmin.com/app/settings/personalApiToken";
const RENEW = "Create a new key in Garmin Connect and replace it below.";
// Shown before the key is saved: the server isolates people, but the data sits in the owner's Cloudflare account
const TRUST = "Personal MCP gives no one a way to see another person's data. The owner of this server can still read it "
  + "directly in their Cloudflare account. Save your key here only if you trust the owner.";
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const esc = (v: string | number) => String(v).replace(/[&<>"']/g, (c) => ENTITIES[c]);

// Times ignore the user's time zone: always UTC, labeled as such
const date = (v: string | number, year = true) =>
  new Date(v).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", ...(year ? { year: "numeric" } : {}) });
const time = (v: string | number) =>
  new Date(v).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }) + " UTC";

const icon = (id: string, size: number) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

// Icons per the rules in docs/architecture.md, section "Settings UI" — every one used on the page
const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-chevron" viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="i-check" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-external" viewBox="0 0 16 16"><path d="M6 3.5h6.5V10M12.5 3.5L4 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-warning" viewBox="0 0 16 16"><path d="M8 2.5l6 10.5H2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.3v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-x-circle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-sync" viewBox="0 0 16 16"><path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M11.5 2v2.5H9M4.5 14v-2.5H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>`;

const GARMIN_LINK = `<a class="btn" href="${GARMIN_KEY_PAGE}" target="_blank" rel="noopener noreferrer">Open Garmin Connect ${icon("external", 14)}</a>`;

// After copying, the icon is a check mark for 2 s, aria-label "Copied"
const COPY_SCRIPT = `<script>
const b = document.getElementById("copy"), u = b.querySelector("use");
const show = (done) => {
  b.classList.toggle("done", done);
  b.setAttribute("aria-label", done ? "Copied" : "Copy address");
  b.title = done ? "Copied" : "Copy";
  u.setAttribute("href", done ? "#i-check" : "#i-copy");
};
b.onclick = () => navigator.clipboard.writeText(b.previousElementSibling.textContent).then(() => {
  show(true);
  setTimeout(show, 2000, false);
});
</script>`;

/** One badge: none > rejected > expiring (≤ 0 days — expired) > paused > loading history > connected */
function badge(s: SettingsState): { cls: string; icon?: string; text: string; detail?: string } {
  if (s.key === "none") return { cls: "idle", text: "Not connected" };
  if (s.key === "rejected") return { cls: "err", icon: "x-circle", text: "Key rejected", detail: `Sync stopped. ${RENEW}` };
  if (s.key === "expiring") {
    const n = s.daysLeft ?? 0;
    return n <= 0 ? { cls: "err", icon: "x-circle", text: "Key expired", detail: RENEW }
      : { cls: "warn", icon: "warning", text: `Key expires in ${n} ${n === 1 ? "day" : "days"}`, detail: RENEW };
  }
  if (s.pausedUntil) return { cls: "info", icon: "sync", text: "Paused", detail: `until ${time(s.pausedUntil)}` };
  if (!s.history.done) {
    const from = s.history.from ? `, from ${date(s.history.from)}` : "";
    return { cls: "info", icon: "sync", text: "Loading history", detail: `${s.history.percent}% done${from}` };
  }
  return { cls: "ok", icon: "check", text: "Connected", detail: s.lastSyncAt && `Last sync ${date(s.lastSyncAt, false)}, ${time(s.lastSyncAt)}` };
}

/** Badge with its detail; a progress bar while there is a key and history is not loaded, whichever badge wins */
function stateLine(s: SettingsState): string {
  const b = badge(s);
  let h = `<div class="stateline"><span class="badge ${b.cls}">${b.icon ? icon(b.icon, 12) : ""}${esc(b.text)}</span>`
    + `${b.detail ? `<p>${esc(b.detail)}</p>` : ""}</div>`;
  if (s.key !== "none" && !s.history.done) {
    const p = esc(s.history.percent);
    h += `<div class="bar" role="progressbar" aria-label="History loaded" aria-valuenow="${p}"><i style="width:${p}%"></i></div>`;
  }
  if (b.text === "Loading history") h += `<p class="intro" style="margin-top:10px">Recent days are already available in Claude.</p>`;
  return h;
}

/**
 * Key form: the field never gets the submitted value back; a save error goes under the field.
 * replace — under the "Replace key" row: with a link to Garmin, no top margin (the row provides it)
 */
function keyForm(v: View, replace = false): string {
  const err = v.error && v.error !== "deleting" ? ERRORS[v.error] : undefined;
  const chosen = v.validity ?? 365;
  const options = VALIDITY_DAYS.map((d) => `<option value="${esc(d)}"${d === chosen ? " selected" : ""}>${esc(d)} days</option>`).join("");
  return `<form method="post" action="${ACTION}"${replace ? "" : ` style="margin-top:12px"`}><input type="hidden" name="action" value="save">`
    + (replace ? `<div class="field">${GARMIN_LINK}</div>` : "")
    + `<div class="field"><label for="key">Key</label><input id="key" name="key" class="input" type="password" autocomplete="off" required`
    + (err ? ` aria-invalid="true" aria-describedby="key-error"><p class="error" id="key-error">${esc(err)}</p>` : ">")
    + `</div><div class="field"><label for="validity">Validity you chose in Garmin</label>`
    + `<select id="validity" name="validity" class="input">${options}</select></div>`
    + `<div class="field"><button class="btn primary">Save key</button></div></form>`;
}

function deleteAllRow(error?: PageError): string {
  const err = error === "deleting";
  return `<div class="row"><div><div>Delete all data</div><div class="desc">Erases the key, your history and workout files. This cannot be undone.</div></div>`
    + `<form method="post" action="${ACTION}" onsubmit="return confirm('Delete your Garmin key, history and workout files? This cannot be undone.')">`
    + `<button class="btn danger" name="action" value="delete-all"${err ? ` aria-describedby="delete-error"` : ""}>Delete all</button></form>`
    + (err ? `<p class="error" id="delete-error">${esc(ERRORS.deleting)}</p>` : "")
    + `</div>`;
}

/** First visit (and after "Delete key"): three steps; while data exists, also the "Delete all data" row */
function setup(s: SettingsState, v: View): string {
  return `<p class="intro">Connect your Garmin account so Claude can answer questions about your training, sleep and heart rate. It takes about five minutes.</p>
${stateLine(s)}
<div class="steps">
<div class="step"><div class="num">1</div><div><b>Create a key in Garmin Connect</b><p>Garmin shows the key only once, so copy it right away. Any validity works; a year means fewer renewals.</p>${GARMIN_LINK}</div></div>
<div class="step"><div class="num">2</div><div><b>Paste the key</b><div class="note" role="note">${icon("warning", 16)}<span>${TRUST}</span></div>${keyForm(v)}</div></div>
<div class="step later"><div class="num">3</div><div><b>Add the connector in Claude</b><p>Available once Garmin accepts the key.</p></div></div>
</div>
${s.hasData ? `<h2>Delete</h2>\n${deleteAllRow(v.error)}` : ""}`;
}

/**
 * After setup: key, connector address, deletion. "Replace key" is the key row itself (summary), with the form below it;
 * open after a failed save and when the key is rejected or expired ("replace it below")
 */
function connected(s: SettingsState, v: View): string {
  const expired = s.key === "expiring" && (s.daysLeft ?? 0) <= 0;
  const label = s.key === "rejected" ? "Rejected" : expired ? "Expired" : "Working";
  const desc = s.key === "rejected" ? "Garmin no longer accepts this key"
    : !s.keyExpiresOn ? "" : `${expired ? "Expired on" : "Valid until"} ${date(s.keyExpiresOn)}`;
  const open = (v.error && v.error !== "deleting") || s.key === "rejected" || expired ? " open" : "";
  return `${stateLine(s)}
<h2>Garmin key</h2>
<details${open}><summary class="row"><span>${label}${desc ? `<br><span class="desc">${esc(desc)}</span>` : ""}</span><span class="btn">Replace key</span></summary>${keyForm(v, true)}</details>
<h2>Connect Claude</h2>
<p class="sub">In Claude, go to Customize, then Connectors, click + Add and choose Add custom connector. Paste this address. Claude on your phone picks it up by itself.</p>
<div class="copy"><span>${esc(`${v.origin}/garmin/mcp`)}</span><button class="icon" id="copy" type="button" aria-label="Copy address" title="Copy">${icon("copy", 16)}</button></div>
<h2>Delete</h2>
<div class="row"><div><div>Delete key</div><div class="desc">Sync stops. Loaded data stays.</div></div><form method="post" action="${ACTION}"><button class="btn danger-soft" name="action" value="delete-key">Delete key</button></form></div>
${deleteAllRow(v.error)}
${COPY_SCRIPT}`;
}

/** Garmin settings page for the user's state; every interpolated value is escaped */
export function renderPage(s: SettingsState, v: View): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garmin settings</title>
<style>${SETTINGS_CSS}</style>
</head>
<body>
${SPRITE}
<div class="page">
<header class="topbar"><div class="crumbs"><span>Personal MCP</span>${icon("chevron", 14)}Garmin</div><div class="who">${esc(v.email)}</div></header>
<main class="content">
<h1>Garmin</h1>
${s.key === "none" ? setup(s, v) : connected(s, v)}
</main>
</div>
</body>
</html>
`;
}
