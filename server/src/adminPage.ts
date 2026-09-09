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
<title>TifoMaker — Admin</title>
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

  .frow{ display:grid; grid-template-columns:minmax(90px,132px) 1fr minmax(88px,110px); align-items:center; gap:10px; padding:5px 0; }
  .flab{ font-size:13px; text-transform:capitalize; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
    <p>Enter the admin password — the <code>AI_ADMIN_PASSWORD</code> set on the server.</p>
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
    api('/api/funnel?days=' + currentDays)
  ]);
  var ov = results[0], tr = results[1], fn = results[2];
  if (!ov.ok){
    if (ov.status === 403){ clearUnlock(); showLogin('Wrong or expired password. Sign in again.'); return; }
    setStatus('Failed to load (' + ov.status + ').');
    return;
  }
  render(ov.data || {}, (tr.ok && tr.data) ? tr.data : null, (fn.ok && fn.data) ? fn.data : { steps:[], days: currentDays });
  setStatus('Updated ' + new Date().toLocaleTimeString());
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
  return '<div class="card"><p class="lt">Visits per day <span class="dim" style="font-weight:400">— ' + fmt(totalV) + ' total, peak ' + fmt(max) + '</span></p>'
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

function funnelHtml(funnel){
  var steps = (funnel && funnel.steps) || [];
  if (!steps.length) return '<div class="card"><p class="empty">No funnel data captured yet.</p></div>';
  var html = '<div class="card">';
  for (var i=0;i<steps.length;i++){
    var s = steps[i];
    var p = Number(s.pctOfTop)||0;
    html += '<div class="frow"><div class="flab">' + esc(labelize(s.name)) + '</div>'
      + '<div class="fbar"><div class="ffill" style="width:' + Math.max(1.5, p) + '%"></div></div>'
      + '<div class="fnum">' + fmt(s.sessions) + ' <span class="dim">' + p + '%</span></div></div>';
  }
  return html + '</div>';
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

/* ---------- render ---------- */

function trafficSection(tr, days){
  var html = '<h2 class="sec">Where visitors come from <span class="hint">last ' + days + ' days · measured server-side, counts everyone</span></h2>';

  if (!tr || !tr.enabled){
    return html + '<div class="callout"><b>Traffic sources are not enabled yet.</b> Deploy this build with a DATABASE_URL set and the <code>visits</code> table is created automatically on boot. Data starts appearing within minutes of the first page view.</div>';
  }
  var t = tr.totals || { visits:0, visitors:0, botVisits:0 };
  if (!t.visits){
    html += '<div class="callout"><b>No page views recorded yet.</b> This starts collecting the moment the new build is live. If the site has been up for a while and this stays empty, check that the server booted without a <code>visits init failed</code> error in the logs.</div>';
    return html;
  }

  var topSource = (tr.sources && tr.sources.length) ? (SOURCE_LABEL[tr.sources[0].key] || tr.sources[0].key) : '—';
  var topRef = (tr.referrers && tr.referrers.length) ? tr.referrers[0].key : '—';

  html += '<div class="grid">';
  html += kpi('Page views', t.visits);
  html += kpi('Unique visitors', t.visitors, 'approx., resets daily', true);
  html += kpi('Biggest source', topSource);
  html += kpi('Top referrer', topRef);
  html += kpi('Bot requests filtered', t.botVisits, 'excluded from every number above', true);
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += trafficChart(tr.daily);
  html += barList('Traffic sources', 'visits / unique visitors', tr.sources, 'source', SOURCE_LABEL);
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += barList('Referrers', 'which site or search engine sent them', tr.referrers, '#58a6ff');
  html += barList('Landing pages', 'the first page they opened', tr.pages, '#3fb950');
  html += '</div>';

  html += '<div class="grid three" style="margin-top:10px">';
  html += barList('Countries', tr.countries && tr.countries.length ? 'from the edge network' : 'needs Cloudflare in front — see CLOUDFLARE.md', tr.countries, '#d29922');
  html += barList('Languages', 'browser language, aggregated', tr.languages, '#a371f7');
  html += barList('Devices', 'desktop vs phone vs tablet', tr.devices, '#39c5cf');
  html += '</div>';

  html += '<div class="grid two" style="margin-top:10px">';
  html += barList('Browsers & in-app webviews', 'a TikTok or Instagram webview here means the link was opened inside that app', tr.browsers, '#58a6ff');
  html += barList('Tagged campaigns', 'links you tagged with ?utm_source=... — nothing here means no tagged link was used', tr.campaigns, '#d29922');
  html += '</div>';

  html += '<div class="callout ok"><b>How this is measured.</b> Recorded on the server, after each page is sent, so it counts every visitor rather than only those who accept analytics. No cookie is set. Your IP address is never stored — it is hashed once in memory with a secret that is regenerated every day and never written to disk, so visitors cannot be identified or followed from one day to the next. Referring URLs are reduced to a hostname before storage.</div>';
  return html;
}

function render(ov, tr, funnel){
  var t = ov.totals || {};
  var r7 = ov.recent7d || {};
  var mod = ov.moderation || {};
  var series = ov.series || {};
  var days = Number(funnel && funnel.days) || currentDays;

  el('mode').textContent = (ov.mode === 'memory') ? 'in-memory (dev)' : 'postgres';
  el('mode').className = (ov.mode === 'memory') ? 'badge warn' : 'badge good';

  var html = '';

  /* 1. The question this dashboard exists to answer. */
  html += trafficSection(tr, days);

  /* 2. The business. */
  html += '<h2 class="sec">Totals</h2><div class="grid">';
  html += kpi('Accounts', t.users);
  html += kpi('Designs', t.designs);
  html += kpi('Public designs', t.publicDesigns);
  html += kpi('Templates', t.templates);
  html += kpi('AI generations', t.aiGenerations, fmt(t.aiUsers) + ' accounts used AI', true);
  html += kpi('Design views', t.totalViews);
  html += kpi('B2B leads', t.leads);
  html += '</div>';

  html += '<h2 class="sec">Last 7 days</h2><div class="grid">';
  html += kpi('New accounts', r7.signups);
  html += kpi('New designs', r7.designs);
  html += kpi('New leads', r7.leads);
  html += kpi('Active AI users', r7.aiActiveUsers);
  html += '</div>';

  html += '<h2 class="sec">Growth <span class="hint">last 30 days</span></h2><div class="grid two">';
  html += chartCard('New accounts per day', series.signups, '#58a6ff');
  html += chartCard('New designs per day', series.designs, '#d29922');
  html += '</div>';

  /* 3. The funnel, with the caveat that makes its numbers readable. */
  html += '<h2 class="sec">Editor funnel <span class="hint">last ' + days + ' days · consent-gated</span></h2>';
  html += funnelHtml(funnel);
  html += '<div class="callout"><b>Read these as a shape, not a headcount.</b> These steps come from in-browser tracking that only runs after a visitor picks &ldquo;Accept all&rdquo; in the cookie banner, so the totals are far lower than the page views above and the two sections will never reconcile. The drop-off <em>between</em> steps is still meaningful — that is what to watch.</div>';

  html += '<h2 class="sec">Engagement</h2><div class="grid">';
  html += kpi('Likes / votes', t.votes);
  html += kpi('Comments', t.comments);
  html += kpi('Follows', t.follows);
  html += kpi('Match photos', t.photos, fmt(t.verifiedPhotos) + ' verified', true);
  html += kpi('Shares', t.shares);
  html += '</div>';

  /* 4. Things needing action. */
  var queue = (Number(mod.openReports)||0) + (Number(mod.unverifiedPhotos)||0) + (Number(mod.pendingStadiums)||0);
  html += '<h2 class="sec">Moderation ' + (queue ? '<span class="badge warn">' + fmt(queue) + ' waiting</span>' : '<span class="badge good">all clear</span>') + '</h2><div class="grid">';
  html += kpi('Open reports', mod.openReports);
  html += kpi('Unverified photos', mod.unverifiedPhotos);
  html += kpi('Pending stadiums', mod.pendingStadiums);
  html += kpi('Approved stadiums', mod.approvedStadiums);
  html += '</div>';
  html += '<p class="note">Act on the queues inside the app: open the editor, then the <strong>Stadium</strong> panel shows the community review queue. <a href="/app">Open the app &rarr;</a></p>';

  html += '<h2 class="sec">Leaderboards</h2><div class="grid two">';
  html += tableCard(['Top public designs','Views','Likes'], ov.topDesigns,
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
