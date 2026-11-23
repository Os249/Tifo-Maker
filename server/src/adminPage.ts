/**
 * Admin analytics dashboard — served at /admin (+ /admin.js).
 *
 * Why a server-rendered string and not a Vite page: the site CSP is strict
 * (script-src 'self' only since performance plan P3.1, connect-src 'self', no CDNs, no inline
 * <script>). So the shell carries NO inline script — it loads /admin.js as a
 * same-origin ES module — and every chart is hand-drawn SVG with zero external
 * libraries. Inline <style> is allowed (style-src includes 'unsafe-inline').
 *
 * Security model: this page is public HTML/JS. ALL protection is server-side —
 * /api/admin/overview, /api/admin/traffic and /api/funnel each require an admin
 * token. A non-admin who opens /admin sees a login form and can fetch nothing.
 *
 * The two exported strings are embedded in template literals, so they must not
 * contain backticks or ${...}. The script deliberately uses single quotes and
 * string concatenation throughout to honour that.
 */

/**
 * The dashboard shell.
 *
 * `unlocked` decides whether the page carries the dashboard module at all. It
 * used to always carry it, so /admin.js — nine hundred lines naming every
 * /api/admin/* endpoint the server has — was readable by anyone who typed the
 * URL. Every one of those endpoints is gated, so this was a map rather than a
 * key; but handing a stranger the map is still the first step of everything
 * that comes after, and there is no reason to.
 *
 * The unlock module is always served, because the password form has to exist
 * before there is anything to prove. It is a separate file rather than an
 * inline script because the CSP forbids inline script, and duplicating twenty
 * lines of fetch-and-reload is a better trade than relaxing that.
 */
export function adminHtml(unlocked: boolean): string {
  return ADMIN_HTML_HEAD + (unlocked ? '<script type="module" src="/admin.js"></script>\n' : '') + ADMIN_HTML_TAIL;
}

