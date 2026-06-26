/*
 * Floodlight — Tifo Maker design system.
 *
 * One idea: the canvas is lit, everything else is the unlit concourse. The ink
 * ramp is a compressed 4-step dark so panels recede; the contrast budget is
 * spent only on text and two accents. Accent division is strict and enforced
 * by the glow rule: terracotta ACTS (tools, primary actions, active state),
 * violet SELECTS (focus, presence, viewport). Danger never glows; accents
 * always do.
 *
 * Injected at runtime by theme.ts so the design tokens live in one TS module
 * the rest of the app can import from, while the CSS stays declarative.
 */

export const FLOODLIGHT_TOKENS = {
  ink0: '#0B1120',
  ink1: '#0F172A',
  ink2: '#161E31',
  ink3: '#1E2942',
  canvasPit: '#070B14',
  line1: '#243049',
  line2: '#33415C',
  text1: '#F1F4FB',
  text2: '#A6B0C8',
  text3: '#6B7793',
  flare: '#1C6FE0',
  flareHover: '#3B86EE',
  flarePress: '#155EC4',
  flareInk: '#FFFFFF',
  violet: '#8B7CFF',
  violetPress: '#5B4CCF',
  violetInk: '#FFFFFF',
  ok: '#0FBF6B',
  warn: '#F5B43C',
  danger: '#F0455A',
} as const;

