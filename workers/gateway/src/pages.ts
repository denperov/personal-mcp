// Public pages for the Google consent screen (home and policy). Access lets them through without sign-in (Bypass),
// the gateway serves them before the identity check — exact path and GET/HEAD only. Colors and font come from
// workers/garmin/src/settings/style.ts (docs/architecture.md, section "Settings UI").
const CSS = `:root { color-scheme: light dark; --bg: light-dark(#fff, #191919); --text: light-dark(#000000e6, #ffffffed);
  --text-2: light-dark(#00000099, #ffffff91); --link: light-dark(#1757ac, #6aabf1);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/22px var(--font); }
main { max-width: 600px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 22px; line-height: 28px; font-weight: 600; margin: 0 0 16px; }
h2 { font-size: 16px; line-height: 22px; font-weight: 600; margin: 24px 0 6px; }
p, ul { margin: 0 0 10px; } ul { padding-left: 20px; }
a { color: var(--link); } .muted { color: var(--text-2); }`;

const UPDATED = "November 9, 2026";

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>
`;

// No owner's personal data and no technical details (tested): only what Google requires about sign-in data
const ABOUT = page("Private access", `<h1>Private access</h1>
<p>A private service, available only by invitation.</p>
<p>"Sign in with Google" only confirms your email address. Access is granted only if that address has been
invited.</p>
<p><a href="/privacy">Privacy policy</a></p>`);

const PRIVACY = page("Privacy policy", `<h1>Privacy policy</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>When you sign in with Google, we receive your email address, name and profile picture.</p>
<p>Only your email address is used: to check that you have been invited and to identify your account. Your name and
picture are not used.</p>
<p>This data is kept by our hosting provider as part of its sign-in records. It is not sold or shared with anyone
else.</p>
<p>To have your access removed, contact the person who invited you.</p>
<p><a href="/about">About this service</a></p>`);

export const PAGES = new Map([["/about", ABOUT], ["/privacy", PRIVACY]]);

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
