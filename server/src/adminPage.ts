/**
 * Admin analytics dashboard — served at /admin (+ /admin.js).
 *
 * Why a server-rendered string and not a Vite page: the site CSP is strict
 * (script-src 'self' 'unsafe-eval', connect-src 'self', no CDNs, no inline
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

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>TifoMaker: Admin</title>
<style>
  :root{
    --bg:#0d1117; --bg2:#151b23; --bg3:#1c232c; --line:#2a323d; --line2:#374151;
    --tx:#e6edf3; --mut:#8b949e; --dim:#6b7480;
    --green:#3fb950; --blue:#58a6ff; --gold:#d29922; --red:#f85149; --violet:#a371f7; --teal:#39c5cf;
  }
  *{ box-sizing:border-box; }
  html,body{ overflow-x:hidden; }
  body{ margin:0; background:var(--bg); color:var(--tx); font:14px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }

  header{ position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
          padding:11px 20px; background:rgba(13,17,23,.88); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); }
  .brand{ font-weight:700; font-size:15px; letter-spacing:.2px; white-space:nowrap; }
  .brand span{ font-weight:400; color:var(--mut); }
  .ctrls{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .muted{ color:var(--mut); } .dim{ color:var(--dim); }
  select,button{ font:inherit; font-size:13px; color:var(--tx); background:var(--bg3); border:1px solid var(--line); border-radius:8px; padding:6px 11px; cursor:pointer; transition:border-color .12s,background .12s; }
  button:hover,select:hover{ border-color:var(--line2); background:#222b36; }
  button.primary{ background:var(--green); color:#04220e; border-color:var(--green); font-weight:600; }
  button.primary:hover{ background:#4ac95c; }

  main{ max-width:1240px; margin:0 auto; padding:16px 20px 64px; }
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

<main id="dash" style="display:none">
  <div id="dash-body"></div>
  <p class="note" id="generated"></p>
</main>

<script type="module" src="/admin.js"></script>
</body>
</html>`;

export const ADMIN_JS = `
var UNLOCK_KEY = 'tifo_ai_unlock_v1';
var currentDays = 30;

function el(id){ return document.getElementById(id); }
function getUnlock(){ try { return localStorage.getItem(UNLOCK_KEY); } catch(e){ return null; } }
function setUnlock(t){ try { localStorage.setItem(UNLOCK_KEY, t); } catch(e){} }
function clearUnlock(){ try { localStorage.removeItem(UNLOCK_KEY); } catch(e){} }
function fmt(n){ n = Number(n)||0; return n.toLocaleString(); }
function pct(a, b){ if (!b) return '0%'; return (Math.round((a/b)*1000)/10) + '%'; }
function labelize(s){ return String(s==null?'':s).replace(/_/g,' '); }
function esc(s){ s = String(s==null?'':s); return s.replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
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
async function post(path, body){
  var res;
  try { res = await fetch(path, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) }); }
  catch(e){ return { ok:false, status:0, data:null }; }
  var data = null;
  try { data = await res.json(); } catch(e){ data = null; }
  return { ok: res.ok, status: res.status, data: data };
}

function showLogin(message){
  el('login').style.display = '';
  el('dash').style.display = 'none';
  el('ctrls').style.display = 'none';
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
async function doLogout(){ clearUnlock(); showLogin('Signed out.'); }

async function loadAll(){
  setStatus('Loading...');
  var results = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/traffic?days=' + currentDays),
    api('/api/funnel?days=' + currentDays),
    api('/api/admin/shares?days=' + currentDays),
    api('/api/admin/feedback?limit=50')
  ]);
  var ov = results[0], tr = results[1], fn = results[2], sh = results[3], fb = results[4];
  if (!ov.ok){
    if (ov.status === 403){ clearUnlock(); showLogin('Wrong or expired password. Sign in again.'); return; }
    setStatus('Failed to load (' + ov.status + ').');
    return;
  }
  render(ov.data || {}, (tr.ok && tr.data) ? tr.data : null, (fn.ok && fn.data) ? fn.data : { steps:[], days: currentDays }, (sh.ok && sh.data) ? sh.data : null, (fb.ok && fb.data) ? fb.data : null);
  setStatus('Updated ' + new Date().toLocaleTimeString());
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

function kpi(label, value, sub, subDim){
  return '<div class="card"><div class="k-val">' + (typeof value === 'string' ? esc(value) : fmt(value)) + '</div>'
    + '<div class="k-lab">' + esc(label) + '</div>'
    + (sub ? '<div class="k-sub' + (subDim ? ' n' : '') + '">' + esc(sub) + '</div>' : '') + '</div>';
}

var SOURCE_LABEL = {
  search:'Search engines', social:'Social media', ai:'AI assistants',
  referral:'Other websites', campaign:'Tagged campaigns', direct:'Direct / QR / app', internal:'Internal'
};
var SOURCE_COLOR = {
  search:'#3fb950', social:'#a371f7', ai:'#39c5cf',
  referral:'#58a6ff', campaign:'#d29922', direct:'#8b949e', internal:'#6b7480'
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
      + '<div class="vv"><b>' + fmt(it.visits) + '</b> <span class="dim">/ ' + fmt(it.visitors) + '</span></div>'
      + '</div>';
  }
  return html + '</div>';
}

/* Two-series line chart (visits + unique visitors) over the daily array. */
function trafficChart(daily){
  var W=560, H=140, padX=6, padY=10;
  if (!daily || !daily.length){
    return '<div class="card"><p class="lt">Visits per day</p><p class="empty">No traffic recorded yet.</p></div>';
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
  return '<div class="card"><p class="lt">Visits per day <span class="dim" style="font-weight:400">: ' + fmt(totalV) + ' total, peak ' + fmt(max) + '</span></p>'
    + '<p class="lc"><span style="color:#3fb950">&#9632;</span> visits &nbsp; <span style="color:#58a6ff">&#9632;</span> unique visitors</p>'
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
function chartCard(title, points, color){
  var total = sum(points||[]);
  var last = (points && points.length) ? (Number(points[points.length-1].count)||0) : 0;
  return '<div class="card"><p class="lt">' + esc(title) + '</p>'
    + '<p class="lc">' + fmt(total) + ' total · ' + fmt(last) + ' latest day</p>'
    + lineChart(points, color) + '</div>';
}

/* The rows used to print the raw event name: "Paint First", "View 3d",
   "Account Prompt". Those are the names the code uses, not what happened to a
   person, and you had to remember which was which. */
var FUNNEL_STEP = {
  landed:         ['Opened the editor',      'arrived on /app'],
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
};

/* Only these are a sequence everyone passes through in order, so only these get
   a drop-off figure. The rest are side signals - a draft being restored is not
   a stage between painting and saving, and printing "-3" beside it invented a
   loss that never happened. */
var MAIN_PATH = ['landed', 'paint_first', 'view_3d', 'save_clicked', 'signed_up', 'published'];

function funnelRow(s, lost){
  var p = Number(s.pctOfTop)||0;
  var meta = FUNNEL_STEP[s.name] || [labelize(s.name), ''];
  return '<div class="frow"><div class="flab">' + esc(meta[0])
    + (meta[1] ? '<span class="fsub">' + esc(meta[1]) + '</span>' : '') + '</div>'
    + '<div class="fbar"><div class="ffill" style="width:' + Math.max(1.5, p) + '%"></div></div>'
    + '<div class="fnum">' + fmt(s.sessions) + ' <span class="dim">' + p + '%</span>'
    + (lost > 0 ? '<span class="flost" title="lost since the step above">&minus;' + fmt(lost) + '</span>' : '')
    + '</div></div>';
}

function funnelHtml(funnel){
  var steps = (funnel && funnel.steps) || [];
  if (!steps.length) return '<div class="card"><p class="empty">No funnel data captured yet.</p></div>';
  var byName = {}, i;
  for (i=0;i<steps.length;i++) byName[steps[i].name] = steps[i];

  var html = '<div class="card">';
  var prev = 0;
  for (i=0;i<MAIN_PATH.length;i++){
    var s = byName[MAIN_PATH[i]];
    if (!s) continue;
    var lost = prev > 0 ? prev - (Number(s.sessions)||0) : 0;
    html += funnelRow(s, lost);
    prev = Number(s.sessions)||0;
  }
  html += '</div>';

  var side = steps.filter(function(x){ return MAIN_PATH.indexOf(x.name) === -1; });
  if (side.length){
    html += '<div class="card" style="margin-top:10px">'
      + '<p class="lt">Along the way</p>'
      + '<p class="lc">things that happen off the main path, so no drop-off is implied</p>';
    for (i=0;i<side.length;i++) html += funnelRow(side[i], 0);
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
      td += '<td' + (c===0?' class="name" title="'+esc(String(v))+'"':'') + '>' + (c===0?esc(String(v)):fmt(v)) + '</td>';
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
  html += kpi('Shared', shares, 'platform buttons pressed', true);
  html += kpi('Links opened', opens, 'arrived on a shared link', true);
  html += kpi('Tifos shared', sh.designsShared, 'distinct designs', true);
  html += kpi('Opens per share', shares ? (Math.round((opens/shares)*100)/100) : 0, 'reach per press', true);
  html += '</div>';

  html += '<div class="grid two">';
  html += shareBars('Where they shared to', 'shared / opened · last ' + days + ' days', sh.platforms);
  html += shareChart(sh.daily);
  html += '</div>';

  html += '<div class="grid two">';
  html += tableCard(['Most-shared tifos','Shares'], sh.topDesigns,
    [function(d){ return (d.title || 'Untitled') + (d.owner ? ' · @' + d.owner : ''); }, function(d){ return d.shares; }]);
  html += inb
    ? barList('Landing pages of shared links', 'visits / unique visitors', inb.pages, '#3fb950')
    : '<div class="card"><p class="lt">Landing pages of shared links</p><p class="empty">Traffic measurement is off.</p></div>';
  html += '</div>';

  if (inb){
    html += '<div class="grid">';
    html += kpi('Visits to shared pages', inb.visits, 'server-side, counts everyone', true);
    html += kpi('Tifos opened', inb.tifosOpened, 'distinct shared pages visited', true);
    html += '</div>';
    if (inb.social && inb.social.length){
      html += barList('Arrived from a social or messaging site', 'visits / unique visitors', inb.social, 'social');
    }
  }

  html += '<div class="callout"><b>A share is a button press, not a delivered message.</b> Once the platform takes over, nothing on this site can see whether it was sent, so treat <em>Shared</em> as intent and <em>Links opened</em> as the result. The two do not have to match, and opens can exceed shares when one link is passed on repeatedly.<br><br><b>The social row below is a floor.</b> WhatsApp, Telegram, Discord and most messaging apps strip the referrer, so links passed around there arrive looking like direct traffic. Real reach from sharing is higher than that row shows, never lower.</div>';
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

function feedbackSection(fb){
  var counts = (fb && fb.counts) || { total:0, open:0, bugs:0, ideas:0 };
  var items = (fb && fb.items) || [];
  var html = '<h2 class="sec">What people told me'
    + (counts.bugs ? ' <span class="badge warn">' + fmt(counts.bugs) + ' broken</span>' : '')
    + ' <span class="hint">sent from inside the site</span></h2>';

  if (!items.length){
    return html + '<div class="card"><p class="empty">Nothing reported yet. '
      + 'The form is in the account menu in the editor, and in the footer of every public page.</p></div>';
  }

  html += '<div class="grid">';
  html += kpi('Reports', counts.total);
  html += kpi('Bugs', counts.bugs);
  html += kpi('Feature ideas', counts.ideas);
  html += '</div>';

  html += '<div class="card" style="margin-top:10px">';
  for (var i=0;i<items.length;i++){
    var it = items[i];
    var meta = FB_KIND[it.kind] || FB_KIND.other;
    var c = it.context;
    var ctxLine = c
      ? [c.path, c.browser && c.os ? c.browser + ' on ' + c.os : (c.browser || c.os), c.device, c.viewport]
          .filter(Boolean).join(' · ')
      : 'no diagnostics attached';
    html += '<div class="fbrow">'
      + '<div class="fbtop">'
      +   '<span class="fbkind" style="background:' + meta[1] + '22;color:' + meta[1] + '">' + esc(meta[0]) + '</span>'
      +   '<span class="fbwhen">' + esc(timeAgo(it.createdAt)) + '</span>'
      +   (it.email ? '<a class="fbmail" href="mailto:' + esc(it.email) + '">' + esc(it.email) + '</a>'
                    : '<span class="fbmail dim">no reply address</span>')
      + '</div>'
      + '<p class="fbmsg">' + esc(it.message) + '</p>'
      + (it.steps ? '<p class="fbsteps"><b>Doing:</b> ' + esc(it.steps) + '</p>' : '')
      + '<p class="fbctx">' + esc(ctxLine) + '</p>'
      + '</div>';
  }
  return html + '</div>';
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
    + '<div class="strip-lab">people</div>'
    + '<div class="strip-sub">' + (span
        ? (span.count === 1 ? 'on ' + niceDay(span.first) : niceDay(span.first) + ' to ' + niceDay(span.last))
        : 'nothing recorded yet') + '</div></div>';

  html += '<div class="strip-cell"><div class="strip-val">' + (cmp ? fmt(cmp.now) : '&mdash;') + '</div>'
    + '<div class="strip-lab">' + (cmp ? 'last ' + cmp.days + (cmp.days === 1 ? ' day' : ' days') : 'trend') + '</div>'
    + '<div class="strip-sub">' + (cmp ? deltaChip(cmp) : 'needs a few more days before a trend means anything') + '</div></div>';

  html += '<div class="strip-cell"><div class="strip-val">' + (topSource ? fmt(topSource.visits) : '&mdash;') + '</div>'
    + '<div class="strip-lab">' + (topSource ? (SOURCE_LABEL[topSource.key] || labelize(topSource.key)) : 'top channel') + '</div>'
    + '<div class="strip-sub">' + (topSource && externalVisits
        ? pct(topSource.visits, externalVisits) + ' of arrivals'
        : 'no external arrivals yet') + '</div></div>';

  var r7 = (ov && ov.recent7d) || {};
  html += '<div class="strip-cell"><div class="strip-val">' + fmt(r7.signups) + '</div>'
    + '<div class="strip-lab">new accounts</div>'
    + '<div class="strip-sub dim">last 7 days</div></div>';

  var mod = (ov && ov.moderation) || {};
  var queue = (Number(mod.openReports)||0) + (Number(mod.unverifiedPhotos)||0) + (Number(mod.pendingStadiums)||0);
  html += '<div class="strip-cell"><div class="strip-val">' + fmt(queue) + '</div>'
    + '<div class="strip-lab">needs review</div>'
    + '<div class="strip-sub">' + (queue
        ? '<span class="badge warn">waiting on you</span>'
        : '<span class="badge good">all clear</span>') + '</div></div>';

  return html + '</div>';
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
  html += kpi('Page views', t.visits, fmt(t.visitors) + ' people', true);
  html += kpi('Pages per person', perVisitor, 'higher means they looked around', true);
  html += kpi('Bot requests filtered', t.botVisits, 'excluded from every number here', true);
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += trafficChart(tr.daily);
  html += barList('Traffic sources', 'visits / unique visitors', tr.sources, 'source', SOURCE_LABEL);
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += barList('Referrers', 'which site or search engine sent them', tr.referrers, '#58a6ff');
  html += barList('Landing pages', 'the first page they opened', tr.pages, '#3fb950');
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
  html += barList('Tagged campaigns', 'links you tagged with ?utm_source=..., nothing here means no tagged link was used', tr.campaigns, '#d29922');
  html += '</div>';

  html += '<div class="callout ok"><b>How this is measured.</b> Recorded on the server, after each page is sent, so it counts every visitor rather than only those who accept analytics. No cookie is set. Your IP address is never stored: it is hashed once in memory with a secret that is regenerated every day and never written to disk, so visitors cannot be identified or followed from one day to the next. Referring URLs are reduced to a hostname before storage.</div>';
  return html;
}

function render(ov, tr, funnel, sh, fb){
  var t = ov.totals || {};
  var r7 = ov.recent7d || {};
  var mod = ov.moderation || {};
  var series = ov.series || {};
  var days = Number(funnel && funnel.days) || currentDays;

  el('mode').textContent = (ov.mode === 'memory') ? 'in-memory (dev)' : 'postgres';
  el('mode').className = (ov.mode === 'memory') ? 'badge warn' : 'badge good';

  /* Four groups, not nine sections. Each answers one question:
       1. How is it going        - the strip, read first and then stop
       2. Where people come from - acquisition
       3. What they do here      - funnel, sharing, engagement
       4. What is in the library - designs, moderation, leaderboards, reference
     Time windows are stated per panel from the data, never from the picker. */
  var html = headerStrip(ov, tr, sh);

  /* ---- 2. acquisition ---- */
  html += trafficSection(tr, days);

  /* ---- 3. what they do here ---- */
  html += '<h2 class="sec">What people do here</h2>';

  var funnelShort = 'consent-gated, so far below the page views above';
  html += '<h3 class="sub">Editor funnel <span class="hint">last ' + days + ' days &middot; ' + funnelShort + '</span></h3>';
  html += funnelHtml(funnel);
  html += '<p class="note">These steps only fire after a visitor accepts analytics, so they will never reconcile with the traffic numbers. Read the drop-off <em>between</em> steps, not the totals.</p>';

  html += '<h3 class="sub">Sharing <span class="hint">' + esc(spanLabel(sh && sh.daily, days)) + ' &middot; counts everyone</span></h3>';
  html += sharesSection(sh, days);

  html += '<h3 class="sub">Engagement <span class="hint">all time</span></h3><div class="grid">';
  html += kpi('Likes / votes', t.votes);
  html += kpi('Comments', t.comments);
  html += kpi('Follows', t.follows);
  html += kpi('Match photos', t.photos, fmt(t.verifiedPhotos) + ' verified', true);
  html += '</div>';

  /* ---- what people told me ---- */
  html += feedbackSection(fb);

  /* ---- 4. the library, and the reference numbers ---- */
  var queue = (Number(mod.openReports)||0) + (Number(mod.unverifiedPhotos)||0) + (Number(mod.pendingStadiums)||0);
  html += '<h2 class="sec">The library ' + (queue ? '<span class="badge warn">' + fmt(queue) + ' waiting</span>' : '') + '</h2>';

  html += '<div class="grid">';
  html += kpi('Accounts', t.users, fmt(r7.signups) + ' in the last 7 days', true);
  html += kpi('Designs', t.designs, fmt(r7.designs) + ' in the last 7 days', true);
  html += kpi('Published', t.publicDesigns, 'visible in the community', true);
  html += kpi('Templates', t.templates);
  html += kpi('AI generations', t.aiGenerations, fmt(t.aiUsers) + ' accounts used AI', true);
  html += kpi('B2B leads', t.leads, fmt(r7.leads) + ' in the last 7 days', true);
  html += '</div>';

  if (queue){
    html += '<div class="grid">';
    html += kpi('Open reports', mod.openReports);
    html += kpi('Unverified photos', mod.unverifiedPhotos);
    html += kpi('Pending stadiums', mod.pendingStadiums);
    html += kpi('Approved stadiums', mod.approvedStadiums);
    html += '</div>';
    html += '<p class="note">Act on these in the app: open the editor, then the <strong>Stadium</strong> panel shows the community review queue. <a href="/app">Open the app &rarr;</a></p>';
  }

  html += '<div class="grid two">';
  html += chartCard('New accounts per day', series.signups, '#58a6ff');
  html += chartCard('New designs per day', series.designs, '#d29922');
  html += '</div>';

  html += '<div class="grid two">';
  html += tableCard(['Most-viewed designs','Views','Likes'], ov.topDesigns,
    [function(d){ return d.title || 'Untitled'; }, function(d){ return d.views; }, function(d){ return d.likeScore; }]);
  html += tableCard(['Stadium','Designs'], ov.topStadiums,
    [function(d){ return d.templateId; }, function(d){ return d.count; }]);
  html += '</div>';

  el('dash-body').innerHTML = html;
  el('generated').textContent = 'Snapshot generated ' + (ov.generatedAt ? new Date(ov.generatedAt).toLocaleString() : 'now') + '.';
}


el('login-form').addEventListener('submit', doLogin);
el('refresh').addEventListener('click', function(){ loadAll(); });
el('logout').addEventListener('click', function(){ doLogout(); });
el('days').addEventListener('change', function(e){ currentDays = Number(e.target.value) || 30; loadAll(); });

init();
`;