const ADMIN_HTML_HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>TifoMaker: Admin</title>
<style>
  :root{
    /* The site's night palette (src/ui/tokens.css), written out: this page is
       served on its own and imports nothing. */
    --bg:#0B1120; --bg2:#131B2D; --bg3:#1E2942; --line:#243049; --line2:#33415C;
    --tx:#F1F4FB; --mut:#A6B0C8; --dim:#8690A7;
    --green:#3fb950; --blue:#58a6ff; --gold:#d29922; --red:#f85149; --violet:#a371f7; --teal:#39c5cf;
  }
  *{ box-sizing:border-box; }
  html,body{ overflow-x:hidden; }
  body{ margin:0; background:var(--bg); color:var(--tx); font:14px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }

  header{ position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
          padding:11px 20px; background:rgba(11,17,32,.9); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); }
  .brand{ font-weight:700; font-size:15px; letter-spacing:.2px; white-space:nowrap; }
  .brand span{ font-weight:400; color:var(--mut); }
  .ctrls{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .muted{ color:var(--mut); } .dim{ color:var(--dim); }
  select,button{ font:inherit; font-size:13px; color:var(--tx); background:var(--bg3); border:1px solid var(--line); border-radius:8px; padding:6px 11px; cursor:pointer; transition:border-color .12s,background .12s; }
  button:hover,select:hover{ border-color:var(--line2); background:#243049; }
  button.primary{ background:#1C6FE0; color:#fff; border-color:#1C6FE0; font-weight:600; }
  button.primary:hover{ background:#155EC4; }

  /* The menu. It was a row of eleven peer tabs; it is now a sidebar in
     groups, one short screen per question, and a number beside a name only
     ever means "this is waiting for you". On a phone it is a row again. */
  .shell{ display:grid; grid-template-columns:216px minmax(0,1fr); align-items:start; }
  .tabs{ position:sticky; top:49px; z-index:19; display:flex; flex-direction:column; gap:2px;
         padding:14px 10px 24px; max-height:calc(100vh - 49px); overflow-y:auto; border-right:1px solid var(--line); }
  .tabs .grp{ font-size:10.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--dim); padding:14px 12px 5px; }
  .tab{ flex:0 0 auto; display:inline-flex; align-items:center; gap:7px; padding:7px 14px; border-radius:999px;
        border:1px solid transparent; background:transparent; color:var(--mut); font-size:13px; font-weight:600;
        cursor:pointer; white-space:nowrap; min-height:34px; }
  .tabs .tab{ width:100%; justify-content:space-between; border-radius:8px; padding:7px 12px; text-align:left; }
  .tab:hover{ background:var(--bg3); color:var(--tx); border-color:var(--line); }
  .tab[aria-current="true"]{ background:var(--bg3); color:var(--tx); border-color:var(--line2); }
  .tab:focus-visible, button:focus-visible, select:focus-visible, summary:focus-visible, a:focus-visible{ outline:2px solid var(--blue); outline-offset:2px; }
  .tab .pill{ font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; background:var(--line); color:var(--mut); }
  .tab[aria-current="true"] .pill{ background:var(--blue); color:#04203f; }
  @media (max-width: 860px){
    .shell{ display:block; }
    .tabs{ flex-direction:row; gap:4px; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; max-height:none;
           padding:8px 13px; background:rgba(11,17,32,.95); backdrop-filter:blur(10px); border-right:none; border-bottom:1px solid var(--line); }
    .tabs::-webkit-scrollbar{ display:none; }
    .tabs .grp{ display:none; }
    .tabs .tab{ width:auto; border-radius:999px; padding:7px 14px; min-height:44px; }
  }
  /* A figure with its unit, its period and how it is counted. */
  .k-val .k-unit{ font-size:12.5px; font-weight:500; letter-spacing:0; color:var(--mut); margin-left:5px; }
  .k-how{ margin-top:7px; font-size:11.5px; color:var(--mut); line-height:1.55; }
  .k-how summary{ cursor:pointer; color:var(--blue); list-style:none; }
  .k-how summary::-webkit-details-marker{ display:none; }
  /* Steps people move through, each a share of the first. */
  .steps{ display:grid; gap:7px; }
  .step{ display:grid; grid-template-columns:minmax(120px,230px) minmax(0,1fr) minmax(64px,auto); gap:12px; align-items:center; font-size:13px; }
  .step .sbar{ height:11px; border-radius:6px; background:var(--bg3); overflow:hidden; }
  .step .sbar i{ display:block; height:100%; border-radius:6px; background:var(--blue); }
  .step .sbar i.unk{ background:repeating-linear-gradient(90deg, var(--line2) 0 6px, transparent 6px 12px); }
  .step .sn{ text-align:right; font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
  .step .sn span{ font-weight:400; color:var(--dim); font-size:11.5px; margin-left:5px; }
  @media (max-width: 640px){ .step{ grid-template-columns:1fr auto; } .step .sbar{ grid-column:1 / -1; order:3; } }
  /* The list of what is waiting, on Today. */
  .todo{ background:var(--bg2); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .todo a{ display:flex; align-items:center; gap:12px; padding:11px 15px; border-bottom:1px solid var(--line); color:inherit; text-decoration:none; min-height:44px; }
  .todo a:last-child{ border-bottom:none; }
  .todo a:hover{ background:var(--bg3); }
  .todo .tn{ font-size:17px; font-weight:700; min-width:30px; font-variant-numeric:tabular-nums; }
  .todo a.clear .tn{ color:var(--dim); font-weight:600; }
  .todo .tl{ flex:1; min-width:0; }
  .todo .tg{ font-size:12px; color:var(--blue); white-space:nowrap; }
  .tab .pill.warn{ background:var(--gold); color:#2a1d00; }
  .lede{ color:var(--mut); font-size:13px; margin:14px 0 0; max-width:74ch; }

  main{ max-width:1180px; margin:0; padding:16px 24px 64px; min-width:0; }
  h2.sec{ font-size:12px; text-transform:uppercase; letter-spacing:.09em; color:var(--mut); margin:30px 0 11px; font-weight:600; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  h2.sec:first-child{ margin-top:14px; }
  h2.sec .hint{ text-transform:none; letter-spacing:0; font-weight:400; color:var(--dim); font-size:11.5px; }

  /* Third-level headings inside a group. The page used to be nine peer sections
     with no hierarchy, so nothing looked more important than anything else. */
  h3.sub{ font-size:12.5px; color:var(--tx); margin:20px 0 9px; font-weight:600; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  h3.sub .hint{ font-weight:400; color:var(--dim); font-size:11.5px; }

  /* The header strip: the one row that answers "is it growing, and where from"
     before any scrolling. */
  .strip{
    display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
    gap:1px; background:var(--line); border:1px solid var(--line);
    border-radius:12px; overflow:hidden; margin:14px 0 4px;
  }
  .strip-cell{ background:var(--bg2); padding:15px 16px 14px; }
  .strip-val{ font-size:26px; font-weight:700; line-height:1.1; letter-spacing:-.01em; }
  .strip-lab{ font-size:12px; color:var(--tx); margin-top:3px; }
  .strip-sub{ font-size:11px; color:var(--dim); margin-top:5px; line-height:1.5; }
  .fbrow{ padding:13px 0; border-bottom:1px solid var(--line); }
  .fbrow:last-child{ border-bottom:none; padding-bottom:2px; }
  .fbtop{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:6px; }
  .fbkind{ font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:20px; letter-spacing:.03em; }
  .fbwhen{ font-size:11px; color:var(--dim); }
  .fbmail{ font-size:11px; color:var(--blue); margin-inline-start:auto; text-decoration:none; }
  .fbmail:hover{ text-decoration:underline; }
  .fbmail.dim{ color:var(--dim); }
  .fbmsg{ margin:0 0 5px; font-size:13px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
  .fbsteps{ margin:0 0 5px; font-size:12px; line-height:1.6; color:var(--mut); white-space:pre-wrap; }
  .fbctx{ margin:0; font-size:10.5px; color:var(--dim); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-word; }
  .flab .fsub{ display:block; font-size:10.5px; color:var(--dim); font-weight:400; line-height:1.4; margin-top:1px; }
  .fnum .flost{ display:inline-block; margin-left:7px; font-size:11px; color:var(--red); font-weight:600; }
  @media (max-width: 640px){
    .strip{ grid-template-columns:repeat(2, 1fr); }
    .strip-val{ font-size:22px; }
  }

  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(148px,1fr)); gap:10px; }
  .grid.two{ grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .grid.three{ grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
  .card{ background:var(--bg2); border:1px solid var(--line); border-radius:12px; padding:14px 15px; min-width:0; }
  .k-val{ font-size:25px; font-weight:700; line-height:1.15; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .k-lab{ color:var(--mut); font-size:12px; margin-top:3px; }
  .k-sub{ font-size:11px; margin-top:6px; color:var(--green); }
  .k-sub.n{ color:var(--dim); }
  /* A queue card is a door, not a readout: it says where the work is handled. */
  a.card{ display:block; text-decoration:none; color:inherit; transition:border-color .12s, background .12s; }
  a.card:hover{ border-color:var(--blue); background:var(--bg3, var(--bg2)); }
  a.card .k-go{ font-size:11px; margin-top:6px; color:var(--blue); }
  a.card.clear{ opacity:.55; }

  .lt{ font-size:12.5px; font-weight:600; color:var(--tx); margin:0 0 2px; }
  .lc{ color:var(--dim); font-size:11px; margin:0 0 11px; }
  .row{ display:grid; grid-template-columns:1fr auto; gap:10px; align-items:center; padding:5px 0; position:relative; }
  .row .bg{ position:absolute; left:0; top:2px; bottom:2px; border-radius:5px; opacity:.16; }
  .row .nm{ position:relative; z-index:1; padding-left:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .row .vv{ position:relative; z-index:1; font-variant-numeric:tabular-nums; font-size:12.5px; color:var(--mut); white-space:nowrap; padding-right:5px; }
  .row .vv b{ color:var(--tx); font-weight:600; }

  /* Wider label column and no capitalize: the rows now carry a real sentence
     plus a one-line explanation, and title-casing turned "Opened the editor"
     into "Opened The Editor". */
  .frow{ display:grid; grid-template-columns:minmax(120px,190px) 1fr minmax(96px,124px); align-items:center; gap:12px; padding:7px 0; }
  .flab{ font-size:13px; line-height:1.35; min-width:0; }
  @media (max-width: 640px){
    .frow{ grid-template-columns:1fr minmax(80px,104px); row-gap:4px; }
    .fbar{ grid-column:1 / -1; }
  }
  .fbar{ background:var(--bg3); border-radius:6px; height:13px; overflow:hidden; }
  .ffill{ background:var(--green); height:100%; border-radius:6px; }
  .fnum{ text-align:right; font-variant-numeric:tabular-nums; font-size:12.5px; }

  table{ width:100%; border-collapse:collapse; }
  th{ text-align:left; color:var(--mut); font-weight:600; font-size:11.5px; padding:5px 7px; border-bottom:1px solid var(--line); }
  td{ padding:7px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; font-size:13px; }
  tr:last-child td{ border-bottom:none; }
  td.name,th.name{ max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .note{ color:var(--dim); font-size:12px; margin:9px 0 0; line-height:1.6; }
  .callout{ background:var(--bg2); border:1px solid var(--line); border-left:3px solid var(--gold); border-radius:8px; padding:11px 14px; margin:10px 0 0; color:var(--mut); font-size:12.5px; line-height:1.6; }
  .callout.ok{ border-left-color:var(--green); }
  .callout b{ color:var(--tx); }
  .badge{ font-size:11px; padding:2px 9px; border-radius:999px; border:1px solid var(--line); color:var(--mut); white-space:nowrap; }
  .badge.warn{ color:var(--gold); border-color:#4a3c1d; background:#241d0c; }
  .badge.good{ color:var(--green); border-color:#1e4429; background:#0d2213; }
  .empty{ color:var(--dim); font-size:12.5px; margin:0; padding:6px 0; }

  .login-wrap{ min-height:72vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .login{ width:100%; max-width:370px; background:var(--bg2); border:1px solid var(--line); border-radius:14px; padding:24px; }
  .login h1{ font-size:18px; margin:0 0 5px; }
  .login p{ margin:0 0 16px; color:var(--mut); font-size:13px; line-height:1.6; }
  .login label{ display:block; font-size:12px; color:var(--mut); margin:10px 0 5px; }
  .login input{ width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--tx); font:inherit; }
  .login input:focus{ outline:none; border-color:var(--blue); }
  .login button{ width:100%; margin-top:17px; padding:11px; }
  .msg{ min-height:18px; font-size:12px; color:var(--red); margin-top:11px; }
  a{ color:var(--blue); }
  @media (max-width:560px){ main{ padding:12px 13px 48px; } .k-val{ font-size:22px; } }

  /* Security tab. State chips carry a word as well as a colour, so the verdict
     survives colour-blindness and a greyscale screenshot. */
  /* Link builder (Where from). */
  .lb-grid{ display:grid; grid-template-columns:1fr 1fr; gap:9px 12px; margin:10px 0 0; }
  .lb-grid label{ display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--mut); }
  .lb-grid .lb-wide{ grid-column:1 / -1; }
  .lb-grid select, .lb-grid input, .lb-out input{ padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--tx); font:inherit; font-size:13px; min-width:0; }
  .lb-out{ display:flex; gap:8px; margin-top:12px; }
  .lb-out input{ flex:1; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .lb-r{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px solid var(--line); font-size:12.5px; }
  .lb-r:last-child{ border-bottom:none; }
  .lb-rn{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  @media (max-width:560px){ .lb-grid{ grid-template-columns:1fr; } }
  /* Events tab. */
  .ev-card{ margin:12px 0 0; }
  .ev-card .tbl{ margin-top:10px; }
  .ev-reason{ padding:6px 9px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--tx); font:inherit; font-size:12.5px; width:190px; max-width:100%; }
  .lb-grid input:disabled{ opacity:.55; }
  .callout.bad{ border-left-color:var(--red); }
  .callout.bad b{ color:var(--red); }
  .st{ display:inline-block; min-width:52px; text-align:center; font-size:10.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:2px 7px; border-radius:999px; border:1px solid var(--line); color:var(--mut); white-space:nowrap; }
  .st.good{ color:var(--green); border-color:#1e4429; background:#0d2213; }
  .st.warn{ color:var(--gold); border-color:#4a3c1d; background:#241d0c; }
  .st.bad{ color:var(--red); border-color:#5a1d1d; background:#2a0f0f; }
  .st.info{ color:var(--mut); }
  .tagcode{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--teal); }
  td.when{ white-space:nowrap; }
  .scroll{ overflow-x:auto; }
  .scroll table{ min-width:560px; }
  .posture-row{ display:grid; grid-template-columns:112px minmax(140px,220px) 1fr; gap:12px; align-items:start; padding:9px 0; border-bottom:1px solid var(--line); font-size:13px; }
  .posture-row:last-child{ border-bottom:none; }
  .posture-row .pd{ color:var(--mut); line-height:1.55; }
  @media (max-width:640px){ .posture-row{ grid-template-columns:112px 1fr; } .posture-row .pd{ grid-column:1 / -1; } }
  /* Review queues: the work shown where the count is. Each item is a card with
     what a decision needs (a picture, who sent it, when) and its two actions. */
  .qgrid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:10px; }
  .qitem{ display:flex; flex-direction:column; gap:8px; background:var(--bg2); border:1px solid var(--line); border-radius:12px; padding:12px; min-width:0; }
  .qitem.busy{ opacity:.55; pointer-events:none; }
  .qpic{ aspect-ratio:16/10; border-radius:8px; background:var(--bg); border:1px solid var(--line); display:flex; align-items:center; justify-content:center; overflow:hidden; color:var(--dim); font-size:11px; }
  .qpic img{ width:100%; height:100%; object-fit:cover; display:block; }
  .qpic svg{ width:100%; height:100%; display:block; padding:6px; }
  .qname{ font-weight:600; font-size:13.5px; line-height:1.3; overflow-wrap:anywhere; }
  .qmeta{ font-size:11.5px; color:var(--mut); line-height:1.55; overflow-wrap:anywhere; }
  .qmeta b{ color:var(--tx); font-weight:600; }
  .qacts{ display:flex; gap:6px; flex-wrap:wrap; margin-top:auto; }
  .qacts button{ flex:1 1 auto; min-height:34px; }
  button.danger{ color:var(--red); border-color:#5a1d1d; }
  button.danger:hover{ background:#2a0f0f; border-color:var(--red); }
  .qerr{ font-size:11.5px; color:var(--red); min-height:0; }
  .qerr:empty{ display:none; }
  .qhead{ display:flex; align-items:center; gap:8px; margin:20px 0 9px; font-size:12.5px; font-weight:600; }
  .qhead .badge{ font-weight:500; }
  /* AI failures: the reason in words, what to do about it, and the evidence. */
  .why{ display:grid; grid-template-columns:minmax(150px,230px) 1fr auto; gap:4px 14px; align-items:baseline; padding:9px 0; border-bottom:1px solid var(--line); }
  .why:last-child{ border-bottom:none; }
  .why .wl{ font-weight:600; font-size:13px; }
  .why .wf{ color:var(--mut); font-size:12px; line-height:1.5; }
  .why .wn{ font-variant-numeric:tabular-nums; font-size:13px; text-align:right; white-space:nowrap; }
  .why .wn span{ display:block; color:var(--dim); font-size:10.5px; }
  @media (max-width:640px){ .why{ grid-template-columns:1fr auto; } .why .wf{ grid-column:1 / -1; } }
  td.detail{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--mut); white-space:normal; word-break:break-word; min-width:220px; }
  .via{ display:inline-block; margin-inline-start:6px; font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid #4a3c1d; color:var(--gold); }
</style>
</head>
<body>
<header>
  <div class="brand">TifoMaker <span>· Admin</span></div>
  <div class="ctrls" id="ctrls" style="display:none">
    <span id="status" class="dim" style="font-size:12px"></span>
    <span id="mode" class="badge"></span>
    <select id="days" title="Reporting window">
      <option value="7">Last 7 days</option>
      <option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option>
    </select>
    <button id="refresh">Refresh</button>
    <button id="logout">Sign out</button>
  </div>
</header>

<div id="login" class="login-wrap">
  <form class="login" id="login-form">
    <h1>Admin sign in</h1>
    <p>Enter the admin password, the <code>AI_ADMIN_PASSWORD</code> set on the server.</p>
    <label for="p">Admin password</label>
    <input id="p" type="password" autocomplete="current-password">
    <button class="primary" type="submit">Sign in</button>
    <div class="msg" id="msg"></div>
  </form>
</div>

<div class="shell">
<nav id="tabs" class="tabs" style="display:none" aria-label="Dashboard sections"></nav>

<main id="dash" style="display:none">
  <div id="dash-body"></div>
  <p class="note" id="generated"></p>
</main>
</div>

`;

// The unlock module runs AFTER the dashboard module, so that on an unlocked page
// it can see __tifoAdminLoaded and stand down. Module scripts execute in
// document order, so this ordering is the whole mechanism — reversed, both
// modules attach a submit handler to the same form and the login screen flashes
// up on every admin page load.
const ADMIN_HTML_TAIL = `<script type="module" src="/admin-unlock.js"></script>
</body>
</html>`;

/**
 * The unlock form, and nothing else.
 *
 * Deliberately knows one endpoint. On success the server sets an HttpOnly
 * cookie alongside the token, and the reload is what makes the page come back
 * carrying the dashboard module. The token still goes to localStorage because
 * that is what every data request sends as a header — the cookie authorises
 * exactly one thing, fetching a script, and no state-changing request accepts it.
 */
export const ADMIN_UNLOCK_JS = `
var UNLOCK_KEY = 'tifo_ai_unlock_v1';
function el(id){ return document.getElementById(id); }
function have(){ try { return !!localStorage.getItem(UNLOCK_KEY); } catch(e){ return false; } }

/* Already signed in and the dashboard module loaded: leave it alone. */
if (!window.__tifoAdminLoaded) {
  var login = el('login');
  if (login) login.style.display = '';
  var form = el('login-form') || login;
  if (form) form.addEventListener('submit', async function(ev){
    ev.preventDefault();
    var p = el('p').value;
    var msg = el('msg');
    if (!p){ msg.textContent = 'Enter the admin password.'; return; }
    msg.textContent = 'Signing in...';
    var res, data = null;
    try {
      res = await fetch('/api/ai/unlock', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ password: p }) });
      data = await res.json();
    } catch(e){ msg.textContent = 'Could not reach the server.'; return; }
    if (!res.ok || !data || !data.token){
      msg.textContent = 'Wrong password, or no admin password is configured on the server.';
      return;
    }
    try { localStorage.setItem(UNLOCK_KEY, data.token); } catch(e){}
    el('p').value = '';
    location.reload();
  });
  if (have() && !window.__tifoAdminLoaded) {
    /* localStorage says unlocked but the page came back without the dashboard,
       so the cookie has expired. Say so rather than showing a blank shell. */
    var m = el('msg');
    if (m) m.textContent = 'Your session expired. Enter the password again.';
  }
}
`;

export const ADMIN_JS = `
window.__tifoAdminLoaded = true;
var UNLOCK_KEY = 'tifo_ai_unlock_v1';
var currentDays = 30;
/* The free ceiling, for the copy in the AI tab. Mirrors AI_FREE_LIMIT's default
   in server.ts; it is a sentence, not a calculation, so a drift here is cosmetic. */
var AI_LIMIT_HINT = 10;

function el(id){ return document.getElementById(id); }
function getUnlock(){ try { return localStorage.getItem(UNLOCK_KEY); } catch(e){ return null; } }
function setUnlock(t){ try { localStorage.setItem(UNLOCK_KEY, t); } catch(e){} }
function clearUnlock(){ try { localStorage.removeItem(UNLOCK_KEY); } catch(e){} }
function fmt(n){ n = Number(n)||0; return n.toLocaleString(); }
function pct(a, b){ if (!b) return '0%'; return (Math.round((a/b)*1000)/10) + '%'; }
function labelize(s){ return String(s==null?'':s).replace(/_/g,' '); }
function esc(s){ s = String(s==null?'':s); return s.replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function sum(arr){ var t=0; for (var i=0;i<arr.length;i++){ t += Number(arr[i].count)||0; } return t; }

async function api(path){
  var headers = {};
  var t = getUnlock();
  if (t) headers['x-ai-unlock'] = t;
  var res;
  try { res = await fetch(path, { headers: headers }); }
  catch(e){ return { ok:false, status:0, data:null }; }
  var data = null;
  try { data = await res.json(); } catch(e){ data = null; }
  return { ok: res.ok, status: res.status, data: data };
}
/* A reply link that cannot carry extra mail headers. The address comes from an
   anonymous feedback form: "dev@example.com?bcc=attacker@evil&body=..." made the
   reply open with a hidden BCC and the attacker's text. The server now refuses
   such addresses, and this encodes the characters mailto: treats as structure. */
function mailtoHref(addr){ return 'mailto:' + String(addr).replace(/[?&#%]/g, function(c){ return encodeURIComponent(c); }); }
async function post(path, body){
  var res;
  /* The unlock token travels on admin POSTs too. /api/ai/unlock is the one call
     that has no token yet, and sending nothing there is exactly right. */
  var headers = { 'Content-Type':'application/json' };
  var t = getUnlock();
  if (t) headers['x-ai-unlock'] = t;
  try { res = await fetch(path, { method:'POST', headers: headers, body: JSON.stringify(body) }); }
  catch(e){ return { ok:false, status:0, data:null }; }
  var data = null;
  try { data = await res.json(); } catch(e){ data = null; }
  return { ok: res.ok, status: res.status, data: data };
}

/* DELETE with the token and no body: a JSON content-type with an empty body is
   refused by the server's parser, so this sends neither. */
async function del(path){
  var headers = {};
  var t = getUnlock();
  if (t) headers['x-ai-unlock'] = t;
  var res;
  try { res = await fetch(path, { method:'DELETE', headers: headers }); }
  catch(e){ return { ok:false, status:0, data:null }; }
  var data = null;
  try { data = await res.json(); } catch(e){ data = null; }
  return { ok: res.ok, status: res.status, data: data };
}

function hideTabs(){ var n = el('tabs'); if (n) n.style.display = 'none'; }

function showLogin(message){
  el('login').style.display = '';
  el('dash').style.display = 'none';
  el('ctrls').style.display = 'none';
  hideTabs();
  el('msg').textContent = message || '';
}
function showDash(){
  el('login').style.display = 'none';
  el('dash').style.display = '';
  el('ctrls').style.display = 'flex';
}
function setStatus(s){ el('status').textContent = s || ''; }

async function init(){
  if (!getUnlock()){ showLogin(''); return; }
  showDash();
  await loadAll();
}

async function doLogin(ev){
  ev.preventDefault();
  var p = el('p').value;
  if (!p){ el('msg').textContent = 'Enter the admin password.'; return; }
  el('msg').textContent = 'Signing in...';
  var r = await post('/api/ai/unlock', { password:p });
  if (!r.ok || !r.data || !r.data.token){ el('msg').textContent = 'Wrong password, or no admin password is configured on the server.'; return; }
  setUnlock(r.data.token);
  el('msg').textContent=''; el('p').value='';
  showDash();
  await loadAll();
}
async function doLogout(){
  clearUnlock();
  /* Clear the cookie as well, or the page keeps being served the dashboard
     module after signing out. Best-effort: a failed clear must not trap anyone
     on a page they are trying to leave. */
  try { await fetch('/api/ai/unlock', { method:'DELETE' }); } catch(e){}
  location.reload();
}

async function loadAll(){
  setStatus('Loading...');
  EVENTS = null; /* the Events tab fetches its own, when it is next shown */
  var results = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/traffic?days=' + currentDays),
    api('/api/funnel?days=' + currentDays),
    api('/api/admin/shares?days=' + currentDays),
    api('/api/admin/feedback?limit=200'),
    api('/api/admin/ai?days=' + currentDays),
    api('/api/admin/email'),
    api('/api/admin/soc'),
    api('/api/admin/queue'),
    api('/api/admin/pro'),
    api('/api/admin/pro/prices'),
    api('/api/admin/pro/orders'),
    api('/api/admin/pro/subscriptions'),
    api('/api/admin/pro/refund-requests'),
    api('/api/admin/pro/launch'),
    api('/api/admin/pro/members'),
    api('/api/admin/leads?limit=200')
  ]);
  LEADS = results[16].ok && results[16].data ? results[16].data : { error: results[16].status };
  MEMBERS = results[15].ok && results[15].data ? results[15].data : { error: results[15].status };
  LAUNCH = results[14].ok && results[14].data ? results[14].data : { error: results[14].status };
  REQS = results[13].ok && results[13].data ? results[13].data : { error: results[13].status };
  var ov = results[0], tr = results[1], fn = results[2], sh = results[3], fb = results[4], ai = results[5], em = results[6], sc = results[7];
  QUEUE = results[8].ok && results[8].data ? results[8].data : { error: results[8].status };
  PRO = results[9].ok && results[9].data ? results[9].data : { error: results[9].status };
  PRICES = results[10].ok && results[10].data ? results[10].data : { error: results[10].status };
  ORDERS = results[11].ok && results[11].data ? results[11].data : { error: results[11].status };
  SUBS = results[12].ok && results[12].data ? results[12].data : { error: results[12].status };
  if (!ov.ok){
    if (ov.status === 403){ clearUnlock(); showLogin('Wrong or expired password. Sign in again.'); return; }
    setStatus('Failed to load (' + ov.status + ').');
    return;
  }
  render(ov.data || {}, (tr.ok && tr.data) ? tr.data : null, (fn.ok && fn.data) ? fn.data : { steps:[], days: currentDays }, (sh.ok && sh.data) ? sh.data : null, (fb.ok && fb.data) ? fb.data : null, (ai.ok && ai.data) ? ai.data : null, (em.ok && em.data) ? em.data : null, (sc.ok && sc.data) ? sc.data : null);
  setStatus('Updated ' + new Date().toLocaleTimeString());
  loadProFunnel();
}

/* ---------- honest windows ---------- */

/* The panels used to print the window you ASKED for. The visits table only
   started collecting on 9 Sept, so "204 page views - last 30 days" invited you
   to read three days of traffic as a month of it. Every panel now states the
   span it actually covers, derived from the data rather than the request. */
function spanOf(daily){
  if (!daily || !daily.length) return null;
  var days = daily.map(function(d){ return d.day; }).sort();
  return { first: days[0], last: days[days.length-1], count: days.length };
}
function niceDay(iso){
  var p = String(iso).split('-');
  if (p.length !== 3) return iso;
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(p[1])-1] || p[1];
  return Number(p[2]) + ' ' + m;
}
/* "last 30 days" only when the data really reaches back that far. */
function spanLabel(daily, requestedDays){
  var s = spanOf(daily);
  if (!s) return 'no data yet';
  if (s.count >= requestedDays - 1) return 'last ' + requestedDays + ' days';
  return s.count === 1
    ? 'one day of data (' + niceDay(s.first) + ')'
    : s.count + ' days of data (' + niceDay(s.first) + ' to ' + niceDay(s.last) + ')';
}
/* True when a panel is showing less history than the picker implies, which is
   the case worth calling out rather than hiding. */
function isShortSpan(daily, requestedDays){
  var s = spanOf(daily);
  return !!s && s.count < requestedDays - 1;
}

/* Sum a daily series over the last n entries, and over the n before those, so a
   change can be stated against a like-for-like period instead of a guess. */
function periodCompare(daily, key, n){
  if (!daily || daily.length < 2) return null;
  var sorted = daily.slice().sort(function(a,b){ return a.day < b.day ? -1 : 1; });
  var take = Math.min(n, Math.floor(sorted.length / 2));
  if (take < 1) return null;
  var recent = sorted.slice(-take), prior = sorted.slice(-take*2, -take);
  if (!prior.length) return null;
  var sum = function(rows){ var t=0; for (var i=0;i<rows.length;i++) t += Number(rows[i][key])||0; return t; };
  var now = sum(recent), was = sum(prior);
  return { now: now, was: was, days: take, delta: was ? Math.round(((now-was)/was)*1000)/10 : null };
}

/* ---------- components ---------- */

/**
 * A review-queue count that links to where the work is done.
 *
 * These used to open the editor's Moderation and Stadium panels, which only an
 * ADMIN_USERNAMES account can use, from a dashboard opened with the admin
 * password: the operator followed "4 pending stadiums" and was refused. The
 * queues are reviewed in the Library tab now, with this same session.
 */
function queueKpi(label, value, where, href){
  var n = Number(value) || 0;
  return '<a class="card' + (n ? '' : ' clear') + '" href="' + esc(href) + '">'
    + '<div class="k-val">' + fmt(n) + '</div>'
    + '<div class="k-lab">' + esc(label) + '</div>'
    + '<div class="k-go">' + (n ? esc(where) + ' &rarr;' : 'nothing waiting') + '</div></a>';
}

function kpi(label, value, sub, subDim){
  return '<div class="card"><div class="k-val">' + (typeof value === 'string' ? esc(value) : fmt(value)) + '</div>'
    + '<div class="k-lab">' + esc(label) + '</div>'
    + (sub ? '<div class="k-sub' + (subDim ? ' n' : '') + '">' + esc(sub) + '</div>' : '') + '</div>';
}

/* A figure that says what it is: the number, its unit, a name, the period or
   split under it, and (folded) how it is counted. Every headline number on
   this page goes through here, so none is a bare number any more. */
function stat(value, unit, label, sub, how){
  return '<div class="card"><div class="k-val">' + (typeof value === 'string' ? esc(value) : fmt(value))
    + (unit ? '<span class="k-unit">' + esc(unit) + '</span>' : '') + '</div>'
    + '<div class="k-lab">' + esc(label) + '</div>'
    + (sub ? '<div class="k-sub n">' + esc(sub) + '</div>' : '')
    + (how ? '<details class="k-how"><summary>How this is counted</summary>' + esc(how) + '</details>' : '') + '</div>';
}
function plural(n, one, many){ return Number(n) === 1 ? one : many; }

/* One step of a path, as a share of the first. "unknown" draws a hatched bar
   and says so, for a step nobody recorded: a guess would look like a number. */
function stepRow(label, n, top, sub, unknown){
  var w = unknown ? 100 : (top ? Math.max(1.5, Math.min(100, n / top * 100)) : 0);
  return '<div class="step"><span>' + esc(label) + (sub ? '<br><span class="dim" style="font-size:11.5px">' + esc(sub) + '</span>' : '') + '</span>'
    + '<span class="sbar"><i' + (unknown ? ' class="unk"' : '') + ' style="width:' + w.toFixed(1) + '%"></i></span>'
    + '<span class="sn">' + (unknown ? '<span>not recorded</span>' : fmt(n) + (top && n !== top ? '<span>' + pct(n, top) + '</span>' : '')) + '</span></div>';
}

/* Today's date in Riyadh, as YYYY-MM-DD: the day the growth charts end on. */
function riyadhDay(ms){
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  catch(e){ return new Date(ms).toISOString().slice(0, 10); }
}
/* A per-day series with every day in it. The queries only return days that had
   something, and the chart drew them side by side: a quiet week vanished and
   "latest day" was the last busy one. Days with nothing are zeros here. */
function fillDays(points, days){
  var by = {}, i;
  for (i = 0; i < (points || []).length; i++) by[points[i].day] = Number(points[i].count) || 0;
  var out = [], now = Date.now();
  for (i = days - 1; i >= 0; i--){
    var d = riyadhDay(now - i * 86400000);
    out.push({ day: d, count: by[d] || 0 });
  }
  return out;
}

var SOURCE_LABEL = {
  search:'Search engines', social:'Social media', ai:'AI assistants',
  referral:'Other websites', campaign:'Your tagged links', shared:'Shared by visitors', direct:'Direct / QR / app', internal:'Internal'
};
var SOURCE_COLOR = {
  search:'#3fb950', social:'#a371f7', ai:'#39c5cf',
  referral:'#58a6ff', campaign:'#d29922', shared:'#f778ba', direct:'#8b949e', internal:'#6b7480'
};

/* Horizontal bar list. items: [{key, visits, visitors}] */
function barList(title, caption, items, color, mapLabel){
  var html = '<div class="card"><p class="lt">' + esc(title) + '</p><p class="lc">' + esc(caption) + '</p>';
  if (!items || !items.length){ return html + '<p class="empty">Nothing recorded yet.</p></div>'; }
  var max = 0, i;
  for (i=0;i<items.length;i++){ if ((Number(items[i].visits)||0) > max) max = Number(items[i].visits)||0; }
  if (!max) max = 1;
  for (i=0;i<items.length;i++){
    var it = items[i];
    var name = mapLabel ? (mapLabel[it.key] || labelize(it.key)) : it.key;
    var w = Math.max(1.5, (Number(it.visits)||0) / max * 100);
    var c = (color === 'source') ? (SOURCE_COLOR[it.key] || '#58a6ff') : color;
    html += '<div class="row">'
      + '<div class="bg" style="width:' + w.toFixed(1) + '%;background:' + c + '"></div>'
      + '<div class="nm" title="' + esc(name) + '">' + esc(name) + '</div>'
      + '<div class="vv"><b>' + fmt(it.visits) + '</b></div>'
      + '</div>';
  }
  return html + '</div>';
}

/* Two-series line chart (visits + unique visitors) over the daily array. */
function trafficChart(daily){
  var W=560, H=140, padX=6, padY=10;
  if (!daily || !daily.length){
    return '<div class="card"><p class="lt">Per day</p><p class="empty">No traffic recorded yet.</p></div>';
  }
  // One point is not a line. Drawing it produced a triangle sloping up from
  // zero, which reads as growth that has not been measured.
  if (daily.length < 2){
    return '<div class="card"><p class="lt">Visits per day</p>'
      + '<p class="lc">' + esc(niceDay(daily[0].day)) + '</p>'
      + '<p class="empty">One day of data so far, so there is no trend to draw yet. '
      + fmt(daily[0].visits) + ' visits from ' + fmt(daily[0].visitors) + ' people.</p></div>';
  }
  var max=1, i;
  for (i=0;i<daily.length;i++){
    if ((Number(daily[i].visits)||0) > max) max = Number(daily[i].visits)||0;
  }
  var n=daily.length;
  function series(field, close){
    var pts='';
    for (var j=0;j<n;j++){
      var x = (n===1) ? (W/2) : (padX + (j/(n-1))*(W-2*padX));
      var y = (H-padY) - ((Number(daily[j][field])||0)/max)*(H-2*padY);
      pts += (j? ' ':'') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    if (close) return padX + ',' + (H-padY) + ' ' + pts + ' ' + (n===1?(W/2):(W-padX)) + ',' + (H-padY);
    return pts;
  }
  var totalV=0, i2;
  for (i2=0;i2<n;i2++){ totalV += Number(daily[i2].visits)||0; }
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="140" preserveAspectRatio="none" role="img">'
    + '<polygon fill="#3fb950" opacity="0.11" points="' + series('visits', true) + '"></polygon>'
    + '<polyline fill="none" stroke="#3fb950" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' + series('visits', false) + '"></polyline>'
    + '<polyline fill="none" stroke="#58a6ff" stroke-width="1.6" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round" points="' + series('visitors', false) + '"></polyline>'
    + '</svg>';
  var first = daily[0].day, last = daily[n-1].day;
  return '<div class="card"><p class="lt">Per day <span class="dim" style="font-weight:400">: ' + fmt(totalV) + ' page views, busiest day ' + fmt(max) + '</span></p>'
    + '<p class="lc"><span style="color:#3fb950">&#9632;</span> page views &nbsp; <span style="color:#58a6ff">&#9632;</span> visitors &nbsp;&middot;&nbsp; days are UTC days (03:00 to 03:00 in Riyadh); the first and last are part days</p>'
    + svg
    + '<p class="lc" style="margin:5px 0 0;display:flex;justify-content:space-between">' + esc(first) + '<span>' + esc(last) + '</span></p></div>';
}

function lineChart(points, color){
  var W=300, H=68, pad=5;
  if (!points || !points.length) return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="68"></svg>';
  var max=1, i;
  for (i=0;i<points.length;i++){ if ((Number(points[i].count)||0) > max) max = Number(points[i].count)||0; }
  var n=points.length, pts='';
  for (i=0;i<n;i++){
    var x = (n===1) ? (W/2) : (pad + (i/(n-1))*(W-2*pad));
    var y = (H-pad) - ((Number(points[i].count)||0)/max)*(H-2*pad);
    pts += (i? ' ':'') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  var areaPts = pad + ',' + (H-pad) + ' ' + pts + ' ' + (n===1?(W/2):(W-pad)) + ',' + (H-pad);
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="68" preserveAspectRatio="none">'
    + '<polygon fill="' + color + '" opacity="0.12" points="' + areaPts + '"></polygon>'
    + '<polyline fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' + pts + '"></polyline>'
    + '</svg>';
}
function chartCard(title, points, color, lastName){
  var total = sum(points||[]);
  var last = (points && points.length) ? (Number(points[points.length-1].count)||0) : 0;
  return '<div class="card"><p class="lt">' + esc(title) + '</p>'
    + '<p class="lc">' + fmt(total) + ' in the period · ' + fmt(last) + ' ' + esc(lastName || 'on the last day with any') + '</p>'
    + lineChart(points, color) + '</div>';
}

/* The rows used to print the raw event name: "Paint First", "View 3d",
   "Account Prompt". Those are the names the code uses, not what happened to a
   person, and you had to remember which was which. */
var FUNNEL_STEP = {
  landed:         ['Opened the editor',      'arrived on /app'],
  project_created:['Created a project',      'named it and picked a stadium'],
  paint_first:    ['Painted something',      'first brush stroke'],
  view_3d:        ['Looked at it in 3D',     'opened the stadium or split view'],
  draft_restored: ['Came back to their work','their draft was still here on a later visit'],
  save_clicked:   ['Pressed Save',           ''],
  save_local:     ['Kept it in the browser', 'saved without an account'],
  account_prompt: ['Saw the account offer',  'shown only after a save worked'],
  auth_opened:    ['Opened the sign-up form',''],
  signed_up:      ['Created an account',     ''],
  draft_claimed:  ['Moved it to the account','the work survived the sign-up'],
  published:      ['Published it',           'visible in the community'],
  exported:       ['Exported a PDF or CSV',  'the production files'],
  view_banner:    ['Opened the Banner view', ''],
  post_opened:    ['Opened Post it',         'the picture of their tifo, ready to post'],
  shared:         ['Shared it',              'a share button, the phone share sheet or copy link'],
  guide_started:  ['Started the guide',      'the guided first tifo, on a first project'],
  guide_done:     ['Followed it to Post it', 'all four steps'],
  guide_free:     ['Left it for Free mode',  'the whole editor, part way through'],
  ai_cta:         ['Pressed Generate with AI','on the Projects page'],
  ai_bar:         ['Asked the AI from the canvas bar','in the editor'],
  template_cta:   ['Pressed Use as template','on the home page'],
  pro_viewed:     ['Opened the Pro page','/pro'],
  event_view:     ['Opened a tifo event','its page'],
  event_enter:    ['Entered a tifo event','one tifo per account'],
  event_vote:     ['Voted in a tifo event','for an entry'],
  pro_limit:      ['Met a Pro limit card','an allowance used up'],
  pro_notify:     ['Pressed Tell me when Pro opens','from before Pro was on sale'],
  pro_ask_seen:   ['Asked in the editor','the founding-fans card, once'],
  pro_price:      ['Answered the price question','on /pro or the card in the editor, before Pro was on sale'],
  pro_checkout:   ['Pressed Get Pro','sent to Moyasar to pay'],
  pro_paid:       ['Came back with Pro on','paid'],
  gift_accepted:  ['Accepted the 7-day gift','Pro for 7 days'],
  cutout_used:    ['Got a smart cut-out','a picture lifted out'],
  export_sheet:   ['Saw the export sheet','their tifo had Pro items'],
  export_free:    ['Exported without Pro items','the free version'],
  pro_offer_post:    ['Saw Pro on Post it','the Pro versions row'],
  pro_offer_share:   ['Saw Pro on the share dialog','the row to the Pro versions'],
  pro_offer_export:  ['Saw a Pro offer on the export sheet','their tifo had Pro items'],
  pro_offer_page:    ['Saw the Pro page on sale','with the price'],
  pro_offer_giftend: ['Saw the offer after the gift','the gift-end card'],
  pro_offer_limit:   ['Saw a Pro offer at a limit','what Pro adds'],
  pro_offer_account: ['Saw a Pro offer on the account page',''],
  pro_get_post:      ['Pressed Get Pro on Post it',''],
  pro_get_share:     ['Pressed Get Pro from the share dialog',''],
  pro_get_export:    ['Pressed Get Pro on the export sheet',''],
  pro_get_page:      ['Pressed Get Pro on the Pro page',''],
  pro_get_giftend:   ['Pressed Keep Pro after the gift',''],
  pro_get_limit:     ['Pressed Get Pro at a limit',''],
  pro_get_account:   ['Pressed Get Pro on the account page',''],
  pro_preview_post:  ['Previewed Pro on Post it','their own tifo as the vertical video'],
  monthly_bought:    ['Bought 30 days of Pro','came back from paying'],
  match_bought:      ['Bought a match pass','came back from paying'],
  year_bought:       ['Bought a year of Pro','came back from paying'],
  pro_plans_post: ['Saw the plan list on Post it',''],
  pro_plans_share: ['Saw the plan list on the share dialog',''],
  pro_plans_export: ['Saw the plan list on the export sheet',''],
  pro_plans_page: ['Saw the plan list on the Pro page',''],
  pro_plans_giftend: ['Saw the plan list after the gift',''],
  pro_plans_limit: ['Saw the plan list on a limit card',''],
  pro_plans_account: ['Saw the plan list on the account page',''],
  pro_pick_monthly_post: ['Chose the month on Post it',''],
  pro_pick_monthly_share: ['Chose the month on the share dialog',''],
  pro_pick_monthly_export: ['Chose the month on the export sheet',''],
  pro_pick_monthly_page: ['Chose the month on the Pro page',''],
  pro_pick_monthly_giftend: ['Chose the month after the gift',''],
  pro_pick_monthly_limit: ['Chose the month on a limit card',''],
  pro_pick_monthly_account: ['Chose the month on the account page',''],
  pro_pick_match_post: ['Chose the match pass on Post it',''],
  pro_pick_match_share: ['Chose the match pass on the share dialog',''],
  pro_pick_match_export: ['Chose the match pass on the export sheet',''],
  pro_pick_match_page: ['Chose the match pass on the Pro page',''],
  pro_pick_match_giftend: ['Chose the match pass after the gift',''],
  pro_pick_match_limit: ['Chose the match pass on a limit card',''],
  pro_pick_match_account: ['Chose the match pass on the account page',''],
  pro_pick_year_post: ['Chose the year on Post it',''],
  pro_pick_year_share: ['Chose the year on the share dialog',''],
  pro_pick_year_export: ['Chose the year on the export sheet',''],
  pro_pick_year_page: ['Chose the year on the Pro page',''],
  pro_pick_year_giftend: ['Chose the year after the gift',''],
  pro_pick_year_limit: ['Chose the year on a limit card',''],
  pro_pick_year_account: ['Chose the year on the account page',''],
  gift_auto:         ['The gift started by itself','7 days of Pro'],
  gift_welcome:      ['Saw the gift welcome','Pro is on for 7 days'],
  gift_end_seen:     ['Saw the gift-end card','what they made, and the price'],
  bought_after_gift: ['Paid after their gift',''],
  signup_offer_post: ['Offered an account on Post it','one line, Google or email'],
  signup_post:       ['Made an account from Post it',''],
};

/* Only these are a sequence everyone passes through in order, so only these get
   a drop-off figure. The rest are side signals - a draft being restored is not
   a stage between painting and saving, and printing "-3" beside it invented a
   loss that never happened. */
var MAIN_PATH = ['landed', 'paint_first', 'view_3d', 'save_clicked', 'signed_up', 'published'];

/* One step: how many sessions did it. On the main path the bar and the percent
   are that step against "Opened the editor". Off it there is no percent: those
   things can happen in a session that never opened the editor (the Pro page,
   an event page), so a share of editor sessions means nothing and could pass
   100%. The old "lost since the step above" figure is gone: each step is
   counted on its own, nobody is made to do them in this order, and a step
   could be larger than the one above it. */
function funnelRow(s, top){
  var n = Number(s.sessions)||0;
  var meta = FUNNEL_STEP[s.name] || [labelize(s.name), ''];
  var w = top ? Math.max(1.5, Math.min(100, n / top * 100)) : 0;
  return '<div class="frow"><div class="flab">' + esc(meta[0])
    + (meta[1] ? '<span class="fsub">' + esc(meta[1]) + '</span>' : '') + '</div>'
    + '<div class="fbar"><div class="ffill" style="width:' + w.toFixed(1) + '%"></div></div>'
    + '<div class="fnum">' + fmt(n) + (top ? ' <span class="dim">' + pct(n, top) + '</span>' : '')
    + '</div></div>';
}

function funnelHtml(funnel){
  var steps = (funnel && funnel.steps) || [];
  if (!steps.length) return '<div class="card"><p class="empty">No funnel data captured yet.</p></div>';
  var byName = {}, i;
  for (i=0;i<steps.length;i++) byName[steps[i].name] = steps[i];
  var top = byName.landed ? (Number(byName.landed.sessions)||0) : 0;

  var html = '<div class="card"><p class="lt">In the editor</p>'
    + '<p class="lc">sessions that did each thing, and that as a share of the sessions that opened the editor</p>';
  for (i=0;i<MAIN_PATH.length;i++){
    var s = byName[MAIN_PATH[i]];
    if (!s) continue;
    html += funnelRow(s, top);
  }
  html += '</div>';

  var side = steps.filter(function(x){ return MAIN_PATH.indexOf(x.name) === -1; });
  var max = 0;
  for (i=0;i<side.length;i++) if ((Number(side[i].sessions)||0) > max) max = Number(side[i].sessions)||0;
  if (side.length){
    html += '<div class="card" style="margin-top:10px">'
      + '<p class="lt">Everything else that is counted</p>'
      + '<p class="lc">sessions that did each thing; bars compare them with each other, not with the editor</p>';
    for (i=0;i<side.length;i++){
      var x = side[i], n = Number(x.sessions)||0, meta = FUNNEL_STEP[x.name] || [labelize(x.name), ''];
      html += '<div class="frow"><div class="flab">' + esc(meta[0]) + (meta[1] ? '<span class="fsub">' + esc(meta[1]) + '</span>' : '') + '</div>'
        + '<div class="fbar"><div class="ffill" style="width:' + (max ? Math.max(n ? 1.5 : 0, n / max * 100) : 0).toFixed(1) + '%"></div></div>'
        + '<div class="fnum">' + fmt(n) + '</div></div>';
    }
    html += '</div>';
  }
  return html;
}

function tableCard(head, rows, cols){
  if (!rows || !rows.length) return '<div class="card"><p class="lt">' + esc(head[0]) + '</p><p class="empty">Nothing yet.</p></div>';
  var th='', i;
  for (i=0;i<head.length;i++){ th += '<th' + (i===0?' class="name"':'') + '>' + esc(head[i]) + '</th>'; }
  var body='';
  for (i=0;i<rows.length;i++){
    var r = rows[i], td='';
    for (var c=0;c<cols.length;c++){
      var v = cols[c](r);
      /* Every column but the first used to go through the number formatter, so
         a text cell (a date, a label) came out as "0". Numbers still format;
         anything else is printed as written. */
      var isNum = (typeof v === 'number') || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
      var cell = (c === 0 || !isNum) ? esc(String(v)) : fmt(v);
      td += '<td' + (c===0?' class="name" title="'+esc(String(v))+'"':'') + '>' + cell + '</td>';
    }
    body += '<tr>' + td + '</tr>';
  }
  return '<div class="card"><table><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}


/* ---------- sharing ---------- */

var PLATFORM_LABEL = {
  whatsapp:'WhatsApp', x:'X', twitter:'X / Twitter', telegram:'Telegram', facebook:'Facebook',
  reddit:'Reddit', email:'Email', instagram:'Instagram', tiktok:'TikTok', discord:'Discord',
  copy:'Copy link', webshare:'Device share sheet', qr:'QR code', link:'Direct link'
};
var PLATFORM_COLOR = {
  // X's brand black is invisible on a dark dashboard, and its white is so light
  // the bar label stops being readable. Its own mid grey works for both.
  whatsapp:'#25d366', x:'#71767b', twitter:'#71767b', telegram:'#2aabee', facebook:'#1877f2',
  reddit:'#ff4500', email:'#8b949e', instagram:'#e1306c', tiktok:'#69c9d0', discord:'#5865f2',
  copy:'#58a6ff', webshare:'#a371f7', qr:'#d29922', link:'#58a6ff'
};

/* Bars for share destinations. Presses and opens are separate numbers on
   purpose: one is intent, the other is arrival, and summing them means nothing. */
function shareBars(title, caption, items){
  var html = '<div class="card"><p class="lt">' + esc(title) + '</p><p class="lc">' + esc(caption) + '</p>';
  if (!items || !items.length){ return html + '<p class="empty">Nothing recorded yet.</p></div>'; }
  var max = 0, i;
  for (i=0;i<items.length;i++){ if ((Number(items[i].shares)||0) > max) max = Number(items[i].shares)||0; }
  if (!max) max = 1;
  for (i=0;i<items.length;i++){
    var it = items[i];
    var name = PLATFORM_LABEL[it.key] || labelize(it.key);
    var w = Math.max(1.5, (Number(it.shares)||0) / max * 100);
    var c = PLATFORM_COLOR[it.key] || '#58a6ff';
    html += '<div class="row">'
      + '<div class="bg" style="width:' + w.toFixed(1) + '%;background:' + c + '"></div>'
      + '<div class="nm" title="' + esc(name) + '">' + esc(name) + '</div>'
      + '<div class="vv"><b>' + fmt(it.shares) + '</b> <span class="dim">/ ' + fmt(it.opens) + '</span></div>'
      + '</div>';
  }
  return html + '</div>';
}

/* Presses vs opens over time, reusing the two-series chart shape. */
function shareChart(daily){
  if (!daily || daily.length < 2) return '<div class="card"><p class="lt">Daily</p><p class="empty">Not enough days yet.</p></div>';
  var a = [], b = [], i;
  for (i=0;i<daily.length;i++){ a.push(Number(daily[i].shares)||0); b.push(Number(daily[i].opens)||0); }
  var max = 1;
  for (i=0;i<a.length;i++){ if (a[i] > max) max = a[i]; if (b[i] > max) max = b[i]; }
  var W = 560, H = 120, pad = 4;
  function path(vals){
    var d = '', j;
    for (j=0;j<vals.length;j++){
      var x = pad + (j/(vals.length-1)) * (W - pad*2);
      var y = H - pad - (vals[j]/max) * (H - pad*2);
      d += (j ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    return d;
  }
  return '<div class="card"><p class="lt">Day by day</p>'
    + '<p class="lc"><span style="color:#a371f7">&#9632;</span> shared &nbsp; <span style="color:#3fb950">&#9632;</span> opened</p>'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:120px">'
    + '<path d="' + path(a) + '" fill="none" stroke="#a371f7" stroke-width="2"/>'
    + '<path d="' + path(b) + '" fill="none" stroke="#3fb950" stroke-width="2"/>'
    + '</svg>'
    + '<p class="lc">' + esc(daily[0].day) + ' to ' + esc(daily[daily.length-1].day) + ' · peak ' + fmt(max) + '</p></div>';
}

function sharesSection(sh, days){
  if (!sh) return '<div class="card"><p class="empty">Share data unavailable.</p></div>';
  var shares = Number(sh.shares)||0, opens = Number(sh.opens)||0;
  var inb = sh.inbound || null;

  var html = '<div class="grid">';
  html += stat(shares, plural(shares, 'press', 'presses'), 'Share buttons pressed', 'on published tifos',
    'A press on a share button, counted once a day for each person, tifo and platform. Presses on a private tifo are not recorded.');
  html += stat(opens, plural(opens, 'page view', 'page views'), 'Opened from a shared link', 'reloads and repeat opens count again',
    'Page views that arrived on a link made by the share buttons (the link carries a tag). It counts views, not people.');
  html += stat(sh.designsShared, plural(sh.designsShared, 'tifo', 'tifos'), 'Tifos shared', 'different tifos with a press', '');
  html += stat(shares ? (Math.round((opens/shares)*100)/100) : 0, '', 'Page views per press', 'opens divided by presses', 'A rough ratio: presses are counted once a day per person, opens every time.');
  html += '</div>';

  html += '<div class="grid two">';
  html += shareBars('Where they shared to', 'shared / opened · last ' + days + ' days', sh.platforms);
  html += shareChart(sh.daily);
  html += '</div>';

  html += '<div class="grid two">';
  html += tableCard(['Most-shared tifos','Shares'], sh.topDesigns,
    [function(d){ return (d.title || 'Untitled') + (d.owner ? ' · @' + d.owner : ''); }, function(d){ return d.shares; }]);
  html += inb
    ? barList('Most-viewed tifo pages', 'page views, the top 10, however people got there', inb.pages, '#3fb950')
    : '<div class="card"><p class="lt">Most-viewed tifo pages</p><p class="empty">Traffic measurement is off.</p></div>';
  html += '</div>';

  if (inb){
    html += '<div class="grid">';
    html += stat(inb.visits, plural(inb.visits, 'page view', 'page views'), 'Views of tifo pages', 'every tifo page, counts everyone',
      'Page views of any published tifo page (/t/ and /d/ links, English and Arabic), however the visitor got there: a shared link, the community, or the owner looking at their own.');
    html += stat(inb.tifosOpened, plural(inb.tifosOpened, 'tifo', 'tifos'), 'Different tifos viewed', 'with at least one page view', '');
    html += '</div>';
    if (inb.social && inb.social.length){
      html += barList('Page views sent by social and messaging sites', 'to any page of the site, among the 15 biggest referrers', inb.social, 'social');
    }
  }

  html += '<div class="callout"><b>A share is a button press, not a delivered message.</b> Once the platform takes over, nothing on this site can see whether it was sent, so treat <em>Shared</em> as intent and <em>Links opened</em> as the result. The two do not have to match, and opens can exceed shares when one link is passed on repeatedly.<br><br><b>Links opened is counted from the link itself.</b> Every share button tags its link with the platform (utm_medium=share), so an opened link is counted even from WhatsApp, Telegram and Discord, which send no referrer. Links shared before 30 Sep 2026 carried no tag and are not in it. The list of social and messaging sites above goes by the referrer instead, so it is a floor: most messaging apps send none.</div>';
  return html;
}

/* ---------- what people told me ---------- */

var FB_KIND = { bug:['Broken','#f85149'], idea:['Idea','#58a6ff'], other:['Note','#8b949e'] };

function timeAgo(iso){
  var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/1000));
  if (s < 90) return 'just now';
  var m = Math.round(s/60); if (m < 60) return m + 'm ago';
  var h = Math.round(m/60); if (h < 24) return h + 'h ago';
  var d = Math.round(h/24); return d === 1 ? 'yesterday' : d + 'd ago';
}

var FB_SHOW = 'open';
var FB_MSG = '';
/* ---- Club enquiries: what a club, an agency or a group wrote on the For clubs page ----
   Stored since the form went up, and counted on the Overview, but never listed: the only way to read one was
   the database. Same shape as a feedback report: who, when, the message, a reply link, Mark handled. */
var LEAD_SHOW = 'open';
var LEAD_MSG = '';
var LEAD_TYPE = { club:'Club', agency:'Agency', ultras:'Supporters group', other:'Other' };
function leadsOpen(){ return (LEADS && LEADS.counts && Number(LEADS.counts.open)) || 0; }
function leadsSection(){
  if (!LEADS || LEADS.error) return '';
  var counts = LEADS.counts || { total:0, open:0 }, items = LEADS.items || [];
  var html = '<h2 class="sec">Club enquiries'
    + (counts.open ? ' <span class="badge warn">' + fmt(counts.open) + ' not handled</span>' : (counts.total ? ' <span class="badge good">all handled</span>' : ''))
    + ' <span class="hint">sent from the For clubs page &middot; all time</span></h2>';
  if (!counts.total && !items.length){
    return html + '<div class="card"><p class="empty">No club has written yet. The form is at the bottom of the For clubs page.</p></div>';
  }
  html += '<p class="note" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
    + '<button type="button" class="tab lead-filter" data-lead="open" aria-current="' + (LEAD_SHOW === 'open') + '">Not handled</button>'
    + '<button type="button" class="tab lead-filter" data-lead="all" aria-current="' + (LEAD_SHOW === 'all') + '">Everything</button></p>';
  html += '<p id="lead-out" class="note" role="status" aria-live="polite">' + esc(LEAD_MSG) + '</p>';
  var shown = [];
  for (var k = 0; k < items.length; k++) if (LEAD_SHOW === 'all' || !items[k].handled) shown.push(items[k]);
  if (!shown.length){
    html += '<div class="card"><p class="empty">' + (LEAD_SHOW === 'open' ? 'Nothing is waiting among the newest ' + fmt(items.length) + '.' : 'Nothing here.') + '</p></div>';
  } else {
    html += '<div class="card" style="margin-top:10px">';
    for (var i = 0; i < shown.length; i++){
      var it = shown[i];
      var from = [it.organization, it.orgType ? (LEAD_TYPE[it.orgType] || it.orgType) : ''].filter(Boolean).join(' · ');
      html += '<div class="fbrow leadrow">'
        + '<div class="fbtop">'
        +   '<b>' + esc(it.name) + '</b>'
        +   '<span class="fbwhen">' + esc(timeAgo(it.createdAt)) + (it.handled ? ' &middot; handled' : '') + '</span>'
        +   '<a class="fbmail" href="' + esc(mailtoHref(it.email)) + '">' + esc(it.email) + '</a>'
        +   '<button type="button" class="lead-handle" data-id="' + esc(it.id) + '" data-to="' + (it.handled ? '0' : '1') + '">' + (it.handled ? 'Reopen' : 'Mark handled') + '</button>'
        + '</div>'
        + (from ? '<p class="fbsteps">' + esc(from) + '</p>' : '')
        + '<p class="fbmsg">' + (it.message ? esc(it.message) : '<span class="dim">No message, only the contact details.</span>') + '</p>'
        + '</div>';
    }
    html += '</div>';
  }
  if (counts.total > items.length) html += '<p class="note">The newest ' + fmt(items.length) + ' enquiries are listed; ' + fmt(counts.total - items.length) + ' older ones are counted above but not shown.</p>';
  return html;
}
function wireLeads(){
  var filters = document.querySelectorAll('.lead-filter');
  for (var i = 0; i < filters.length; i++){
    filters[i].addEventListener('click', function(e){ LEAD_SHOW = e.currentTarget.getAttribute('data-lead'); LEAD_MSG = ''; paintSection(); });
  }
  var btns = document.querySelectorAll('.lead-handle');
  for (var j = 0; j < btns.length; j++){
    btns[j].addEventListener('click', async function(e){
      var b = e.currentTarget, id = b.getAttribute('data-id'), to = b.getAttribute('data-to') === '1';
      b.disabled = true;
      var r = await post('/api/admin/leads/' + encodeURIComponent(id) + '/handled', { handled: to });
      if (!r.ok){ b.disabled = false; el('lead-out').textContent = 'Not saved (' + ((r.data && r.data.error) || ('HTTP ' + r.status)) + '). Try again.'; return; }
      var items = (LEADS && LEADS.items) || [];
      for (var k = 0; k < items.length; k++) if (items[k].id === id && !!items[k].handled !== to){
        items[k].handled = to;
        if (LEADS.counts) LEADS.counts.open = Math.max(0, (Number(LEADS.counts.open) || 0) + (to ? -1 : 1));
      }
      LEAD_MSG = to ? 'Marked handled.' : 'Reopened.';
      var y = window.scrollY;
      renderTabs();
      paintSection();
      window.scrollTo(0, y);
    });
  }
}

function feedbackSection(fb){
  var counts = (fb && fb.counts) || { total:0, open:0, bugs:0, ideas:0 };
  var items = (fb && fb.items) || [];
  var html = '<h2 class="sec">What people told me'
    + (counts.open ? ' <span class="badge warn">' + fmt(counts.open) + ' not handled</span>' : ' <span class="badge good">all handled</span>')
    + ' <span class="hint">sent from inside the site &middot; all time</span></h2>';

  if (!counts.total && !items.length){
    return html + '<div class="card"><p class="empty">Nothing reported yet. '
      + 'The form is in the account menu in the editor, and in the footer of every public page.</p></div>';
  }

  var notes = Math.max(0, counts.total - counts.bugs - counts.ideas);
  html += '<div class="grid three">';
  html += stat(counts.open, plural(counts.open, 'report', 'reports'), 'Not handled yet', 'of ' + fmt(counts.total) + ' ever sent',
    'A report stays here until you press Mark handled on it. The number beside Feedback in the menu is this one.');
  html += stat(counts.bugs, plural(counts.bugs, 'report', 'reports'), 'Said something is broken', 'handled or not', '');
  html += stat(counts.ideas, plural(counts.ideas, 'report', 'reports'), 'Ideas', fmt(notes) + ' more are plain notes', 'Broken, ideas and notes add up to everything ever sent.');
  html += '</div>';

  html += '<p class="note" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
    + '<button type="button" class="tab fb-filter" data-fb="open" aria-current="' + (FB_SHOW === 'open') + '">Not handled</button>'
    + '<button type="button" class="tab fb-filter" data-fb="all" aria-current="' + (FB_SHOW === 'all') + '">Everything</button></p>';
  html += '<p id="fb-out" class="note" role="status" aria-live="polite">' + esc(FB_MSG) + '</p>';

  var shown = [];
  for (var k = 0; k < items.length; k++) if (FB_SHOW === 'all' || !items[k].handled) shown.push(items[k]);
  if (!shown.length){
    html += '<div class="card"><p class="empty">' + (FB_SHOW === 'open' ? 'Nothing is waiting among the newest ' + fmt(items.length) + '.' : 'Nothing here.') + '</p></div>';
  } else {
    html += '<div class="card" style="margin-top:10px">';
    for (var i=0;i<shown.length;i++){
      var it = shown[i];
      var meta = FB_KIND[it.kind] || FB_KIND.other;
      var c = it.context;
      var ctxLine = c
        ? [c.path, c.browser && c.os ? c.browser + ' on ' + c.os : (c.browser || c.os), c.device, c.viewport]
            .filter(Boolean).join(' · ')
        : 'no diagnostics attached';
      html += '<div class="fbrow">'
        + '<div class="fbtop">'
        +   '<span class="fbkind" style="background:' + meta[1] + '22;color:' + meta[1] + '">' + esc(meta[0]) + '</span>'
        +   '<span class="fbwhen">' + esc(timeAgo(it.createdAt)) + (it.handled ? ' &middot; handled' : '') + '</span>'
        +   (it.email ? '<a class="fbmail" href="' + esc(mailtoHref(it.email)) + '">' + esc(it.email) + '</a>'
                      : '<span class="fbmail dim">no reply address</span>')
        +   '<button type="button" class="fb-handle" data-id="' + esc(it.id) + '" data-to="' + (it.handled ? '0' : '1') + '">' + (it.handled ? 'Reopen' : 'Mark handled') + '</button>'
        + '</div>'
        + '<p class="fbmsg">' + esc(it.message) + '</p>'
        + (it.steps ? '<p class="fbsteps"><b>Doing:</b> ' + esc(it.steps) + '</p>' : '')
        + '<p class="fbctx">' + esc(ctxLine) + '</p>'
        + '</div>';
    }
    html += '</div>';
  }
  if (counts.total > items.length) html += '<p class="note">The newest ' + fmt(items.length) + ' reports are listed; ' + fmt(counts.total - items.length) + ' older ones are counted above but not shown.</p>';
  return html;
}
function wireFeedback(){
  var filters = document.querySelectorAll('.fb-filter');
  for (var i = 0; i < filters.length; i++){
    filters[i].addEventListener('click', function(e){ FB_SHOW = e.currentTarget.getAttribute('data-fb'); FB_MSG = ''; paintSection(); });
  }
  var btns = document.querySelectorAll('.fb-handle');
  for (var j = 0; j < btns.length; j++){
    btns[j].addEventListener('click', async function(e){
      var b = e.currentTarget, id = b.getAttribute('data-id'), to = b.getAttribute('data-to') === '1';
      b.disabled = true;
      var r = await post('/api/admin/feedback/' + encodeURIComponent(id) + '/handled', { handled: to });
      if (!r.ok){ b.disabled = false; el('fb-out').textContent = 'Not saved (' + ((r.data && r.data.error) || ('HTTP ' + r.status)) + '). Try again.'; return; }
      var fb = DATA.fb || {}, items = fb.items || [];
      for (var k = 0; k < items.length; k++) if (items[k].id === id && !!items[k].handled !== to){
        items[k].handled = to;
        if (fb.counts) fb.counts.open = Math.max(0, (Number(fb.counts.open) || 0) + (to ? -1 : 1));
      }
      FB_MSG = to ? 'Marked handled.' : 'Reopened.';
      var y = window.scrollY;
      renderTabs();
      paintSection();
      window.scrollTo(0, y);
    });
  }
}

/* ---------- the header strip ---------- */

/* One row, before anything else: is it growing, and where from. Everything that
   follows is detail; this is the part you read and then decide whether to keep
   scrolling. Where there is not enough history to compare fairly it says so
   rather than inventing a direction from two days of noise. */
function deltaChip(cmp){
  if (!cmp || cmp.delta === null) return '';
  var up = cmp.delta >= 0;
  var arrow = up ? '&#9650;' : '&#9660;';
  var col = up ? '#3fb950' : '#f85149';
  return '<span style="color:' + col + ';font-weight:600">' + arrow + ' ' + Math.abs(cmp.delta) + '%</span>'
    + '<span class="dim"> vs previous ' + cmp.days + (cmp.days === 1 ? ' day' : ' days') + '</span>';
}

function headerStrip(ov, tr, sh){
  var t = (tr && tr.totals) || null;
  var daily = (tr && tr.daily) || [];
  var span = spanOf(daily);
  var visitors = t ? t.visitors : 0;

  /* Channel mix, with internal navigation removed: "where from" is about how
     people ARRIVE, and a second page view by someone already here is not a
     source. Leaving it in made Internal look like an acquisition channel. */
  var external = ((tr && tr.sources) || []).filter(function(s){ return s.key !== 'internal'; });
  var topSource = external.length ? external[0] : null;
  var externalVisits = 0;
  for (var i=0;i<external.length;i++) externalVisits += Number(external[i].visits)||0;

  var cmp = periodCompare(daily, 'visitors', 7);

  var html = '<div class="strip">';

  html += '<div class="strip-cell"><div class="strip-val">' + fmt(visitors) + '</div>'
    + '<div class="strip-lab">visitors <span class="dim" title="Visitors cannot be followed from one day to the next, so a person who comes back tomorrow counts again. A restart of the server in the middle of a day can count the same person twice that day.">(each counted once a day, added up)</span></div>'
    + '<div class="strip-sub">' + (span
        ? esc(span.count === 1 ? 'on ' + niceDay(span.first) : niceDay(span.first) + ' to ' + niceDay(span.last))
        : 'nothing recorded yet') + '</div></div>';

  html += '<div class="strip-cell"><div class="strip-val">' + (cmp ? fmt(cmp.now) : '&mdash;') + '</div>'
    + '<div class="strip-lab">' + (cmp ? 'visitors, last ' + cmp.days + (cmp.days === 1 ? ' day' : ' days') : 'trend') + '</div>'
    + '<div class="strip-sub">' + (cmp ? deltaChip(cmp) : 'needs a few more days before a trend means anything') + '</div></div>';

  html += '<div class="strip-cell"><div class="strip-val">' + (topSource ? fmt(topSource.visits) : '&mdash;') + '</div>'
    + '<div class="strip-lab">page views from ' + (topSource ? esc(SOURCE_LABEL[topSource.key] || labelize(topSource.key)) : 'the top channel') + '</div>'
    + '<div class="strip-sub">' + (topSource && externalVisits
        ? 'the biggest source: ' + pct(topSource.visits, externalVisits) + ' of page views, moving around the site left out'
        : 'no page views from outside yet') + '</div></div>';

  var r7 = (ov && ov.recent7d) || {};
  html += '<div class="strip-cell"><div class="strip-val">' + fmt(r7.signups) + '</div>'
    + '<div class="strip-lab">new accounts</div>'
    + '<div class="strip-sub dim">last 7 days</div></div>';

  return html + '</div>';
}

/* ---------- link builder ----------

   Tagged links, so a post shows up by name under "Your tagged links" instead of
   disappearing into "Social media" (or, from WhatsApp, "Direct"). Built on this
   page only: nothing is sent anywhere, and the last few are kept in this
   browser so a link used in a bio can be found again. */
var SHARE_PLATFORM_LABEL = { x:'X', twitter:'X', whatsapp:'WhatsApp', telegram:'Telegram', facebook:'Facebook', reddit:'Reddit',
  email:'Email', instagram:'Instagram', tiktok:'TikTok', discord:'Discord', snapchat:'Snapchat', copy:'Copied link', webshare:'Phone share sheet', qr:'QR code', link:'Link' };
var LB_PLATFORMS = [['x','X'],['tiktok','TikTok'],['instagram','Instagram'],['snapchat','Snapchat'],['youtube','YouTube'],['whatsapp','WhatsApp'],['telegram','Telegram'],['reddit','Reddit'],['discord','Discord']];
var LB_SPOTS = [['post','A post'],['bio','Profile bio'],['story','Story'],['ad','Paid ad'],['message','Message or group']];
var LB_PAGES = [['/','Home page'],['/projects?new=1','Start designing'],['/community','Community'],['/clubs','For clubs']];
var LB_KEY = 'tifo_admin_links_v1';
function lbSlug(s){ return String(s || '').toLowerCase().trim().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
function lbRecent(){ try { return JSON.parse(localStorage.getItem(LB_KEY) || '[]').slice(0, 8); } catch(e){ return []; } }
function lbOpts(list){ var h=''; for (var i=0;i<list.length;i++) h += '<option value="' + esc(list[i][0]) + '">' + esc(list[i][1]) + '</option>'; return h; }
function buildTaggedLink(base, page, platform, spot, name){
  var u = new URL(page, base);
  u.searchParams.set('utm_source', platform);
  u.searchParams.set('utm_medium', spot);
  var slug = lbSlug(name);
  if (slug) u.searchParams.set('utm_campaign', slug);
  return u.toString();
}
function linkBuilderCard(){
  var recent = lbRecent(), rh = '';
  for (var i=0;i<recent.length;i++){
    rh += '<div class="lb-r"><span class="lb-rn">' + esc(recent[i].label) + '</span><button type="button" class="ghost lb-rc" data-url="' + esc(recent[i].url) + '">Copy</button></div>';
  }
  return '<div class="card" id="link-builder"><p class="lt">Make a tagged link</p>'
    + '<p class="lc">Use it wherever you post. Its visits show up above as <b>platform / name</b>.</p>'
    + '<div class="lb-grid">'
    + '<label>Where<select id="lb-platform">' + lbOpts(LB_PLATFORMS) + '</select></label>'
    + '<label>As<select id="lb-spot">' + lbOpts(LB_SPOTS) + '</select></label>'
    + '<label>Opens<select id="lb-page">' + lbOpts(LB_PAGES) + '<option value="custom">A tifo link&hellip;</option></select></label>'
    + '<label>Name<input id="lb-name" type="text" maxlength="40" placeholder="e.g. reveal-video-1" /></label>'
    + '<label id="lb-custom-wrap" hidden class="lb-wide">Tifo link<input id="lb-custom" type="url" placeholder="https://tifomaker.org/t/..." /></label>'
    + '</div>'
    + '<div class="lb-out"><input id="lb-url" readonly aria-label="Tagged link" /><button type="button" id="lb-copy">Copy</button></div>'
    + '<p class="note" id="lb-msg"></p>'
    + (rh ? '<p class="lt" style="margin-top:12px">Recent links <span class="dim">(this browser)</span></p>' + rh : '')
    + '</div>';
}
function wireLinkBuilder(){
  var root = document.getElementById('link-builder');
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  var get = function(id){ return document.getElementById(id); };
  var base = location.origin;
  var update = function(){
    var page = get('lb-page').value;
    get('lb-custom-wrap').hidden = page !== 'custom';
    var target = page;
    if (page === 'custom'){
      var raw = String(get('lb-custom').value || '').trim();
      try { var cu = new URL(raw, base); target = cu.origin === base ? cu.pathname + cu.search : '/'; } catch(e){ target = '/'; }
    }
    get('lb-url').value = buildTaggedLink(base, target, get('lb-platform').value, get('lb-spot').value, get('lb-name').value);
  };
  ['lb-platform','lb-spot','lb-page','lb-name','lb-custom'].forEach(function(id){
    get(id).addEventListener('input', update);
    get(id).addEventListener('change', update);
  });
  var copy = async function(url, msg){
    try { await navigator.clipboard.writeText(url); msg.textContent = 'Copied.'; }
    catch(e){ msg.textContent = 'Select the link and copy it.'; }
  };
  get('lb-copy').addEventListener('click', function(){
    var url = get('lb-url').value, msg = get('lb-msg');
    void copy(url, msg);
    var name = lbSlug(get('lb-name').value);
    var label = get('lb-platform').value + ' / ' + (name || '-') + ' (' + get('lb-spot').value + ')';
    var list = lbRecent().filter(function(r){ return r.url !== url; });
    list.unshift({ url: url, label: label });
    try { localStorage.setItem(LB_KEY, JSON.stringify(list.slice(0, 8))); } catch(e){}
  });
  root.querySelectorAll('.lb-rc').forEach(function(b){
    b.addEventListener('click', function(){ void copy(b.getAttribute('data-url'), get('lb-msg')); });
  });
  update();
}

/* ---------- render ---------- */

function trafficSection(tr, days){
  // The span comes from the data, not the picker: the visits table began on 9
  // Sept, so "last 30 days" over three days of rows invited a month-sized
  // reading of a three-day number.
  var label = (tr && tr.daily) ? spanLabel(tr.daily, days) : 'last ' + days + ' days';
  var short = (tr && tr.daily) ? isShortSpan(tr.daily, days) : false;
  var html = '<h2 class="sec">Where visitors come from <span class="hint">' + esc(label)
    + ' · measured server-side, counts everyone' + (short ? ' · all the history there is' : '') + '</span></h2>';

  if (!tr || !tr.enabled){
    return html + '<div class="callout"><b>Traffic sources are not enabled yet.</b> Deploy this build with a DATABASE_URL set and the <code>visits</code> table is created automatically on boot. Data starts appearing within minutes of the first page view.</div>';
  }
  var t = tr.totals || { visits:0, visitors:0, botVisits:0 };
  if (!t.visits){
    html += '<div class="callout"><b>No page views recorded yet.</b> This starts collecting the moment the new build is live. If the site has been up for a while and this stays empty, check that the server booted without a <code>visits init failed</code> error in the logs.</div>';
    return html;
  }

  // Only what the strip does not already say. Page views per visitor is the one
  // number neither shows on its own, and it is the useful one: it separates
  // "people arrive and leave" from "people arrive and look around".
  var perVisitor = t.visitors ? Math.round((t.visits / t.visitors) * 10) / 10 : 0;
  html += '<div class="grid">';
  html += stat(t.visitors, plural(t.visitors, 'visitor', 'visitors'), 'Visitors', 'each counted once a day, the days added up',
    'A visitor is one device on one day. Nobody is followed from day to day, so someone who comes on three days counts three times. If the server restarts during a day, the same person can count twice that day.');
  html += stat(t.visits, plural(t.visits, 'page view', 'page views'), 'Page views', 'every page opened, moving around the site included', 'Bots are left out.');
  html += stat(perVisitor, 'pages', 'Pages per visitor', 'page views divided by visitors', '');
  html += stat(t.botVisits, plural(t.botVisits, 'request', 'requests'), 'From bots', 'left out of every number on this screen', 'The numbers on What they do come from the browser instead and have no bot filter.');
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += trafficChart(tr.daily);
  html += barList('Where page views came from', 'page views; Internal is someone moving from one page of the site to another', tr.sources, 'source', SOURCE_LABEL);
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += barList('Referrers', 'page views by the site or search engine that sent them, the top 15', tr.referrers, '#58a6ff');
  html += barList('Pages viewed', 'page views by page, the top 15', tr.pages, '#3fb950');
  html += '</div>';

  // Countries only fills in behind an edge that sets CF-IPCountry. Rather than
  // hold a full column open to say "nothing recorded yet" forever, it appears
  // when there is something in it and becomes one line of prose when there is
  // not - language is a decent stand-in for reach in the meantime.
  var hasCountries = tr.countries && tr.countries.length;
  html += '<div class="grid ' + (hasCountries ? 'three' : 'two') + '" style="margin-top:10px">';
  if (hasCountries) html += barList('Countries', 'from the edge network', tr.countries, '#d29922');
  html += barList('Languages', 'browser language - the best reach signal available without country data', tr.languages, '#a371f7');
  html += barList('Devices', 'desktop vs phone vs tablet', tr.devices, '#39c5cf');
  html += '</div>';
  if (!hasCountries){
    html += '<p class="note">Country data needs an edge that sets <code>CF-IPCountry</code>. Putting Cloudflare in front turns it on and costs nothing; see <code>CLOUDFLARE.md</code>.</p>';
  }

  html += '<div class="grid two" style="margin-top:10px">';
  html += barList('Browsers & in-app webviews', 'a TikTok or Instagram webview here means the link was opened inside that app', tr.browsers, '#58a6ff');
  html += barList('Your tagged links', 'platform / name, from links made with the builder below', tr.campaigns, '#d29922');
  html += '</div>';
  html += '<div class="grid two" style="margin-top:10px">';
  html += barList('Shared by visitors', 'links passed on from the share buttons on the site, by platform (WhatsApp included)', tr.shared || [], '#f778ba', SHARE_PLATFORM_LABEL);
  html += linkBuilderCard();
  html += '</div>';

  html += '<div class="callout ok"><b>How this is measured.</b> Recorded on the server, after each page is sent, so it counts every visitor rather than only those who accept analytics. No cookie is set. Your IP address is never stored: it is hashed once in memory with a secret that is regenerated every day and never written to disk, so visitors cannot be identified or followed from one day to the next. The price of that: the secret is also new after a restart, so a deploy in the middle of a day can count that day\\'s earlier visitors a second time. Lists by source, page or country show page views only, because visitors cannot be counted per list beyond the last two days. Referring URLs are reduced to a hostname before storage.</div>';
  return html;
}

/* ---------- sections ----------

   One tab answers one question. The data is fetched once and kept, so
   switching tabs is instant and does not re-hit the API; only the window
   picker and Refresh reload.                                              */

var TABS = [
  { id:'board',    label:'Today' },
  { group:'Money' },
  { id:'pro',      label:'Pro and launch' },
  { id:'orders',   label:'Orders and refunds' },
  { id:'members',  label:'Members' },
  { id:'prices',   label:'Price research' },
  { group:'Audience' },
  { id:'traffic',  label:'Visitors' },
  { id:'funnel',   label:'What they do' },
  { group:'Product' },
  { id:'ai',       label:'AI' },
  { id:'events',   label:'Events' },
  { id:'library',  label:'Library' },
  { group:'Needs you' },
  { id:'review',   label:'Review' },
  { id:'feedback', label:'Feedback' },
  { group:'Under the hood' },
  { id:'email',    label:'Email' },
  { id:'security', label:'Security' }
];
var DATA = null;
var currentTab = 'board';

function isTab(id){
  for (var i = 0; i < TABS.length; i++) if (TABS[i].id && TABS[i].id === id) return true;
  return false;
}
function tabFromUrl(){
  var h = (location.hash || '').replace('#', '');
  if (isTab(h)) return h;
  try { var saved = localStorage.getItem('tifo_admin_tab'); if (saved && isTab(saved)) return saved; } catch(e){}
  return 'board';
}

/* What is waiting for the owner, by screen. These are the only numbers the
   menu shows: a count beside a name used to be page views on one tab, every AI
   request on another and "everything ever sent" on a third. */
function waitingCounts(){
  var qc = queueCounts();
  var reqs = (REQS && REQS.requests) || [], pending = 0;
  for (var i = 0; i < reqs.length; i++) if (reqs[i].status === 'pending') pending++;
  var look = (ORDERS && ORDERS.stats && Number(ORDERS.stats.review)) || 0;
  var fb = (DATA && DATA.fb && DATA.fb.counts) || {};
  return {
    review: qc.reports + qc.photos + qc.stadiums,
    orders: pending + look, refunds: pending, look: look,
    feedback: (Number(fb.open) || 0) + leadsOpen(),
    enquiries: leadsOpen(),
    security: DATA ? socFiring().length : 0
  };
}
function tabBadge(id){
  if (!DATA) return '';
  var n = waitingCounts()[id];
  return n ? '<span class="pill warn">' + fmt(n) + '</span>' : '';
}

function renderTabs(){
  var html = '';
  for (var i = 0; i < TABS.length; i++){
    var tb = TABS[i];
    if (tb.group){ html += '<span class="grp">' + esc(tb.group) + '</span>'; continue; }
    html += '<button class="tab" type="button" data-tab="' + tb.id + '" aria-current="' + (tb.id === currentTab) + '">'
          + '<span>' + esc(tb.label) + '</span>' + tabBadge(tb.id) + '</button>';
  }
  el('tabs').innerHTML = html;
  var btns = el('tabs').querySelectorAll('.tab');
  for (var k = 0; k < btns.length; k++){
    btns[k].addEventListener('click', function(e){ selectTab(e.currentTarget.getAttribute('data-tab')); });
  }
}

function selectTab(id){
  currentTab = id;
  try { localStorage.setItem('tifo_admin_tab', id); } catch(e){}
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  renderTabs();
  paintSection();
  window.scrollTo(0, 0);
}

/* ---- today: what is waiting, the business in one row, then growth ---- */
function todoRow(n, label, where, href){
  n = Number(n) || 0;
  return '<a class="' + (n ? '' : 'clear') + '" href="' + esc(href) + '"><span class="tn">' + fmt(n) + '</span>'
    + '<span class="tl">' + esc(label) + '</span><span class="tg">' + esc(where) + ' &rarr;</span></a>';
}
/* Who holds Pro and what it has earned: the same three figures on Today and
   on Pro and launch, from the same lists the Members and Orders screens show. */
function proHeadline(){
  var html = '';
  if (MEMBERS && !MEMBERS.error){
    var c = memCounts(memAccounts());
    html += stat(c.now, plural(c.now, 'account', 'accounts'), 'Hold Pro now',
      fmt(c.paid) + ' bought, ' + fmt(c.hand) + ' given by you, ' + fmt(c.gift) + ' on the 7-day gift',
      'Accounts with a pass that has started and has not ended or been revoked. An account with two passes counts once, under the one that makes it Pro now. A purchase made with test keys counts as bought, and is marked TEST on Members.');
  } else {
    html += stat('?', '', 'Hold Pro now', 'the member list did not load', '');
  }
  if (ORDERS && !ORDERS.error){
    var n = ORDERS.stats || {};
    html += stat('SAR ' + fmt((n.revenue || 0) / 100), '', 'Kept, all time',
      fmt(n.paid || 0) + plural(n.paid || 0, ' paid order', ' paid orders') + ', before Moyasar fees',
      'Real-money orders that are paid and have not been refunded. Refunded orders and test orders are left out, so this is what stayed with you.');
    html += stat(n.refunded || 0, plural(n.refunded || 0, 'order', 'orders'), 'Refunded, all time', 'the whole amount went back', '');
  }
  return html;
}
function boardSection(){
  var ov = DATA.ov, t = ov.totals || {}, r7 = ov.recent7d || {}, series = ov.series || {};
  var w = waitingCounts(), qc = queueCounts();
  var html = '<h2 class="sec">Waiting for you ' + (w.orders + w.review + w.feedback + w.security
    ? '' : '<span class="badge good">nothing</span>') + '</h2><div class="todo">';
  html += todoRow(w.refunds, 'Refund requests to answer', 'Orders and refunds', '#orders');
  if (w.look) html += todoRow(w.look, 'Orders paid at the wrong amount', 'Orders and refunds', '#orders');
  html += todoRow(qc.stadiums, 'Stadium submissions to review', 'Review', '#review');
  html += todoRow(qc.photos, 'Match photos to verify', 'Review', '#review');
  html += todoRow(qc.reports, 'Reported designs', 'Review', '#review');
  html += todoRow(w.feedback - w.enquiries, 'Feedback not marked handled', 'Feedback', '#feedback');
  html += todoRow(w.enquiries, 'Club enquiries not marked handled', 'Feedback', '#feedback');
  html += todoRow(w.security, 'Security alerts firing', 'Security', '#security');
  html += '</div>';

  html += '<h2 class="sec">Pro and money</h2><div class="grid three">' + proHeadline() + '</div>';

  html += '<h2 class="sec">Visitors <span class="hint">the period picked at the top</span></h2>';
  html += headerStrip(ov, DATA.tr, DATA.sh);

  var drafts = Math.max(0, (t.designs || 0) - (t.publicDesigns || 0) - (t.trashedDesigns || 0));
  html += '<h2 class="sec">The site <span class="hint">all time</span></h2><div class="grid three">';
  html += stat(t.users, 'accounts', 'Signed up', fmt(r7.signups) + ' in the last 7 days', 'Every account that exists now. A deleted account leaves this number.');
  html += stat(t.designs, 'designs', 'Saved', fmt(t.publicDesigns) + ' published, ' + fmt(drafts) + ' private, ' + fmt(t.trashedDesigns) + ' in the Trash',
    'Every design row: private drafts, published ones and ones in the Trash (kept 30 days, then removed for good). ' + fmt(r7.designs) + ' were made in the last 7 days.');
  html += stat(t.publicDesigns, 'designs', 'Published', 'of which ' + fmt(t.templates) + plural(t.templates, ' is a template', ' are templates'), 'Designs marked public. Templates are published designs too, so they are inside this number, not beside it.');
  html += aiBoardKpi();
  html += stat(t.leads, 'leads', 'Club enquiries', fmt(r7.leads) + ' in the last 7 days', 'Messages sent from the For clubs page. Read and answer them under Feedback.');
  html += '</div>';

  html += '<h2 class="sec">Growth <span class="hint">last 30 days &middot; Riyadh days &middot; every day drawn, empty ones as zero</span></h2><div class="grid two">';
  html += chartCard('New accounts per day', fillDays(series.signups, 30), '#58a6ff', 'today');
  html += chartCard('New designs per day', fillDays(series.designs, 30), '#d29922', 'today');
  html += '</div>';
  return html;
}

/* The old KPI read sum(used) from ai_usage and called it lifetime. That meter
   holds one row per user carrying only the CURRENT hour, reset to 1 on the
   hour — so a heavy user who last generated once yesterday counted as 1. The
   real total comes from ai_events; the meter number is not shown any more. */
function aiBoardKpi(){
  var a = DATA.ai;
  if (!a || a.unavailable || !a.totals) {
    return stat('?', '', 'AI designs delivered', 'history is not recorded on this server', '');
  }
  return stat(a.totals.model, 'designs', 'AI designs delivered', 'of ' + fmt(a.totals.all) + ' AI requests of every kind',
    'Requests to the AI designer that came back with a design, all time. The larger number is every AI request: refusals, the quick designer, Polish, photo reading and chat included.');
}

function trafficTab(){ return trafficSection(DATA.tr, DATA.days); }

function funnelTab(){
  var t = (DATA.ov && DATA.ov.totals) || {};
  var html = '<h2 class="sec">What people do <span class="hint">last ' + DATA.days + ' days &middot; sessions &middot; only visitors who accepted analytics</span></h2>';
  html += funnelHtml(DATA.funnel);
  html += '<p class="note">A session is one browser tab, so one person with two tabs is two sessions. These are only recorded for visitors who accept analytics, so they are lower than the visitor numbers and will never match them. Each row is counted by itself: it is not one group of people followed from step to step, so compare the sizes, and do not read a difference between two rows as people lost.</p>';
  html += '<h2 class="sec">Sharing <span class="hint">' + esc(spanLabel(DATA.sh && DATA.sh.daily, DATA.days)) + ' &middot; counts everyone</span></h2>';
  html += sharesSection(DATA.sh, DATA.days);
  html += '<h2 class="sec">Engagement <span class="hint">all time</span></h2><div class="grid">';
  html += stat(t.votes, plural(t.votes, 'like', 'likes'), 'Likes', fmt(t.dislikes) + plural(t.dislikes, ' dislike', ' dislikes') + ', counted apart', '');
  html += stat(t.comments, plural(t.comments, 'comment', 'comments'), 'Comments', '', '');
  html += stat(t.follows, plural(t.follows, 'follow', 'follows'), 'Follows', '', '');
  html += stat(t.photos, plural(t.photos, 'photo', 'photos'), 'Match photos', fmt(t.verifiedPhotos) + ' verified', '');
  html += '</div>';
  return html;
}

function libraryTab(){
  var ov = DATA.ov, t = ov.totals || {}, mod = ov.moderation || {};
  var drafts = Math.max(0, (t.designs || 0) - (t.publicDesigns || 0) - (t.trashedDesigns || 0));
  var html = '<h2 class="sec">The library <span class="hint">all time</span></h2><div class="grid three">';
  html += stat(t.designs, 'designs', 'Saved', fmt(drafts) + ' private, ' + fmt(t.trashedDesigns) + ' in the Trash', 'Every design row, whatever its state. Designs in the Trash are removed for good after 30 days.');
  html += stat(t.publicDesigns, 'designs', 'Published', 'of which ' + fmt(t.templates) + plural(t.templates, ' is a template', ' are templates'), 'Designs marked public. Templates are inside this number.');
  html += stat(mod.approvedStadiums, 'stadiums', 'Approved from the community', 'live in the stadium picker', '');
  html += '</div>';

  html += '<h2 class="sec">Leaderboards <span class="hint">all time</span></h2><div class="grid two">';
  html += tableCard(['Most-viewed published designs (top 6)','Views','Likes minus dislikes'], ov.topDesigns,
    [function(d){ return d.title || 'Untitled'; }, function(d){ return d.views; }, function(d){ return d.likeScore; }]);
  html += tableCard(['Stadium (top 8, by its code name)','Designs saved on it'], ov.topStadiums,
    [function(d){ return d.templateId; }, function(d){ return d.count; }]);
  html += '</div>';
  html += '<p class="note">The designs, photos and stadiums waiting for a decision are on <a href="#review">Review</a>.</p>';
  return html;
}

function reviewTab(){ return reviewQueues(); }


/* ---- review queues (Library tab) ----

   The work is shown where the count is. Everything a decision needs is on the
   card: a picture (the seat plan for a stadium, the photo, the design's
   thumbnail), who sent it and when, and the two actions. Every request carries
   the unlock token in a header; the server writes each decision to the
   security audit under this session's id. */
var QUEUE = null;
var IMG_CACHE = {};

/* How much is waiting. The queue itself is the truth once it has loaded — the
   overview's counts are a separate query and, in memory mode, not kept at all —
   and after each decision only the queue is updated. */
function queueCounts(){
  var mod = (DATA && DATA.ov && DATA.ov.moderation) || {};
  if (QUEUE && !QUEUE.error){
    /* Each list holds 100 at most. A full list means there may be more, and the
       overview's own count (no ceiling) is then the one to believe. */
    var full = function(list, total){ list = list || []; return list.length >= 100 ? Math.max(list.length, Number(total) || 0) : list.length; };
    return { reports: full(QUEUE.reports, mod.openReports), photos: full(QUEUE.photos, mod.unverifiedPhotos), stadiums: full(QUEUE.stadiums, mod.pendingStadiums) };
  }
  return { reports: Number(mod.openReports)||0, photos: Number(mod.unverifiedPhotos)||0, stadiums: Number(mod.pendingStadiums)||0 };
}

function whenLabel(iso){ try { return timeAgo(iso); } catch(e){ return ''; } }

function stadiumItem(st){
  var meta = [];
  meta.push(esc(st.country || 'no country given'));
  if (st.seats) meta.push('<b>' + fmt(st.seats) + '</b> seats');
  meta.push(fmt(st.tiers) + (st.tiers === 1 ? ' tier' : ' tiers'));
  return '<div class="qitem" data-kind="stadium" data-id="' + esc(st.id) + '">'
    + '<div class="qpic">' + (st.planSvg ? st.planSvg : 'no preview: the seat map could not be built') + '</div>'
    + '<div class="qname">' + esc(st.name) + '</div>'
    + '<div class="qmeta">' + meta.join(' &middot; ') + '<br>sent by <b>' + esc(st.submitter ? '@' + st.submitter : 'a signed-out visitor') + '</b> &middot; ' + esc(whenLabel(st.createdAt)) + '</div>'
    + '<div class="qerr"></div>'
    + '<div class="qacts"><button type="button" class="primary" data-act="approve">Approve</button>'
    + '<button type="button" class="danger" data-act="reject">Reject</button></div></div>';
}

function photoItem(ph){
  var src = '/api/admin/photos/' + encodeURIComponent(ph.id) + '/image';
  return '<div class="qitem" data-kind="photo" data-id="' + esc(ph.id) + '">'
    + '<div class="qpic" data-img="' + esc(src) + '">' + (IMG_CACHE[src] ? '<img alt="" src="' + IMG_CACHE[src] + '">' : 'loading...') + '</div>'
    + '<div class="qname">' + esc(ph.caption || 'No caption') + '</div>'
    + '<div class="qmeta">on <a href="/d/' + encodeURIComponent(ph.designId) + '" target="_blank" rel="noopener">' + esc(ph.designTitle || 'a deleted design') + '</a> &middot; ' + esc(whenLabel(ph.createdAt)) + '</div>'
    + '<div class="qerr"></div>'
    + '<div class="qacts"><button type="button" class="primary" data-act="verify">Verify as genuine</button>'
    + '<button type="button" class="danger" data-act="delete">Delete</button></div></div>';
}

function reportItem(r){
  var gone = r.targetTitle === null;
  var src = '/api/admin/designs/' + encodeURIComponent(r.targetId) + '/thumbnail.png';
  var pic = (!gone && r.targetHasThumbnail)
    ? '<div class="qpic" data-img="' + esc(src) + '">' + (IMG_CACHE[src] ? '<img alt="" src="' + IMG_CACHE[src] + '">' : 'loading...') + '</div>'
    : '<div class="qpic">' + (gone ? 'design deleted' : 'no thumbnail') + '</div>';
  return '<div class="qitem" data-kind="report" data-id="' + esc(r.id) + '" data-target="' + esc(r.targetId) + '">'
    + pic
    + '<div class="qname">' + (gone ? '<em>(design deleted)</em>' : '<a href="/d/' + encodeURIComponent(r.targetId) + '" target="_blank" rel="noopener">' + esc(r.targetTitle) + '</a>')
    + (r.targetIsPublic === false ? ' <span class="badge">already hidden</span>' : '') + '</div>'
    + '<div class="qmeta">reported for <b>' + esc(r.reason) + '</b>' + (gone ? '' : ' &middot; by @' + esc(r.targetOwner || 'unknown')) + ' &middot; ' + esc(whenLabel(r.createdAt)) + '</div>'
    + '<div class="qerr"></div>'
    + '<div class="qacts"><button type="button" data-act="dismiss">Dismiss</button>'
    + (gone ? '' : '<button type="button" class="danger" data-act="takedown">Take down</button>') + '</div></div>';
}

function queueGroup(id, title, items, render, empty){
  var html = '<div class="qhead" id="q-' + id + '">' + esc(title) + ' <span class="badge' + (items.length ? ' warn' : '') + '">' + fmt(items.length) + '</span></div>';
  if (!items.length) return html + '<div class="card"><p class="empty">' + esc(empty) + '</p></div>';
  html += '<div class="qgrid">';
  for (var i = 0; i < items.length; i++) html += render(items[i]);
  return html + '</div>';
}

function reviewQueues(){
  var qc = queueCounts();
  var queue = qc.reports + qc.photos + qc.stadiums;
  var html = '<h2 class="sec">Waiting for review ' + (queue ? '<span class="badge warn">' + fmt(queue) + ' waiting</span>' : '<span class="badge good">all clear</span>') + '</h2>';
  if (!QUEUE || QUEUE.error){
    var why = QUEUE && (QUEUE.error === 401 || QUEUE.error === 403)
      ? 'This admin session was refused. Sign out and sign in again with the admin password.'
      : 'The review queue could not be loaded' + (QUEUE && QUEUE.error ? ' (HTTP ' + QUEUE.error + ')' : '') + '. Try Refresh.';
    return html + '<div class="callout bad"><b>Could not load the queue.</b> ' + esc(why) + '</div>';
  }
  html += queueGroup('stadiums', 'Stadium submissions', QUEUE.stadiums || [], stadiumItem,
    QUEUE.stadiumsEnabled === false ? 'Community stadium submissions are switched off on this server.' : 'No stadium is waiting for review.');
  html += queueGroup('photos', 'Match photos to verify', QUEUE.photos || [], photoItem, 'No photo is waiting to be verified.');
  html += queueGroup('reports', 'Reported designs', QUEUE.reports || [], reportItem, 'No open reports.');
  html += '<p class="note">Approving a stadium puts it in everyone&#39;s stadium picker. Verifying a photo marks it as a genuine match-day photo on its design. Taking a design down makes it private and closes its reports; the owner keeps it. Every decision is written to the Security tab&#39;s audit log.</p>';
  return html;
}

/* Images need the token, so they are fetched rather than linked, and kept as
   data: URLs (the page's CSP allows data:, not blob:) so a repaint after a
   decision does not download them again. */
function loadQueueImages(){
  var nodes = document.querySelectorAll('.qpic[data-img]');
  for (var i = 0; i < nodes.length; i++){
    (function(node){
      var src = node.getAttribute('data-img');
      if (IMG_CACHE[src] || node.getAttribute('data-loading')) return;
      node.setAttribute('data-loading', '1');
      var headers = {}; var t = getUnlock(); if (t) headers['x-ai-unlock'] = t;
      fetch(src, { headers: headers }).then(function(res){
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      }).then(function(blob){
        return new Promise(function(resolve){
          var fr = new FileReader();
          fr.onload = function(){ resolve(String(fr.result)); };
          fr.readAsDataURL(blob);
        });
      }).then(function(url){
        IMG_CACHE[src] = url;
        node.innerHTML = '<img alt="" src="' + url + '">';
      }).catch(function(){ node.textContent = 'image unavailable'; });
    })(nodes[i]);
  }
}

var QUEUE_ACTIONS = {
  approve:  { kind:'stadium', run: function(id){ return post('/api/stadiums/' + encodeURIComponent(id) + '/review', { approve: true }); } },
  reject:   { kind:'stadium', ask:'Reject this stadium submission? It will not appear in the picker.',
              run: function(id){ return post('/api/stadiums/' + encodeURIComponent(id) + '/review', { approve: false }); } },
  verify:   { kind:'photo', run: function(id){ return post('/api/admin/photos/' + encodeURIComponent(id) + '/verify', { verified: true }); } },
  'delete': { kind:'photo', ask:'Delete this photo for good? This cannot be undone.',
              run: function(id){ return del('/api/admin/photos/' + encodeURIComponent(id)); } },
  dismiss:  { kind:'report', run: function(id){ return post('/api/admin/reports/' + encodeURIComponent(id) + '/dismiss', {}); } },
  takedown: { kind:'report', ask:'Take this design down? It becomes private and its open reports are closed.',
              run: function(id, item){ return post('/api/admin/designs/' + encodeURIComponent(item.getAttribute('data-target')) + '/takedown', {}); } }
};

/* After a decision the item leaves the queue and every count that mentions it
   drops with it: the section, the tab badge and the Board's cards. */
function settleQueueItem(kind, id, item){
  if (kind === 'stadium'){
    QUEUE.stadiums = (QUEUE.stadiums || []).filter(function(x){ return x.id !== id; });
  } else if (kind === 'photo'){
    QUEUE.photos = (QUEUE.photos || []).filter(function(x){ return x.id !== id; });
  } else {
    /* A takedown closes every open report on that design, not just this one. */
    var target = item.getAttribute('data-target');
    QUEUE.reports = (QUEUE.reports || []).filter(function(x){ return x.id !== id && !(item.__takedown && x.targetId === target); });
  }
  var y = window.scrollY;
  renderTabs();
  paintSection();
  window.scrollTo(0, y);
}

function wireLibrary(){
  loadQueueImages();
  var body = el('dash-body');
  if (!body || body.__queueWired) return;
  body.__queueWired = true;
  body.addEventListener('click', async function(e){
    var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn || currentTab !== 'review') return;
    var item = btn.closest('.qitem');
    var act = QUEUE_ACTIONS[btn.getAttribute('data-act')];
    if (!item || !act) return;
    if (act.ask && !window.confirm(act.ask)) return;
    var id = item.getAttribute('data-id');
    var err = item.querySelector('.qerr');
    item.classList.add('busy');
    if (err) err.textContent = '';
    var r = await act.run(id, item);
    if (r.ok || r.status === 404){
      /* 404: someone (another tab, the editor panel) already decided it. */
      item.__takedown = btn.getAttribute('data-act') === 'takedown';
      if (btn.getAttribute('data-act') === 'approve' && r.ok && DATA.ov && DATA.ov.moderation){
        DATA.ov.moderation.approvedStadiums = (Number(DATA.ov.moderation.approvedStadiums)||0) + 1;
      }
      settleQueueItem(act.kind, id, item);
      return;
    }
    item.classList.remove('busy');
    if (err) err.textContent = (r.status === 401 || r.status === 403)
      ? 'Refused: this admin session has expired. Sign out and sign in again.'
      : 'Did not go through' + (r.status ? ' (HTTP ' + r.status + ')' : ': no connection') + '. Try again.';
  });
}

function feedbackTab(){ return leadsSection() + feedbackSection(DATA.fb); }

/* ---- AI: what people actually did with the designer ----

   Everything here comes from ai_events, not ai_usage. The meter only ever
   knew the current hour, so before this table existed none of these questions
   had an answer: how much has been generated, has anyone hit the cap, how
   often does premium fail, how many people take the free offline designer.  */
function aiTab(){
  var a = DATA.ai;
  if (!a || a.unavailable){
    return '<h2 class="sec">AI</h2><div class="card"><p class="empty">AI history is not being recorded on this server.</p></div>';
  }
  var W = a.window || {}, T = a.totals || {};
  var since = a.since ? new Date(a.since) : null;
  var sinceLabel = since ? 'since ' + since.toLocaleDateString() : 'nothing recorded yet';

  var html = '<h2 class="sec">AI <span class="hint">last ' + a.days + ' days &middot; requests, not people &middot; days are UTC days &middot; totals ' + esc(sinceLabel) + '</span></h2>';
  html += '<p class="lede">Every number here is a count of requests. One person asking five times is five. What each request cost is further down.</p>';

  html += '<div class="grid three">';
  html += stat(W.model, plural(W.model, 'design', 'designs'), 'Designs delivered', fmt(T.model) + ' all time',
    'Requests to the AI designer that came back with a design. It includes designs that arrived without their picture, and runs made with the admin password, which spend nobody\\'s allowance.');
  html += stat(W.quick, plural(W.quick, 'design', 'designs'), 'Made by the quick designer', 'the free engine on the site, no model call', '');
  html += stat(W.cache, plural(W.cache, 'request', 'requests'), 'Answered from the cache', 'free, no model call', '');
  html += stat(W.quota, plural(W.quota, 'request', 'requests'), 'Refused by a limit', fmt(T.quota) + ' all time',
    'Any request turned away because an allowance was used up: the designs of a day or a month, Polish, photo reading, cut-out, review or chat. Each try counts, so one person pressing three times is three.');
  html += stat(W.busy, plural(W.busy, 'request', 'requests'), 'Model busy or failed', 'the reasons are under Why it failed',
    'The model did not answer, or answered with something unusable. A refusal by the provider\\'s own safety filter is counted here too.');
  html += stat(W.blocked, plural(W.blocked, 'request', 'requests'), 'Stopped by our prompt check', fmt(T.blocked) + ' all time', 'Our own screen of the prompt, before any model is called.');
  html += '</div>';

  html += textModelsSection(a.text);
  html += aiReliabilitySection(a);
  html += aiCostSection(a);
  html += picturesSection(a.pictures);

  /* The question that started this: has anyone actually been turned away? */
  html += '<h2 class="sec">Who has been refused by a limit <span class="hint">all time, not the period &middot; the 20 refused most</span></h2>';
  if (!a.hitCap || !a.hitCap.length){
    html += '<div class="card"><p class="empty">Nobody has been refused by a limit yet.</p>'
         +  '<p class="note">With Pro on, a free account has a daily and a monthly allowance of AI designs, and Pro has its own month. A refusal by any of them would be listed here.</p></div>';
  } else {
    html += tableCard(['Account','Times refused','Last time'], a.hitCap,
      [function(d){ return d.username; }, function(d){ return d.times; }, function(d){ return new Date(d.last).toLocaleString(); }]);
  }

  html += aiFailuresSection(a);

  html += '<h2 class="sec">Per day <span class="hint">last ' + a.days + ' days</span></h2>';
  html += '<div class="grid two">';
  html += chartCard('Designs delivered', seriesOf(a.perDay, 'model'), '#a371f7');
  html += chartCard('Made by the quick designer', seriesOf(a.perDay, 'quick'), '#39c5cf');
  html += '</div>';

  html += '<h2 class="sec">Who uses it <span class="hint">last ' + a.days + ' days &middot; the 20 with the most designs</span></h2>';
  html += tableCard(['Account','Designs delivered','Quick designer','Refused by a limit','Last request of any kind'], a.topUsers,
    [function(d){ return d.username; }, function(d){ return d.model; }, function(d){ return d.quick; },
     function(d){ return d.quota; }, function(d){ return new Date(d.last).toLocaleDateString(); }]);

  var modes = a.modes || { std:0, super:0, polish:0, photo:0, cutout:0, critique:0, chat:0 };
  html += '<h2 class="sec">Reference</h2><div class="grid">';
  html += stat(modes.super, plural(modes.super, 'request', 'requests'), 'Asked for the whole stadium', 'any outcome, in the period', 'Requests marked Super. Since 29 Oct 2026 both marks go through the same designer; the mark only says what was asked for.');
  html += stat(modes.std, plural(modes.std, 'request', 'requests'), 'Asked for one design', 'any outcome, in the period', 'Requests marked Standard.');
  html += stat(a.meteredAccounts, plural(a.meteredAccounts, 'account', 'accounts'), 'On the old hourly meter', 'all time; not growing while Pro is on', 'Accounts that used the hourly meter from before Pro. Accounts on the new daily and monthly allowances never get counted here.');
  html += stat(W.all, plural(W.all, 'request', 'requests'), 'All AI requests', fmt(T.all) + ' all time', 'Every recorded request of every kind and outcome. The six figures at the top do not add up to this: Polish, photo reading, cut-out, review and chat are only in this one.');
  html += '</div>';
  html += '<p class="note">Prompt text is deliberately not stored \u2014 only what happened to each request. The outcome is what pricing and capacity need; the text is the part that would put this table at odds with the privacy page.</p>';
  return html;
}


/* ---- which models answer ----

   Claude first and Gemini behind it (October 2026). The one thing worth
   shouting about is Claude being paused: its key refused, or the month's API
   credit spent, so Gemini is answering everything until the pause ends. */
var PROVIDER_NAME = { anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI', none: 'none' };
function textModelsSection(t){
  if (!t || !t.main || t.main === 'none') return '';
  var main = PROVIDER_NAME[t.main] || t.main;
  var html = '<h2 class="sec">Text models <span class="hint">who writes the designs</span></h2>';
  html += '<div class="card"><div class="posture-row"><div>' + picChip(t.paused ? 'bad' : 'good', t.paused ? 'paused' : 'first') + '</div><div><b>' + esc(main) + '</b> <span class="dim">main</span></div>'
    + '<div class="pd">Standard designs and the copywriter: <b>' + esc(t.models.fast) + '</b> &middot; Super, Polish and photos: <b>' + esc(t.models.premium) + '</b></div></div>';
  if (t.backup){
    var b = t.backupModels || {};
    html += '<div class="posture-row"><div>' + picChip('info', 'backup') + '</div><div><b>' + esc(PROVIDER_NAME[t.backup] || t.backup) + '</b> <span class="dim">when ' + esc(main) + ' cannot</span></div>'
      + '<div class="pd">' + esc(b.fast || '') + ' &middot; ' + esc(b.premium || '') + (b.fallback ? ', then ' + esc(b.fallback) : '') + '</div></div>';
  }
  html += '</div>';
  if (t.paused){
    html += '<div class="callout bad"><b>' + esc(PROVIDER_NAME[t.paused.provider] || t.paused.provider) + ' is paused until ' + esc(new Date(t.paused.until).toLocaleTimeString()) + '</b>'
      + (t.backup ? ', and ' + esc(PROVIDER_NAME[t.backup] || t.backup) + ' is writing every design meanwhile' : '') + '. It answered: <span class="dim">' + esc(t.paused.why) + '</span>'
      + (/credit|usage limit/i.test(t.paused.why) ? ' The month&#39;s Claude API credit is spent; the next one arrives with the Max plan&#39;s renewal.' : '') + '</div>';
  } else if (!t.backup && t.main !== 'gemini'){
    html += '<p class="note">No backup: when ' + esc(main) + ' is busy or out of credit, premium designs end &ldquo;busy&rdquo;. Set GEMINI_API_KEY (Google&#39;s free tier is enough).</p>';
  }
  return html;
}

/* ---- how often each mode delivers ----

   "Model busy or failed" above is every mode together, and Super, Standard,
   Polish and photo reading fail for different reasons at very different rates.
   Polish and photo successes are recorded from October 2026; before that only
   their failures were, so their early rates read as 0%. */
function aiReliabilitySection(a){
  var mo = a.modeOutcomes, c = a.cost || {};
  if (!mo) return '';
  var lat = c.latencyMs || {}, by = c.byMode || {};
  var rows = [];
  var order = ['super', 'std', 'critique', 'chat', 'polish', 'photo', 'cutout'];
  for (var i = 0; i < order.length; i++){
    var m = order[i], o = mo[m] || {};
    var limited = o.limited || 0;
    var failed = Math.max(0, (o.busy || 0) - limited);
    var asked = (o.model || 0) + failed;
    if (!o.all) continue;
    rows.push({ mode: MODE_LABEL[m] || m, all: o.all, model: o.model || 0, busy: failed, limited: limited,
      rate: asked ? pct(o.model || 0, asked) : '—',
      wait: lat[m] == null ? '—' : (Math.round(lat[m] / 100) / 10) + ' s',
      each: by[m] && by[m].perDelivered != null ? usd(by[m].perDelivered) : '—' });
  }
  if (!rows.length) return '';
  var html = '<h2 class="sec">How often each mode delivers <span class="hint">last ' + a.days + ' days</span></h2>';
  html += tableCard(['Mode','Requests','Delivered','Busy or failed','Our limits','Success','Average wait','Cost each'], rows,
    [function(d){ return d.mode; }, function(d){ return d.all; }, function(d){ return d.model; }, function(d){ return d.busy; },
     function(d){ return d.limited; }, function(d){ return d.rate; }, function(d){ return d.wait; }, function(d){ return d.each; }]);
  html += '<p class="note">Success is delivered ÷ (delivered + busy or failed). <b>Our limits</b> are requests our own rules turned away before any model was asked (the daily AI budget, an account&#39;s daily Polish or photo share, no provider set) and are left out of it. A request answered by the fallback model counts as delivered; the model table below says how many were.</p>';
  return html;
}

/* ---- what the AI cost ----

   Every request since the October 2026 release carries the provider's own
   token counts and the model that answered; before, every cost figure was an
   estimate from prompt sizes. Prices are LIST prices (paid tier, aiPricing.ts):
   a project on Google's free tier pays nothing, so these say what the same
   traffic costs once billing is on. Thinking is billed as output. */
function usd(n){
  n = Number(n) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 10) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}
function aiCostSection(a){
  var c = a.cost;
  var html = '<h2 class="sec">What it cost <span class="hint">last ' + a.days + ' days &middot; list prices</span></h2>';
  if (!c || !c.measured){
    return html + '<div class="card"><p class="empty">No measured requests yet.</p>'
      + '<p class="note">Token counts are recorded from this release on; older requests carry none.</p></div>';
  }
  var t = c.tokens || { in: 0, out: 0, thought: 0, cached: 0 }, by = c.byMode || {};
  html += '<div class="grid">';
  html += kpi('Estimated spend', usd(c.usd), c.unpriced ? fmt(c.unpriced) + (c.unpriced === 1 ? ' request had' : ' requests had') + ' no price' : fmt(c.measured) + ' measured requests', true);
  html += kpi('Per Super design', by['super'] && by['super'].perDelivered != null ? usd(by['super'].perDelivered) : '—', fmt(by['super'] ? by['super'].delivered : 0) + ' delivered', true);
  html += kpi('Per Standard design', by.std && by.std.perDelivered != null ? usd(by.std.perDelivered) : '—', fmt(by.std ? by.std.delivered : 0) + ' delivered', true);
  html += kpi('Thinking', pct(t.thought, t.thought + t.out), 'of output tokens: ' + fmt(t.thought) + ' thinking, ' + fmt(t.out) + ' answer', true);
  html += kpi('Pictures', c.pictures, 'delivered with designs', true);
  html += kpi('Input tokens', t.in, fmt(t.cached) + ' served from cache', true);
  html += '</div>';
  if (c.models && c.models.length){
    html += '<h3 class="sub">Which model answered <span class="hint">delivered results &middot; a fallback model shows up here</span></h3>';
    html += tableCard(['Model','Delivered','Spend'], c.models,
      [function(d){ return d.model; }, function(d){ return d.requests; }, function(d){ return d.usd == null ? 'no price' : usd(d.usd); }]);
  }
  /* One day is a dot, not a trend: the line needs two. */
  if (c.perDay && c.perDay.length > 1){
    var pts = [];
    for (var i = 0; i < c.perDay.length; i++) pts.push({ day: c.perDay[i].day, count: Math.round(c.perDay[i].usd * 100) / 100 });
    html += '<h3 class="sub">Spend per day</h3>';
    html += '<div class="grid two">' + chartCard('Estimated spend per day (US$)', pts, '#e3b341') + '</div>';
  }
  html += '<p class="note">Measured since ' + esc(c.measuredSince ? new Date(c.measuredSince).toLocaleDateString() : '—')
    + '. Cost each = all spend in a mode, failed calls included, divided by what it delivered (results with no price left out). Prices change: 3.6 Flash doubles on 1 January 2027, and each request keeps the price it ran at. A call that timed out is counted as $0: no token counts come back for it, though it may still be billed. Claude&#39;s share is paid from the Max plan&#39;s monthly API credit, not in cash, and Claude does not report its thinking apart from the answer.</p>';
  return html;
}

/* ---- why the AI failed ----

   The editor now tells a person only what they can act on ("the AI is busy,
   try again in a minute"). Everything else lands here: the precise reason, what
   to do about it, the account that hit it and what the provider actually said
   (credential-shaped text masked on the server). Categories come from
   server/src/aiFailure.ts. */
var REASON_INFO = {
  overloaded:      ['Provider overloaded', 'The model provider is short of capacity (HTTP 503, "high demand"). The fallback model (AI_MODEL_FALLBACK) is asked next, so a row here means it failed too. If it keeps happening, point AI_MODEL_PREMIUM / AI_MODEL_FAST at a less busy model.'],
  rate_limited:    ['Rate limit or quota', 'Our API key hit the provider&#39;s quota (HTTP 429), or the month&#39;s Claude API credit is spent (it comes back with the Max plan&#39;s renewal), and the backup could not answer either. On Google&#39;s free tier the Flash models allow only 20 requests a day.'],
  budget:          ['Daily budget spent', 'Our own AI_DAILY_BUDGET breaker tripped. Raise it, or wait for 00:00 UTC.'],
  timeout:         ['Timed out', 'No answer inside AI_TIMEOUT_MS / AI_TIMEOUT_PREMIUM_MS. Raise the limit or use a faster model.'],
  network:         ['Could not reach the provider', 'The server&#39;s request never got an answer: DNS, egress or an outage.'],
  auth:            ['Key refused', 'HTTP 401/403: the API key is wrong, expired, or has no access to this model.'],
  model_not_found: ['Model not found', 'HTTP 404: the model id in AI_MODEL_* does not exist (or was retired). Fix the env var.'],
  bad_request:     ['Request refused', 'HTTP 400: the provider rejected the request itself. The detail says which field.'],
  safety:          ['Provider safety filter', 'The model refused the brief or its own answer. Usually a name or phrase in the brief.'],
  prompt_screen:   ['Blocked by our prompt screen', 'promptSafety.ts refused the brief before any model saw it. The detail names the list that matched.'],
  truncated:       ['Answer cut off', 'The model ran out of output tokens mid-design. Raise AI_MAX_OUTPUT_TOKENS.'],
  bad_output:      ['Unreadable answer', 'The model replied, but not with JSON we could read.'],
  invalid_design:  ['Design failed validation', 'JSON arrived but the spec validator rejected it. The detail lists the first problems.'],
  picture_failed:  ['Picture not generated', 'The design was delivered without its picture and was not charged. Every picture provider was tried (main, then backup) and none delivered. The Pictures section above says which one is failing and why.'],
  no_provider:     ['No AI provider configured', 'Set GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.'],
  upstream_error:  ['Provider error', 'The provider answered with a server error (5xx).'],
  unknown:         ['Unclassified', 'Read the detail; if it recurs, it deserves its own category in aiFailure.ts.']
};
var MODE_LABEL = { std:'Premium', 'super':'Super AI', polish:'Polish', photo:'Photo reading', cutout:'Smart cut-out', critique:'Critique', chat:'Critique chat' };
function reasonLabel(r){ return (REASON_INFO[r] || [labelize(r)])[0]; }

function aiFailuresSection(a){
  var fails = a.failures || [], recent = a.recentFailures || [];
  var html = '<h2 class="sec">Why it failed <span class="hint">last ' + a.days + ' days</span></h2>';
  if (!fails.length){
    return html + '<div class="card"><p class="empty">No failures recorded in this window.</p>'
      + '<p class="note">Reasons are recorded from this release on; older "busy" rows above have no reason attached.</p></div>';
  }
  html += '<div class="card">';
  for (var i = 0; i < fails.length; i++){
    var f = fails[i], info = REASON_INFO[f.reason] || [labelize(f.reason), ''];
    html += '<div class="why"><div class="wl">' + esc(info[0]) + '</div><div class="wf">' + info[1] + '</div>'
      + '<div class="wn">' + fmt(f.count) + '<span>last ' + esc(timeAgo(f.last)) + '</span></div></div>';
  }
  html += '</div>';
  html += '<h3 class="sub">Recent failures <span class="hint">newest first &middot; up to 50</span></h3>';
  html += '<div class="card scroll"><table><thead><tr><th>When</th><th class="name">Account</th><th>Mode</th><th>Reason</th><th>What the provider said</th></tr></thead><tbody>';
  for (var j = 0; j < recent.length; j++){
    var r = recent[j];
    html += '<tr><td class="when" title="' + esc(new Date(r.at).toLocaleString()) + '">' + esc(timeAgo(r.at)) + '</td>'
      + '<td class="name" title="' + esc(r.username) + '">' + esc(r.username) + (r.via === 'password' && r.username.indexOf('admin password') !== 0 ? '<span class="via">admin password</span>' : '') + '</td>'
      + '<td>' + esc(MODE_LABEL[r.mode] || r.mode) + '</td>'
      + '<td>' + esc(reasonLabel(r.reason)) + '</td>'
      + '<td class="detail">' + esc(r.detail || '—') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  html += '<p class="note">People only ever see a short, translated sentence (busy, resting, too slow, declined, incomplete, unavailable) with a way forward. The provider&#39;s text is kept here and never sent to the editor. Prompts are still not stored.</p>';
  return html;
}

/* ---- pictures: which provider is making them, and is it working ----

   Live state since the last restart (server/src/imageHealth.ts), not history.
   Built after the Pollinations credit ran out on 28 Sep 2026 and every Super AI
   design shipped with a bare stand for a day before anyone noticed. */
var PIC_KIND = { credit:'out of credit', auth:'key refused', rate:'rate limited', down:'not answering', refused:'refused the prompt', other:'failed' };
function picChip(cls, word){ return '<span class="st ' + cls + '">' + esc(word) + '</span>'; }
function inMinutes(iso){
  var m = Math.max(1, Math.round((new Date(iso).getTime() - Date.now())/60000));
  return m + ' min';
}
function picturesSection(p){
  if (!p) return '';
  var list = p.providers || [];
  var html = '<h2 class="sec">Pictures <span class="hint">since the server started ' + esc(timeAgo(p.since)) + '</span></h2>';
  if (!list.length){
    return html + '<div class="card"><p class="empty">No picture provider has a key, so AI designs arrive without pictures.</p>'
      + '<p class="note">Set AI_POLLINATIONS_KEY (from enter.pollinations.ai) or GEMINI_API_KEY in Railway.</p></div>';
  }
  var mainRow = null, backupRow = null, backups = p.backups || (p.backup ? [p.backup] : []);
  html += '<div class="card">';
  for (var i = 0; i < list.length; i++){
    var r = list[i], chip, bits = [];
    if (r.provider === p.main) mainRow = r;
    /* The backup that matters is the first one still working. */
    if (backups.indexOf(r.provider) >= 0 && (!backupRow || (backupRow.pausedUntil && !r.pausedUntil))) backupRow = r;
    var lastFailAt = r.lastFailure ? new Date(r.lastFailure.at).getTime() : 0;
    var lastOkAt = r.lastOk ? new Date(r.lastOk).getTime() : 0;
    if (r.pausedUntil) chip = picChip('bad', 'paused');
    else if (lastFailAt && lastFailAt > lastOkAt) chip = picChip('warn', 'failing');
    else if (lastOkAt) chip = picChip('good', 'working');
    else chip = picChip('info', 'not used yet');
    bits.push(fmt(r.delivered) + ' delivered, ' + fmt(r.failed) + ' failed');
    if (r.pausedUntil) bits.push('<b>' + esc(PIC_KIND[r.pausedFor] || 'paused') + '</b>: skipped while the other provider works, tried again in ' + esc(inMinutes(r.pausedUntil)));
    if (r.lastFailure) bits.push('last problem ' + esc(timeAgo(r.lastFailure.at)) + ': ' + esc(PIC_KIND[r.lastFailure.kind] || r.lastFailure.kind)
      + (r.lastFailure.detail ? ' <span class="dim">(' + esc(r.lastFailure.detail) + ')</span>' : ''));
    var role = r.provider === p.main ? 'main' : (backups.indexOf(r.provider) >= 0 ? 'backup' : 'not in use');
    html += '<div class="posture-row"><div>' + chip + '</div><div><b>' + esc(r.label) + '</b> <span class="dim">' + role + '</span></div><div class="pd">' + bits.join(' &middot; ') + '</div></div>';
  }
  html += '</div>';

  if (mainRow && mainRow.pausedUntil){
    html += backupRow && !backupRow.pausedUntil
      ? '<div class="callout"><b>' + esc(backupRow.label) + ' is making the pictures</b> because ' + esc(mainRow.label) + ' is ' + esc(PIC_KIND[mainRow.pausedFor] || 'paused') + '. People are not affected' + (backupRow.provider === 'gemini' ? ', but Gemini pictures cost more.' : backupRow.provider === 'cloudflare' ? ' (free for about 170 pictures a day).' : '.') + '</div>'
      : '<div class="callout bad"><b>No provider can make pictures right now.</b> ' + esc(mainRow.label) + ' is ' + esc(PIC_KIND[mainRow.pausedFor] || 'paused') + (backupRow ? ' and the backup is failing too' : ' and there is no backup') + '. AI designs arrive without their picture (and are not charged).</div>';
  }
  if (!p.backup){
    html += '<p class="note">No backup provider: when ' + esc(mainRow ? mainRow.label : 'the main provider') + ' fails, pictures are lost. Set AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN for a free backup, about 170 pictures a day (AI_IMAGE_FALLBACK=none turns backups off).</p>';
  }
  var sums = [];
  sums.push(fmt(p.servedByBackup) + ' picture' + (p.servedByBackup === 1 ? '' : 's') + ' made by the backup');
  sums.push(fmt(p.failedEverywhere) + ' lost (no provider delivered)');
  html += '<p class="note">' + sums.join(' &middot; ') + '. '
    + (p.alerts && p.alerts.to
      ? 'Problems are emailed to ' + esc(p.alerts.to) + ': when a provider runs out of credit or its key is refused, and when pictures fail everywhere.'
      : '<b>Nobody is emailed about picture problems.</b> Set AI_ALERT_TO (or SECURITY_ALERT_TO) in Railway.')
    + '</p>';
  var sent = (p.alerts && p.alerts.sent) || [];
  if (sent.length){
    html += '<h3 class="sub">Picture alerts <span class="hint">newest first &middot; since the server started</span></h3>';
    html += tableCard(['When','Alert','Emailed'], sent,
      [function(d){ return timeAgo(d.at); }, function(d){ return d.subject; }, function(d){ return d.delivered ? 'yes' : (d.error || 'sending'); }]);
  }
  return html;
}

/* chartCard wants a plain {day,count} series. */
function seriesOf(perDay, key){
  var out = [];
  for (var i = 0; i < (perDay || []).length; i++) out.push({ day: perDay[i].day, count: perDay[i][key] });
  return out;
}

function paintSection(){
  var html = '';
  if (currentTab === 'board') html = boardSection();
  else if (currentTab === 'traffic') html = trafficTab();
  else if (currentTab === 'funnel') html = funnelTab();
  else if (currentTab === 'ai') html = aiTab();
  else if (currentTab === 'pro') html = proTab();
  else if (currentTab === 'orders') html = ordersTab();
  else if (currentTab === 'prices') html = pricesTab();
  else if (currentTab === 'members') html = membersTab();
  else if (currentTab === 'events') html = eventsTab();
  else if (currentTab === 'library') html = libraryTab();
  else if (currentTab === 'review') html = reviewTab();
  else if (currentTab === 'feedback') html = feedbackTab();
  else if (currentTab === 'email') html = emailTab();
  else if (currentTab === 'security') html = securityTab();
  el('dash-body').innerHTML = html;
  if (currentTab === 'email') wireEmailTest();
  if (currentTab === 'security') wireSecurity();
  if (currentTab === 'review') wireLibrary();
  if (currentTab === 'feedback'){ wireFeedback(); wireLeads(); }
  if (currentTab === 'traffic') wireLinkBuilder();
  if (currentTab === 'pro') wireLaunch();
  if (currentTab === 'orders'){ wireOrders(); wireRequests(); wireSubs(); }
  if (currentTab === 'prices') wirePrices();
  if (currentTab === 'members'){ wireMembers(); wireLookup(); }
  if (currentTab === 'events') wireEvents();
}

/* ---- pro: who Pro is on for, what is held, and passes by hand ----
   Everything here reads and writes on the server (server/src/proRoutes.ts);
   a grant or revoke is written to the Security tab's audit trail. */
var PRO = null;
var PRO_LOOKUP = null;
var PRO_PLAN_LABEL = { monthly:'Pro monthly', gift:'7-day gift' };
var PRO_MODE_TEXT = {
  off: 'Off: nobody sees Pro; everyone keeps the old AI limits.',
  preview: 'Preview: only the accounts in PRO_PREVIEW_USERS see Pro and its limits.',
  on: 'On: everyone has the new free limits, the gift and the Pro page.'
};
function proTab(){
  var html = '<h2 class="sec">Pro and launch</h2>';
  if (!PRO || PRO.error){
    return html + '<div class="callout bad"><b>Could not load Pro.</b> HTTP ' + esc(String((PRO && PRO.error) || '?')) + '</div>';
  }
  var st = PRO.stats || { gifts:{}, passes:{} };
  html += '<p class="lede">' + esc(PRO_MODE_TEXT[PRO.mode] || PRO.mode) + (PRO.mode === 'preview' ? ' (' + fmt(PRO.previewUsers) + ' account' + (PRO.previewUsers === 1 ? '' : 's') + ')' : '') + '</p>';
  if (PRO.mode === 'preview' && !PRO.previewUsers) html += '<div class="callout warn"><b>Preview with nobody in it.</b> Set PRO_PREVIEW_USERS to your username (comma-separated for more) and redeploy.</div>';
  if (!PRO.throwawayList || !PRO.throwawayList.loaded) html += '<div class="callout bad"><b>The throwaway email list did not load</b>, so no gifts are offered. ' + esc((PRO.throwawayList && PRO.throwawayList.error) || '') + '</div>';
  if (!PRO.cutoutConfigured) html += '<div class="callout warn"><b>Smart cut-out has no provider.</b> It uses AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN (the picture backup\\'s). Until both are set, the cut-out button says it is not available.</div>';
  if (!PRO.paymentsOpen && !(ORDERS && ORDERS.status && ORDERS.status.on)) html += '<div class="callout"><b>Payments are not open.</b> /pro is a coming-soon page: it shows no price, asks what a month is worth, and offers "Tell me when Pro opens". The answers are on <a href="#prices">Price research</a>.</div>';

  html += '<div class="grid three">' + proHeadline() + '</div>';
  html += '<p class="note">The people are on <a href="#members">Members</a>; the orders, refunds and how payments are set up are on <a href="#orders">Orders and refunds</a>.</p>';

  html += giftHtml(st.gifts || {});
  html += launchHtml();
  html += turnaroundHtml();
  html += tellMeHtml(st);
  return html;
}

/* ---- the 7-day gift: eligible, shown, started, running ----
   "Gifts offered" used to be the first number here. It counted the accounts
   the server had found eligible, and a row is written the moment an eligible
   account's browser asks for its Pro state, on any page. The offer itself is a
   card on My projects that hides for three days after "Later". So it is named
   for what it is, and the showing is its own step (recorded from 22 Nov 2026). */
function giftHtml(g){
  var top = g.offered || 0;
  var html = '<h2 class="sec">The 7-day gift <span class="hint">all time</span></h2><div class="card"><div class="steps">';
  html += stepRow('Eligible for the gift', top, top, 'verified email, one saved design, never had Pro');
  if (g.seenSince) html += stepRow('Were shown the offer', g.seen || 0, top, 'the card on My projects, or the gift sheet');
  else html += stepRow('Were shown the offer', 0, top, 'the card on My projects, or the gift sheet', true);
  html += stepRow('Started the gift', g.accepted || 0, top, '');
  html += stepRow('On the gift now', g.active || 0, top, 'the 7 days have not run out');
  html += '</div></div>';
  html += '<p class="note">An account becomes eligible when its browser asks for its Pro state, on any page; that is not the same as seeing the offer. '
    + (g.seenSince
      ? 'Showings are recorded since ' + esc(riyadh(g.seenSince)) + '. An offer shown before then counts as shown only if the gift was started, so the second step reads low until the older offers have been seen again.'
      : 'Whether the offer was shown has not been recorded yet: it starts with the first fan who sees the card after this version is live. Until then the share who took the gift cannot be worked out, only that it is at least ' + pct(g.accepted || 0, top) + ' of the eligible.')
    + '</p>';
  return html;
}

/* ---- the "tell me" list and the price question, from before the launch ----
   Answering the price question while signed in adds the account to the "tell
   me" list (the thank-you the question promises). The count used to read
   "Asked to hear when Pro opens", as if each had pressed the button. */
function tellMeHtml(st){
  var via = st.notifyVia || { price: 0, wontPay: 0 }, n = st.notify || 0;
  var pressed = Math.max(0, n - (via.price || 0));
  var html = '<h2 class="sec">Before the launch <span class="hint">all time</span></h2><div class="grid three">';
  html += stat(n, plural(n, 'account', 'accounts'), 'On the tell-me list',
    fmt(via.price) + ' put there by answering the price question, ' + fmt(pressed) + ' by pressing Tell me only',
    'One row per account. Answering the price question while signed in adds the account, so this is not a count of people who asked to be told. ' + fmt(via.wontPay) + ' of them answered "Not for me". The founders were taken from this list at the launch.');
  html += stat((PRICES && PRICES.total) || 0, plural((PRICES && PRICES.total) || 0, 'answer', 'answers'), 'Price answers',
    'from /pro and the card in the editor',
    'One answer per account, or per browser for someone signed out. The medians and every answer are on Price research.');
  html += '</div>';
  return html;
}

function ordersTab(){
  return ordersHtml() + subsHtml();
}
function pricesTab(){
  return pricesHtml();
}

/* ---- one account: its plan, its gift, every pass (bottom of Members) ---- */
function lookupHtml(){
  var html = '<h2 class="sec">Look up one account</h2>';
  html += '<p class="note"><label>Username <input id="pro-user" type="text" autocomplete="off" spellcheck="false" maxlength="32" value="' + esc(PRO_LOOKUP || '') + '"></label> '
        + '<button id="pro-find" type="button">Look up</button></p>';
  var a = PRO && PRO.account;
  if (a){
    html += '<table class="tbl"><tbody>'
      + '<tr><th>Account</th><td>@' + esc(a.username) + (a.emailVerified ? '' : ' <b class="warn">(email not verified)</b>') + '</td></tr>'
      + '<tr><th>Pro on for them</th><td>' + (a.live ? 'yes' : 'no (PRO_MODE)') + '</td></tr>'
      + '<tr><th>Plan now</th><td>' + esc(a.plan === 'free' ? 'Free' : (PRO_PLAN_LABEL[a.plan] || a.plan)) + '</td></tr>'
      + '<tr><th>Gift</th><td>' + (a.gift
          ? (a.gift.acceptedAt ? 'started ' + esc(riyadh(a.gift.acceptedAt))
            : 'eligible since ' + esc(riyadh(a.gift.offeredAt)) + ', not started' + (a.gift.seenAt ? '; shown the offer ' + esc(riyadh(a.gift.seenAt)) : '; not recorded as shown'))
          : 'not eligible, or has not opened the site since Pro was on') + '</td></tr>'
      + '</tbody></table>';
    if (a.passes && a.passes.length){
      html += '<table class="tbl"><thead><tr><th>Pass</th><th>How</th><th>From</th><th>Until</th><th></th></tr></thead><tbody>';
      for (var i = 0; i < a.passes.length; i++){
        var p = a.passes[i];
        var over = p.revokedAt || Date.parse(p.endsAt) <= Date.now();
        html += '<tr><td>' + esc(PRO_PLAN_LABEL[p.plan] || p.plan) + '</td><td>' + esc(p.source) + '</td><td>' + esc(riyadh(p.startsAt)) + '</td><td>' + esc(riyadh(p.endsAt)) + '</td><td>'
          + (p.revokedAt ? 'revoked' : over ? 'ended' : '<button type="button" class="pro-revoke" data-pass="' + esc(p.id) + '">Revoke</button>') + '</td></tr>';
      }
      html += '</tbody></table>';
    }
  } else if (PRO_LOOKUP){
    html += '<p class="note">No account called @' + esc(PRO_LOOKUP) + '.</p>';
  }
  html += '<p id="pro-out" class="note" role="status" aria-live="polite"></p>';
  return html;
}
async function proReload(){
  var both = await Promise.all([
    api('/api/admin/pro' + (PRO_LOOKUP ? '?username=' + encodeURIComponent(PRO_LOOKUP) : '')),
    api('/api/admin/pro/prices'),
    api('/api/admin/pro/orders'),
    api('/api/admin/pro/subscriptions'),
    api('/api/admin/pro/refund-requests'),
    api('/api/admin/pro/launch'),
    api('/api/admin/pro/members')
  ]);
  /* A grant, a revoke or a refund changes who is a member: the Members tab and its count follow. */
  MEMBERS = both[6].ok && both[6].data ? both[6].data : { error: both[6].status };
  LAUNCH = both[5].ok && both[5].data ? both[5].data : { error: both[5].status };
  REQS = both[4].ok && both[4].data ? both[4].data : { error: both[4].status };
  SUBS = both[3].ok && both[3].data ? both[3].data : { error: both[3].status };
  PRO = both[0].ok && both[0].data ? both[0].data : { error: both[0].status };
  PRICES = both[1].ok && both[1].data ? both[1].data : { error: both[1].status };
  ORDERS = both[2].ok && both[2].data ? both[2].data : { error: both[2].status };
  renderTabs();
  paintSection();
  loadProFunnel();
}


/* ---- the turnaround (22 Nov 2026): the settings, the automatic gift, the Pro funnel ----
   Everything here is read-only. The settings are Railway variables; this only
   says how the server reads them. The funnel's "saw" and "pressed" are the
   consent-gated events (only visitors who allowed counting); "paid" is the
   orders themselves, under the place each checkout named. */
var PROFUNNEL = null;
var PLACE_LABEL = { post: 'Post it', share: 'Share dialog', 'export': 'Export sheet', page: 'The Pro page', giftend: 'After the gift', limit: 'A limit card', account: 'Account page' };
function loadProFunnel(){
  api('/api/admin/pro/funnel?days=' + currentDays).then(function(r){
    PROFUNNEL = r.ok && r.data ? r.data : { error: r.status };
    if (typeof paintSection === 'function') paintSection();
  });
}
function onOff(v){ return v ? '<b>on</b>' : 'off'; }
function turnaroundHtml(){
  if (!PRO || PRO.error) return '';
  var s = PRO.settings || {}, m = s.match || {}, y = s.year || {}, g = PRO.giftsStarted || null;
  var html = '<h2 class="sec">Switches <span class="hint">Railway variables, as the server reads them now</span></h2><div class="card"><table class="tbl"><tbody>';
  html += '<tr><td>PRO_MONTHLY_PRICE</td><td>' + (s.monthlyPriceInvalid ? '<b>not a price from SAR 1 to SAR 100: ignored</b>' : s.monthlyPrice == null ? 'unset: the launch and regular prices decide' : '<b>SAR ' + esc(String(s.monthlyPrice)) + '</b> for 30 days, with no launch price beside it') + '</td></tr>';
  html += '<tr><td>PRO_MATCH_PASS</td><td>' + onOff(m.asked) + ': SAR ' + esc(String(m.price)) + ' for ' + esc(String((m.days || 0) * 24)) + ' hours' + (m.asked && !PRO.paymentsOpen ? ' (not sold until Pro is on sale)' : '') + '</td></tr>';
  html += '<tr><td>PRO_YEAR</td><td>' + onOff(y.asked) + ': SAR ' + esc(String(y.price)) + ' for ' + esc(String(y.days || 0)) + ' days, one payment, never renews' + (y.priceInvalid ? ' <b>(PRO_YEAR_PRICE is not a price from SAR 1 to SAR 100: ignored)</b>' : '') + (y.asked && !PRO.paymentsOpen ? ' (not sold until Pro is on sale)' : '') + '</td></tr>';
  html += '<tr><td>PRO_THREE_PLANS</td><td>' + onOff(s.threePlans) + ': /pro is the three-plan page, and the sheets name every plan on sale' + (s.threePlans && !PRO.paymentsOpen ? ' (only where Pro is on sale)' : '') + '</td></tr>';
  html += '<tr><td>PRO_AUTO_GIFT</td><td>' + onOff(s.autoGift) + ': the 7 days start by themselves for a verified email that never held Pro</td></tr>';
  html += '<tr><td>PRO_GIFT_MAILS</td><td>' + onOff(s.giftMails) + (s.giftMails ? '' : (s.autoGift ? '' : ' (needs PRO_AUTO_GIFT too)')) + ': the three emails about the 7 days. '
    + 'See one as it would go now: '
    + '<button type="button" class="gift-mail" data-kind="start">started</button> '
    + '<button type="button" class="gift-mail" data-kind="soon">ends soon</button> '
    + '<button type="button" class="gift-mail" data-kind="end">ended</button> '
    + '<button type="button" class="gift-mail" data-kind="end" data-offer="1">ended, with the price (only for a fan who ticked the box)</button></td></tr>';
  html += '<tr><td>PRO_POST_OFFERS</td><td>' + onOff(s.postOffers) + ': Pro versions and the account offer on Post it and share</td></tr>';
  html += '</tbody></table></div>';
  html += '<p id="gift-mail-subject" class="note" role="status" aria-live="polite"></p>'
    + '<iframe id="gift-mail-frame" title="An email about the 7 days" sandbox="" hidden style="width:100%;height:760px;border:1px solid #8884;border-radius:8px;background:#f3f4f6"></iframe>';
  if (g){
    var a = g.auto || {}, o = g.accept || {};
    html += '<h2 class="sec">Gifts started <span class="hint">all time</span></h2><div class="card"><table class="tbl"><thead><tr><th>How it started</th><th>Started</th><th>Running now</th><th>Ended</th><th>Bought while it ran</th><th>Bought within ' + esc(String(g.afterDays)) + ' days of its end</th></tr></thead><tbody>';
    html += '<tr><td>By itself (automatic)</td><td>' + fmt(a.started || 0) + '</td><td>' + fmt(a.running || 0) + '</td><td>' + fmt(a.ended || 0) + '</td><td>' + fmt(a.boughtDuring || 0) + '</td><td>' + fmt(a.boughtAfter || 0) + (a.ended ? ' <span class="dim">' + pct(a.boughtAfter || 0, a.ended) + ' of ended</span>' : '') + '</td></tr>';
    html += '<tr><td>The old Accept button</td><td>' + fmt(o.started || 0) + '</td><td>' + fmt(o.running || 0) + '</td><td>' + fmt(o.ended || 0) + '</td><td>' + fmt(o.boughtDuring || 0) + '</td><td>' + fmt(o.boughtAfter || 0) + (o.ended ? ' <span class="dim">' + pct(o.boughtAfter || 0, o.ended) + ' of ended</span>' : '') + '</td></tr>';
    html += '</tbody></table></div><p class="note">Bought means a real, paid order that was not refunded. A fan who bought while the gift ran is counted there and not again after it.</p>';
  }
  html += '<h2 class="sec">Pro funnel <span class="hint">last ' + esc(String(currentDays)) + ' days</span></h2>';
  if (!PROFUNNEL) html += '<p class="note">Loading.</p>';
  else if (PROFUNNEL.error) html += '<p class="note">The Pro funnel could not be loaded (' + esc(String(PROFUNNEL.error)) + ').</p>';
  else {
    var F = PROFUNNEL, rows = F.places || [];
    html += '<div class="card"><table class="tbl"><thead><tr><th>Where the offer was seen</th><th>Saw a Pro offer</th><th>Pressed Get Pro</th><th>Saw the plan list</th><th>Chose: match pass / month / year</th><th>Paid: match pass</th><th>Paid: monthly</th><th>Paid: year</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++){
      var r = rows[i];
      html += '<tr><td>' + esc(PLACE_LABEL[r.place] || r.place) + '</td><td>' + fmt(r.saw) + '</td><td>' + fmt(r.pressed) + (r.saw ? ' <span class="dim">' + pct(r.pressed, r.saw) + '</span>' : '') + '</td><td>' + fmt(r.plans || 0) + '</td><td>' + fmt((r.pick || {}).match || 0) + ' / ' + fmt((r.pick || {}).monthly || 0) + ' / ' + fmt((r.pick || {}).year || 0) + '</td><td>' + fmt(r.match) + '</td><td>' + fmt(r.monthly) + '</td><td>' + fmt(r.year || 0) + '</td></tr>';
    }
    html += '<tr><td>Place not said</td><td class="dim">n/a</td><td class="dim">n/a</td><td class="dim">n/a</td><td class="dim">n/a</td><td>' + fmt((F.notSaid || {}).match || 0) + '</td><td>' + fmt((F.notSaid || {}).monthly || 0) + '</td><td>' + fmt((F.notSaid || {}).year || 0) + '</td></tr>';
    html += '<tr><td><b>All</b></td><td></td><td></td><td></td><td></td><td><b>' + fmt((F.paid || {}).match || 0) + '</b></td><td><b>' + fmt((F.paid || {}).monthly || 0) + '</b></td><td><b>' + fmt((F.paid || {}).year || 0) + '</b></td></tr>';
    var rb = (F.paid || {}).revenueBy || {};
    html += '<tr><td>Money kept (SAR)</td><td></td><td></td><td></td><td></td><td>' + esc(String(rb.match || 0)) + '</td><td>' + esc(String(rb.monthly || 0)) + '</td><td>' + esc(String(rb.year || 0)) + '</td></tr>';
    html += '</tbody></table></div>';
    var st = F.steps || {};
    html += '<div class="grid three">';
    html += stat(st.gift_welcome || 0, plural(st.gift_welcome || 0, 'session', 'sessions'), 'Saw the gift welcome', 'the 7 days started by themselves', 'Counted only for visitors who allowed counting.');
    html += stat(st.pro_preview_post || 0, plural(st.pro_preview_post || 0, 'session', 'sessions'), 'Previewed Pro on Post it', 'their own tifo as the vertical video', '');
    html += stat(st.signup_offer_post || 0, plural(st.signup_offer_post || 0, 'session', 'sessions'), 'Offered an account on Post it', (st.signup_post || 0) + ' made one from it', '');
    html += stat(st.gift_end_seen || 0, plural(st.gift_end_seen || 0, 'session', 'sessions'), 'Saw the gift-end card', (st.bought_after_gift || 0) + ' paid after their gift', '');
    html += stat(st.monthly_bought || 0, plural(st.monthly_bought || 0, 'session', 'sessions'), 'Came back from paying: monthly', '', '');
    html += stat(st.match_bought || 0, plural(st.match_bought || 0, 'session', 'sessions'), 'Came back from paying: match pass', '', '');
    html += stat(st.year_bought || 0, plural(st.year_bought || 0, 'session', 'sessions'), 'Came back from paying: year', '', '');
    html += '</div>';
    html += '<p class="note">Saw and pressed are sessions that allowed counting, so they read lower than what happened. Paid is every real order in the period that was not refunded (SAR ' + esc(String((F.paid || {}).revenue || 0)) + ' in all); an order names its place only when its buyer allowed counting.' + (F.counted ? '' : ' Event counting is not enabled on this server.') + '</p>';
  }
  return html;
}

/* ---- the launch: the price, the founders, their one email (server/src/proLaunch.ts) ----
   Before Pro is on sale: who would be a founder, and the email as it would
   go. After: how the emails went and who bought in time. "Send now" is the
   fallback for the job that sends them by itself; it is still once per
   account. Usernames are the only thing listed: never an address. */
var LAUNCH = null;
var LAUNCH_MSG = '';
var LAUNCH_SRC = { notify: 'pressed Tell me', price: 'answered the price question', both: 'answered the price question (which also put them on the tell-me list)' };
function riyadh(iso){
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) + ' Riyadh'; }
  catch(e){ return String(iso); }
}
function launchHtml(){
  if (!LAUNCH || LAUNCH.error) return '';
  var L = LAUNCH, p = L.price || {}, f = L.founders || { rows: [] }, w = L.window || {};
  var html = '<h2 class="sec">Launch and founders</h2>';
  html += '<p class="lede">' + (L.launchedAt
    ? 'Pro went on sale on ' + esc(riyadh(L.launchedAt)) + '.' + (w.bonusOn ? ' The founders offer ' + (L.ended ? 'ended' : 'ends') + ' on ' + esc(riyadh(L.deadline)) + '.' : '')
    : (L.public ? 'Pro is on sale: the launch is being recorded now.' : 'Not launched. The launch is recorded, and the founders emailed, the first time the server finds Pro on sale for real: PRO_PAYMENTS=on, a live Moyasar key and PRO_MODE=on. Nothing happens on a test key or in preview.')) + '</p>';
  html += '<p class="note"><b>Price now: SAR ' + esc(String(p.now)) + '</b> for 30 days. '
    + (p.launch ? 'That is the launch price; SAR ' + esc(String(p.regular)) + ' from ' + esc(riyadh(p.until)) + ', by itself.'
      : p.untilInvalid ? 'PRO_LAUNCH_PRICE_UNTIL is set but is not a date (use 2027-01-15), so there is no launch price.'
      : p.untilPassed ? 'The launch price ended on ' + esc(riyadh(p.until)) + '; PRO_LAUNCH_PRICE_UNTIL can be removed.'
      : 'No launch price: set PRO_LAUNCH_PRICE_UNTIL to the first day at SAR ' + esc(String(p.regular)) + ' (a Riyadh date like 2027-01-15) to sell at SAR ' + esc(String(p.launchPrice)) + ' until then.')
    + ' Auto-renew always renews at SAR ' + esc(String(p.regular)) + '. '
    + (p.display === 'strike' ? 'The regular price is shown crossed out, with discount licence no. ' + esc(String(p.licence)) + '.' : 'Shown in plain words, with no crossed-out price.') + '</p>';
  if (p.strikeRefused) html += '<div class="callout warn"><b>PRO_PRICE_DISPLAY=strike is set without a licence number.</b> The crossed-out price is not shown. It needs PRO_DISCOUNT_LICENCE (the Ministry of Commerce discount licence number), which the page then prints.</div>';
  if (!w.bonusOn) html += '<div class="callout warn"><b>The founders offer is switched off</b> (PRO_FOUNDERS_BONUS=off). Founders still get their one email saying Pro is open, with no offer in it, and nobody gets extra days. Remove the variable and the offer starts with the launch: ' + fmt(w.hours) + ' hours, ' + fmt(w.bonusDays) + ' extra days on a founder\\'s first purchase, once per account.</div>';
  else if (!L.launchedAt) html += '<p class="note">The founders offer starts by itself the moment Pro is on sale to everyone: ' + fmt(w.hours) + ' hours from then, ' + fmt(w.bonusDays) + ' extra days on a founder\\'s first purchase, once per account.</p>';
  if (!L.mailLive) html += '<div class="callout warn"><b>Email is not being delivered</b> (no mail key), so no founder email goes out. They wait; none is marked sent.</div>';
  html += '<div class="grid">';
  var answered = (f.price || 0) + (f.both || 0);
  html += stat(f.total || 0, plural(f.total || 0, 'account', 'accounts'), 'Founders',
    fmt(answered) + ' answered the price question, ' + fmt(f.notify || 0) + ' only pressed Tell me',
    'Accounts with a verified email that were on the tell-me list, or had answered the price question signed in, when Pro went on sale. Answering the question puts an account on the list, so nearly all founders come from the question, whatever they answered.');
  if (L.mail){
    html += stat(L.mail.sent, plural(L.mail.sent, 'email', 'emails'), 'Founders email sent', fmt(L.mail.waiting) + ' waiting', 'Handed to the mail service, once per founder.');
    html += stat(L.mail.failed + L.mail.unknown + L.mail.skipped, plural(L.mail.failed + L.mail.unknown + L.mail.skipped, 'founder', 'founders'), 'Not emailed', fmt(L.mail.failed) + ' failed, ' + fmt(L.mail.unknown) + ' not known, ' + fmt(L.mail.skipped) + ' skipped', '');
    html += stat(L.bought.inTime, plural(L.bought.inTime, 'founder', 'founders'), 'Bought with the offer', fmt(L.bought.refunded) + ' more bought and no longer hold it',
      'Founders whose first purchase got the extra days and is still paid. The smaller figure is founders whose bonus order was refunded or did not complete.');
  }
  html += '</div>';
  if (!L.launchedAt) html += '<p class="note">This is the list as it would be taken if Pro went on sale now: signed-in accounts with a verified email. Guests who answered signed out have no address and are not on it.</p>';
  if (L.mail && L.mail.unknown) html += '<div class="callout warn"><b>' + fmt(L.mail.unknown) + ' not known.</b> The server stopped between taking a founder and sending. It is not sent again, so that nobody gets it twice; write to them yourself if it matters.</div>';
  if ((f.rows || []).length){
    html += '<details><summary>The ' + fmt(f.rows.length) + ' founder' + (f.rows.length === 1 ? '' : 's') + '</summary><table class="tbl"><thead><tr><th>Who</th><th>How</th><th>Email</th><th>Bought in time</th></tr></thead><tbody>';
    for (var i = 0; i < f.rows.length; i++){
      var r = f.rows[i];
      html += '<tr><td>' + (r.username ? '@' + esc(r.username) : '<span class="dim">?</span>') + '</td><td>' + esc(LAUNCH_SRC[r.source] || r.source) + '</td><td>' + esc(r.mail) + '</td><td>' + (r.bought ? 'Yes' : '<span class="dim">no</span>') + '</td></tr>';
    }
    html += '</tbody></table></details>';
  }
  html += '<details id="launch-mail"><summary>The founders email, as it would go now</summary>'
    + '<p class="note"><b>Subject:</b> ' + esc((L.email && L.email.subject) || '') + '</p>'
    + '<iframe id="launch-frame" title="The founders email" sandbox="" style="width:100%;height:900px;border:1px solid #8884;border-radius:8px;background:#f3f4f6"></iframe></details>';
  if (L.launchedAt && L.mail && !L.ended && (L.mail.waiting || L.mail.failed)) {
    html += '<p class="note"><button type="button" id="launch-send">Send now</button> The server sends these by itself, a few a minute. This runs it now and tries the failed ones again. Nobody who has had the email gets it twice.</p>';
  }
  html += '<p id="launch-out" class="note" role="status" aria-live="polite">' + esc(LAUNCH_MSG) + '</p>';
  return html;
}
function wireLaunch(){
  /* The gift's emails, each as it would go out now, in a frame that can run nothing. */
  var gm = document.querySelectorAll('.gift-mail');
  for (var gi = 0; gi < gm.length; gi++) gm[gi].addEventListener('click', async function(e){
    var b = e.currentTarget, out = el('gift-mail-subject'), fr = el('gift-mail-frame');
    var r = await api('/api/admin/pro/gift/email?json=1&kind=' + encodeURIComponent(b.getAttribute('data-kind')) + (b.getAttribute('data-offer') ? '&offer=1' : ''));
    if (!r.ok || !r.data){ if (out) out.textContent = 'The email could not be loaded (' + r.status + ').'; return; }
    if (out) out.textContent = 'Subject: ' + (r.data.subject || '');
    if (fr){ fr.hidden = false; fr.srcdoc = r.data.html || ''; }
  });
  var frame = el('launch-frame');
  /* The email's own HTML, in a frame that can run nothing. */
  if (frame && LAUNCH && LAUNCH.email) frame.srcdoc = LAUNCH.email.html || '';
  var send = el('launch-send');
  if (send) send.addEventListener('click', async function(){
    if (send.getAttribute('data-sure') !== '1'){
      send.setAttribute('data-sure', '1');
      send.textContent = 'Sure? Send to the founders now';
      return;
    }
    send.disabled = true;
    var r = await post('/api/admin/pro/launch/send', {});
    var d = r.data || {};
    LAUNCH_MSG = r.ok
      ? fmt(d.sent || 0) + ' sent, ' + fmt(d.failed || 0) + ' failed, ' + fmt(d.skipped || 0) + ' skipped.' + (d.held === 'budget' ? ' The rest wait for the day\\'s email allowance.' : d.held === 'mail' ? ' Email is not being delivered.' : d.held === 'ended' ? ' The offer has ended: it is not sent any more.' : '')
      : 'Not sent (' + ((r.data && r.data.error) || ('HTTP ' + r.status)) + ').';
    proReload();
  });
}

/* ---- buying Pro (payments v1): the switches, the orders, refunds ----
   server/src/payments.ts and payRoutes.ts. A refund goes back to the way the
   fan paid, through Moyasar, and ends the pass bought with it. */
var ORDERS = null;
/* What the last refund said, kept across the repaint that follows it. */
var ORDER_MSG = '';
var ORDER_STATUS = {
  pending: ['Not paid yet', 'dim'], paid: ['Paid', ''], refunded: ['Refunded', 'dim'],
  failed: ['Did not go through', 'dim'], expired: ['Page closed unpaid', 'dim'], review: ['Needs a look', 'warn']
};
var ORDER_METHOD = { applepay: 'Apple Pay', creditcard: 'Card / mada', stcpay: 'STC Pay', samsungpay: 'Samsung Pay', googlepay: 'Google Pay' };
function ordersHtml(){
  var html = '<h2 class="sec">Payments</h2>';
  if (!ORDERS || ORDERS.error){
    if (ORDERS && ORDERS.error === 404) return html + '<p class="note">This server has no order store.</p>';
    return html + '<div class="callout bad"><b>Could not load the orders.</b> HTTP ' + esc(String((ORDERS && ORDERS.error) || '?')) + '</div>';
  }
  var st = ORDERS.status || {}, n = ORDERS.stats || {};
  if (!st.on){
    html += '<div class="callout"><b>Payments are off.</b> Nobody sees a price or a buy button. They turn on with PRO_PAYMENTS=on and MOYASAR_SECRET_KEY (from Moyasar\\'s dashboard) in Railway\\'s variables.'
      + (st.switch && !st.keySet ? ' PRO_PAYMENTS is on, but there is no key.' : '')
      + (st.keySet && !st.key ? ' The key set is not a secret key (it should start sk_test_ or sk_live_).' : '')
      + '</div>';
  } else {
    html += '<p class="lede">' + (st.key === 'test'
      ? 'On, with TEST keys: only the accounts in PRO_PREVIEW_USERS can buy, with Moyasar\\'s test cards. No real money moves.'
      : st.public ? 'On, with LIVE keys, for everyone: real money.' : 'On, with LIVE keys, for the accounts Pro is on for (PRO_MODE): real money.') + '</p>';
    html += '<p class="note">How it is set up: ' + esc(
      (st.checkout === 'form' ? 'the payment form on /pro (' + (st.methods || []).join(', ') + ')' : 'the hosted invoice page')
      + '; ' + (st.verify === 'webhook' ? 'NO secret key on the server: Pro is given from the webhook alone, and refunds are made in the Moyasar dashboard' : 'every payment is read back from Moyasar with the secret key')
      + (st.proxy ? '; calls to Moyasar go through the fixed-IP proxy' : '')
      + '; auto-renew is ' + (st.autoRenew ? 'ON' + (st.autoRenewMada ? ' (mada included)' : ' (mada excluded)') : 'off')
      + '; refund requests ' + (st.autoRefund ? 'are refunded AUTOMATICALLY when in time and unused (PRO_AUTO_REFUND)' : 'wait for you') + '.') + '</p>';
    if (st.autoRefundAsked && !st.autoRefund) html += '<div class="callout warn"><b>PRO_AUTO_REFUND=on is set but not in use.</b> Refunding from here needs the secret key (not MOYASAR_VERIFY=webhook). Requests wait for you.</div>';
    if (st.formRefused) html += '<div class="callout warn"><b>PRO_CHECKOUT=form is set but not in use.</b> MOYASAR_PUBLISHABLE_KEY is missing, or is a test key beside a live secret key (or the reverse). Get Pro still goes to the hosted page.</div>';
    if (st.autoRenewAsked && !st.autoRenew) html += '<div class="callout warn"><b>PRO_AUTORENEW=on is set but not in use.</b> It needs the payment form (PRO_CHECKOUT=form with a matching publishable key) and the secret key.</div>';
    if (st.checkout === 'form' && (st.methods || []).indexOf('applepay') < 0 && !st.applePayFile) html += '<p class="note">Apple Pay is not offered: add it to MOYASAR_METHODS and set APPLE_PAY_DOMAIN_ASSOCIATION once the domain is registered with Moyasar.</p>';
    if (ORDERS.verification) html += '<div class="callout"><b>Moyasar\\'s webhook code: ' + esc(ORDERS.verification.code) + '</b>. Type it in Moyasar\\'s dashboard (Settings, Webhooks, Verify Webhook) within 30 minutes of ' + esc(String(ORDERS.verification.at).slice(11, 16)) + ' UTC.</div>';
    if (!st.webhook) html += '<div class="callout warn"><b>No webhook secret.</b> Payments still arrive through the fan\\'s return and the invoice\\'s callback, but a refund made in Moyasar\\'s dashboard is only noticed when someone opens that order. Set MOYASAR_WEBHOOK_SECRET to the secret you type in Moyasar\\'s webhook settings, pointing at /api/pro/pay/webhook.</div>';
  }
  if (n.review) html += '<div class="callout bad"><b>' + fmt(n.review) + ' order' + (n.review === 1 ? '' : 's') + ' need' + (n.review === 1 ? 's' : '') + ' a look.</b> Paid at an amount that does not match: nobody got Pro for ' + (n.review === 1 ? 'it' : 'them') + '. Check in Moyasar\\'s dashboard, then refund or give Pro by hand.</div>';
  html += '<div class="grid">';
  html += stat(n.paid || 0, plural(n.paid || 0, 'order', 'orders'), 'Paid and kept', 'real money, all time', 'Real-money orders that are paid now. An order that was paid and then refunded is under Refunded, not here.');
  html += stat('SAR ' + fmt((n.revenue || 0) / 100), '', 'Kept', 'those orders added up, before Moyasar fees', 'Refunded orders are already left out.');
  html += stat(n.refunded || 0, plural(n.refunded || 0, 'order', 'orders'), 'Refunded', 'real money, sent back in full', 'The promise on /legal is a refund within ' + fmt(ORDERS.refundDays || 7) + ' days of paying, with Pro unused. A refund you chose to make later counts here too.');
  html += stat(n.test || 0, plural(n.test || 0, 'order', 'orders'), 'Test orders', 'test keys, no money moved, any status', '');
  html += '</div>';
  html += requestsHtml();
  var rows = ORDERS.orders || [];
  if (!rows.length) return html + '<p class="empty">No orders yet.</p>';
  html += '<table class="tbl"><thead><tr><th>When (UTC)</th><th>Who</th><th>Plan</th><th>Amount</th><th>Status</th><th>How</th><th>Pro used</th><th></th></tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++){
    var o = rows[i], lab = ORDER_STATUS[o.status] || [o.status, ''];
    var act = '';
    if (o.status === 'paid'){
      act = '<button type="button" class="order-refund" data-order="' + esc(o.id) + '" data-late="' + (o.refundable ? '0' : '1') + '" data-amount="' + esc(String(o.amount)) + '">'
        + (o.refundable ? 'Refund' : 'Refund anyway') + '</button>';
    }
    html += '<tr><td>' + esc(String(o.createdAt || '').slice(0, 16).replace('T', ' ')) + (o.test ? ' <b class="dim">TEST</b>' : '') + '</td><td>'
      + (o.username ? '@' + esc(o.username) : '<span class="dim">account deleted</span>') + '</td><td>' + esc(o.product === 'year' ? 'Year' : o.product === 'match' ? 'Match pass' : 'Month') + ' <span class="dim">' + esc(String(o.days || '')) + ' days' + (o.src ? ', from ' + esc(PLACE_LABEL[o.src] || o.src) : '') + '</span></td><td>SAR ' + esc(String(o.amount))
      + (o.refunded ? ' <span class="dim">(' + esc(String(o.refunded)) + ' back)</span>' : '') + '</td><td>'
      + (lab[1] ? '<span class="' + lab[1] + '">' + esc(lab[0]) + '</span>' : esc(lab[0]))
      + (o.told === true ? '<br><span class="dim">fan emailed</span>' : o.told === false ? '<br><span class="warn">fan not emailed yet</span>' : '')
      + (o.note ? '<br><span class="dim">' + esc(o.note) + '</span>' : '') + '</td><td>' + esc(ORDER_METHOD[o.method] || o.method || '')
      + (o.kind === 'renewal' ? ' <span class="dim">renewal</span>' : o.keep ? ' <span class="dim">asked to renew</span>' : '') + '</td><td>'
      + (o.used == null ? '<span class="dim">no pass</span>' : o.used ? '<b>' + fmt(o.used) + ' uses</b>' : 'not yet') + '</td><td>' + act + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<p class="note">"Pro used" counts the AI designs, Polishes and cut-outs taken on the pass bought. Exports with Pro items are not counted, so ask if unsure. A refund within ' + fmt(ORDERS.refundDays || 7) + ' days of paying is the promise on /legal; "Refund anyway" is for later ones you choose to make.</p>';
  html += '<p id="order-out" class="note" role="status" aria-live="polite">' + esc(ORDER_MSG) + '</p>';
  return html;
}
function wireOrders(){
  var btns = document.querySelectorAll('.order-refund');
  for (var i = 0; i < btns.length; i++){
    btns[i].addEventListener('click', async function(e){
      var b = e.currentTarget;
      /* Two presses: the first asks, the second refunds. */
      if (b.getAttribute('data-sure') !== '1'){
        b.setAttribute('data-sure', '1');
        b.textContent = 'Sure? Refund SAR ' + b.getAttribute('data-amount');
        return;
      }
      b.disabled = true;
      b.textContent = 'Refunding...';
      var r = await post('/api/admin/pro/refund', { orderId: b.getAttribute('data-order'), late: b.getAttribute('data-late') === '1' });
      if (r.ok){ ORDER_MSG = 'Refunded. The money goes back the way it was paid, the pass has ended, and the fan has been emailed.'; proReload(); return; }
      ORDER_MSG = '';
      b.disabled = false;
      b.removeAttribute('data-sure');
      b.textContent = 'Refund';
      el('order-out').innerHTML = '<b class="warn">Not refunded.</b> ' + esc((r.data && (r.data.reason || r.data.error)) || ('HTTP ' + r.status))
        + (r.data && r.data.reason === 'dashboard' ? ': this server has no secret key (MOYASAR_VERIFY=webhook). Refund it in the Moyasar dashboard; the webhook then ends the pass here.' : '')
        + (r.data && r.data.reason === 'failed' ? ': Moyasar refused it. Try once more, or refund from Moyasar\\'s dashboard (this page notices it).' : '');
    });
  }
}

/* ---- refund requests: what fans asked for from their account page ----
   server/src/payments.ts requestRefund and decideRequest. Approve refunds the
   order through Moyasar (the pass ends and the fan is emailed); Decline needs
   a reason, which is emailed to the fan. What a fan wrote goes through esc(). */
var REQS = null;
var REQ_MSG = '';
function requestsHtml(){
  if (!REQS || REQS.error) return '';
  var rows = REQS.requests || [];
  var open = rows.filter(function(x){ return x.status === 'pending'; });
  if (!rows.length) return '';
  var html = '<h2 class="sec">Refund requests</h2>';
  html += '<p class="lede">' + (open.length
    ? fmt(open.length) + ' waiting for you. The fan was told to expect an answer within 3 working days.'
    : 'None waiting.') + (REQS.auto ? ' PRO_AUTO_REFUND is on: a request in time, with Pro unused, from an account never refunded before, is refunded without you.' : '') + '</p>';
  html += '<table class="tbl"><thead><tr><th>Asked (UTC)</th><th>Who</th><th>Order</th><th>Pro</th><th>They wrote</th><th></th></tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++){
    var q = rows[i], o = q.order || {};
    var usedNow = q.usedNow == null ? q.usedThen : q.usedNow;
    var used = usedNow ? '<b>used</b> <span class="dim">(' + fmt(usedNow) + ' use' + (usedNow === 1 ? '' : 's') + (q.usedNow != null && q.usedNow !== q.usedThen ? ', ' + fmt(q.usedThen) + ' when asked' : '') + ')</span>' : 'not used';
    var act;
    if (q.status === 'pending'){
      act = '<button type="button" class="req-approve" data-req="' + esc(q.id) + '" data-amount="' + esc(String(o.amount)) + '">Approve</button> '
        + '<button type="button" class="req-decline" data-req="' + esc(q.id) + '">Decline</button>';
    } else {
      act = q.status === 'approved' ? '<span class="dim">Approved' + (q.auto ? ' automatically' : '') + ' ' + esc(String(q.answeredAt || '').slice(0, 10)) + '</span>'
        : '<span class="dim">Declined ' + esc(String(q.answeredAt || '').slice(0, 10)) + ': ' + esc(q.declineReason || '') + '</span>';
    }
    html += '<tr><td>' + esc(String(q.askedAt || '').slice(0, 16).replace('T', ' ')) + (o.test ? ' <b class="dim">TEST</b>' : '') + '</td><td>'
      + (q.username ? '@' + esc(q.username) : '<span class="dim">account deleted</span>') + '</td><td>SAR ' + esc(String(o.amount == null ? '?' : o.amount))
      + '<br><span class="dim">paid ' + esc(String(o.paidAt || '').slice(0, 10)) + (o.daysSincePaid == null ? '' : ', ' + fmt(o.daysSincePaid) + ' day' + (o.daysSincePaid === 1 ? '' : 's') + ' ago')
      + (o.inTime ? ', asked in time' : ', asked LATE') + '</span></td><td>' + used + '</td><td>' + (q.note ? esc(q.note) : '<span class="dim">nothing</span>') + '</td><td>' + act + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<p class="note">"Not used" means nothing was counted against the allowances of the pass this order bought (AI designs, Polishes, cut-outs, stadium photos, reviews, chat). It cannot see exports made with Pro items (the film, the poster, the pack), fonts, styles or kits, so ask if unsure. Approve refunds the whole order; the pass ends and the fan gets the refund email. Decline emails the fan your reason.</p>';
  html += '<p id="req-out" class="note" role="status" aria-live="polite">' + esc(REQ_MSG) + '</p>';
  return html;
}
function wireRequests(){
  var ok = document.querySelectorAll('.req-approve');
  for (var i = 0; i < ok.length; i++){
    ok[i].addEventListener('click', async function(e){
      var b = e.currentTarget;
      /* Two presses, like Refund: the first asks, the second moves the money. */
      if (b.getAttribute('data-sure') !== '1'){
        b.setAttribute('data-sure', '1');
        b.textContent = 'Sure? Refund SAR ' + b.getAttribute('data-amount');
        return;
      }
      b.disabled = true;
      b.textContent = 'Refunding...';
      var r = await post('/api/admin/pro/refund-request', { id: b.getAttribute('data-req'), action: 'approve' });
      if (r.ok){ REQ_MSG = 'Approved and refunded. The pass has ended and the fan has been emailed.'; proReload(); return; }
      REQ_MSG = '';
      b.disabled = false;
      b.removeAttribute('data-sure');
      b.textContent = 'Approve';
      var why = (r.data && r.data.reason) || '';
      el('req-out').innerHTML = '<b class="warn">Not refunded.</b> ' + esc(why || (r.data && r.data.error) || ('HTTP ' + r.status))
        + (why === 'dashboard' ? ': this server has no secret key (MOYASAR_VERIFY=webhook). Refund it in the Moyasar dashboard; the webhook then ends the pass, closes this request and emails the fan.' : '')
        + (why === 'failed' ? ': Moyasar refused it. Try once more, or refund from Moyasar\\'s dashboard (this page notices it).' : '')
        + (why === 'off' ? ': payments are switched off, so nothing can be refunded from here.' : '');
    });
  }
  var no = document.querySelectorAll('.req-decline');
  for (var j = 0; j < no.length; j++){
    no[j].addEventListener('click', async function(e){
      var b = e.currentTarget, cell = b.parentNode;
      /* The first press opens the reason; it is emailed to the fan, so it has to be written. */
      var box = cell.querySelector('.req-why');
      if (!box){
        box = document.createElement('input');
        box.type = 'text';
        box.className = 'req-why';
        box.maxLength = 500;
        box.placeholder = 'Reason (emailed to the fan)';
        box.setAttribute('aria-label', 'Reason for declining, emailed to the fan');
        cell.insertBefore(box, b);
        b.textContent = 'Send decline';
        box.focus();
        return;
      }
      if (box.value.trim().length < 3){ el('req-out').textContent = 'Write the reason first: the fan is emailed it.'; box.focus(); return; }
      b.disabled = true;
      var r = await post('/api/admin/pro/refund-request', { id: b.getAttribute('data-req'), action: 'decline', reason: box.value });
      REQ_MSG = r.ok ? 'Declined. The fan has been emailed your reason, and keeps Pro.' : 'Not declined (' + ((r.data && (r.data.reason || r.data.error)) || ('HTTP ' + r.status)) + ').';
      proReload();
    });
  }
}

/* ---- auto-renew ("Keep Pro on", payments v2): who renews, who is failing, who stopped ----
   server/src/payments.ts runRenewals. Switching one off deletes its saved card
   at Moyasar; the Pro already paid for runs to its end. The switch for all of
   it is PRO_AUTORENEW in the server variables: unset, nothing is charged. */
var SUBS = null;
var SUB_MSG = '';
var SUB_STATUS = { active: ['Renewing', ''], failing: ['Failing: retrying', 'warn'], cancelled: ['Cancelled', 'dim'], ended: ['Ended by itself', 'dim'] };
function subsHtml(){
  if (!SUBS || SUBS.error) return '';
  var rows = SUBS.subscriptions || [];
  if (!SUBS.on && !rows.length) return '';
  var html = '<h2 class="sec">Auto-renew</h2>';
  var live = rows.filter(function(x){ return x.status === 'active' || x.status === 'failing'; });
  html += '<p class="lede">' + (SUBS.on
    ? 'On: fans who ticked Keep Pro on are charged every 30 days, 3 days after a reminder email.'
    : 'OFF (PRO_AUTORENEW is not on): nothing is offered and nothing is charged.' + (live.length ? ' ' + fmt(live.length) + ' subscription' + (live.length === 1 ? ' is' : 's are') + ' waiting, and will not be charged while it is off.' : '')) + '</p>';
  if (SUBS.tokensToDelete) html += '<div class="callout warn"><b>' + fmt(SUBS.tokensToDelete) + ' saved card' + (SUBS.tokensToDelete === 1 ? '' : 's') + ' still to delete at Moyasar.</b> Moyasar could not be reached when ' + (SUBS.tokensToDelete === 1 ? 'it was' : 'they were') + ' cancelled; the server tries again every hour.</div>';
  html += '<div class="grid">';
  html += kpi('Renewing', rows.filter(function(x){ return x.status === 'active'; }).length, 'will be charged on their date', true);
  html += kpi('Failing', rows.filter(function(x){ return x.status === 'failing'; }).length, 'a renewal did not go through', true);
  html += kpi('Cancelled', rows.filter(function(x){ return x.status === 'cancelled'; }).length, 'by the fan, a refund or you', true);
  html += kpi('Ended', rows.filter(function(x){ return x.status === 'ended'; }).length, 'retries ran out, or the card expired', true);
  html += '</div>';
  if (!rows.length) return html + '<p class="empty">Nobody has turned auto-renew on yet.</p>';
  var soon = live.slice().sort(function(a, b){ return String(a.nextAt).localeCompare(String(b.nextAt)); });
  html += '<table class="tbl"><thead><tr><th>Who</th><th>Status</th><th>Next renewal (UTC)</th><th>Amount</th><th>Card</th><th>Since</th><th></th></tr></thead><tbody>';
  var all = soon.concat(rows.filter(function(x){ return x.status !== 'active' && x.status !== 'failing'; }));
  for (var i = 0; i < all.length; i++){
    var x = all[i], lab = SUB_STATUS[x.status] || [x.status, ''];
    var on = x.status === 'active' || x.status === 'failing';
    html += '<tr><td>' + (x.username ? '@' + esc(x.username) : '<span class="dim">?</span>') + (x.test ? ' <b class="dim">TEST</b>' : '') + '</td><td>'
      + (lab[1] ? '<span class="' + lab[1] + '">' + esc(lab[0]) + '</span>' : esc(lab[0]))
      + (x.status === 'failing' ? '<br><span class="dim">' + fmt(x.attempts) + ' failed: ' + esc(x.lastError || '') + '</span>' : '')
      + (!on && x.reason ? '<br><span class="dim">' + esc(x.reason) + '</span>' : '') + '</td><td>'
      + (on ? esc(String(x.nextAt || '').slice(0, 16).replace('T', ' ')) + (x.status === 'active' ? '<br><span class="dim">' + (x.remindedAt ? 'reminded ' + esc(String(x.remindedAt).slice(0, 10)) : 'reminder not sent yet') + '</span>' : '') : '<span class="dim">' + esc(String(x.stoppedAt || '').slice(0, 10)) + '</span>')
      + '</td><td>SAR ' + esc(String(x.amount)) + ' / ' + esc(String(x.days)) + ' days</td><td>'
      + esc((ORDER_METHOD[x.method] || x.method || '') + (x.brand ? ' ' + x.brand : '') + (x.lastFour ? ' ..' + x.lastFour : '')) + '</td><td>'
      + esc(String(x.since || '').slice(0, 10)) + ' <span class="dim">#' + esc(String(x.cycle)) + '</span></td><td>'
      + (on ? '<button type="button" class="sub-off" data-sub="' + esc(x.id) + '">Switch off</button>' : '') + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<p class="note">Switch off stops the renewals for that account and deletes its saved card at Moyasar; the fan is emailed, and keeps Pro until the paid days end. Refunding an order does the same.</p>';
  html += '<p id="sub-out" class="note" role="status" aria-live="polite">' + esc(SUB_MSG) + '</p>';
  return html;
}
function wireSubs(){
  var btns = document.querySelectorAll('.sub-off');
  for (var i = 0; i < btns.length; i++){
    btns[i].addEventListener('click', async function(e){
      var b = e.currentTarget;
      /* Two presses: the first asks, the second switches it off. */
      if (b.getAttribute('data-sure') !== '1'){
        b.setAttribute('data-sure', '1');
        b.textContent = 'Sure? Switch off';
        return;
      }
      b.disabled = true;
      var r = await post('/api/admin/pro/subscription/cancel', { id: b.getAttribute('data-sub') });
      SUB_MSG = r.ok ? 'Switched off. The saved card is deleted at Moyasar and the fan has been emailed.' : 'Not switched off (' + ((r.data && r.data.error) || ('HTTP ' + r.status)) + ').';
      proReload();
    });
  }
}

/* ---- "What would you pay for Pro?": the answers from the coming-soon /pro ----
   Every value here was typed by a visitor: all of it goes through esc(), and
   the CSV guards cells a spreadsheet would run as a formula. */
var PRICES = null;
var PRICE_CUR = ['SAR', 'USD'];
function priceText(n, cur){
  n = Number(n) || 0;
  return cur + ' ' + (n % 1 ? n.toFixed(2) : String(n));
}
/* The bands' names, from the edges the server counted by: under the first edge, then up to each, then the last and above. */
function bandNames(edges){
  var out = ['under ' + edges[0]];
  for (var i = 1; i < edges.length; i++) out.push(edges[i - 1] + ' to under ' + edges[i]);
  out.push(edges[edges.length - 1] + ' and over');
  return out;
}
function pricesHtml(){
  var html = '<h2 class="sec">What would you pay for Pro?</h2>';
  if (!PRICES || PRICES.error){
    return html + '<div class="callout bad"><b>Could not load the answers.</b> HTTP ' + esc(String((PRICES && PRICES.error) || '?')) + '</div>';
  }
  html += '<p class="note">Asked on /pro and on a card in the editor, while Pro is not on sale, in riyals or US dollars (the page starts in riyals in Arabic, dollars in English). One answer per account, or per browser for a visitor who is signed out; answering again replaces the first. '
        + fmt(PRICES.total) + ' answer' + (PRICES.total === 1 ? '' : 's') + ' so far (at most ' + fmt(PRICES.max) + ' are kept).</p>';
  if (!PRICES.total) return html + '<p class="empty">No answers yet.</p>';
  var wont = PRICES.wontPay || { n: 0, accounts: 0 }, src = PRICES.sources || { page: 0, editor: 0 };
  html += '<div class="grid">';
  html += kpi('Would pay something', PRICES.total - wont.n, Math.round((PRICES.total - wont.n) / PRICES.total * 100) + '% of answers', true);
  html += kpi('Not for me', wont.n, Math.round(wont.n / PRICES.total * 100) + '% of answers, ' + fmt(wont.accounts) + ' from accounts', true);
  html += kpi('From the editor card', src.editor, 'signed-in fans, asked once', true);
  html += kpi('From the /pro page', src.page, 'anyone', true);
  html += '</div>';
  html += '<table class="tbl"><thead><tr><th>Currency</th><th>Answers</th><th>From accounts</th><th>Median</th><th>Middle half</th><th>Average</th><th>Lowest</th><th>Highest</th><th>Median, accounts only</th></tr></thead><tbody>';
  for (var c = 0; c < PRICE_CUR.length; c++){
    var cur = PRICE_CUR[c], s = PRICES.summary && PRICES.summary[cur];
    if (!s) continue;
    if (!s.n){ html += '<tr><td>' + cur + '</td><td>0</td><td colspan="7" class="dim">no answers in ' + cur + '</td></tr>'; continue; }
    html += '<tr><td>' + cur + '</td><td>' + fmt(s.n) + '</td><td>' + fmt(s.accounts) + '</td><td><b>' + esc(priceText(s.median, cur)) + '</b></td><td>'
      + esc(priceText(s.p25, cur)) + ' to ' + esc(priceText(s.p75, cur)) + '</td><td>' + esc(priceText(s.mean, cur)) + '</td><td>' + esc(priceText(s.min, cur)) + '</td><td>'
      + esc(priceText(s.max, cur)) + '</td><td>' + (s.accountsMedian == null ? '<span class="dim">none yet</span>' : esc(priceText(s.accountsMedian, cur))) + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<p class="note">The prices leave out "Not for me" (counted above). The median is the middle answer, and the middle half is where the central 50% of answers fall: both shrug off a joke answer of 999 that would pull the average. Answers from accounts are harder to repeat than signed-out ones.</p>';

  html += '<div class="grid two">';
  for (c = 0; c < PRICE_CUR.length; c++){
    cur = PRICE_CUR[c]; s = PRICES.summary && PRICES.summary[cur];
    if (!s || !s.n || !PRICES.bands || !PRICES.bands[cur]) continue;
    var names = bandNames(PRICES.bands[cur]), top = 1;
    for (var b = 0; b < s.bands.length; b++) if (s.bands[b] > top) top = s.bands[b];
    html += '<div class="card"><p class="lt">Where the ' + cur + ' answers fall</p><p class="lc">' + fmt(s.n) + ' answers, in ' + cur + ' a month</p>';
    for (b = 0; b < s.bands.length; b++){
      html += '<div class="frow"><div class="flab">' + esc(names[b]) + '</div><div class="fbar"><div class="ffill" style="width:' + (s.bands[b] / top * 100).toFixed(1) + '%"></div></div><div class="fnum">' + fmt(s.bands[b]) + '</div></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  var rows = PRICES.rows || [];
  html += '<h2 class="sec">Every answer, newest first <button id="price-csv" type="button">Download all as CSV</button></h2>';
  html += '<p id="price-csv-out" class="note" role="status" aria-live="polite"></p>';
  html += '<table class="tbl"><thead><tr><th>When (UTC)</th><th>Price a month</th><th>Who</th><th>Where</th><th>Language</th><th>Comment</th></tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++){
    var r = rows[i];
    html += '<tr><td>' + esc(String(r.at || '').slice(0, 16).replace('T', ' ')) + '</td><td>' + (r.wontPay ? '<span class="dim">Not for me</span>' : '<b>' + esc(priceText(r.amount, r.currency)) + '</b>') + '</td><td>'
      + (r.username ? '@' + esc(r.username) : '<span class="dim">signed out</span>') + '</td><td>' + (r.source === 'editor' ? 'editor card' : '/pro') + '</td><td>' + (r.lang === 'ar' ? 'Arabic' : 'English') + '</td><td>'
      + (r.comment ? '<bdi>' + esc(r.comment) + '</bdi>' : '<span class="dim">none</span>') + '</td></tr>';
  }
  html += '</tbody></table>';
  if (PRICES.total > rows.length) html += '<p class="note">The newest ' + fmt(rows.length) + ' are listed here; the CSV has all ' + fmt(PRICES.total) + '.</p>';
  return html;
}
/* One CSV cell: quoted, and a leading = + - @ (or a tab or return) disarmed so a spreadsheet shows it as text. */
function csvCell(v){
  var s = String(v == null ? '' : v);
  var c0 = s.charAt(0);
  if (c0 === '=' || c0 === '+' || c0 === '-' || c0 === '@' || s.charCodeAt(0) === 9 || s.charCodeAt(0) === 13) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function downloadPricesCsv(){
  var out = el('price-csv-out');
  out.textContent = 'Fetching every answer...';
  var r = await api('/api/admin/pro/prices?all=1');
  if (!r.ok || !r.data){ out.textContent = 'Could not fetch them (HTTP ' + r.status + ').'; return; }
  var NL = String.fromCharCode(13, 10);
  var lines = ['when_utc,amount,currency,not_for_me,where,page_language,account,comment'];
  var rows = r.data.rows || [];
  for (var i = 0; i < rows.length; i++){
    var x = rows[i];
    lines.push([csvCell(x.at), csvCell(x.wontPay ? '' : x.amount), csvCell(x.currency), csvCell(x.wontPay ? 'yes' : 'no'), csvCell(x.source === 'editor' ? 'editor card' : '/pro'), csvCell(x.lang), csvCell(x.username ? '@' + x.username : ''), csvCell(x.comment || '')].join(','));
  }
  /* The byte-order mark makes Excel read the Arabic comments as UTF-8. */
  var blob = new Blob([String.fromCharCode(65279) + lines.join(NL) + NL], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tifomaker-pro-price-answers-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 10000);
  out.textContent = 'Downloaded ' + fmt(rows.length) + ' answer' + (rows.length === 1 ? '' : 's') + '.';
}
function wirePrices(){
  var csv = el('price-csv');
  if (csv) csv.addEventListener('click', function(){ void downloadPricesCsv(); });
}
function wireLookup(){
  var find = el('pro-find');
  if (find) find.addEventListener('click', function(){ PRO_LOOKUP = (el('pro-user').value || '').trim().replace(/^@/, ''); proReload(); });
  var btns = document.querySelectorAll('.pro-revoke');
  for (var i = 0; i < btns.length; i++){
    btns[i].addEventListener('click', async function(e){
      var b = e.currentTarget;
      b.disabled = true;
      var r = await post('/api/admin/pro/revoke', { passId: b.getAttribute('data-pass') });
      if (!r.ok){ b.disabled = false; el('pro-out').innerHTML = '<b class="warn">Refused.</b> ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)); return; }
      proReload();
    });
  }
}

/* ---- members: everyone who holds Pro or has held it ----
   One row per account, from /api/admin/pro/members (every pass, the newest
   first). How it was got is the pass's source: bought (matched to its order
   by passId, for the price and the way it was paid), given by hand, or the
   7-day gift. "Revoke" ends every pass the account still holds; it never
   refunds (that is Pro, Payments). "Give Pro" is the same grant as the Pro
   tab's. Both are written to the Security tab's audit trail. Usernames only. */
var MEMBERS = null;
var LEADS = null;
var MEM_FILTER = 'now';
var MEM_MSG = '';
var MEM_GIVE = '';
var MEM_OPEN = {};
var MEM_KIND = { paid: 'Bought', hand: 'Given by hand', gift: '7-day gift' };
function memDay(iso){
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  catch(e){ return String(iso).slice(0, 10); }
}
function memState(p, now){
  return p.revokedAt ? 'revoked' : Date.parse(p.endsAt) <= now ? 'ended' : Date.parse(p.startsAt) > now ? 'later' : 'on';
}
function memOrder(passId){
  var rows = (ORDERS && ORDERS.orders) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].passId === passId) return rows[i];
  return null;
}
/* How a pass was got, in words (HTML). */
function memHow(p){
  if (p.source === 'gift') return 'The free ' + fmt((MEMBERS && MEMBERS.giftDays) || 7) + '-day gift, started by them';
  if (p.source === 'admin') return 'Given by hand' + (p.givenBy ? ' by @' + esc(p.givenBy) : '');
  var o = memOrder(p.id);
  if (!o) return 'Bought';
  return 'Bought for SAR ' + esc(String(o.amount)) + (o.method ? ', ' + esc(ORDER_METHOD[o.method] || o.method) : '')
    + (o.kind === 'renewal' ? ', auto-renewal' : '') + (o.bonusDays ? ', founder: +' + fmt(o.bonusDays) + ' days' : '')
    + (o.test ? ' <b class="dim">TEST</b>' : '') + (o.status === 'refunded' ? ' <span class="dim">(refunded)</span>' : '');
}
/* The accounts: who holds Pro now (soonest to end first), then who used to. */
function memAccounts(){
  var now = Date.now(), by = {}, list = [];
  var rows = (MEMBERS && MEMBERS.passes) || [];
  for (var i = 0; i < rows.length; i++){
    var p = rows[i], key = p.username || ('?' + p.id);
    var m = by[key];
    if (!m){ m = by[key] = { username: p.username, passes: [], cur: null, until: 0, live: [], used: 0 }; list.push(m); }
    m.passes.push(p);
    var st = memState(p, now);
    if (st === 'on' || st === 'later'){
      m.live.push(p);
      m.until = Math.max(m.until, Date.parse(p.endsAt));
    }
    /* The pass that makes them Pro now: a month before the gift, then the one that ends last. */
    if (st === 'on' && (!m.cur || (m.cur.plan === 'gift' && p.plan !== 'gift') || (m.cur.plan === p.plan && Date.parse(p.endsAt) > Date.parse(m.cur.endsAt)))) m.cur = p;
  }
  for (var k = 0; k < list.length; k++){
    var a = list[k];
    a.kind = !a.cur ? 'past' : a.cur.source === 'payment' ? 'paid' : a.cur.source === 'admin' ? 'hand' : 'gift';
    a.used = a.cur ? a.cur.used : 0;
    a.last = a.passes[0];
  }
  list.sort(function(x, y){
    if (!!x.cur !== !!y.cur) return x.cur ? -1 : 1;
    if (x.cur) return x.until - y.until;
    return Date.parse(y.last.revokedAt || y.last.endsAt) - Date.parse(x.last.revokedAt || x.last.endsAt);
  });
  return list;
}
function memCounts(list){
  var c = { now: 0, paid: 0, hand: 0, gift: 0, past: 0, soon: 0 }, week = Date.now() + 7 * 86400000;
  for (var i = 0; i < list.length; i++){
    var m = list[i];
    c[m.kind]++;
    if (m.cur){ c.now++; if (m.until <= week) c.soon++; }
  }
  return c;
}
function memPassesHtml(m){
  var now = Date.now();
  var html = '<table class="tbl"><thead><tr><th>Pass</th><th>How</th><th>From</th><th>Until</th><th>Pro used</th><th>Now</th></tr></thead><tbody>';
  for (var i = 0; i < m.passes.length; i++){
    var p = m.passes[i], st = memState(p, now);
    html += '<tr><td>' + esc(PRO_PLAN_LABEL[p.plan] || p.plan) + '</td><td>' + memHow(p) + '</td><td>' + esc(memDay(p.startsAt)) + '</td><td>' + esc(memDay(p.endsAt)) + '</td><td>'
      + (p.used ? fmt(p.used) + ' uses' : '<span class="dim">not yet</span>') + '</td><td>'
      + (st === 'on' ? '<b>running</b>' : st === 'later' ? 'starts ' + esc(memDay(p.startsAt)) : st === 'revoked' ? '<span class="dim">ended by hand or refund, ' + esc(memDay(p.revokedAt)) + '</span>' : '<span class="dim">ran out</span>') + '</td></tr>';
  }
  return html + '</tbody></table>';
}
function membersTab(){
  var html = '<h2 class="sec">Pro members</h2>';
  if (!MEMBERS || MEMBERS.error){
    return html + '<div class="callout bad"><b>Could not load the members.</b> HTTP ' + esc(String((MEMBERS && MEMBERS.error) || '?')) + '</div>';
  }
  var list = memAccounts(), c = memCounts(list), now = Date.now();
  html += '<p class="lede">Everyone who holds Pro now, how they got it, and when it ends. Dates are Riyadh dates. Accounts are listed by username only.</p>';
  html += '<div class="grid">';
  html += kpi('Members now', c.now, fmt(c.soon) + ' end within 7 days', true);
  html += kpi('Bought', c.paid, 'paid through Moyasar', true);
  html += kpi('Given by hand', c.hand, 'by you, from here', true);
  html += kpi('On the 7-day gift', c.gift, 'free, started by the fan', true);
  html += '</div>';

  html += '<h2 class="sec">Give Pro to an account</h2>';
  html += '<p class="note"><label>Username <input id="mem-g-user" type="text" autocomplete="off" spellcheck="false" maxlength="32" value="' + esc(MEM_GIVE) + '"></label> '
        + '<label>Days <input id="mem-g-days" type="number" min="1" max="400" step="1" placeholder="30" style="width:110px"></label> '
        + '<button id="mem-grant" type="button" class="primary">Give Pro</button></p>';
  html += '<p class="note">Any account, free of charge: a prize, a supporters group, a thank-you. 30 days unless you type other days (1 to 400). The days count from today, also for someone who already has Pro: 30 days given to a member with 10 left makes it 30, not 40.</p>';
  html += '<p id="mem-out" class="note" role="status" aria-live="polite">' + MEM_MSG + '</p>';

  html += '<h2 class="sec">The members</h2>';
  var F = [['now', 'Members now', c.now], ['paid', 'Bought', c.paid], ['hand', 'Given by hand', c.hand], ['gift', '7-day gift', c.gift], ['past', 'Used to be', c.past]];
  html += '<p class="note" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">';
  for (var f = 0; f < F.length; f++){
    html += '<button type="button" class="tab mem-filter" data-mem="' + F[f][0] + '" aria-current="' + (MEM_FILTER === F[f][0]) + '">' + F[f][1] + '<span class="pill">' + fmt(F[f][2]) + '</span></button>';
  }
  html += ' <label>Find <input id="mem-q" type="search" autocomplete="off" spellcheck="false" maxlength="32" placeholder="username"></label></p>';

  var shown = [];
  for (var i = 0; i < list.length; i++){
    var m = list[i];
    if (MEM_FILTER === 'now' ? !!m.cur : m.kind === MEM_FILTER) shown.push(m);
  }
  if (!shown.length){
    html += '<p class="empty">' + (MEM_FILTER === 'past' ? 'Nobody has had Pro and lost it.' : 'Nobody here yet.') + '</p>';
  } else {
    var past = MEM_FILTER === 'past';
    html += '<div class="scroll"><table class="tbl" id="mem-table" style="min-width:820px;white-space:nowrap"><thead><tr><th>Who</th><th>How they got it</th>'
      + (past ? '<th>Had it until</th><th>Why it ended</th>' : '<th>Since</th><th>Until</th><th>Left</th><th>Pro used</th>') + '<th></th></tr></thead><tbody>';
    for (var j = 0; j < shown.length; j++){
      var a = shown[j], name = a.username || '';
      var who = (a.username ? '@' + esc(a.username) : '<span class="dim">account renamed or deleted</span>');
      var more = '<button type="button" class="mem-more" data-user="' + esc(name) + '">' + (MEM_OPEN[name] ? 'Hide passes' : 'Passes (' + fmt(a.passes.length) + ')') + '</button>';
      var give = a.username ? ' <button type="button" class="mem-give" data-user="' + esc(name) + '">' + (past ? 'Give Pro' : 'Give days') + '</button>' : '';
      html += '<tr data-user="' + esc(name.toLowerCase()) + '"><td>' + who + '</td>';
      if (past){
        var l = a.last;
        html += '<td>' + memHow(l) + '</td><td>' + esc(memDay(l.revokedAt || l.endsAt)) + '</td><td>'
          + (l.revokedAt ? (memOrder(l.id) && memOrder(l.id).status === 'refunded' ? 'Refunded' : 'Ended by hand') : 'Ran out') + '</td><td>' + more + give + '</td></tr>';
      } else {
        var days = Math.max(0, Math.ceil((a.until - now) / 86400000));
        var ids = [];
        for (var q = 0; q < a.live.length; q++) ids.push(a.live[q].id);
        html += '<td>' + memHow(a.cur) + (a.live.length > 1 ? '<br><span class="dim">' + fmt(a.live.length) + ' passes running or waiting</span>' : '') + '</td><td>' + esc(memDay(a.cur.startsAt)) + '</td><td>' + esc(memDay(new Date(a.until).toISOString())) + '</td><td>'
          + (days <= 7 ? '<b class="warn">' + fmt(days) + (days === 1 ? ' day' : ' days') + '</b>' : fmt(days) + ' days') + '</td><td>'
          + (a.used ? fmt(a.used) + ' uses' : '<span class="dim">not yet</span>') + '</td><td>' + more + give
          + ' <button type="button" class="mem-revoke" data-user="' + esc(name) + '" data-passes="' + esc(ids.join(',')) + '" data-paid="' + (a.kind === 'paid' ? '1' : '0') + '">Revoke</button></td></tr>';
      }
      if (MEM_OPEN[name]) html += '<tr data-user="' + esc(name.toLowerCase()) + '"><td colspan="' + (past ? 5 : 7) + '">' + memPassesHtml(a) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<p class="note">"Revoke" ends Pro for that account now: every pass it still holds. It does not give any money back. To refund someone who bought, use Refund on <a href="#orders">Orders and refunds</a>: that returns the money and ends the pass in one step. "Pro used" counts the AI designs, reviews and messages taken on the pass.</p>';
  if ((MEMBERS.passes || []).length >= (MEMBERS.max || 0)) html += '<p class="note">Showing the newest ' + fmt(MEMBERS.max) + ' passes.</p>';
  html += lookupHtml();
  return html;
}
function wireMembers(){
  var out = el('mem-out');
  var filters = document.querySelectorAll('.mem-filter');
  for (var i = 0; i < filters.length; i++){
    filters[i].addEventListener('click', function(e){ MEM_FILTER = e.currentTarget.getAttribute('data-mem'); MEM_MSG = ''; paintSection(); });
  }
  var find = el('mem-q');
  if (find) find.addEventListener('input', function(){
    var want = (find.value || '').trim().replace(/^@/, '').toLowerCase();
    var rows = document.querySelectorAll('#mem-table tbody tr[data-user]');
    for (var r = 0; r < rows.length; r++) rows[r].hidden = !!want && rows[r].getAttribute('data-user').indexOf(want) < 0;
  });
  var mores = document.querySelectorAll('.mem-more');
  for (var m = 0; m < mores.length; m++){
    mores[m].addEventListener('click', function(e){ var u = e.currentTarget.getAttribute('data-user'); MEM_OPEN[u] = !MEM_OPEN[u]; paintSection(); });
  }
  var gives = document.querySelectorAll('.mem-give');
  for (var g = 0; g < gives.length; g++){
    gives[g].addEventListener('click', function(e){
      var box = el('mem-g-user');
      box.value = e.currentTarget.getAttribute('data-user');
      box.scrollIntoView({ block: 'center' });
      el('mem-g-days').focus();
    });
  }
  var grant = el('mem-grant');
  if (grant) grant.addEventListener('click', async function(){
    var user = (el('mem-g-user').value || '').trim().replace(/^@/, '');
    var days = (el('mem-g-days').value || '').trim();
    if (!user){ out.textContent = 'Type a username first.'; return; }
    grant.disabled = true;
    out.textContent = 'Giving...';
    var body = { username: user, plan: 'monthly' };
    if (days) body.days = Number(days);
    var r = await post('/api/admin/pro/grant', body);
    grant.disabled = false;
    if (r.ok && r.data && r.data.ok){
      MEM_GIVE = '';
      MEM_MSG = '<b>Given.</b> @' + esc(user) + ' has Pro until ' + esc(memDay(r.data.pass.endsAt)) + '.';
      proReload();
      return;
    }
    MEM_GIVE = user;
    out.innerHTML = '<b class="warn">Not given.</b> ' + esc(r.status === 404 ? 'There is no account called @' + user + '.' : ((r.data && r.data.error) || ('HTTP ' + r.status)));
  });
  var revokes = document.querySelectorAll('.mem-revoke');
  for (var v = 0; v < revokes.length; v++){
    revokes[v].addEventListener('click', async function(e){
      var b = e.currentTarget, user = b.getAttribute('data-user');
      /* Two presses: the first asks, the second ends it. */
      if (b.getAttribute('data-sure') !== '1'){
        b.setAttribute('data-sure', '1');
        b.textContent = 'Sure? End Pro for @' + user;
        return;
      }
      b.disabled = true;
      b.textContent = 'Ending...';
      var ids = (b.getAttribute('data-passes') || '').split(','), failed = 0;
      for (var n = 0; n < ids.length; n++){
        if (!ids[n]) continue;
        var r = await post('/api/admin/pro/revoke', { passId: ids[n] });
        /* 404: that pass has ended since the list was loaded, which is what was wanted. */
        if (!r.ok && r.status !== 404) failed++;
      }
      MEM_MSG = failed
        ? '<b class="warn">Not all of it ended.</b> ' + fmt(failed) + ' pass' + (failed === 1 ? '' : 'es') + ' of @' + esc(user) + ' could not be revoked. Try again.'
        : '<b>Ended.</b> @' + esc(user) + ' is on the free plan now.' + (b.getAttribute('data-paid') === '1' ? ' Nothing was refunded: if the money should go back too, refund the order under Pro, Payments.' : '');
      proReload();
    });
  }
}

/* ---- tifo events: themed contests, made and run from here ----
   Everything is on the server (server/src/eventRoutes.ts, tifoEvents.ts): the
   stage comes from the four times and the clock, votes are hidden from fans
   until the result is confirmed here, and every action below is written to
   the Security tab's audit trail. Times are typed and shown in this
   browser's own time zone. */
var EVENTS = null;
var EV_EDIT = null;
var EV_MSG = '';
var EV_STAGE = {
  draft: ['Draft', 'only you see it until its announcement time'],
  announced: ['Announced', 'the theme, dates and prize are public'],
  open: ['Open for entries', 'fans are entering'],
  voting: ['Voting', 'entries are frozen; fans vote and see no counts'],
  closed: ['Waiting for you', 'voting is over: confirm the result'],
  result: ['Result confirmed', 'the podium and the counts are public'],
  cancelled: ['Cancelled', 'on no public page']
};
function evLocal(iso){
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function evShow(iso){ return iso ? esc(evLocal(iso).replace('T', ' ')) : ''; }
function evById(id){
  var list = (EVENTS && EVENTS.events) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
async function evReload(){
  var r = await api('/api/admin/events');
  EVENTS = r.ok && r.data ? r.data : { error: r.status };
  if (currentTab === 'events') paintSection();
}
function evField(id, label, value, attrs, wide){
  return '<label' + (wide ? ' class="lb-wide"' : '') + '>' + label + ' <input id="' + id + '" ' + attrs + ' value="' + esc(value == null ? '' : value) + '"></label>';
}
function evForm(){
  var e = EV_EDIT ? evById(EV_EDIT) : null;
  var html = '<h2 class="sec">' + (e ? 'Change "' + esc(e.titleEn) + '"' : 'Make an event') + '</h2>';
  html += '<p class="note">A theme, four times and a prize. Nothing is public before the announcement time, so an event can be made days ahead. Times are in this browser&#39;s time zone.</p>';
  html += '<div class="lb-grid" id="ev-form">'
    + evField('ev-title-en', 'Title (English)', e ? e.titleEn : '', 'type="text" maxlength="60" autocomplete="off"')
    + evField('ev-title-ar', 'Title (Arabic)', e ? e.titleAr : '', 'type="text" maxlength="60" autocomplete="off" dir="rtl"')
    + evField('ev-line-en', 'One line about the theme (English)', e ? e.lineEn : '', 'type="text" maxlength="200" autocomplete="off"', true)
    + evField('ev-line-ar', 'One line about the theme (Arabic)', e ? e.lineAr : '', 'type="text" maxlength="200" autocomplete="off" dir="rtl"', true)
    + evField('ev-announce', 'Announced (public from)', evLocal(e ? e.announceAt : ''), 'type="datetime-local"')
    + evField('ev-open', 'Entries open', evLocal(e ? e.openAt : ''), 'type="datetime-local"')
    + evField('ev-vote', 'Voting starts (entries freeze)', evLocal(e ? e.voteAt : ''), 'type="datetime-local"')
    + evField('ev-close', 'Voting ends', evLocal(e ? e.closeAt : ''), 'type="datetime-local"')
    + evField('ev-prize', 'Prize: days of Pro for the winner (0 for none)', e ? e.prizeDays : 30, 'type="number" min="0" max="90" step="1" inputmode="numeric"')
    + evField('ev-slug', 'Address: /events/... (empty: from the English title)', e ? e.slug : '', 'type="text" maxlength="41" autocomplete="off" spellcheck="false"' + (e && e.stage !== 'draft' ? ' disabled' : ''))
    + '</div>';
  html += '<p class="note"><button id="ev-fill" type="button">Fill the usual dates</button> announced now, entries open in 2 days for 5 days, then 2 days of voting.</p>';
  html += '<p class="note"><button id="ev-save" type="button">' + (e ? 'Save changes' : 'Make the event') + '</button>'
    + (e ? ' <button id="ev-stop" type="button">Stop changing</button>' : '') + '</p>';
  html += '<p id="ev-out" class="note" role="status" aria-live="polite">' + EV_MSG + '</p>';
  return html;
}
function evCard(e){
  var st = EV_STAGE[e.stage] || [e.stage, ''];
  var kind = e.stage === 'closed' ? ' warn' : (e.stage === 'open' || e.stage === 'voting' || e.stage === 'result') ? ' good' : '';
  var entries = e.entries || [];
  var isPublic = e.stage !== 'draft' && e.stage !== 'cancelled';
  var html = '<div class="card ev-card" data-ev="' + esc(e.id) + '">';
  html += '<p class="lt"><bdi>' + esc(e.titleEn) + '</bdi> &middot; <bdi>' + esc(e.titleAr) + '</bdi> <span class="badge' + kind + '">' + esc(st[0]) + '</span></p>';
  html += '<p class="lc">' + esc(st[1]) + (isPublic ? ' &middot; <a href="/events/' + esc(e.slug) + '" target="_blank" rel="noopener">/events/' + esc(e.slug) + '</a>' : ' &middot; /events/' + esc(e.slug)) + '</p>';
  if (e.lineEn || e.lineAr) html += '<p class="note"><bdi>' + esc(e.lineEn) + '</bdi>' + (e.lineAr ? '<br><bdi>' + esc(e.lineAr) + '</bdi>' : '') + '</p>';
  html += '<table class="tbl"><tbody>'
    + '<tr><th>Announced</th><td>' + evShow(e.announceAt) + '</td><th>Entries open</th><td>' + evShow(e.openAt) + '</td></tr>'
    + '<tr><th>Voting starts</th><td>' + evShow(e.voteAt) + '</td><th>Voting ends</th><td>' + evShow(e.closeAt) + '</td></tr>'
    + '<tr><th>Prize</th><td>' + (e.prizeDays ? fmt(e.prizeDays) + ' days of Pro' : 'the title only') + '</td><th>Entries</th><td>' + fmt(entries.length) + '</td></tr>'
    + '</tbody></table>';
  if (e.stage === 'result'){
    var w = null;
    for (var k = 0; k < entries.length; k++) if (entries[k].designId === e.winnerDesign) w = entries[k];
    html += '<div class="callout ok"><b>Confirmed ' + evShow(e.confirmedAt) + '.</b> '
      + (e.winnerUser ? 'Winner: ' + (w ? '<bdi>' + esc(w.title || 'a tifo') + '</bdi> by @' + esc(w.owner || '?') : 'a tifo that is no longer public') + '. ' + (e.prizePass ? 'The prize pass was given.' : 'No prize pass was given.') : 'No entry had a counted vote, so there is no winner.')
      + '</div>';
  }
  if (e.stage === 'closed'){
    html += '<div class="callout"><b>Voting is over.</b> ' + (e.proposed && e.proposed.length ? 'The result would name the entries marked 1, 2 and 3 below. Take out any that broke the theme first, then confirm.' : 'No entry has a counted vote: confirming records no winner.') + '</div>';
  }
  if (entries.length){
    html += '<table class="tbl"><thead><tr><th>#</th><th>Tifo</th><th>By</th><th>Entered</th><th>Votes that count</th><th>All votes</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < entries.length; i++){
      var x = entries[i];
      var place = e.stage === 'result'
        ? (x.designId === e.winnerDesign ? 1 : x.designId === e.secondDesign ? 2 : x.designId === e.thirdDesign ? 3 : 0)
        : (e.proposed ? e.proposed.indexOf(x.designId) + 1 : 0);
      html += '<tr><td>' + (place ? '<b>' + place + '</b>' : '') + '</td><td>'
        + (x.isPublic ? '<a href="/t/' + esc(x.designId) + '" target="_blank" rel="noopener"><bdi>' + esc(x.title || 'Untitled') + '</bdi></a>' : '<span class="dim">unpublished or deleted: out of the result</span>')
        + (x.reason ? '<br><b class="warn">Taken out:</b> <bdi>' + esc(x.reason) + '</bdi>' : '') + '</td><td>'
        + (x.owner ? '@' + esc(x.owner) : '') + '</td><td>' + evShow(x.enteredAt) + '</td><td>' + fmt(x.votes) + '</td><td>' + fmt(x.allVotes) + '</td><td>';
      if (e.stage !== 'result'){
        html += x.reason
          ? '<button class="ev-back" type="button" data-design="' + esc(x.designId) + '">Put back</button>'
          : '<input class="ev-reason" type="text" maxlength="120" placeholder="Reason, shown to fans" aria-label="Reason for taking this entry out" data-design="' + esc(x.designId) + '"> <button class="ev-out" type="button" data-design="' + esc(x.designId) + '">Take out</button>';
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    html += '<p class="note">A vote counts when the voter&#39;s email was verified before voting started. Fans never see either number until the result is confirmed, and then only the votes that count.</p>';
  }
  html += '<p class="note">';
  if (e.stage !== 'result') html += '<button class="ev-edit" type="button">Change</button> ';
  if (e.stage === 'closed') html += '<button class="ev-confirm" type="button">Confirm the result</button> ';
  if (e.stage === 'cancelled') html += '<button class="ev-uncancel" type="button">Bring back</button> ';
  else if (e.stage !== 'result') html += '<button class="ev-cancel" type="button">Cancel the event</button> ';
  if (!entries.length && e.stage !== 'result') html += '<button class="ev-delete" type="button">Delete</button>';
  html += '</p></div>';
  return html;
}
function eventsTab(){
  var html = '<h2 class="sec">Tifo events</h2>';
  if (EVENTS === null){ void evReload(); return html + '<p class="note">Loading...</p>'; }
  if (EVENTS.error){
    return html + '<div class="callout bad"><b>Could not load the events.</b> HTTP ' + esc(String(EVENTS.error)) + (EVENTS.error === 404 ? ' (this server has no events store)' : '') + '</div>';
  }
  html += '<p class="lede">A themed contest, when you want one: announce it, fans enter one tifo each, then vote. You confirm the winner here. While there is no event, nothing about events shows anywhere on the site.</p>';
  if (!EVENTS.canGrant) html += '<div class="callout warn"><b>This server has no Pro store</b>, so a winner gets the title and no pass.</div>';
  else if (EVENTS.proMode !== 'on') html += '<div class="callout warn"><b>Pro is ' + esc(EVENTS.proMode) + '.</b> The winner still gets the pass, but only accounts Pro is on for see the crown and the Pro tools. Set the prize to 0 days for a contest with the title alone.</div>';
  html += evForm();
  var list = EVENTS.events || [];
  html += '<h2 class="sec">Events <span class="hint">newest first</span></h2>';
  if (!list.length) html += '<p class="note">None yet.</p>';
  for (var i = 0; i < list.length; i++) html += evCard(list[i]);
  return html;
}
function evSay(html){ EV_MSG = html; var o = el('ev-out'); if (o) o.innerHTML = html; }
function evRefused(r){ return '<b class="warn">Refused.</b> ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)); }
function evIso(id){
  var v = el(id).value;
  if (!v) return '';
  var d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
function evBody(){
  return {
    titleEn: el('ev-title-en').value, titleAr: el('ev-title-ar').value, lineEn: el('ev-line-en').value, lineAr: el('ev-line-ar').value,
    announceAt: evIso('ev-announce'), openAt: evIso('ev-open'), voteAt: evIso('ev-vote'), closeAt: evIso('ev-close'),
    prizeDays: el('ev-prize').value === '' ? 30 : Number(el('ev-prize').value), slug: (el('ev-slug').value || '').trim().toLowerCase()
  };
}
async function evAct(id, path, body, done){
  var r = await post('/api/admin/events/' + id + path, body || {});
  if (r.ok && r.data && r.data.ok) evSay(done(r.data));
  else evSay(evRefused(r));
  await evReload();
  var out = el('ev-out');
  if (out && out.scrollIntoView) out.scrollIntoView({ block: 'center' });
}
function wireEvents(){
  var save = el('ev-save');
  if (!save) return;
  el('ev-fill').addEventListener('click', function(){
    var day = 24 * 3600 * 1000, t = Date.now();
    el('ev-announce').value = evLocal(new Date(t).toISOString());
    el('ev-open').value = evLocal(new Date(t + 2 * day).toISOString());
    el('ev-vote').value = evLocal(new Date(t + 7 * day).toISOString());
    el('ev-close').value = evLocal(new Date(t + 9 * day).toISOString());
  });
  save.addEventListener('click', async function(){
    var body = evBody();
    if (!body.titleEn.trim() || !body.titleAr.trim()){ evSay('Type the title in English and in Arabic first.'); return; }
    if (!body.announceAt || !body.openAt || !body.voteAt || !body.closeAt){ evSay('Fill all four times first.'); return; }
    save.disabled = true;
    evSay('Saving...');
    var r = await post('/api/admin/events' + (EV_EDIT ? '/' + EV_EDIT : ''), body);
    save.disabled = false;
    if (r.ok && r.data && r.data.ok){
      evSay((EV_EDIT ? 'Saved' : 'Made') + ': <b>' + esc(r.data.event.titleEn) + '</b>, at /events/' + esc(r.data.event.slug) + '.');
      EV_EDIT = null;
      await evReload();
    } else evSay(evRefused(r));
  });
  var stop = el('ev-stop');
  if (stop) stop.addEventListener('click', function(){ EV_EDIT = null; EV_MSG = ''; paintSection(); });
  function idOf(node){ var c = node.closest('.ev-card'); return c ? c.getAttribute('data-ev') : ''; }
  function each(sel, fn){
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', function(ev){ var b = ev.currentTarget; void fn(b, idOf(b)); });
  }
  each('.ev-edit', function(b, id){ EV_EDIT = id; EV_MSG = ''; paintSection(); var f = el('ev-form'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' }); });
  each('.ev-cancel', function(b, id){
    if (!window.confirm('Cancel this event? It leaves every public page. Entries and votes are kept, and you can bring it back.')) return;
    return evAct(id, '/cancel', { cancelled: true }, function(){ return 'Cancelled.'; });
  });
  each('.ev-uncancel', function(b, id){ return evAct(id, '/cancel', { cancelled: false }, function(){ return 'Brought back.'; }); });
  each('.ev-delete', function(b, id){
    if (!window.confirm('Delete this event for good?')) return;
    if (EV_EDIT === id) EV_EDIT = null;
    return evAct(id, '/delete', {}, function(){ return 'Deleted.'; });
  });
  each('.ev-out', function(b, id){
    var design = b.getAttribute('data-design');
    var input = b.parentNode.querySelector('.ev-reason');
    var reason = input ? (input.value || '').trim() : '';
    if (!reason){ evSay('Type the reason first: fans see it on the event page.'); if (input) input.focus(); return; }
    return evAct(id, '/disqualify', { designId: design, reason: reason }, function(){ return 'Taken out.'; });
  });
  each('.ev-back', function(b, id){ return evAct(id, '/disqualify', { designId: b.getAttribute('data-design'), reason: '' }, function(){ return 'Put back.'; }); });
  each('.ev-confirm', function(b, id){
    var e = evById(id);
    var top = e && e.proposed && e.proposed.length ? e.proposed[0] : null;
    var w = null;
    for (var i = 0; top && i < e.entries.length; i++) if (e.entries[i].designId === top) w = e.entries[i];
    var what = w ? 'The winner will be "' + (w.title || 'Untitled') + '" by @' + (w.owner || '?') + ' with ' + w.votes + ' counted vote' + (w.votes === 1 ? '' : 's') + (e.prizeDays ? ', who gets ' + e.prizeDays + ' days of Pro' : '') + '.' : 'No entry has a counted vote, so there will be no winner.';
    if (!window.confirm('Confirm the result? ' + what + ' This makes the podium and the counts public and cannot be undone here.')) return;
    b.disabled = true;
    return evAct(id, '/confirm', {}, function(d){
      var prize = d.prize === 'given' ? 'The prize pass was given.'
        : d.prize === 'too_soon' ? 'No pass: this winner had an event prize in the last 90 days, so they take the title only.'
        : d.prize === 'failed' ? 'The pass could not be given: give it by hand on the Pro tab.'
        : d.prize === 'no_winner' ? 'No entry had a counted vote: no winner.'
        : 'The title only.';
      return '<b>Result confirmed.</b> ' + (d.winner ? 'Winner: @' + esc(d.winner.owner || '?') + '. ' : '') + prize;
    });
  });
}

/* ---- security: is anyone attacking the site, and is it set up to cope ----
   Everything here is counted on the server after each response. Addresses
   arrive as 12-character tags, never as addresses; accounts only by their
   public @name. See server/src/soc.ts for what is recorded and why. */
var SOC_KIND = {
  login_failed:           ['Failed sign-ins', 'wrong password, or an account that does not exist'],
  login_ok:               ['Successful sign-ins', 'context, not an attack'],
  register_conflict:      ['Sign-ups that hit an existing account', 'the way someone tests which emails are registered'],
  reset_requested:        ['Password reset requests', ''],
  code_failed:            ['Wrong verification codes', ''],
  code_exhausted:         ['Verification codes used up', 'five wrong guesses at one code'],
  mail_refused:           ['Emails refused by the per-address limits', 'someone trying to flood a mailbox'],
  password_change_failed: ['Wrong current password when changing it', ''],
  oauth_linked:           ['Google connected to an account', ''],
  oauth_link_refused:     ['Google refused a link to an unverified account', 'the email is already taken by an account that never verified it'],
  admin_unlock_failed:    ['Wrong admin password', 'the /admin sign-in'],
  admin_denied:           ['Admin requests without admin rights', ''],
  rate_limited:           ['Rate-limited requests', 'past 300 a minute, or 10 a minute on sign-in routes'],
  oversized_body:         ['Oversized requests', 'past the body size limit'],
  scanner_probe:          ['Vulnerability scanner probes', '/.env, /wp-login.php and the like'],
  bot_trap:               ['Bots caught by the feedback form', 'honeypot field or impossibly fast'],
  upload_refused:         ['Uploads that were not images', ''],
  server_error:           ['Server errors', 'a 500 answer']
};
var SOC_SIGNIN = ['login_failed', 'code_failed', 'code_exhausted', 'password_change_failed', 'register_conflict', 'reset_requested', 'mail_refused', 'oauth_link_refused', 'login_ok', 'oauth_linked'];
var SOC_ABUSE = ['rate_limited', 'oversized_body', 'scanner_probe', 'admin_unlock_failed', 'admin_denied', 'bot_trap', 'upload_refused', 'server_error'];
var SOC_COLOR = { signin:'#f85149', admin:'#a371f7', abuse:'#d29922', errors:'#58a6ff' };
var STATE_WORD = { good:'good', warn:'check', bad:'fix', info:'note' };

function socFiring(){
  var sc = DATA && DATA.sc;
  if (!sc || !sc.rules) return [];
  return sc.rules.filter(function(r){ return r.firing; });
}
function socTotal(kind, span){
  var sc = DATA.sc, t = (sc && sc.summary && sc.summary.totals) || [];
  for (var i = 0; i < t.length; i++) if (t[i].kind === kind) return Number(t[i][span || 'day']) || 0;
  return 0;
}
function socTotals(kinds, span){
  var n = 0;
  for (var i = 0; i < kinds.length; i++) n += socTotal(kinds[i], span);
  return n;
}
function kindLabel(k){ return (SOC_KIND[k] && SOC_KIND[k][0]) || labelize(k); }
function clockTime(iso){
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function stateChip(state){ return '<span class="st ' + esc(state) + '">' + esc(STATE_WORD[state] || state) + '</span>'; }
function tagCell(t){ return t ? '<span class="tagcode" title="Hashed address">' + esc(t) + '</span>' : '<span class="dim">-</span>'; }

/* 48 hourly stacked bars. Hours with nothing in them are still drawn as gaps,
   so a quiet night reads as quiet rather than being squeezed out. */
function socHourlyChart(sc){
  var W = 720, H = 150, padB = 4;
  var rows = (sc.summary && sc.summary.hourly) || [];
  var byHour = {};
  for (var i = 0; i < rows.length; i++) byHour[rows[i].hour] = rows[i];
  var end = Math.floor(Date.parse(sc.generatedAt || new Date().toISOString()) / 3600000) * 3600000;
  var slots = [], max = 0;
  for (var h = 47; h >= 0; h--){
    var key = new Date(end - h * 3600000).toISOString();
    var r = byHour[key] || { signin:0, admin:0, abuse:0, errors:0 };
    var tot = (Number(r.signin)||0) + (Number(r.admin)||0) + (Number(r.abuse)||0) + (Number(r.errors)||0);
    if (tot > max) max = tot;
    slots.push({ key: key, r: r, tot: tot });
  }
  if (!max){
    return '<div class="card"><p class="lt">The last 48 hours</p><p class="empty">Nothing recorded: no attacks, no blocked requests, no server errors.</p></div>';
  }
  var bw = W / 48, svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="150" preserveAspectRatio="none" role="img" aria-label="Security events per hour, last 48 hours">';
  for (var s2 = 0; s2 < slots.length; s2++){
    var sl = slots[s2], y = H - padB, parts = ['errors', 'abuse', 'admin', 'signin'];
    for (var p = 0; p < parts.length; p++){
      var v = Number(sl.r[parts[p]]) || 0;
      if (!v) continue;
      var bh = Math.max(1.5, v / max * (H - padB - 6));
      y -= bh;
      svg += '<rect x="' + (s2 * bw + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + SOC_COLOR[parts[p]] + '"><title>' + esc(clockTime(sl.key)) + ': ' + fmt(v) + ' ' + parts[p] + '</title></rect>';
    }
  }
  svg += '</svg>';
  return '<div class="card"><p class="lt">The last 48 hours <span class="dim" style="font-weight:400">: peak ' + fmt(max) + ' in an hour</span></p>'
    + '<p class="lc"><span style="color:' + SOC_COLOR.signin + '">&#9632;</span> sign-in activity (failed sign-ins, wrong codes, password resets) &nbsp; <span style="color:' + SOC_COLOR.admin + '">&#9632;</span> admin &nbsp; <span style="color:' + SOC_COLOR.abuse + '">&#9632;</span> blocked and abusive &nbsp; <span style="color:' + SOC_COLOR.errors + '">&#9632;</span> server errors</p>'
    + svg
    + '<p class="lc" style="margin:5px 0 0;display:flex;justify-content:space-between">' + esc(clockTime(slots[0].key)) + '<span>now</span></p></div>';
}

function socKindTable(kinds){
  var body = '';
  for (var i = 0; i < kinds.length; i++){
    var k = kinds[i], info = SOC_KIND[k] || [k, ''];
    body += '<tr><td class="name" title="' + esc(info[1]) + '">' + esc(info[0]) + (info[1] ? '<span class="fsub dim" style="display:block;font-size:11px">' + esc(info[1]) + '</span>' : '') + '</td>'
      + '<td>' + fmt(socTotal(k, 'day')) + '</td><td>' + fmt(socTotal(k, 'week')) + '</td><td>' + fmt(socTotal(k, 'month')) + '</td></tr>';
  }
  return '<div class="card scroll"><table><thead><tr><th class="name">What</th><th>24 hours</th><th>7 days</th><th>30 days</th></tr></thead><tbody>' + body + '</tbody></table></div>';
}

function securityTab(){
  var sc = DATA.sc;
  if (!sc) return '<h2 class="sec">Security</h2><p class="note">Could not read the security log. The server may be running without the monitor.</p>';
  var firing = socFiring();
  var html = '<h2 class="sec">Security <span class="hint">the last 24 hours unless a column says otherwise &middot; the alert rules count since the last deploy</span></h2>';

  if (firing.length){
    html += '<div class="callout bad"><b>' + fmt(firing.length) + (firing.length === 1 ? ' alert is' : ' alerts are') + ' over threshold right now.</b><br>';
    for (var f = 0; f < firing.length; f++){
      var fr = firing[f];
      html += esc(fr.title) + ': ' + fmt(fr.count) + ' in ' + fmt(fr.windowMin) + ' min' + (fr.perSource ? ' from one address' : '') + ' (threshold ' + fmt(fr.threshold) + ')' + (fr.lastAlertAt ? ', emailed ' + esc(timeAgo(fr.lastAlertAt)) : '') + '<br>';
    }
    html += '</div>';
  } else {
    html += '<div class="callout ok"><b>All quiet.</b> No alert rule is over its threshold in its window. The rules count in memory, so they start again from zero at each deploy; the tables below are kept and do not.</div>';
  }

  html += '<div class="grid" style="margin-top:12px">';
  html += kpi('Failed sign-ins', socTotal('login_failed'), fmt(socTotal('login_failed', 'week')) + ' in 7 days', true);
  html += kpi('Code and password guesses', socTotals(['code_failed', 'code_exhausted', 'password_change_failed']), 'verification codes, password changes', true);
  html += kpi('Wrong admin password', socTotal('admin_unlock_failed'), fmt(socTotal('admin_unlock_failed', 'week')) + ' in 7 days', true);
  html += kpi('Blocked requests', socTotals(['rate_limited', 'oversized_body']), 'rate limits and size limits', true);
  html += kpi('Scanner probes', socTotal('scanner_probe'), 'bots looking for weak spots', true);
  html += kpi('Server errors', socTotal('server_error'), fmt(socTotal('server_error', 'week')) + ' in 7 days', true);
  html += '</div>';
  html += '<div style="margin-top:10px">' + socHourlyChart(sc) + '</div>';

  /* ---- attacks on sign-in ---- */
  var summary = sc.summary || {};
  html += '<h2 class="sec">Sign-in activity <span class="hint">attacks and ordinary use together: a password reset is in here too</span></h2>';
  html += socKindTable(SOC_SIGNIN);
  html += '<div class="grid two" style="margin-top:10px">';
  var subj = summary.topSubjects || [];
  html += '<div class="card"><p class="lt">Most targeted accounts</p><p class="lc">failed sign-ins in the last 7 days, and from how many addresses</p>';
  if (!subj.length) html += '<p class="empty">No failed sign-ins against a real account.</p>';
  for (var a = 0; a < subj.length; a++){
    html += '<div class="row"><div class="nm">@' + esc(subj[a].subject) + '</div><div class="vv"><b>' + fmt(subj[a].failures) + '</b> <span class="dim">from ' + fmt(subj[a].sources) + '</span></div></div>';
  }
  html += '</div>';
  var srcs = summary.topSources || [];
  html += '<div class="card"><p class="lt">Busiest addresses</p><p class="lc">hashed; everything they triggered in the last 24 hours</p>';
  if (!srcs.length) html += '<p class="empty">Nothing recorded.</p>';
  for (var b = 0; b < srcs.length; b++){
    var ks = (srcs[b].kinds || []).map(kindLabel).join(', ');
    html += '<div class="row"><div class="nm" title="' + esc(ks) + '">' + tagCell(srcs[b].source) + ' <span class="dim" style="font-size:11.5px">' + esc(ks) + '</span></div><div class="vv"><b>' + fmt(srcs[b].total) + '</b></div></div>';
  }
  html += '</div></div>';

  /* ---- blocked and abusive traffic ---- */
  html += '<h2 class="sec">Blocked and abusive traffic</h2>';
  html += socKindTable(SOC_ABUSE);
  var routes = summary.topRoutes || [];
  html += '<div class="card" style="margin-top:10px"><p class="lt">What was refused, and where</p><p class="lc">last 24 hours</p>';
  if (!routes.length) html += '<p class="empty">Nothing refused.</p>';
  for (var c = 0; c < routes.length; c++){
    html += '<div class="row"><div class="nm"><code>' + esc(routes[c].route) + '</code> <span class="dim" style="font-size:11.5px">' + esc(kindLabel(routes[c].kind)) + '</span></div><div class="vv"><b>' + fmt(routes[c].total) + '</b></div></div>';
  }
  html += '</div>';

  /* ---- alerts ---- */
  html += '<h2 class="sec">Alerts <span class="hint">emailed at most once an hour per rule</span></h2>';
  html += sc.alertsTo
    ? '<p class="lede">Alerts go to <b>' + esc(sc.alertsTo) + '</b>.</p>'
    : '<div class="callout"><b>Nobody is emailed.</b> Set <code>SECURITY_ALERT_TO</code> in Railway to the address that should hear about an attack while it is happening. Everything is still recorded here.</div>';
  /* When a rule last alerted comes from the kept history. The rule's own memory
     is empty after a deploy, and said "never" above a table listing its alerts. */
  var lastOf = {}, hist = sc.alerts || [];
  for (var h = 0; h < hist.length; h++){
    var hr = hist[h];
    if (hr && hr.rule && (!lastOf[hr.rule] || hr.at > lastOf[hr.rule])) lastOf[hr.rule] = hr.at;
  }
  var rules = sc.rules || [], rb = '';
  for (var d = 0; d < rules.length; d++){
    var ru = rules[d];
    var lastAt = ru.lastAlertAt && (!lastOf[ru.id] || ru.lastAlertAt > lastOf[ru.id]) ? ru.lastAlertAt : (lastOf[ru.id] || null);
    rb += '<tr><td class="name" title="' + esc(ru.title) + '">' + esc(ru.title) + '</td>'
      + '<td>' + (ru.firing ? '<span class="st bad">firing</span>' : '<span class="st good">quiet</span>') + '</td>'
      + '<td>' + fmt(ru.count) + ' / ' + fmt(ru.threshold) + '</td>'
      + '<td>' + fmt(ru.windowMin) + ' min' + (ru.perSource ? ', one address' : '') + '</td>'
      + '<td>' + (lastAt ? esc(timeAgo(lastAt)) : '<span class="dim">not among the last ' + fmt(hist.length || 30) + ' alerts</span>') + '</td></tr>';
  }
  html += '<div class="card scroll" style="margin-top:10px"><table><thead><tr><th class="name">Rule</th><th>Now</th><th>Count / threshold</th><th>Window</th><th>Last alert</th></tr></thead><tbody>' + rb + '</tbody></table></div>';
  var al = sc.alerts || [];
  if (al.length){
    var ab = '';
    for (var e = 0; e < al.length; e++){
      ab += '<tr><td class="when">' + esc(clockTime(al[e].at)) + '</td><td class="name" title="' + esc(al[e].summary) + '">' + esc(al[e].rule) + '</td><td>' + fmt(al[e].count) + '</td><td>'
        + (al[e].delivered ? '<span class="st good">sent</span>' : '<span class="st warn" title="' + esc(al[e].error || '') + '">not sent</span> <span class="dim" style="font-size:11.5px">' + esc(al[e].error || '') + '</span>') + '</td></tr>';
    }
    html += '<div class="card scroll" style="margin-top:10px"><p class="lt">Alert history</p><table><thead><tr><th>When</th><th class="name">Rule</th><th>Count</th><th>Email</th></tr></thead><tbody>' + ab + '</tbody></table></div>';
  }
  html += '<p style="margin-top:12px"><button id="soc-test" type="button">Send a test alert</button> <span id="soc-test-out" class="note"></span></p>';

  /* ---- audit trail ---- */
  var audit = sc.audit || [];
  html += '<h2 class="sec">Admin audit trail <span class="hint">every admin sign-in and action</span></h2>';
  if (!audit.length){
    html += '<p class="empty">No admin actions recorded yet.</p>';
  } else {
    var tb = '';
    for (var g = 0; g < audit.length; g++){
      var au = audit[g], det = '';
      if (au.detail){ for (var dk in au.detail){ if (Object.prototype.hasOwnProperty.call(au.detail, dk)) det += (det ? ', ' : '') + dk + ': ' + au.detail[dk]; } }
      tb += '<tr><td class="when">' + esc(clockTime(au.at)) + '</td><td>' + esc(au.actor) + '</td><td class="name" title="' + esc(au.action) + '">' + esc(au.action) + (det ? ' <span class="dim">(' + esc(det) + ')</span>' : '') + '</td><td>' + (au.target ? '<code>' + esc(au.target) + '</code>' : '<span class="dim">-</span>') + '</td><td>' + tagCell(au.source) + '</td></tr>';
    }
    html += '<div class="card scroll"><table><thead><tr><th>When</th><th>Who</th><th class="name">What</th><th>On</th><th>From</th></tr></thead><tbody>' + tb + '</tbody></table></div>';
    html += '<p class="note">An address you do not recognise next to "signed in with the admin password" means someone else has it: change <code>AI_ADMIN_PASSWORD</code>, which signs every session out.</p>';
  }

  /* ---- posture ---- */
  var posture = sc.posture || [], bad = 0, warn = 0, pr = '';
  for (var q = 0; q < posture.length; q++){
    var pc = posture[q];
    if (pc.state === 'bad') bad++;
    if (pc.state === 'warn') warn++;
    pr += '<div class="posture-row"><div>' + stateChip(pc.state) + '</div><div><b>' + esc(pc.label) + '</b></div><div class="pd">' + esc(pc.detail) + '</div></div>';
  }
  html += '<h2 class="sec">Security posture' + (bad ? ' <span class="badge warn">' + fmt(bad) + ' to fix</span>' : '') + (warn ? ' <span class="badge">' + fmt(warn) + ' to check</span>' : '') + '</h2>';
  html += '<div class="card">' + (pr || '<p class="empty">No checks available.</p>') + '</div>';

  /* ---- recent events ---- */
  var recent = sc.recent || [];
  html += '<h2 class="sec">Recent events <span class="hint">the latest ' + fmt(recent.length) + ' since this server started</span></h2>';
  if (!recent.length){
    html += '<p class="empty">Nothing since the last restart.</p>';
  } else {
    var rbody = '';
    for (var x = 0; x < recent.length; x++){
      var ev = recent[x];
      rbody += '<tr><td class="when">' + esc(clockTime(ev.at)) + '</td><td class="name" title="' + esc(kindLabel(ev.kind)) + '">' + esc(kindLabel(ev.kind)) + '</td><td><code>' + esc(ev.route || '-') + '</code></td><td>' + (ev.status == null ? '' : esc(ev.status)) + '</td><td>' + tagCell(ev.source) + '</td><td>' + (ev.subject ? '@' + esc(ev.subject) : '') + '</td></tr>';
    }
    html += '<div class="card scroll"><table><thead><tr><th>When</th><th class="name">What</th><th>Route</th><th>Status</th><th>From</th><th>Account</th></tr></thead><tbody>' + rbody + '</tbody></table></div>';
    html += '<p class="note">To act on an address, for example to block it at Cloudflare, find the request in the Railway logs at that time (the log line carries the real address); the dashboard never has it.</p>';
  }

  html += '<div class="callout ok" style="margin-top:22px"><b>What is kept.</b> Counts per minute, for ' + fmt(sc.retentionDays || 30) + ' days, then deleted. Addresses are never stored: each becomes a 12-character tag made with a secret key that is not in the database'
    + (sc.keyStable ? ' (SOC_IP_KEY, so a tag means the same address across restarts).' : ', regenerated at every restart, so tags do not carry over a deploy.')
    + ' Accounts appear only by their public @name, and only when the account exists. Passwords and codes are never recorded, right or wrong.</div>';
  return html;
}

function wireSecurity(){
  var btn = el('soc-test');
  if (!btn) return;
  btn.addEventListener('click', async function(){
    var out = el('soc-test-out');
    btn.disabled = true;
    out.textContent = 'Sending...';
    var r = await post('/api/admin/soc/test-alert', {});
    btn.disabled = false;
    if (r.ok && r.data && r.data.ok){ out.innerHTML = '<b>Sent.</b> Check the inbox (and the spam folder, the first time).'; }
    else { out.innerHTML = '<b class="warn">Not sent.</b> ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)); }
  });
}

/* ---- email: is anything actually being delivered ----
   This tab exists because a verification email that never arrives used to leave
   no trace anywhere a human would look. A missing API key, a refused key, an
   unverified sending domain and an exhausted daily quota all present to the
   person signing up as the same silence, and they need four different fixes. */
function emailTab(){
  var em = DATA.em;
  if (!em) return '<h2 class="sec">Email</h2><p class="note">Could not read the email status.</p>';
  var bad = !em.delivering || (em.lastError && (!em.lastSentAt || em.lastErrorAt > em.lastSentAt));
  var html = '<h2 class="sec">Email</h2>';
  html += '<p class="lede">' + (bad ? '<b class="warn">' : '') + esc(em.summary) + (bad ? '</b>' : '') + '</p>';
  html += '<div class="grid">';
  var real = em.provider === 'resend';
  html += stat(real ? 'Resend' : 'Log only', '', 'Mail service', real ? 'messages go out' : 'nothing is delivered to anyone', '');
  html += stat(em.sent, plural(em.sent, 'message', 'messages'), real ? 'Accepted by the mail service' : 'Written to the log, not sent', 'since the last deploy',
    'Counted in memory, so it starts again from zero at each deploy. Accepted means the mail service took it, not that it reached an inbox.');
  html += stat(em.failed, plural(em.failed, 'message', 'messages'), 'Did not go', 'since the last deploy', 'Refused by the mail service, or it could not be reached (a timeout counts).');
  html += '</div>';
  html += '<table class="tbl"><tbody>';
  html += '<tr><th>From</th><td>' + esc(em.from || '-') + (/(^|[<\\s"])(no[-_.]?reply|do[-_.]?not[-_.]?reply)@/i.test(em.from || '') ? ' <b>(no-reply: a spam signal)</b>' : '') + '</td></tr>';
  html += '<tr><th>Replies go to</th><td>' + esc(em.replyTo || em.from || '-') + '</td></tr>';
  html += '<tr><th>Last accepted</th><td>' + (em.lastSentAt ? esc(new Date(em.lastSentAt).toLocaleString()) : 'not since the last deploy') + '</td></tr>';
  html += '<tr><th>Last one that did not go</th><td>' + (em.lastErrorAt ? esc(new Date(em.lastErrorAt).toLocaleString()) : 'none since the last deploy') + '</td></tr>';
  if (em.lastError) html += '<tr><th>What the provider said</th><td><code>' + esc(em.lastError) + '</code></td></tr>';
  html += '</tbody></table>';
  html += '<h2 class="sec">Send a test</h2>';
  html += '<p class="note">One real message, and the provider&#39;s own answer. If it is accepted but never arrives, the problem is after the hand-off: SPF/DKIM records, or the recipient&#39;s spam filter.</p>';
  html += '<p><input id="em-to" type="email" placeholder="you@example.com" style="min-width:260px" /> '
        + '<button id="em-send" type="button">Send test</button></p>';
  html += '<p id="em-out" class="note"></p>';
  return html;
}

function wireEmailTest(){
  var btn = el('em-send');
  if (!btn) return;
  btn.addEventListener('click', async function(){
    var to = (el('em-to').value || '').trim();
    var out = el('em-out');
    if (!to){ out.textContent = 'Type an address first.'; return; }
    btn.disabled = true;
    out.textContent = 'Sending...';
    var r = await post('/api/admin/email/test', { to: to });
    btn.disabled = false;
    if (r.ok && r.data && r.data.ok){ out.innerHTML = '<b>Accepted.</b> ' + esc(r.data.note || ''); }
    else { out.innerHTML = '<b class="warn">Refused.</b> <code>' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</code>'; }
    loadAll();
  });
}

function render(ov, tr, funnel, sh, fb, ai, em, sc){
  DATA = { ov: ov, tr: tr, funnel: funnel, sh: sh, fb: fb, ai: ai, em: em, sc: sc, days: Number(funnel && funnel.days) || currentDays };

  el('mode').textContent = (ov.mode === 'memory') ? 'in-memory (dev)' : 'postgres';
  el('mode').className = (ov.mode === 'memory') ? 'badge warn' : 'badge good';
  el('tabs').style.display = '';

  currentTab = tabFromUrl();
  renderTabs();
  paintSection();
  el('generated').textContent = 'Snapshot generated ' + (ov.generatedAt ? new Date(ov.generatedAt).toLocaleString() : 'now') + '.';
}

/* Changing the hash — pasting a link, or Back/Forward — is a same-document
   navigation: the module does not re-run, so without this the URL would say
   one section while the page showed another. replaceState rather than push, so
   Back leaves the dashboard instead of walking six tabs first. */
window.addEventListener('hashchange', function(){
  if (!DATA) return;
  var id = tabFromUrl();
  if (id !== currentTab) selectTab(id);
});

el('login-form').addEventListener('submit', doLogin);
el('refresh').addEventListener('click', function(){ loadAll(); });
el('logout').addEventListener('click', function(){ doLogout(); });
el('days').addEventListener('change', function(e){ currentDays = Number(e.target.value) || 30; loadAll(); });

init();
`;
