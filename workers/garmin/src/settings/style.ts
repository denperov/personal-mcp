// Stylesheet of the settings pages, the source of their CSS. The gateway's public pages (workers/gateway/src/pages.ts)
// copy its colors (--bg, --text, --text-2, --link) and font from here, so change them together.
// Rules: docs/architecture.md, section "Settings UI".
// Move it to a shared module once a second server needs it
export const SETTINGS_CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#fff, #191919);
  --text: light-dark(#000000e6, #ffffffed);
  --text-2: light-dark(#00000099, #ffffff91);
  --text-3: light-dark(#00000077, #ffffff66);
  --line: light-dark(#0000001f, #ffffff1f);
  --border: light-dark(#00000014, #ffffff0d);
  --fill-primary: light-dark(#191919, #efefef);
  --on-primary: light-dark(#fff, #191919);
  --fill-secondary: light-dark(#0000000d, #ffffff26);
  --field: light-dark(#00000008, #ffffff0d);
  --accent: #257de0;
  --text-accent: light-dark(#1757ac, #6aabf1);   --bg-accent: light-dark(#257de01f, #257de02e);
  --text-success: light-dark(#006c10, #53c556);  --bg-success: light-dark(#10a12224, #10a1222e);
  --text-warning: light-dark(#794c02, #e49c06);  --bg-warning: light-dark(#fbb31529, #fbb3151f);
  --danger: #dc3c3d;
  --text-danger: light-dark(#a42528, #f17778);   --bg-danger: light-dark(#dc3c3d1a, #dc3c3d26);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/20px var(--font);
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }

.page { max-width: 600px; margin: 0 auto; background: var(--bg); color: var(--text); }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; height: 52px; padding: 0 20px; border-bottom: 1px solid var(--line); }
.crumbs { display: flex; align-items: center; gap: 6px; font-weight: 520; white-space: nowrap; }
.crumbs span { color: var(--text-2); font-weight: 435; }
.crumbs svg { color: var(--text-3); }
.who { font-size: 13px; line-height: 18px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.content { padding: 24px 20px 28px; }

h1 { font-size: 22px; line-height: 28px; font-weight: 520; margin: 0 0 4px; }
h2 { font-size: 15px; line-height: 20px; font-weight: 520; margin: 32px 0 4px; }
.intro { color: var(--text-2); margin: 0; }
.sub { color: var(--text-2); margin: 0 0 12px; }

.stateline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 16px; }
.stateline p { margin: 0; color: var(--text-2); }
.bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; margin-top: 10px; }
.bar i { display: block; height: 100%; background: var(--accent); }

.badge { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 6px;
  font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; }
.badge.idle { background: var(--fill-secondary); color: var(--text-2); }
.badge.info { background: var(--bg-accent); color: var(--text-accent); }
.badge.ok { background: var(--bg-success); color: var(--text-success); }
.badge.warn { background: var(--bg-warning); color: var(--text-warning); }
.badge.err { background: var(--bg-danger); color: var(--text-danger); }

.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; padding: 16px 0; }
.row > :first-child { flex: 1 1 200px; }
.row + .row { border-top: 1px solid var(--line); }
.desc { color: var(--text-2); }

.steps { margin-top: 20px; }
.step { display: grid; grid-template-columns: 24px 1fr; gap: 12px; padding: 16px 0; }
.step + .step { border-top: 1px solid var(--line); }
.num { width: 24px; height: 24px; margin-top: -2px; border-radius: 50%; background: var(--fill-secondary);
  display: grid; place-items: center; font-size: 12px; font-weight: 520; }
.step b { display: block; font-weight: 520; }
.step p { color: var(--text-2); margin: 2px 0 12px; }
.step.later { opacity: .5; }
.step.later p { margin-bottom: 0; }
.note { display: flex; gap: 8px; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
  font-size: 13px; line-height: 18px; color: var(--text-2); }
.note svg { flex: none; margin-top: 1px; color: var(--text-warning); }

.btn { font: inherit; font-weight: 435; height: 32px; padding: 0 12px; border: 0; border-radius: 8px;
  background: var(--fill-secondary); color: var(--text); display: inline-flex; align-items: center; gap: 6px;
  white-space: nowrap; cursor: pointer; text-decoration: none; }
.btn.primary { background: var(--fill-primary); color: var(--on-primary); }
.btn.danger-soft { background: var(--bg-danger); color: var(--text-danger); }
.btn.danger { background: var(--danger); color: #fff; }
summary.row { list-style: none; cursor: pointer; }
summary.row::-webkit-details-marker { display: none; }

.field + .field { margin-top: 12px; }
.field label { display: block; color: var(--text-2); margin-bottom: 6px; }
.input { font: inherit; width: 100%; height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--field); color: var(--text); }
.error { margin: 6px 0 0; font-size: 13px; line-height: 18px; color: var(--text-danger); }

.copy { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 4px 0 12px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--field); }
.copy span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { flex: none; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); display: grid; place-items: center; cursor: pointer; }
.icon:hover { background: var(--fill-secondary); color: var(--text); }
.icon.done { color: var(--text-success); }

:is(.btn, .icon, .input, a, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (pointer: coarse) {
  body { font-size: 15px; }
  .btn { height: 40px; }
  .input { height: 44px; font-size: 16px; }
}
`;