export const FLOODLIGHT_CSS = `
:root {
  /* Deep-slate surfaces (replacing flat blacks) so vibrant brand colors pop. */
  --ink-0:#0B1120; --ink-1:#0F172A; --ink-2:#161E31; --ink-3:#1E2942;
  --canvas-pit:#070B14; --line-1:#243049; --line-2:#33415C;
  --text-1:#F1F4FB; --text-2:#A6B0C8; --text-3:#6B7793;

  /* Brand palette pulled from the landing page. --flare is now electric blue
     (the landing's primary action color); the old dull orange is gone. */
  --blue:#1C6FE0; --purple:#5B2A86; --emerald:#0F8A4D; --neon:#D9F000;
  --flare:#1C6FE0; --flare-hover:#3B86EE; --flare-press:#155EC4; --flare-ink:#FFFFFF;
  --violet:#8B7CFF; --violet-press:#5B4CCF; --violet-ink:#FFFFFF;
  --ok:#0FBF6B; --warn:#F5B43C; --danger:#F0455A;

  /* Signature gradient (purple→blue→emerald), echoing the landing hero. */
  --grad-brand:linear-gradient(100deg,#5B2A86 0%,#1C6FE0 55%,#0F8A4D 100%);
  --grad-accent:linear-gradient(120deg,#1C6FE0,#5B2A86);

  --glow-flare:0 6px 18px rgba(28,111,224,.40);
  --glow-soft:0 4px 14px rgba(28,111,224,.28);
  --shadow-card:0 1px 2px rgba(0,0,0,.30), 0 8px 22px rgba(0,0,0,.24);
  --shadow-pop:0 14px 44px rgba(0,0,0,.55);
  --ring-focus:0 0 0 2px var(--ink-1), 0 0 0 4px rgba(28,111,224,.7);
  --r-sm:8px; --r-md:12px; --r-lg:16px; --r-pill:999px;
  --font-ui:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --font-data:'JetBrains Mono',ui-monospace,monospace;
}
* { box-sizing:border-box; }
html, body { height:100%; }
body {
  margin:0; background:var(--ink-0); color:var(--text-1);
  font:13px/1.5 var(--font-ui); overflow:hidden;
  display:flex; flex-direction:column;
  -webkit-font-smoothing:antialiased;
}

/* ---- top bar ---- */
header {
  height:56px; flex:0 0 56px; display:flex; align-items:center; gap:16px;
  padding:0 18px; background:var(--ink-1);
  border-bottom:1px solid var(--line-1);
}
.brand { font-weight:800; letter-spacing:.02em; font-size:17px; color:var(--text-1); }
.brand b { color:var(--blue); font-weight:800; }
.doc-title {
  background:var(--ink-2); border:1px solid transparent; border-radius:var(--r-pill);
  color:var(--text-2); font:inherit; padding:7px 14px; max-width:240px; transition:border-color .14s, color .14s, background .14s;
}
.doc-title:hover { border-color:var(--line-2); color:var(--text-1); }
.doc-title:focus { outline:none; box-shadow:var(--ring-focus); color:var(--text-1); background:var(--ink-3); }
.topbar-center { flex:1; display:flex; justify-content:center; }
.topbar-right { display:flex; align-items:center; gap:10px; }

/* segmented Design/Stadium/Split toggle — pill container, gradient active pill */
.segmented {
  display:flex; gap:2px; background:var(--ink-2); border:1px solid var(--line-1);
  border-radius:var(--r-pill); padding:3px;
}
.segmented button {
  border:none; background:transparent; color:var(--text-2);
  padding:7px 18px; font:inherit; font-weight:600; cursor:pointer;
  border-radius:var(--r-pill); transition:color .14s, background .14s;
}
.segmented button:hover { color:var(--text-1); }
.segmented button.active { background:var(--grad-accent); color:#fff; box-shadow:var(--glow-soft); }

.save-dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px rgba(15,191,107,.5); }
.avatar {
  width:30px; height:30px; border-radius:50%; background:var(--grad-accent); color:#fff;
  display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px;
}

/* ---- main 3-column body ---- */
.workspace { flex:1; min-height:0; display:flex; }
.tool-rail {
  width:56px; flex:0 0 56px; background:var(--ink-1); border-right:1px solid var(--line-1);
  display:flex; flex-direction:column; align-items:center; padding:12px 0; gap:6px;
}
.tool-rail .sep { width:28px; height:1px; background:var(--line-1); margin:6px 0; }
.tool {
  width:40px; height:40px; border-radius:var(--r-md); border:1px solid transparent;
  background:transparent; color:var(--text-2); cursor:pointer; font-size:17px;
  display:flex; align-items:center; justify-content:center; transition:background .14s, color .14s, transform .1s;
}
.tool:hover { background:var(--ink-3); color:var(--text-1); }
.tool:active { transform:scale(.94); }
.tool.active { background:var(--grad-accent); color:#fff; box-shadow:var(--glow-soft); }
.tool:focus-visible { outline:none; box-shadow:var(--ring-focus); }

.stage { flex:1; min-width:0; display:flex; flex-direction:column; }

/* contextual tool bars */
.tool-bar {
  display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  padding:12px 18px; background:var(--ink-1); border-bottom:1px solid var(--line-1);
  font-size:12px; color:var(--text-2);
}
.tool-bar .hint { color:var(--text-3); font-size:11px; }
/* contextual tool-bars fade in when their tool becomes active (cam-bar excluded:
   it relies on a translateX centering transform a keyframe would clobber) */
#import-bar, #text-bar, #shape-bar { animation:ctxFadeIn .15s ease; }

.canvas-wrap { flex:1; min-height:0; position:relative; background:var(--canvas-pit); }
#canvas-host, #preview-host { position:absolute; inset:0; }
#canvas-host canvas, #preview-host canvas { display:block; }
/* split view: 2D and 3D side by side, both live */
.canvas-wrap.split { display:flex; }
.canvas-wrap.split #canvas-host,
.canvas-wrap.split #preview-host { position:relative; inset:auto; flex:1 1 50%; min-width:0; height:100%; }
.canvas-wrap.split #canvas-host { border-right:2px solid var(--line-2); }

/* floating canvas chrome */
.zoom-pill, .minimap {
  position:absolute; background:var(--ink-1); border:1px solid var(--line-1);
  border-radius:var(--r-sm); z-index:5;
}
.zoom-pill { left:12px; bottom:12px; display:flex; align-items:center; gap:2px; padding:3px 6px; color:var(--text-1); }
.zoom-pill button { background:transparent; border:none; color:var(--text-2); cursor:pointer; padding:2px 4px; display:flex; }
.zoom-pill button:hover { color:var(--text-1); }
.zoom-pill span { padding:0 6px; font-variant-numeric:tabular-nums; font-size:11px; }
.minimap { right:12px; bottom:12px; padding:5px; width:148px; }
.minimap canvas { width:100%; display:block; border-radius:3px; cursor:pointer; }
.minimap .viewport { position:absolute; border:1.5px solid var(--violet); border-radius:2px; pointer-events:none; }

/* ---- non-removable on-canvas watermark (sits just above the minimap) ---- */
#canvas-watermark {
  position:absolute; right:14px; bottom:62px; z-index:6;
  padding:3px 8px; pointer-events:none; user-select:none;
  font-size:11px; font-weight:600; letter-spacing:.02em;
  color:var(--text-2); background:var(--ink-1);
  border:1px solid var(--line-1); border-radius:var(--r-sm);
  opacity:.72;
}

/* ---- left-rail Save & Animation menu buttons ---- */
.rail-spacer { margin-top:auto; }
.tool.rail-menu.menu-active { background:var(--grad-accent); color:#fff; box-shadow:var(--glow-soft); }

/* ---- stadium export preview modal ---- */
.sx-backdrop {
  position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
  background:rgba(4,6,12,.62); backdrop-filter:blur(2px);
}
.sx-modal {
  background:var(--ink-0); border:1px solid var(--line-1); border-radius:var(--r-lg);
  padding:18px; width:min(640px, 92vw); box-shadow:0 24px 60px rgba(0,0,0,.5); position:relative;
}
.sx-modal h3 { margin:0 0 4px; font-size:15px; color:var(--text-1); }
.sx-modal .sx-lead { margin:0 0 12px; font-size:12px; color:var(--text-3); }
.sx-canvas {
  width:100%; display:block; border-radius:var(--r-md); background:#070b14;
  border:1px solid var(--line-1); aspect-ratio:16/10;
}
.sx-modal .sx-actions { display:flex; gap:8px; margin-top:14px; }
.sx-modal .sx-actions button { flex:1; }
.sx-close { position:absolute; top:10px; right:12px; background:transparent; border:none; color:var(--text-2); font-size:20px; cursor:pointer; }
.sx-modal .sx-msg { font-size:11px; color:var(--text-3); margin:10px 0 0; min-height:14px; }

/* ---- right properties panel: a scrollable rail of breathing cards ---- */
.panel {
  width:312px; flex:0 0 312px; background:var(--ink-0); border-left:1px solid var(--line-1);
  display:flex; flex-direction:column; overflow-y:auto; padding:14px 14px 28px; gap:14px;
}
.panel::-webkit-scrollbar { width:10px; }
.panel::-webkit-scrollbar-thumb { background:var(--ink-3); border-radius:999px; border:3px solid var(--ink-0); }
.panel::-webkit-scrollbar-thumb:hover { background:var(--line-2); }
.panel.collapsed { width:32px; flex-basis:32px; padding:10px 0; }
.panel.collapsed .panel-section, .panel.collapsed .panel-orient, .panel.collapsed .panel-head span { display:none; }
.panel-head {
  display:flex; align-items:center; justify-content:space-between;
  padding:2px 4px 0; margin:0;
}
.panel-head span { font-size:13px; font-weight:700; color:var(--text-1); letter-spacing:0; text-transform:none; }

/* Each section is a card: rounded, bordered, generously padded, with shadow. */
.panel-section {
  padding:16px; border:1px solid var(--line-1); border-radius:var(--r-lg);
  background:var(--ink-1); box-shadow:var(--shadow-card);
}
.panel-section h4 {
  margin:0 0 12px; font-size:12px; font-weight:700; color:var(--text-2);
  text-transform:uppercase; letter-spacing:.05em;
  display:flex; align-items:center; gap:6px;
}
/* a soft accent tick before each card title */
.panel-section h4::before {
  content:''; width:3px; height:13px; border-radius:2px; background:var(--grad-accent); flex:0 0 auto;
}
/* contextual panel: snappy fade-in when a section becomes relevant to the tool */
@keyframes ctxFadeIn {
  from { opacity:0; transform:translateY(4px); }
  to { opacity:1; transform:translateY(0); }
}
.panel-section.ctx-fade-in { animation:ctxFadeIn .15s ease both; }

/* swatches with live counts */
.swatch-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
.swatch-cell { display:flex; flex-direction:column; align-items:center; gap:3px; }

/* foreground colour well + add button (top of the Swatches card) */
.color-well-row { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.fg-well {
  width:44px; height:44px; flex:0 0 auto; border-radius:var(--r-md); padding:0;
  border:2px solid var(--line-2); box-shadow:inset 0 0 0 2px var(--ink-1), var(--shadow-card); cursor:pointer;
  transition:transform .1s, border-color .14s;
}
.fg-well:hover { transform:scale(1.05); border-color:var(--blue); }
.fg-meta { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.fg-hex { font-family:var(--font-data); font-size:13px; color:var(--text-1); text-transform:uppercase; }
.fg-sub { font-size:11px; color:var(--text-3); }
.add-swatch {
  flex:0 0 auto; padding:8px 13px; font-size:12px; font-weight:600; border-radius:var(--r-pill);
  background:var(--ink-3); color:var(--text-1); border:1px dashed var(--line-2); cursor:pointer;
}
.add-swatch:hover { border-style:solid; border-color:var(--blue); color:var(--blue); background:rgba(28,111,224,.1); }
.swatch-hint { font-size:11px; color:var(--text-3); margin-top:10px; line-height:1.45; }
.palette-tools { margin-top:14px; padding-top:14px; border-top:1px solid var(--line-1); }
.swatch {
  width:100%; aspect-ratio:1; border-radius:var(--r-md); border:2px solid transparent;
  cursor:pointer; padding:0; min-width:0; transition:transform .1s;
}
.swatch:hover { transform:scale(1.06); }
.swatch.active { border-color:#fff; box-shadow:0 0 0 2px var(--blue); }
.swatch-count { font-size:10px; color:var(--text-3); font-variant-numeric:tabular-nums; }

/* chips (tier filter, scope) */
.chips { display:flex; gap:7px; flex-wrap:wrap; }
.chip {
  padding:7px 14px; border-radius:var(--r-pill); border:1px solid var(--line-2);
  background:var(--ink-3); color:var(--text-2); font:inherit; font-size:12px; font-weight:500; cursor:pointer;
  transition:border-color .14s, color .14s, background .14s;
}
.chip:hover { border-color:var(--line-2); color:var(--text-1); background:var(--line-1); }
.chip.active { background:rgba(28,111,224,.16); border-color:var(--blue); color:#9FC2F5; }

/* history list */
.history { display:flex; flex-direction:column; gap:4px; max-height:140px; overflow-y:auto; }
.history-item { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); padding:2px 0; }
.history-item.faded { color:var(--text-3); }

/* ---- generic controls ---- */
button {
  background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-pill); padding:9px 16px; font:inherit; font-weight:600; cursor:pointer;
  transition:background .14s, border-color .14s, transform .1s, box-shadow .14s;
}
button:hover { background:var(--line-1); border-color:var(--line-2); }
button:active { transform:translateY(1px); }
button:disabled { opacity:.4; cursor:default; pointer-events:none; }
button.primary {
  background:var(--blue); color:#fff; border-color:transparent; box-shadow:var(--glow-soft);
}
button.primary:hover { background:var(--flare-hover); box-shadow:var(--glow-flare); }
button.primary:active { background:var(--flare-press); }
button.danger { background:rgba(240,69,90,.12); border-color:rgba(240,69,90,.5); color:#F58A96; }
button.danger:hover { background:rgba(240,69,90,.2); }
button:focus-visible { outline:none; box-shadow:var(--ring-focus); }

/* custom dropdown — no native arrow, brand chevron */
select {
  -webkit-appearance:none; appearance:none;
  background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:9px 34px 9px 12px; font:inherit; font-size:13px; cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23A6B0C8' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat:no-repeat; background-position:right 12px center;
  transition:border-color .14s, background-color .14s;
}
select:hover { border-color:var(--line-2); background-color:var(--line-1); }
select:focus-visible { outline:none; box-shadow:var(--ring-focus); }

input[type="text"], input[type="number"] {
  background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:9px 12px; font:inherit; width:200px; transition:border-color .14s, box-shadow .14s;
}
input[type="text"]::placeholder, input[type="number"]::placeholder { color:var(--text-3); }
input[type="text"]:hover, input[type="number"]:hover { border-color:var(--line-2); }
input[type="text"]:focus-visible, input[type="number"]:focus-visible { outline:none; box-shadow:var(--ring-focus); }
#text-input { text-transform:uppercase; }

label { color:var(--text-2); display:inline-flex; align-items:center; gap:8px; font-size:13px; }

/* range slider — gradient-filled track, prominent thumb */
input[type="range"] { -webkit-appearance:none; appearance:none; height:20px; background:transparent; cursor:pointer; }
input[type="range"]::-webkit-slider-runnable-track { height:6px; border-radius:999px; background:var(--ink-3); border:1px solid var(--line-1); }
input[type="range"]::-moz-range-track { height:6px; border-radius:999px; background:var(--ink-3); border:1px solid var(--line-1); }
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance:none; appearance:none; margin-top:-8px; width:20px; height:20px; border-radius:50%;
  background:#fff; border:none; box-shadow:0 2px 6px rgba(0,0,0,.45), 0 0 0 4px var(--blue);
  transition:box-shadow .12s, transform .1s;
}
input[type="range"]::-moz-range-thumb {
  width:20px; height:20px; border:none; border-radius:50%; background:#fff;
  box-shadow:0 2px 6px rgba(0,0,0,.45), 0 0 0 4px var(--blue);
}
input[type="range"]:hover::-webkit-slider-thumb { transform:scale(1.08); }
input[type="range"]:active::-webkit-slider-thumb { transform:scale(.95); }
input[type="range"]:focus-visible { outline:none; }
input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow:0 2px 6px rgba(0,0,0,.45), 0 0 0 4px var(--blue), 0 0 0 7px rgba(28,111,224,.4); }

/* custom checkbox — no native control */
input[type="checkbox"] {
  -webkit-appearance:none; appearance:none; width:20px; height:20px; flex:0 0 auto;
  border:1.5px solid var(--line-2); border-radius:6px; background:var(--ink-3); cursor:pointer;
  position:relative; transition:background .14s, border-color .14s;
}
input[type="checkbox"]:hover { border-color:var(--blue); }
input[type="checkbox"]:checked { background:var(--blue); border-color:var(--blue); }
input[type="checkbox"]:checked::after {
  content:''; position:absolute; left:6px; top:2px; width:5px; height:10px;
  border:solid #fff; border-width:0 2.5px 2.5px 0; transform:rotate(45deg);
}
input[type="checkbox"]:focus-visible { outline:none; box-shadow:var(--ring-focus); }

/* number fields: drop native spinners for a clean, consistent control */
input[type="number"] { -moz-appearance:textfield; }
input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }

/* one disabled treatment for every control */
button:disabled, select:disabled, input:disabled, textarea:disabled, .chip:disabled {
  opacity:.45; cursor:default; pointer-events:none;
}

/* native colour input → clean rounded swatch (colour popover) */
input[type="color"] { -webkit-appearance:none; appearance:none; padding:0; cursor:pointer; }
input[type="color"]::-webkit-color-swatch-wrapper { padding:0; }
input[type="color"]::-webkit-color-swatch { border:none; border-radius:6px; }
input[type="color"]::-moz-color-swatch { border:none; border-radius:6px; }

/* groups: inline in bars (with dividers), stacked with breathing room in cards */
.group { display:flex; align-items:center; gap:10px; }
.tool-bar .group + .group { padding-left:14px; border-left:1px solid var(--line-1); }
.panel-section .group + .group { margin-top:12px; }
.panel-section .group { flex-wrap:wrap; }

/* ---- panel consistency helpers (standardise repeated inline styles) ---- */
.panel-section .note { font-size:11px; color:var(--text-3); margin:0 0 8px; }
.panel-section .note-sm { font-size:10px; color:var(--text-3); margin:0 0 6px; }
.val { font-variant-numeric:tabular-nums; min-width:18px; }
.grow { flex:1; }
.grow0 { flex:1; min-width:0; }
.empty { color:var(--text-3); font-size:12px; line-height:1.5; }
.ai-input {
  width:100%; box-sizing:border-box; resize:vertical; font:inherit; padding:8px;
  border:1px solid var(--line-1); border-radius:var(--r-md); background:var(--ink-2); color:var(--text-1);
}
.ai-input:focus-visible { outline:none; box-shadow:var(--ring-focus); }

/* ---- status bar ---- */
footer {
  height:26px; flex:0 0 26px; display:flex; align-items:center; gap:14px;
  padding:0 14px; background:var(--ink-1); border-top:1px solid var(--line-1);
  color:var(--text-3); font-size:11px; font-variant-numeric:tabular-nums;
}
footer .coords { color:var(--text-2); font-family:var(--font-data); }
footer .spacer { flex:1; }
footer .legible-chip.ok { color:var(--ok); }
footer .legible-chip.warn { color:var(--warn); }
footer kbd { background:var(--ink-3); border:1px solid var(--line-1); border-radius:4px; padding:0 5px; font-size:10px; font-family:var(--font-data); }

/* zen mode hides chrome */
body.zen .tool-rail, body.zen .panel, body.zen footer, body.zen .tool-bar { display:none; }

[hidden] { display:none !important; }

/* color editor popover */
.color-pop {
  position:fixed; z-index:60; display:flex; align-items:center; gap:8px;
  background:var(--ink-2); border:1px solid var(--line-2); border-radius:var(--r-md);
  padding:8px 10px; box-shadow:0 8px 24px rgba(0,0,0,.5);
}
.color-pop span { font-size:11px; color:var(--text-3); }
.color-pop input[type="color"] { width:32px; height:28px; padding:0; border:1px solid var(--line-1); border-radius:var(--r-sm); background:transparent; cursor:pointer; }
.color-pop input[type="text"] { width:84px; font-family:var(--font-data); font-size:12px; }

/* section navigator strip */
.section-strip { display:flex; flex-direction:column; gap:6px; }
.section-stand { }
.section-stand-label { font-size:10px; color:var(--text-3); text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; }
.section-cells { display:flex; flex-wrap:wrap; gap:3px; }
.section-cell {
  width:20px; height:16px; border-radius:3px; border:1px solid var(--line-1);
  background:var(--ink-3); cursor:pointer; font-size:9px; color:var(--text-3);
  display:flex; align-items:center; justify-content:center; padding:0;
}
.section-cell:hover { border-color:var(--violet); color:var(--text-1); }

/* ---- tablet (768-1099px): editor with slide-over panel, bigger touch targets ---- */
.panel-scrim { display:none; }
@media (max-width: 1099px) {
  .tool { width:42px; height:42px; }
  .tool-rail { width:54px; flex-basis:54px; }
  .panel {
    position:absolute; right:0; top:0; bottom:0; z-index:20;
    transform:translateX(100%); transition:transform .18s ease;
    box-shadow:-8px 0 24px rgba(0,0,0,.4);
  }
  .panel.open { transform:translateX(0); }
  /* tap-to-dismiss scrim behind the slide-over so taps don't reach the canvas */
  .panel-scrim { display:block; position:absolute; inset:0; z-index:19; background:rgba(4,6,12,.5); opacity:0; pointer-events:none; transition:opacity .18s ease; }
  .panel-scrim.show { opacity:1; pointer-events:auto; }
  /* keep dense tool-bars on one scrollable row instead of stacking tall */
  .tool-bar { flex-wrap:nowrap; overflow-x:auto; }
  /* comfortable 44px touch targets in the panel */
  .panel button, .panel select, .panel .chip { min-height:44px; }
  .panel-fab {
    position:absolute; right:12px; top:60px; z-index:15;
    width:44px; height:44px; border-radius:50%;
    background:var(--flare); color:var(--flare-ink); border:none;
    display:flex; align-items:center; justify-content:center; box-shadow:var(--glow-flare);
  }
}
@media (min-width: 1100px) { .panel-fab { display:none; } }

/* ---- phone viewer (<768px) ---- */
body.viewer { display:block; overflow-y:auto; background:var(--ink-0); }
.viewer-root { max-width:520px; margin:0 auto; }
.v-top {
  height:46px; display:flex; align-items:center; justify-content:space-between;
  padding:0 16px; background:var(--ink-1); border-bottom:1px solid var(--line-1); position:sticky; top:0; z-index:10;
}
.v-open { font-size:12px; padding:6px 12px; }
.v-hero { position:relative; background:var(--canvas-pit); }
#v-preview-host { position:relative; width:100%; height:300px; }
#v-preview-host canvas { display:block; width:100%; height:100%; }
.v-cams { position:absolute; left:0; right:0; bottom:10px; display:flex; justify-content:center; gap:6px; flex-wrap:wrap; padding:0 10px; }
.v-cam {
  padding:5px 12px; border-radius:20px; font-size:12px;
  background:rgba(18,20,25,.8); border:1px solid var(--line-2); color:var(--text-2);
}
.v-cam.active { background:var(--flare); color:var(--flare-ink); border-color:var(--flare); font-weight:500; }
.v-body { padding:16px; }
.v-title { font-size:18px; font-weight:500; color:var(--text-1); }
.v-sub { font-size:13px; color:var(--text-3); margin-bottom:12px; }
.v-flat { width:100%; height:auto; border-radius:var(--r-sm); display:block; image-rendering:pixelated; }
.v-bom { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.v-bom-chip { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); font-variant-numeric:tabular-nums; }
.v-bom-chip i { width:14px; height:14px; border-radius:4px; display:inline-block; }
.v-actions { display:flex; gap:10px; margin-top:18px; }
.v-actions .primary { flex:1; padding:12px 0; font-size:15px; }
.v-actions button:not(.primary) { width:52px; }
.v-gallery-head { margin-top:22px; padding-top:14px; border-top:1px solid var(--line-1); color:var(--text-3); font-size:13px; }
.v-gallery { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px; }
.v-g-card {
  display:flex; flex-direction:column; align-items:stretch; gap:4px; padding:8px;
  border:1px solid var(--line-1); border-radius:var(--r-md); background:var(--ink-1); text-align:left; color:var(--text-1);
}
.v-g-card img { width:100%; border-radius:var(--r-sm); image-rendering:pixelated; background:var(--ink-2); }
.v-g-card span { font-size:13px; font-weight:500; }
.v-g-card small { font-size:11px; color:var(--text-3); }
.v-muted { color:var(--text-3); font-size:13px; grid-column:1/-1; }

/* ---- auth modal ---- */
.auth-backdrop {
  position:fixed; inset:0; z-index:200; display:flex; align-items:center; justify-content:center;
  background:rgba(7,8,10,.72); backdrop-filter:blur(3px);
}
.auth-modal {
  position:relative; width:360px; max-width:calc(100vw - 32px);
  background:var(--ink-1); border:1px solid var(--line-2); border-radius:14px;
  padding:24px; box-shadow:0 24px 60px rgba(0,0,0,.5);
}
.auth-close {
  position:absolute; top:12px; right:12px; width:30px; height:30px; padding:0;
  border:none; background:transparent; color:var(--text-3); font-size:22px; line-height:1; cursor:pointer;
}
.auth-close:hover { color:var(--text-1); background:transparent; }
.auth-brand { font-weight:500; letter-spacing:.05em; font-size:15px; margin-bottom:18px; }
.auth-brand b { color:var(--flare); font-weight:500; }
.auth-tabs { display:flex; gap:4px; background:var(--ink-3); border-radius:var(--r-md); padding:3px; margin-bottom:18px; }
.auth-tab {
  flex:1; border:none; background:transparent; color:var(--text-2);
  padding:8px 0; border-radius:var(--r-sm); font:inherit; font-size:13px; cursor:pointer;
}
.auth-tab:hover { background:transparent; color:var(--text-1); }
.auth-tab.active { background:var(--ink-1); color:var(--text-1); font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.auth-form { display:flex; flex-direction:column; gap:14px; }
.auth-field { display:flex; flex-direction:column; gap:6px; }
.auth-field span { font-size:12px; color:var(--text-3); }
.auth-field input {
  background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:10px 12px; font:inherit; font-size:14px; width:100%;
}
.auth-field input:focus-visible { outline:none; box-shadow:var(--ring-focus); }
.auth-error {
  background:rgba(240,69,90,.12); border:1px solid var(--danger); color:#F58A96;
  border-radius:var(--r-sm); padding:8px 10px; font-size:12px;
}
.auth-submit { width:100%; padding:11px 0; font-size:14px; margin-top:2px; }
.auth-note { color:var(--text-3); font-size:11px; line-height:1.5; margin:16px 0 0; text-align:center; }

/* ---- community feed ---- */
.feed-backdrop {
  position:fixed; inset:0; z-index:150; display:flex; align-items:center; justify-content:center;
  background:rgba(7,8,10,.78); backdrop-filter:blur(3px);
}
.feed-panel {
  position:relative; width:min(1040px, 94vw); max-height:88vh; display:flex; flex-direction:column;
  background:var(--ink-1); border:1px solid var(--line-2); border-radius:16px; overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.5);
}
.feed-head { position:relative; padding:20px 24px; border-bottom:1px solid var(--line-1); }
.feed-title { font-size:18px; font-weight:500; color:var(--text-1); }
.feed-sub { font-size:13px; color:var(--text-3); margin-top:4px; }
.feed-close {
  position:absolute; top:16px; right:18px; width:32px; height:32px; padding:0;
  border:none; background:transparent; color:var(--text-3); font-size:24px; line-height:1; cursor:pointer;
}
.feed-close:hover { color:var(--text-1); background:transparent; }
.feed-grid {
  padding:20px 24px; overflow-y:auto;
  display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:16px;
}
.feed-loading, .feed-empty { color:var(--text-3); font-size:14px; grid-column:1/-1; padding:24px 0; text-align:center; line-height:1.6; }
.feed-card {
  display:flex; flex-direction:column; border:1px solid var(--line-1); border-radius:12px;
  overflow:hidden; background:var(--ink-2); transition:border-color .12s, transform .12s;
}
.feed-card:hover { border-color:var(--line-2); transform:translateY(-2px); }
.feed-thumb {
  width:100%; aspect-ratio:5/1; object-fit:contain; background:var(--canvas-pit);
  image-rendering:pixelated; cursor:pointer; display:block;
}
.feed-thumb-empty { aspect-ratio:5/1; }
.feed-card-body { padding:10px 12px 12px; }
.feed-card-title { font-size:14px; font-weight:500; color:var(--text-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.feed-card-by { font-size:12px; color:var(--text-3); margin-top:2px; }
.feed-open { margin:0 12px 12px; padding:8px 0; font-size:13px; }

/* ---- onboarding ---- */
.ob-backdrop {
  position:fixed; inset:0; z-index:250; display:flex; align-items:center; justify-content:center;
  background:rgba(7,8,10,.82); backdrop-filter:blur(4px);
}
.ob-modal {
  width:min(520px, 94vw); max-height:90vh; overflow-y:auto;
  background:var(--ink-1); border:1px solid var(--line-2); border-radius:16px;
  box-shadow:0 24px 70px rgba(0,0,0,.55);
}
.ob-hero {
  padding:28px 28px 20px; border-bottom:1px solid var(--line-1);
  background:linear-gradient(160deg, rgba(28,111,224,.12), transparent 60%);
}
.ob-brand { font-weight:500; letter-spacing:.05em; font-size:13px; color:var(--text-2); }
.ob-brand b { color:var(--flare); font-weight:500; }
.ob-h2 { margin:12px 0 8px; font-size:22px; font-weight:600; color:var(--text-1); }
.ob-lead { margin:0; font-size:14px; line-height:1.6; color:var(--text-2); }
.ob-section { padding:18px 28px; border-bottom:1px solid var(--line-1); }
.ob-label { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin-bottom:12px; }
.ob-palettes { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.ob-palette {
  display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px;
  border:1px solid var(--line-1); background:var(--ink-2); color:var(--text-2); cursor:pointer; text-align:left;
}
.ob-palette:hover { border-color:var(--line-2); color:var(--text-1); background:var(--ink-2); }
.ob-palette.active { border-color:var(--violet); background:rgba(139,124,255,.10); color:var(--text-1); }
.ob-swatches { display:inline-flex; gap:3px; flex:0 0 auto; }
.ob-swatch { width:16px; height:22px; border-radius:3px; display:inline-block; }
.ob-palette-name { font-size:12px; }
.ob-starters { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
.ob-name-input {
  width:100%; padding:13px 15px; border:1.5px solid var(--line-1); border-radius:var(--r-md);
  background:var(--ink-2); color:var(--text-1); font-size:16px; font-family:inherit; font-weight:600;
}
.ob-name-input:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px rgba(28,111,224,.18); }
.ob-starter {
  display:flex; flex-direction:column; align-items:flex-start; gap:4px; text-align:left;
  padding:16px; border:1.5px solid var(--line-1); border-radius:var(--r-md); background:var(--ink-2);
  cursor:pointer; transition:border-color .14s, background .14s, transform .1s;
}
.ob-starter:hover { border-color:var(--line-2); transform:translateY(-1px); }
.ob-starter.active { border-color:var(--blue); background:rgba(28,111,224,.1); }
.ob-starter-icon {
  width:36px; height:36px; border-radius:10px; display:grid; place-items:center; font-size:18px; font-weight:800;
  background:var(--grad-accent); color:#fff; margin-bottom:6px;
}
.ob-starter-title { font-weight:700; font-size:15px; color:var(--text-1); }
.ob-starter-blurb { font-size:12px; color:var(--text-3); line-height:1.4; }
.ob-patterns { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.ob-pattern {
  padding:10px 4px; border-radius:8px; border:1px solid var(--line-1); background:var(--ink-2);
  color:var(--text-2); cursor:pointer; font-size:12px;
}
.ob-pattern:hover { border-color:var(--line-2); color:var(--text-1); background:var(--ink-2); }
.ob-pattern.active { border-color:var(--violet); background:rgba(139,124,255,.10); color:var(--text-1); }
.ob-actions { padding:20px 28px; display:flex; gap:10px; align-items:center; }
.ob-start { flex:1; padding:12px 0; font-size:14px; }
.ob-skip { background:transparent; border:none; color:var(--text-3); font-size:13px; cursor:pointer; padding:12px 8px; }
.ob-skip:hover { color:var(--text-1); background:transparent; }

/* feed controls: search + sort tabs */
.feed-controls { display:flex; gap:12px; align-items:center; margin-top:14px; flex-wrap:wrap; }
.feed-search {
  flex:1; min-width:180px; background:var(--ink-3); color:var(--text-1);
  border:1px solid var(--line-2); border-radius:var(--r-md); padding:9px 12px; font:inherit; font-size:13px;
}
.feed-search:focus-visible { outline:none; box-shadow:var(--ring-focus); }
.feed-sorts { display:flex; gap:3px; background:var(--ink-3); border-radius:var(--r-md); padding:3px; }
.feed-sort {
  border:none; background:transparent; color:var(--text-2); padding:7px 14px;
  border-radius:var(--r-sm); font:inherit; font-size:12px; cursor:pointer;
}
.feed-sort:hover { background:transparent; color:var(--text-1); }
.feed-sort.active { background:var(--ink-1); color:var(--text-1); font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.feed-votes { display:flex; gap:6px; align-items:center; margin-top:8px; }
.feed-vote {
  display:inline-flex; align-items:center; gap:4px; padding:4px 8px; font-size:13px;
  border:1px solid var(--line-1); background:var(--ink-1); color:var(--text-2);
  border-radius:var(--r-sm); cursor:pointer; line-height:1;
}
.feed-vote:hover { border-color:var(--line-2); color:var(--text-1); background:var(--ink-1); }
.feed-vote.like.on { border-color:var(--flare); color:var(--flare); background:rgba(28,111,224,.12); }
.feed-vote.dislike.on { border-color:var(--violet); color:var(--violet); background:rgba(139,124,255,.10); }
.feed-score { font-variant-numeric:tabular-nums; font-size:12px; }

/* shining sign-up button — pulses until the user signs up/in */
#signin.signup-shine {
  background:var(--flare); color:#fff; border-color:transparent; position:relative; overflow:hidden;
  animation:signup-pulse 2.2s ease-in-out infinite;
}
#signin.signup-shine::after {
  content:''; position:absolute; top:0; left:-130%; width:60%; height:100%;
  background:linear-gradient(100deg, transparent, rgba(255,255,255,.55), transparent);
  transform:skewX(-18deg); animation:signup-sheen 2.2s ease-in-out infinite;
}
@keyframes signup-pulse {
  0%, 100% { box-shadow:0 0 0 0 rgba(28,111,224,.5); }
  50% { box-shadow:0 0 0 6px rgba(28,111,224,0); }
}
@keyframes signup-sheen {
  0% { left:-130%; }
  55%, 100% { left:130%; }
}
@media (prefers-reduced-motion: reduce) {
  #signin.signup-shine, #signin.signup-shine::after { animation:none; }
}

/* ---- save dialog ---- */
.save-backdrop {
  position:fixed; inset:0; z-index:200; display:flex; align-items:center; justify-content:center;
  background:rgba(7,8,10,.78); backdrop-filter:blur(3px);
}
.save-modal {
  position:relative; width:min(440px, 94vw);
  background:var(--ink-1); border:1px solid var(--line-2); border-radius:16px; padding:24px;
  box-shadow:0 24px 60px rgba(0,0,0,.5);
}
.save-close {
  position:absolute; top:14px; right:16px; width:30px; height:30px; padding:0;
  border:none; background:transparent; color:var(--text-3); font-size:22px; line-height:1; cursor:pointer;
}
.save-close:hover { color:var(--text-1); background:transparent; }
.save-h3 { margin:0 0 4px; font-size:18px; font-weight:600; color:var(--text-1); }
.save-lead { margin:0 0 18px; font-size:13px; color:var(--text-3); }
.save-options { display:flex; flex-direction:column; gap:10px; }
.save-option {
  display:grid; grid-template-columns:24px 1fr; grid-template-rows:auto auto; gap:2px 12px;
  align-items:center; text-align:left; padding:14px 16px; cursor:pointer;
  background:var(--ink-2); border:1px solid var(--line-1); border-radius:12px; color:var(--text-1);
}
.save-option:hover { border-color:var(--flare); background:var(--ink-2); }
.save-option i { grid-row:1/3; font-size:20px; color:var(--flare); }
.save-opt-title { font-size:14px; font-weight:500; }
.save-opt-sub { font-size:12px; color:var(--text-3); }
.save-asnew { display:flex; align-items:center; gap:8px; margin-top:16px; font-size:13px; color:var(--text-2); }

/* design-tab clarity: orientation strip + section header tags */
.panel-orient {
  margin:0; padding:12px 14px; font-size:12px; line-height:1.55; color:var(--text-3);
  background:linear-gradient(135deg, rgba(91,42,134,.16), rgba(28,111,224,.12));
  border:1px solid var(--line-1); border-radius:var(--r-md);
}
.panel-orient b { color:var(--text-1); font-weight:600; }
.h4-tag {
  font-size:10px; font-weight:500; color:var(--text-3); text-transform:none; letter-spacing:0;
  margin-left:auto;
}

/* gallery: templates toggle, tag chips, card tags, report */
.feed-sort.feed-templates { border-left:1px solid var(--line-1); margin-left:2px; padding-left:12px; }
.feed-tag-suggest, .feed-tags { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:10px; }
.feed-tags:not(.has-tags) { margin-top:0; }
.feed-tag-label { font-size:11px; color:var(--text-3); margin-right:2px; }
.feed-tag-chip {
  font-size:11px; padding:4px 10px; border-radius:999px; cursor:pointer;
  background:var(--ink-3); color:var(--text-2); border:1px solid var(--line-1); line-height:1.4;
}
.feed-tag-chip:hover { color:var(--text-1); border-color:var(--line-2); background:var(--ink-3); }
.feed-tag-chip.active { background:rgba(139,124,255,.14); color:var(--violet); border-color:var(--violet); }
.feed-tag-chip .x { opacity:.7; margin-left:2px; }
.feed-card-tags { display:flex; flex-wrap:wrap; gap:4px; margin:6px 0 2px; }
.feed-card-tag {
  font-size:10px; padding:2px 7px; border-radius:999px; cursor:pointer;
  background:var(--ink-3); color:var(--text-3); border:1px solid var(--line-1);
}
.feed-card-tag:hover { color:var(--violet); border-color:var(--violet); }
.feed-tmpl-badge {
  font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:.04em;
  color:var(--flare); border:1px solid var(--flare); border-radius:4px; padding:1px 5px; margin-left:4px;
  vertical-align:middle;
}
.feed-report {
  margin-left:auto; padding:4px 8px; font-size:13px; line-height:1;
  border:1px solid var(--line-1); background:var(--ink-1); color:var(--text-3); border-radius:var(--r-sm); cursor:pointer;
}
.feed-report:hover { color:var(--flare); border-color:var(--flare); background:var(--ink-1); }
.feed-report.reported { color:var(--flare); border-color:var(--flare); cursor:default; }

/* save dialog: tags + template controls */
.save-tags-row { margin-top:16px; }
.save-tags-label { font-size:12px; color:var(--text-2); margin-bottom:6px; display:block; }
.save-tags-input {
  width:100%; background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:9px 12px; font:inherit; font-size:13px;
}
.save-tags-input:focus-visible { outline:none; box-shadow:var(--ring-focus); }
.save-tags-hint { font-size:11px; color:var(--text-3); margin-top:5px; }
.save-template-row { display:flex; align-items:center; gap:8px; margin-top:14px; font-size:13px; color:var(--text-2); }

/* feed: Before/After badge + button */
.feed-thumb-wrap { position:relative; }
.feed-ba-btn {
  position:absolute; left:8px; bottom:8px; display:inline-flex; align-items:center; gap:5px;
  font-size:11px; font-weight:600; padding:5px 10px; border-radius:999px; cursor:pointer;
  background:rgba(14,10,26,.82); color:#fff; border:1px solid rgba(255,255,255,.25); backdrop-filter:blur(4px);
}
.feed-ba-btn:hover { background:var(--violet); border-color:var(--violet); }
.feed-photo-badge {
  font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:.04em;
  color:var(--violet); border:1px solid var(--violet); border-radius:4px; padding:1px 5px; margin-left:4px; vertical-align:middle;
}

/* Before/After split-slider overlay */
.ba-backdrop {
  position:fixed; inset:0; z-index:120; display:flex; align-items:center; justify-content:center;
  background:rgba(8,8,12,.78); backdrop-filter:blur(6px); padding:24px;
}
.ba-panel {
  position:relative; width:min(820px,94vw); background:var(--ink-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:22px; box-shadow:0 24px 64px rgba(0,0,0,.5);
}
.ba-close {
  position:absolute; top:12px; right:14px; background:none; border:none; color:var(--text-2);
  font-size:24px; line-height:1; cursor:pointer; padding:2px 6px;
}
.ba-close:hover { color:var(--text-1); }
.ba-title { font-size:18px; font-weight:600; color:var(--text-1); }
.ba-sub { font-size:13px; color:var(--text-3); margin:2px 0 14px; }
.ba-stage {
  position:relative; width:100%; aspect-ratio:16/10; overflow:hidden; border-radius:var(--r-sm);
  background:var(--ink-3); cursor:ew-resize; user-select:none;
}
.ba-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.ba-before-wrap { position:absolute; inset:0; width:50%; overflow:hidden; border-right:2px solid #fff; }
.ba-before-wrap .ba-before { width:auto; height:100%; max-width:none; }
.ba-before { object-fit:cover; }
.ba-tag {
  position:absolute; top:10px; font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px;
  background:rgba(14,10,26,.75); color:#fff; pointer-events:none;
}
.ba-tag-before { left:10px; }
.ba-tag-after { right:10px; }
.ba-divider {
  position:absolute; top:0; bottom:0; left:50%; width:2px; background:#fff; transform:translateX(-1px);
  pointer-events:auto; cursor:ew-resize;
}
.ba-handle {
  position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:34px; height:34px;
  border-radius:50%; background:#fff; color:var(--ink-0); display:flex; align-items:center; justify-content:center;
  font-size:14px; box-shadow:0 2px 8px rgba(0,0,0,.4);
}
.ba-caption { font-size:13px; color:var(--text-2); margin-top:10px; min-height:18px; }
.ba-thumbs { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
.ba-thumb { width:64px; height:42px; border-radius:6px; overflow:hidden; border:2px solid transparent; cursor:pointer; padding:0; background:none; }
.ba-thumb img { width:100%; height:100%; object-fit:cover; }
.ba-thumb.active { border-color:var(--violet); }

/* moderation panel rows */
.mod-body { padding:16px 0 4px; max-height:60vh; overflow-y:auto; }
.mod-row {
  display:flex; gap:14px; align-items:center; padding:12px; border:1px solid var(--line-1);
  border-radius:var(--r-sm); margin-bottom:10px; background:var(--ink-2);
}
.mod-thumb { width:80px; height:54px; border-radius:6px; object-fit:cover; flex:0 0 auto; background:var(--ink-3); }
.mod-thumb-empty { background:repeating-linear-gradient(45deg, var(--ink-3) 0 6px, var(--ink-2) 6px 12px); }
.mod-thumb-photo { width:96px; height:64px; }
.mod-info { flex:1; min-width:0; }
.mod-title { font-size:14px; font-weight:600; color:var(--text-1); }
.mod-meta { font-size:12px; color:var(--text-3); margin-top:2px; }
.mod-meta strong { color:var(--text-2); }
.mod-date { color:var(--text-3); opacity:.7; }
.mod-flag { font-size:10px; color:var(--flare); border:1px solid var(--flare); border-radius:4px; padding:0 5px; margin-left:6px; }
.mod-actions { display:flex; gap:8px; flex:0 0 auto; }
.mod-btn {
  font-size:12px; padding:7px 12px; border-radius:var(--r-sm); cursor:pointer;
  border:1px solid var(--line-2); background:var(--ink-3); color:var(--text-2);
}
.mod-btn:hover { color:var(--text-1); border-color:var(--text-3); }
.mod-ok { border-color:var(--flare); color:var(--flare); }
.mod-ok:hover { background:var(--flare); color:#fff; }
.mod-danger:hover { border-color:#e0484d; color:#e0484d; }

/* verified-match badge in the Before/After caption */
.ba-verified { color:var(--ok); font-weight:600; display:inline-flex; align-items:center; gap:4px; }
.ba-verified i { font-size:15px; }

/* language toggle in the editor header */
.lang-toggle {
  background:var(--ink-2); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-pill); padding:7px 14px; font:inherit; font-weight:600; font-size:13px; cursor:pointer;
  transition:background .14s, border-color .14s;
}
.lang-toggle:hover { background:var(--ink-3); border-color:var(--line-2); color:var(--text-1); }
.topbar-link {
  color:var(--text-2); font-weight:600; font-size:13px; text-decoration:none; padding:7px 12px;
  border-radius:var(--r-pill); transition:color .14s, background .14s;
}
.topbar-link:hover { color:var(--text-1); background:var(--ink-3); }

/* account menu (avatar dropdown) */
.avatar-wrap { position:relative; }
.avatar { cursor:pointer; }
.avatar-menu {
  position:absolute; top:calc(100% + 8px); right:0; z-index:60; min-width:200px;
  background:var(--ink-1); border:1px solid var(--line-1); border-radius:var(--r-md);
  box-shadow:0 18px 50px rgba(0,0,0,.45); padding:6px; animation:avatarMenuIn .12s ease both;
}
@keyframes avatarMenuIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
.avatar-menu-name { padding:10px 12px 8px; font-weight:700; font-size:13px; color:var(--text-2); border-bottom:1px solid var(--line-1); margin-bottom:4px; }
.avatar-menu-item {
  display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:none; border:none;
  padding:10px 12px; border-radius:var(--r-sm); font-size:14px; font-weight:600; color:var(--text-1); cursor:pointer;
}
.avatar-menu-item:hover { background:var(--ink-3); }
.avatar-menu-item.danger { color:#ff6b7a; }
.avatar-menu-item.danger:hover { background:rgba(255,107,122,.12); }
.avatar-menu-item i { font-size:17px; opacity:.85; }
[dir="rtl"] .avatar-menu { right:auto; left:0; }
[dir="rtl"] .avatar-menu-item { text-align:right; }

/* first-run guided tour */
.tour-overlay { position:fixed; inset:0; z-index:90; pointer-events:none; }
.tour-spotlight {
  position:absolute; border-radius:12px; pointer-events:none;
  box-shadow:0 0 0 9999px rgba(7,10,18,.74); transition:all .22s cubic-bezier(.4,0,.2,1);
  outline:2px solid var(--blue); outline-offset:0;
}
.tour-pop {
  position:absolute; z-index:91; pointer-events:auto; width:300px; max-width:88vw;
  background:var(--ink-1); border:1px solid var(--line-2); border-radius:var(--r-md);
  box-shadow:0 20px 60px rgba(0,0,0,.5); padding:18px; animation:tourPopIn .18s ease both;
}
@keyframes tourPopIn { from { opacity:0; transform:scale(.97); } to { opacity:1; transform:none; } }
.tour-pop-step { font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--blue); margin-bottom:6px; }
.tour-pop-title { margin:0 0 6px; font-size:17px; font-weight:800; color:var(--text-1); }
.tour-pop-body { margin:0 0 16px; font-size:14px; line-height:1.55; color:var(--text-2); }
.tour-pop-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.tour-nav { display:flex; gap:8px; }
.tour-skip { background:none; border:none; color:var(--text-3); font-size:13px; font-weight:600; cursor:pointer; padding:8px 4px; }
.tour-skip:hover { color:var(--text-1); }
.tour-back, .tour-next {
  border:none; border-radius:var(--r-pill); padding:9px 18px; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit;
}
.tour-back { background:var(--ink-3); color:var(--text-1); }
.tour-back:hover { background:var(--line-1); }
.tour-next.primary { background:var(--blue); color:#fff; }
.tour-next.primary:hover { background:#1860c4; }

/* themed confirm / choice dialogs (replace native confirm/alert) */
.dlg-backdrop {
  position:fixed; inset:0; z-index:100; display:grid; place-items:center;
  background:rgba(7,10,18,.72); backdrop-filter:blur(6px); padding:24px;
  animation:dlgFade .14s ease both;
}
@keyframes dlgFade { from { opacity:0; } to { opacity:1; } }
.dlg {
  width:min(440px,94vw); background:var(--ink-1); border:1px solid var(--line-2);
  border-radius:var(--r-lg); box-shadow:0 24px 70px rgba(0,0,0,.55); padding:26px 26px 22px;
  animation:dlgPop .17s cubic-bezier(.4,0,.2,1) both;
}
@keyframes dlgPop { from { opacity:0; transform:scale(.96) translateY(8px); } to { opacity:1; transform:none; } }
.dlg-title { margin:0 0 10px; font-size:19px; font-weight:800; color:var(--text-1); letter-spacing:-0.01em; }
.dlg-msg { margin:0 0 22px; font-size:14px; line-height:1.6; color:var(--text-2); }
.dlg-actions { display:flex; justify-content:flex-end; gap:10px; }
.dlg-btn {
  border:none; border-radius:var(--r-pill); padding:11px 22px; font-size:14px; font-weight:700;
  font-family:inherit; cursor:pointer; background:var(--ink-3); color:var(--text-1);
}
.dlg-btn:hover { background:var(--line-1); }
.dlg-btn.primary { background:var(--blue); color:#fff; }
.dlg-btn.primary:hover { background:#1860c4; }
.dlg-btn.danger { background:#e0384a; color:#fff; }
.dlg-btn.danger:hover { background:#c62f40; }
/* multi-choice list */
.dlg-choices { display:flex; flex-direction:column; gap:10px; margin-bottom:18px; }
.dlg-choice {
  display:flex; flex-direction:column; align-items:flex-start; gap:3px; text-align:left;
  padding:14px 16px; border:1.5px solid var(--line-1); border-radius:var(--r-md);
  background:var(--ink-2); color:var(--text-1); cursor:pointer; font-family:inherit;
  transition:border-color .14s, background .14s, transform .08s;
}
.dlg-choice:hover { border-color:var(--line-2); transform:translateY(-1px); }
.dlg-choice.primary { border-color:var(--blue); background:rgba(28,111,224,.1); }
.dlg-choice.primary:hover { background:rgba(28,111,224,.16); }
.dlg-choice.danger { border-color:rgba(224,56,74,.5); }
.dlg-choice.danger:hover { background:rgba(224,56,74,.12); }
.dlg-choice-label { font-size:15px; font-weight:700; }
.dlg-choice-hint { font-size:12.5px; color:var(--text-3); line-height:1.45; }
.dlg-field { margin-bottom:20px; }
.dlg-input {
  width:100%; padding:13px 15px; border:1.5px solid var(--line-1); border-radius:var(--r-md);
  background:var(--ink-2); color:var(--text-1); font-size:15px; font-family:inherit; resize:vertical;
}
.dlg-input:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px rgba(28,111,224,.18); }
[dir="rtl"] .dlg-actions { justify-content:flex-start; }
[dir="rtl"] .dlg-choice { text-align:right; align-items:flex-end; }

/* fan QR dialog */
.qr-backdrop {
  position:fixed; inset:0; z-index:80; display:grid; place-items:center;
  background:rgba(7,10,18,.72); backdrop-filter:blur(6px); padding:24px;
}
.qr-modal {
  position:relative; background:var(--ink-1); border:1px solid var(--line-1); border-radius:var(--r-lg);
  width:min(420px,94vw); padding:28px; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.5);
}
.qr-close { position:absolute; top:14px; right:14px; background:none; border:none; color:var(--text-3); font-size:24px; cursor:pointer; padding:0; }
.qr-h3 { margin:0 0 8px; font-size:20px; font-weight:700; color:var(--text-1); }
.qr-lead { margin:0 0 20px; font-size:13px; line-height:1.55; color:var(--text-2); }
.qr-img { width:240px; height:240px; border-radius:var(--r-md); background:#fff; padding:12px; }
.qr-url { margin:14px 0 18px; font-family:var(--font-data); font-size:12px; color:var(--text-3); word-break:break-all; }
.qr-actions { display:flex; gap:10px; }
.qr-actions button { flex:1; }
[dir="rtl"] .qr-close { right:auto; left:14px; }

/* ---- RTL: mirror the editor layout for Arabic ---- */
[dir="rtl"] .panel { border-left:none; border-right:1px solid var(--line-1); }
[dir="rtl"] .tool-rail { border-right:none; border-left:1px solid var(--line-1); }
[dir="rtl"] .panel-section h4 { flex-direction:row-reverse; text-align:right; }
[dir="rtl"] .panel-section h4::before { /* accent tick moves to the right of the title */ }
[dir="rtl"] .h4-tag { margin-left:0; margin-right:auto; }
[dir="rtl"] .panel-head { flex-direction:row-reverse; }
[dir="rtl"] .color-well-row { flex-direction:row-reverse; }
[dir="rtl"] .fg-meta { text-align:right; }
[dir="rtl"] .tool-bar { direction:rtl; }
[dir="rtl"] label { flex-direction:row-reverse; }
[dir="rtl"] .panel-orient { text-align:right; }
[dir="rtl"] .feed-card-title, [dir="rtl"] .feed-card-by, [dir="rtl"] .mod-info { text-align:right; }
[dir="rtl"] footer { direction:rtl; }`;
