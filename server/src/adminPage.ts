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
 * /api/admin/overview requires an admin login token (username in ADMIN_USERNAMES).
 * A non-admin who opens /admin just sees a login form and can fetch nothing.
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
  :root{ --bg:#0f1216; --bg2:#161b22; --bg3:#1c232c; --line:#283039; --tx:#e6e9ee; --mut:#8a93a0; --accent:#3fb950; --blue:#58a6ff; --gold:#d29922; --red:#f85149; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--tx); font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header{ position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:12px 18px; background:rgba(15,18,22,.92); backdrop-filter:blur(6px); border-bottom:1px solid var(--line); }
  .brand{ font-weight:700; font-size:16px; letter-spacing:.2px; }
  .brand span{ font-weight:500; }
  .ctrls{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .muted{ color:var(--mut); }
  select,button{ font:inherit; color:var(--tx); background:var(--bg3); border:1px solid var(--line); border-radius:8px; padding:6px 10px; cursor:pointer; }
  button:hover,select:hover{ border-color:#3a4552; }
  button.primary{ background:var(--accent); color:#06210f; border-color:var(--accent); font-weight:600; }
  main{ max-width:1100px; margin:0 auto; padding:18px; }
  h2.sec{ font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); margin:26px 0 10px; font-weight:600; }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .grid.two{ grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
  .card{ background:var(--bg2); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .k-val{ font-size:26px; font-weight:700; line-height:1.1; }
  .k-lab{ color:var(--mut); font-size:12px; margin-top:4px; }
  .k-sub{ color:var(--accent); font-size:11px; margin-top:6px; }
  .frow{ display:grid; grid-template-columns:130px 1fr 110px; align-items:center; gap:10px; padding:5px 0; }
  .flab{ font-size:13px; text-transform:capitalize; }
  .fbar{ background:var(--bg3); border-radius:6px; height:14px; overflow:hidden; }
  .ffill{ background:var(--accent); height:100%; border-radius:6px; }
  .fnum{ text-align:right; font-variant-numeric:tabular-nums; }
  table{ width:100%; border-collapse:collapse; }
  th{ text-align:left; color:var(--mut); font-weight:600; font-size:12px; padding:6px 8px; border-bottom:1px solid var(--line); }
  td{ padding:7px 8px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  td:first-child,th:first-child{ max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chart h3{ margin:0 0 2px; font-size:13px; font-weight:600; }
  .chart .cap{ color:var(--mut); font-size:11px; margin-bottom:6px; }
  .note{ color:var(--mut); font-size:12px; margin-top:8px; }
  .badge{ font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--mut); }
  .badge.warn{ color:var(--gold); border-color:#46391c; }
  .login-wrap{ min-height:70vh; display:flex; align-items:center; justify-content:center; padding:18px; }
  .login{ width:100%; max-width:360px; background:var(--bg2); border:1px solid var(--line); border-radius:14px; padding:22px; }
  .login h1{ font-size:18px; margin:0 0 4px; }
  .login p{ margin:0 0 16px; color:var(--mut); font-size:13px; }
  .login label{ display:block; font-size:12px; color:var(--mut); margin:10px 0 4px; }
  .login input{ width:100%; padding:10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--tx); font:inherit; }
  .login button{ width:100%; margin-top:16px; padding:11px; }
  .msg{ min-height:18px; font-size:12px; color:var(--red); margin-top:10px; }
  a{ color:var(--blue); }
</style>
</head>
<body>
<header>
  <div class="brand">TifoMaker <span class="muted">· Admin analytics</span></div>
  <div class="ctrls" id="ctrls" style="display:none">
    <span id="status" class="muted"></span>
    <span id="mode" class="badge"></span>
    <select id="days" title="Funnel window">
      <option value="7">7 days</option>
      <option value="30" selected>30 days</option>
      <option value="90">90 days</option>
    </select>
    <button id="refresh">Refresh</button>
    <button id="logout">Logout</button>
  </div>
</header>

<div id="login" class="login-wrap">
  <form class="login" id="login-form">
    <h1>Admin sign in</h1>
    <p>Enter the admin password (the AI_ADMIN_PASSWORD set on the server).</p>
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
function labelize(s){ return String(s==null?'':s).replace(/_/g,' '); }
function esc(s){ s = String(s==null?'':s); return s.replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
function sum(arr){ var t=0; for (var i=0;i<arr.length;i++){ t += Number(arr[i].count)||0; } return t; }

async function api(path, opts){
  opts = opts || {};
  var headers = {};
  var t = getUnlock();
  if (t) headers['x-ai-unlock'] = t;
  var body;
  if (opts.body){ headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  var res;
  try { res = await fetch(path, { method: opts.method || 'GET', headers: headers, body: body }); }
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
  var r = await api('/api/ai/unlock', { method:'POST', body:{ password:p } });
  if (!r.ok || !r.data || !r.data.token){ el('msg').textContent = 'Wrong password, or no admin password is configured on the server.'; return; }
  setUnlock(r.data.token);
  el('msg').textContent=''; el('p').value='';
  showDash();
  await loadAll();
}

async function doLogout(){
  clearUnlock();
  showLogin('Signed out.');
}

async function loadAll(){
  setStatus('Loading...');
  var ovP = api('/api/admin/overview');
  var fnP = api('/api/funnel?days=' + currentDays);
  var ov = await ovP;
  var fn = await fnP;
  if (!ov.ok){
    if (ov.status === 403){ clearUnlock(); showLogin('Wrong or expired password. Sign in again.'); return; }
    setStatus('Failed to load (' + ov.status + ').');
    return;
  }
  render(ov.data, (fn.ok && fn.data) ? fn.data : { steps:[], days: currentDays });
  setStatus('Updated ' + new Date().toLocaleTimeString());
}

function kpi(label, value, sub){
  return '<div class="card"><div class="k-val">' + fmt(value) + '</div><div class="k-lab">' + esc(label) + '</div>'
    + (sub ? '<div class="k-sub">' + esc(sub) + '</div>' : '') + '</div>';
}

function funnelHtml(funnel){
  var steps = (funnel && funnel.steps) || [];
  if (!steps.length) return '<div class="card"><p class="muted" style="margin:0">No funnel data captured yet.</p></div>';
  var html = '<div class="card">';
  for (var i=0;i<steps.length;i++){
    var s = steps[i];
    var pct = Number(s.pctOfTop)||0;
    var w = Math.max(2, pct);
    html += '<div class="frow"><div class="flab">' + esc(labelize(s.name)) + '</div>'
      + '<div class="fbar"><div class="ffill" style="width:' + w + '%"></div></div>'
      + '<div class="fnum">' + fmt(s.sessions) + ' <span class="muted">' + pct + '%</span></div></div>';
  }
  html += '</div>';
  return html;
}

function lineChart(points, color){
  var W=300, H=72, pad=5;
  if (!points || !points.length){
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="72" preserveAspectRatio="none"></svg>';
  }
  var max=1, i;
  for (i=0;i<points.length;i++){ if ((Number(points[i].count)||0) > max) max = Number(points[i].count)||0; }
  var n=points.length, pts='', areaPts='';
  for (i=0;i<n;i++){
    var x = (n===1) ? (W/2) : (pad + (i/(n-1))*(W-2*pad));
    var y = (H-pad) - ((Number(points[i].count)||0)/max)*(H-2*pad);
    pts += (i? ' ':'') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  areaPts = pad + ',' + (H-pad) + ' ' + pts + ' ' + (n===1? (W/2):(W-pad)) + ',' + (H-pad);
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="72" preserveAspectRatio="none">'
    + '<polygon fill="' + color + '" opacity="0.12" points="' + areaPts + '"></polygon>'
    + '<polyline fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' + pts + '"></polyline>'
    + '</svg>';
}

function chartCard(title, points, color){
  var total = sum(points||[]);
  var last = (points && points.length) ? (Number(points[points.length-1].count)||0) : 0;
  return '<div class="card chart"><h3>' + esc(title) + '</h3>'
    + '<div class="cap">' + fmt(total) + ' total · ' + fmt(last) + ' latest day</div>'
    + lineChart(points, color) + '</div>';
}

function topDesignsHtml(list){
  if (!list || !list.length) return '<div class="card"><p class="muted" style="margin:0">No public designs yet.</p></div>';
  var rows='';
  for (var i=0;i<list.length;i++){
    var d=list[i];
    rows += '<tr><td title="' + esc(d.title) + '">' + esc(d.title) + '</td><td>' + fmt(d.views) + '</td><td>' + fmt(d.likeScore) + '</td></tr>';
  }
  return '<div class="card"><table><thead><tr><th>Top public designs</th><th>Views</th><th>Likes</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function topStadiumsHtml(list){
  if (!list || !list.length) return '<div class="card"><p class="muted" style="margin:0">No designs yet.</p></div>';
  var rows='';
  for (var i=0;i<list.length;i++){
    var d=list[i];
    rows += '<tr><td title="' + esc(d.templateId) + '">' + esc(d.templateId) + '</td><td>' + fmt(d.count) + '</td></tr>';
  }
  return '<div class="card"><table><thead><tr><th>Stadium</th><th>Designs</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function render(ov, funnel){
  ov = ov || {};
  var t = ov.totals || {};
  var r7 = ov.recent7d || {};
  var mod = ov.moderation || {};
  var series = ov.series || {};

  el('mode').textContent = (ov.mode === 'memory') ? 'in-memory (dev)' : 'postgres';
  el('mode').className = (ov.mode === 'memory') ? 'badge warn' : 'badge';

  var html = '';

  html += '<h2 class="sec">Overview</h2><div class="grid">';
  html += kpi('Accounts', t.users);
  html += kpi('Designs', t.designs);
  html += kpi('Public designs', t.publicDesigns);
  html += kpi('Templates', t.templates);
  html += kpi('AI generations', t.aiGenerations);
  html += kpi('Total views', t.totalViews);
  html += kpi('B2B leads', t.leads);
  html += kpi('Open reports', mod.openReports);
  html += '</div>';

  html += '<h2 class="sec">Last 7 days</h2><div class="grid">';
  html += kpi('New accounts', r7.signups);
  html += kpi('New designs', r7.designs);
  html += kpi('New leads', r7.leads);
  html += kpi('Active AI users', r7.aiActiveUsers);
  html += '</div>';

  html += '<h2 class="sec">Conversion funnel (' + (Number(funnel && funnel.days) || currentDays) + ' days)</h2>';
  html += funnelHtml(funnel);

  html += '<h2 class="sec">Trends (last 30 days)</h2><div class="grid two">';
  html += chartCard('Visitors per day', series.sessions, '#3fb950');
  html += chartCard('New accounts per day', series.signups, '#58a6ff');
  html += chartCard('New designs per day', series.designs, '#d29922');
  html += '</div>';

  html += '<h2 class="sec">Engagement</h2><div class="grid">';
  html += kpi('Likes / votes', t.votes);
  html += kpi('Comments', t.comments);
  html += kpi('Follows', t.follows);
  html += kpi('Match photos', t.photos, fmt(t.verifiedPhotos) + ' verified');
  html += kpi('Shares', t.shares);
  html += kpi('AI users (lifetime)', t.aiUsers);
  html += '</div>';

  html += '<h2 class="sec">Moderation queues</h2><div class="grid">';
  html += kpi('Open reports', mod.openReports);
  html += kpi('Unverified photos', mod.unverifiedPhotos);
  html += kpi('Pending stadiums', mod.pendingStadiums);
  html += kpi('Approved stadiums', mod.approvedStadiums);
  html += '</div>';
  html += '<p class="note">Act on the queues inside the app: open the editor, then the <strong>Stadium</strong> panel shows the community review queue. <a href="/app">Open the app &rarr;</a></p>';

  html += '<h2 class="sec">Leaderboards</h2><div class="grid two">';
  html += topDesignsHtml(ov.topDesigns);
  html += topStadiumsHtml(ov.topStadiums);
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
