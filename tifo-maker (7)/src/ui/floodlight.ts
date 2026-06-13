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
  ink0: '#0B0C0F',
  ink1: '#121419',
  ink2: '#181B22',
  ink3: '#20242E',
  canvasPit: '#07080A',
  line1: '#262B36',
  line2: '#343B49',
  text1: '#E9E7E2',
  text2: '#A2A7B3',
  text3: '#6E7480',
  flare: '#FF5C38',
  flareHover: '#FF7252',
  flarePress: '#C2401F',
  flareInk: '#2B0D04',
  violet: '#8B7CFF',
  violetPress: '#5B4CCF',
  violetInk: '#1A1438',
  ok: '#3DD68C',
  warn: '#F5B43C',
  danger: '#F0455A',
} as const;

export const FLOODLIGHT_CSS = `
:root {
  --ink-0:#0B0C0F; --ink-1:#121419; --ink-2:#181B22; --ink-3:#20242E;
  --canvas-pit:#07080A; --line-1:#262B36; --line-2:#343B49;
  --text-1:#E9E7E2; --text-2:#A2A7B3; --text-3:#6E7480;
  --flare:#FF5C38; --flare-hover:#FF7252; --flare-press:#C2401F; --flare-ink:#2B0D04;
  --violet:#8B7CFF; --violet-press:#5B4CCF; --violet-ink:#1A1438;
  --ok:#3DD68C; --warn:#F5B43C; --danger:#F0455A;
  --glow-flare:0 0 0 1px rgba(255,92,56,.55), 0 0 14px rgba(255,92,56,.28);
  --ring-focus:0 0 0 2px var(--ink-0), 0 0 0 4px rgba(139,124,255,.7);
  --r-sm:6px; --r-md:8px; --r-lg:10px;
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
  height:44px; flex:0 0 44px; display:flex; align-items:center; gap:14px;
  padding:0 14px; background:var(--ink-1); border-bottom:1px solid var(--line-1);
}
.brand { font-weight:500; letter-spacing:.05em; font-size:13px; }
.brand b { color:var(--flare); font-weight:500; }
.doc-title {
  background:transparent; border:1px solid transparent; border-radius:var(--r-sm);
  color:var(--text-2); font:inherit; padding:4px 8px; max-width:240px;
}
.doc-title:hover { border-color:var(--line-1); }
.doc-title:focus { outline:none; box-shadow:var(--ring-focus); color:var(--text-1); }
.topbar-center { flex:1; display:flex; justify-content:center; }
.topbar-right { display:flex; align-items:center; gap:10px; }

/* segmented Design/Stadium toggle — the signature control */
.segmented { display:flex; background:var(--ink-2); border:1px solid var(--line-1); border-radius:var(--r-md); overflow:hidden; }
.segmented button {
  border:none; background:transparent; color:var(--text-2);
  padding:6px 16px; font:inherit; cursor:pointer;
}
.segmented button.active { background:var(--flare); color:var(--flare-ink); font-weight:500; box-shadow:var(--glow-flare); }

.save-dot { width:7px; height:7px; border-radius:50%; background:var(--ok); }
.avatar { width:24px; height:24px; border-radius:50%; background:var(--violet); color:var(--violet-ink); display:flex; align-items:center; justify-content:center; font-weight:500; font-size:11px; }

/* ---- main 3-column body ---- */
.workspace { flex:1; min-height:0; display:flex; }
.tool-rail {
  width:48px; flex:0 0 48px; background:var(--ink-1); border-right:1px solid var(--line-1);
  display:flex; flex-direction:column; align-items:center; padding:8px 0; gap:4px;
}
.tool-rail .sep { width:24px; height:1px; background:var(--line-1); margin:4px 0; }
.tool {
  width:34px; height:34px; border-radius:var(--r-md); border:1px solid transparent;
  background:transparent; color:var(--text-2); cursor:pointer;
  display:flex; align-items:center; justify-content:center; transition:background .12s, color .12s;
}
.tool:hover { background:var(--ink-3); color:var(--text-1); }
.tool.active { background:var(--flare); color:var(--flare-ink); box-shadow:var(--glow-flare); }
.tool:focus-visible { outline:none; box-shadow:var(--ring-focus); }

.stage { flex:1; min-width:0; display:flex; flex-direction:column; }

/* contextual tool bars */
.tool-bar {
  display:flex; align-items:center; gap:12px; flex-wrap:wrap;
  padding:8px 14px; background:var(--ink-1); border-bottom:1px solid var(--line-1);
  font-size:12px; color:var(--text-2);
}
.tool-bar .hint { color:var(--text-3); font-size:11px; }

.canvas-wrap { flex:1; min-height:0; position:relative; background:var(--canvas-pit); }
#canvas-host, #preview-host { position:absolute; inset:0; }
#canvas-host canvas, #preview-host canvas { display:block; }

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

/* ---- right properties panel ---- */
.panel {
  width:264px; flex:0 0 264px; background:var(--ink-1); border-left:1px solid var(--line-1);
  display:flex; flex-direction:column; overflow-y:auto;
}
.panel.collapsed { width:28px; flex-basis:28px; }
.panel.collapsed .panel-section, .panel.collapsed .panel-head span { display:none; }
.panel-head { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--line-1); }
.panel-head span { font-size:11px; color:var(--text-3); text-transform:uppercase; letter-spacing:.06em; }
.panel-section { padding:12px; border-bottom:1px solid var(--line-1); }
.panel-section h4 { margin:0 0 8px; font-size:11px; font-weight:500; color:var(--text-3); text-transform:uppercase; letter-spacing:.06em; }

/* swatches with live counts */
.swatch-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
.swatch-cell { display:flex; flex-direction:column; align-items:center; gap:3px; }
.swatch {
  width:100%; aspect-ratio:1; border-radius:var(--r-sm); border:2px solid transparent;
  cursor:pointer; padding:0; min-width:0;
}
.swatch.active { border-color:var(--text-1); outline:1px solid var(--flare); outline-offset:0; }
.swatch-count { font-size:10px; color:var(--text-3); font-variant-numeric:tabular-nums; }

/* chips (tier filter, scope) */
.chips { display:flex; gap:5px; flex-wrap:wrap; }
.chip {
  padding:4px 10px; border-radius:var(--r-sm); border:1px solid var(--line-1);
  background:transparent; color:var(--text-2); font:inherit; font-size:12px; cursor:pointer;
}
.chip:hover { border-color:var(--line-2); color:var(--text-1); }
.chip.active { background:rgba(139,124,255,.14); border-color:var(--violet); color:#C9C2FF; }

/* history list */
.history { display:flex; flex-direction:column; gap:4px; max-height:140px; overflow-y:auto; }
.history-item { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); padding:2px 0; }
.history-item.faded { color:var(--text-3); }

/* ---- generic controls ---- */
button {
  background:transparent; color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:6px 11px; font:inherit; cursor:pointer; transition:background .12s;
}
button:hover { background:var(--ink-3); }
button:active { transform:scale(0.98); }
button:disabled { opacity:.4; cursor:default; pointer-events:none; }
button.primary { background:var(--flare); color:var(--flare-ink); border-color:var(--flare); font-weight:500; }
button.primary:hover { background:var(--flare-hover); }
button.primary:active { background:var(--flare-press); }
button.danger { background:#2B1216; border-color:var(--danger); color:#F58A96; }
button:focus-visible { outline:none; box-shadow:var(--ring-focus); }

select {
  background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-1);
  border-radius:var(--r-md); padding:6px 8px; font:inherit; font-size:12px;
}
select:focus-visible { outline:none; box-shadow:var(--ring-focus); }

input[type="text"] {
  background:var(--ink-3); color:var(--text-1); border:1px solid var(--line-2);
  border-radius:var(--r-md); padding:6px 10px; font:inherit; width:200px;
}
input[type="text"]::placeholder { color:var(--text-3); }
input[type="text"]:focus-visible { outline:none; box-shadow:var(--ring-focus); }
#text-input { text-transform:uppercase; }

label { color:var(--text-2); display:inline-flex; align-items:center; gap:6px; font-size:12px; }

/* range slider — 3px track, 12px thumb, flare fill */
input[type="range"] { -webkit-appearance:none; appearance:none; height:12px; background:transparent; cursor:pointer; }
input[type="range"]::-webkit-slider-runnable-track { height:3px; border-radius:2px; background:var(--ink-3); }
input[type="range"]::-moz-range-track { height:3px; border-radius:2px; background:var(--ink-3); }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; margin-top:-5px; width:12px; height:12px; border-radius:50%; background:var(--text-1); border:1px solid var(--line-2); }
input[type="range"]::-moz-range-thumb { width:12px; height:12px; border:1px solid var(--line-2); border-radius:50%; background:var(--text-1); }
input[type="range"]:focus-visible { outline:none; }
input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow:var(--ring-focus); }

input[type="checkbox"] { accent-color:var(--violet); }

/* groups inside bars */
.group { display:flex; align-items:center; gap:8px; }
.group + .group { padding-left:12px; border-left:1px solid var(--line-1); }

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
@media (max-width: 1099px) {
  .tool { width:42px; height:42px; }
  .tool-rail { width:54px; flex-basis:54px; }
  .panel {
    position:absolute; right:0; top:0; bottom:0; z-index:20;
    transform:translateX(100%); transition:transform .18s ease;
    box-shadow:-8px 0 24px rgba(0,0,0,.4);
  }
  .panel.open { transform:translateX(0); }
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
  width:100%; aspect-ratio:5/1; object-fit:cover; background:var(--canvas-pit);
  image-rendering:pixelated; cursor:pointer; display:block;
}
.feed-thumb-empty { aspect-ratio:5/1; }
.feed-card-body { padding:10px 12px 12px; }
.feed-card-title { font-size:14px; font-weight:500; color:var(--text-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.feed-card-by { font-size:12px; color:var(--text-3); margin-top:2px; }
.feed-open { margin:0 12px 12px; padding:8px 0; font-size:13px; }
`;
