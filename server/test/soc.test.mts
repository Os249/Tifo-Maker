/**
 * The Security tab: what it records, what it keeps, who it emails, and what it
 * never stores.
 *
 *   npm run test:soc                      (memory)
 *   DATABASE_URL=postgres://... npm run test:soc   (also the Postgres store)
 *
 * Requests go through the real app, so a route that stops reporting (a renamed
 * path, a status code changed) fails here rather than going quiet in production.
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository } from '../src/memoryRepo';
import { MemoryFeedbackRepository } from '../src/feedbackRepo';
import { MemoryAdminStatsRepository } from '../src/statsRepo';
import { buildApp, type TemplateInfo } from '../src/routes';
import { ALERT_DAILY_CAP, ALERT_RULES, SocMonitor, maskEmail, socKeyFrom } from '../src/soc';
import { MemorySocRepository, PgSocRepository, RETENTION_DAYS, type SocRepository } from '../src/socRepo';
import { securityPosture } from '../src/posture';
import { ADMIN_JS } from '../src/adminPage';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
const cellsGzB64 = gzipSync(new Uint8Array(map.count)).toString('base64');
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const MIN = 60_000;
const ADMIN_PASSWORD = 'soc test admin password, long enough';

type Mail = { to: string; subject: string; html: string; text?: string };

async function reg(app: FastifyInstance, u: string, ip = '198.51.100.1'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { username: u, password: 'password1234', email: `${u}@example.test`, acceptedVersion: 'test' } });
  return (r.json() as { token: string }).token;
}

// ---------------------------------------------------------------------------
console.log('— through the real app —');
{
  process.env.AI_ADMIN_PASSWORD = ADMIN_PASSWORD;
  let clock = Date.parse('2026-09-16T12:00:30Z');
  const mails: Mail[] = [];
  const sender = { async send(m: Mail) { mails.push(m); } };
  const repo = new MemorySocRepository();
  const soc = new SocMonitor({
    repo, sender, alertTo: 'ops@example.test', flushMs: 0, now: () => clock,
    key: socKeyFrom({ SOC_IP_KEY: 'a test key that is long enough' } as NodeJS.ProcessEnv),
  });
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const app = await buildApp(designs, auth, templates, {
    staticDir: process.cwd(),
    soc,
    emailSender: sender,
    adminUsernames: ['boss'],
    aiUsage: new MemoryAiUsageRepository(),
    stats: new MemoryAdminStatsRepository(designs),
    feedback: new MemoryFeedbackRepository(),
    verifyResendCooldownMs: 0,
  });

  // ---- attacks on sign-in ----
  await reg(app, 'victim');
  for (let i = 0; i < 6; i++) {
    await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', payload: { username: 'victim', password: `guess-${i}` } });
  }
  await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', payload: { username: 'nobody.at.all@private.example', password: 'guess' } });
  await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.1', payload: { username: 'victim', password: 'password1234' } });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'victim', password: 'password1234', email: 'other@example.test', acceptedVersion: 't' } });

  const coder = await reg(app, 'coder');
  for (let i = 0; i < 6; i++) {
    await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(coder), payload: { code: '000000' } });
  }
  const changer = await reg(app, 'changer');
  await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(changer), payload: { currentPassword: 'wrong wrong', newPassword: 'another password' } });
  for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'victim@example.test' } });
  await app.drainBackground();

  // ---- blocked and abusive traffic ----
  for (const path of ['/.env', '/wp-login.php', '/.git/config', '/phpmyadmin/index.php', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php']) {
    await app.inject({ method: 'GET', url: path, remoteAddress: '192.0.2.66' });
  }
  await app.inject({ method: 'GET', url: '/a-page-that-moved' });
  await app.inject({ method: 'GET', url: '/api/admin/soc', remoteAddress: '192.0.2.66' });
  await app.inject({ method: 'GET', url: '/admin.js', remoteAddress: '192.0.2.66' });
  await app.inject({ method: 'POST', url: '/api/feedback', payload: { kind: 'bug', message: 'buy cheap things', website: 'http://spam.example', elapsedMs: 9000 } });
  const photoOwner = await reg(app, 'photographer');
  const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(photoOwner), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
  const designId = (d.json() as { id: string }).id;
  await app.inject({ method: 'POST', url: `/api/designs/${designId}/photos`, headers: bearer(photoOwner), payload: { imageB64: Buffer.from('<svg onload=alert(1)>').toString('base64') } });
  await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ username: 'x'.repeat(1_100_000) }) });
  const leaky = designs as unknown as { popularTags: () => Promise<never> };
  const original = leaky.popularTags;
  leaky.popularTags = async () => { throw new Error('boom'); };
  await app.inject({ method: 'GET', url: '/api/tags' });
  leaky.popularTags = original;

  await soc.flush();
  const summary = await soc.summary();
  const total = (kind: string): number => summary.totals.find((t) => t.kind === kind)?.day ?? 0;
  assert.equal(total('login_failed'), 7, 'every failed sign-in is counted');
  assert.equal(total('login_ok'), 1, 'successful sign-ins are counted as context');
  assert.equal(total('register_conflict'), 1, 'a registration that hits an existing account');
  assert.equal(total('code_failed'), 4, 'wrong verification codes');
  assert.equal(total('code_exhausted'), 2, 'the fifth wrong code and the attempt after it');
  assert.equal(total('password_change_failed'), 1);
  assert.equal(total('reset_requested'), 3);
  assert.equal(total('mail_refused'), 2, 'two of three reset emails to one address refused by its limit');
  assert.equal(total('scanner_probe'), 5, 'vulnerability probes');
  assert.equal(total('admin_denied'), 2, 'the admin API and /admin.js without rights');
  assert.equal(total('bot_trap'), 1, 'the feedback honeypot');
  assert.equal(total('upload_refused'), 1, 'a photo that is not an image');
  assert.equal(total('oversized_body'), 1, 'a body past the limit');
  assert.equal(total('server_error'), 1, 'a 500');
  const kinds = summary.totals.map((t) => t.kind);
  assert.ok(!kinds.includes('rate_limited'), 'nothing was rate limited in this app');

  assert.deepEqual(summary.topSubjects.map((s) => s.subject), ['victim'], 'the targeted account is named by its public handle');
  assert.equal(summary.topSubjects[0].failures, 6);
  const attacker = soc.tag('203.0.113.7');
  assert.match(attacker, /^[0-9a-f]{12}$/);
  const fromAttacker = summary.topSources.find((x) => x.source === attacker);
  assert.equal(fromAttacker?.total, 7, 'the attacking address is listed, as a tag, with what it did');
  assert.deepEqual(fromAttacker?.kinds, ['login_failed']);
  assert.ok(summary.topRoutes.some((r) => r.kind === 'scanner_probe' && r.route === 'GET /.env'));

  const recent = soc.recent(200);
  const blob = JSON.stringify({ summary, recent });
  assert.doesNotMatch(blob, /203\.0\.113\.7|198\.51\.100\.1|192\.0\.2\.66/, 'no address is kept anywhere, only tags');
  assert.doesNotMatch(blob, /nobody\.at\.all|private\.example/, 'what was typed for an account that does not exist is not kept');
  assert.doesNotMatch(blob, /guess-|password1234/, 'no password text, ever');
  const repoRows = (repo as unknown as { events: Map<string, { source: string }> }).events;
  assert.ok([...repoRows.values()].every((r) => r.source === '' || /^[0-9a-f]{12}$/.test(r.source)), 'stored sources are tags');

  // ---- admin audit trail ----
  const unlock = await app.inject({ method: 'POST', url: '/api/ai/unlock', remoteAddress: '198.51.100.9', payload: { password: ADMIN_PASSWORD } });
  const unlockToken = (unlock.json() as { token: string }).token;
  const session = unlockToken.split('.')[2].slice(0, 6);
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/overview', remoteAddress: '198.51.100.9', headers: { 'x-ai-unlock': unlockToken } })).statusCode, 200);
  }
  const boss = await reg(app, 'boss');
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${designId}/takedown`, remoteAddress: '198.51.100.10', headers: bearer(boss) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${designId}/takedown`, headers: bearer(photoOwner) })).statusCode, 403);
  const testAlert = await app.inject({ method: 'POST', url: '/api/admin/soc/test-alert', headers: { 'x-ai-unlock': unlockToken }, payload: {} });
  assert.deepEqual(testAlert.json(), { ok: true });
  assert.equal(mails.at(-1)?.to, 'ops@example.test');
  assert.match(mails.at(-1)?.subject ?? '', /test alert/);
  await new Promise((r) => setTimeout(r, 20));
  const trail = await soc.auditTrail(20);
  const lines = trail.map((a) => `${a.actor} | ${a.action}`);
  assert.ok(lines.includes(`admin password (session ${session}) | signed in with the admin password`), lines.join('\n'));
  assert.equal(lines.filter((l) => l.endsWith('opened the dashboard')).length, 1, 'three dashboard loads are one line, not three');
  assert.ok(lines.includes('@boss | took down a design'), 'a moderator action names the account');
  assert.equal(trail.find((a) => a.action === 'took down a design')?.target, designId);
  assert.equal(lines.filter((l) => l.includes('took down')).length, 1, 'a refused takedown is not an admin action');
  assert.ok(lines.includes(`admin password (session ${session}) | sent a test security alert`));
  assert.doesNotMatch(JSON.stringify(trail), /198\.51\.100/, 'the audit trail stores tags, not addresses');

  // ---- the endpoint ----
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/soc', headers: bearer(photoOwner) })).statusCode, 403, 'only admins');
  const view = await app.inject({ method: 'GET', url: '/api/admin/soc', headers: { 'x-ai-unlock': unlockToken } });
  assert.equal(view.statusCode, 200);
  assert.equal(view.headers['cache-control'], 'no-store');
  const body = view.json() as { rules: { id: string }[]; posture: { id: string; state: string }[]; alertsTo: string; retentionDays: number; audit: unknown[]; recent: unknown[]; summary: unknown };
  assert.equal(body.rules.length, ALERT_RULES.length);
  assert.equal(body.retentionDays, RETENTION_DAYS);
  assert.equal(body.alertsTo, 'o•••@example.test', 'the alert address is masked');
  assert.ok(body.posture.some((p) => p.id === 'node'), 'the posture checklist is included');
  const alertCheck = (body.posture as { id: string; state: string; detail: string }[]).find((p) => p.id === 'alerts');
  assert.match(alertCheck?.detail ?? '', /o•••@example\.test/, 'and says where alerts go, masked');
  assert.doesNotMatch(view.body, /203\.0\.113\.7|ops@example\.test|soc test admin password/, 'no address, no alert address, no password in the response');

  // ---- alerts: guessing the admin password ----
  const before = mails.length;
  for (let i = 0; i < 3; i++) {
    await app.inject({ method: 'POST', url: '/api/ai/unlock', remoteAddress: '203.0.113.50', payload: { password: `hunter${i}` } });
  }
  await soc.flush();
  const alertMails = mails.slice(before);
  assert.equal(alertMails.length, 1, 'three wrong admin passwords in 15 minutes send one alert');
  assert.match(alertMails[0].subject, /guessing the admin password \(3 in 15 min\)/);
  assert.match(alertMails[0].text ?? '', /AI_ADMIN_PASSWORD/, 'the email says what to do');
  assert.match(alertMails[0].html, /admin#security/);
  assert.doesNotMatch(alertMails[0].text ?? '', /203\.0\.113\.50|hunter/, 'no address and no guessed password in the email');
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/ai/unlock', remoteAddress: '203.0.113.50', payload: { password: 'again' } });
  await soc.flush();
  assert.equal(mails.length, before + 1, 'still one: at most one email per alert type per hour');
  clock += 61 * MIN;
  for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/api/ai/unlock', remoteAddress: '203.0.113.50', payload: { password: 'later' } });
  await soc.flush();
  assert.equal(mails.length, before + 2, 'an hour later it can alert again');
  const stored = await soc.alerts(10);
  assert.equal(stored.filter((a) => a.rule === 'admin-password' && a.delivered).length, 2, 'each alert is recorded');

  // ---- alerts: failures, then a successful sign-in from the same address ----
  const beforeTakeover = mails.length;
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.99', payload: { username: 'victim', password: `stuffed-${i}` } });
  }
  await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.99', payload: { username: 'victim', password: 'password1234' } });
  await soc.flush();
  const takeover = mails.slice(beforeTakeover).find((m) => /account takeover/i.test(m.subject));
  assert.ok(takeover, `an address that failed ten times and then signed in raises the takeover alert (${mails.slice(beforeTakeover).map((m) => m.subject).join(' / ')})`);
  assert.match(takeover!.text ?? '', /@victim/, 'and names the account');

  const statusNow = soc.status();
  assert.ok(statusNow.find((r) => r.id === 'account-takeover')?.firing);

  await app.close();
  delete process.env.AI_ADMIN_PASSWORD;
  console.log('  app: all assertions passed (sign-in kinds, abuse kinds, no addresses or typed names stored, audit trail, endpoint gate, admin-password alert + hourly limit, takeover alert)');
}

// ---------------------------------------------------------------------------
console.log('— rate limits are seen —');
{
  const soc = new SocMonitor({ repo: new MemorySocRepository(), flushMs: 0 });
  const auth = new MemoryAuthRepository();
  const app = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, templates, { soc, rateLimit: true });
  for (let i = 0; i < 12; i++) {
    await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.200', payload: { username: 'x', password: 'y' } });
  }
  await soc.flush();
  const s = await soc.summary();
  assert.equal(s.totals.find((t) => t.kind === 'rate_limited')?.day, 2, 'the two logins past the 10-a-minute limit');
  assert.ok(s.topRoutes.some((r) => r.kind === 'rate_limited' && r.route === 'POST /api/auth/login'), 'with the route they hit');
  await app.close();
  console.log('  rate limits: passed');
}

// ---------------------------------------------------------------------------
console.log('— the monitor under pressure —');
{
  let clock = Date.parse('2026-09-16T08:00:10Z');
  const mails: Mail[] = [];
  const sender = { async send(m: Mail) { mails.push(m); } };
  const repo = new MemorySocRepository();
  const soc = new SocMonitor({ repo, sender, alertTo: 'ops@example.test', flushMs: 0, now: () => clock });

  // A flood from a hundred thousand addresses costs bounded memory and rows.
  for (let i = 0; i < 100_000; i++) soc.record('rate_limited', { ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, route: 'GET /' });
  const pending = (soc as unknown as { pending: Map<string, unknown> }).pending.size;
  assert.ok(pending <= 5_001, `distinct keys are capped (${pending})`);
  await soc.flush();
  const rows = (repo as unknown as { events: Map<string, { count: number }> }).events;
  assert.ok(rows.size <= 5_001, `rows written are capped (${rows.size})`);
  assert.equal([...rows.values()].reduce((a, r) => a + r.count, 0), 100_000, 'but every event is still counted');
  assert.equal(mails.length, 1, 'and the flood raised its alert once');
  assert.match(mails[0].subject, /Flood of blocked requests/);

  // No more than ALERT_DAILY_CAP emails a day, whatever fires.
  for (let hour = 1; hour <= 20; hour++) {
    clock += 61 * MIN;
    for (let i = 0; i < 25; i++) soc.record('server_error', { ip: '10.9.9.9', route: 'GET /api/tags' });
    await soc.flush();
  }
  assert.equal(mails.length, ALERT_DAILY_CAP, `the daily cap holds (${mails.length})`);
  const capped = (await repo.listAlerts(50)).filter((a) => !a.delivered);
  assert.ok(capped.length > 0 && capped.every((a) => /daily cap/.test(a.error ?? '')), 'alerts past the cap are recorded as not sent, with the reason');

  // A restart does not forget: a new monitor on the same store stays quiet within the hour.
  const again = new SocMonitor({ repo, sender, alertTo: 'ops@example.test', flushMs: 0, now: () => clock });
  const before = mails.length;
  for (let i = 0; i < 25; i++) again.record('server_error', { ip: '10.9.9.9' });
  await again.flush();
  assert.equal(mails.length, before, 'a restarted monitor remembers the last alert and the daily count');

  // No alert address: recorded, never sent.
  const quiet = new SocMonitor({ repo: new MemorySocRepository(), sender, flushMs: 0, now: () => clock });
  for (let i = 0; i < 3; i++) quiet.record('admin_unlock_failed', { ip: '10.1.1.1' });
  await quiet.flush();
  assert.equal(mails.length, before, 'nothing is emailed without SECURITY_ALERT_TO');
  const unsent = await quiet.alerts(5);
  assert.equal(unsent[0]?.error, 'SECURITY_ALERT_TO is not set');
  assert.equal(new SocMonitor({ repo, alertTo: 'x@y.z?bcc=evil@example.test', flushMs: 0 }).alertTo, null, 'a malformed alert address is not used');

  // Keys: a configured key gives the same tag after a restart; the fallback does not.
  const env = { SOC_IP_KEY: 'x'.repeat(40) } as NodeJS.ProcessEnv;
  const a = new SocMonitor({ repo, key: socKeyFrom(env), flushMs: 0 });
  const b = new SocMonitor({ repo, key: socKeyFrom(env), flushMs: 0 });
  assert.equal(a.tag('203.0.113.1'), b.tag('203.0.113.1'));
  assert.notEqual(a.tag('203.0.113.1'), a.tag('203.0.113.2'));
  const r1 = new SocMonitor({ repo, flushMs: 0 });
  const r2 = new SocMonitor({ repo, flushMs: 0 });
  assert.notEqual(r1.tag('203.0.113.1'), r2.tag('203.0.113.1'), 'without SOC_IP_KEY each boot has its own key');
  assert.equal(socKeyFrom({ SOC_IP_KEY: 'short' } as NodeJS.ProcessEnv).stable, false, 'a short key is not trusted');
  assert.equal(maskEmail('someone@example.com'), 's•••@example.com');

  console.log('  pressure: passed (bounded keys and rows under a 100k-address flood, daily cap, restart memory, no address no email, key stability)');
}

// ---------------------------------------------------------------------------
console.log('— posture —');
{
  const base = { nodeVersion: 'v24.21.0', uid: 1000, rateLimit: true, database: 'postgres' as const, email: null, soc: null, now: new Date('2026-09-16T00:00:00Z') };
  const byId = (checks: { id: string; state: string }[], id: string) => checks.find((c) => c.id === id)?.state;
  const env = (e: Record<string, string>) => ({ NODE_ENV: 'production', ...e }) as NodeJS.ProcessEnv;
  const noSnapshot = '/nonexistent/audit-snapshot.json';

  let p = securityPosture({ ...base, env: env({ AI_ADMIN_PASSWORD: 'x'.repeat(24), TRUST_PROXY: '1', PUBLIC_URL: 'https://tifomaker.org' }), auditSnapshotPath: noSnapshot });
  assert.equal(byId(p, 'node'), 'good');
  assert.equal(byId(p, 'user'), 'good');
  assert.equal(byId(p, 'proxy'), 'good');
  assert.equal(byId(p, 'admin-password'), 'good');
  assert.equal(byId(p, 'dependencies'), 'info');
  p = securityPosture({ ...base, nodeVersion: 'v20.19.0', uid: 0, rateLimit: false, env: env({ AI_ADMIN_PASSWORD: 'short', TRUST_PROXY: '2' }), auditSnapshotPath: noSnapshot });
  assert.equal(byId(p, 'node'), 'bad', 'Node 20 is past end of life');
  assert.equal(byId(p, 'user'), 'bad', 'root in production');
  assert.equal(byId(p, 'ratelimit'), 'bad');
  assert.equal(byId(p, 'proxy'), 'bad', 'TRUST_PROXY=2');
  assert.equal(byId(p, 'admin-password'), 'bad', 'a short admin password');
  assert.doesNotMatch(JSON.stringify(p), /short/, 'the password itself never appears');

  const dir = mkdtempSync(`${tmpdir()}/tifo-audit-`);
  writeFileSync(`${dir}/bad.json`, JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 2, critical: 0, total: 3 } } }));
  writeFileSync(`${dir}/clean.json`, JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }));
  writeFileSync(`${dir}/offline.json`, 'npm error code ENOTFOUND');
  assert.equal(byId(securityPosture({ ...base, env: env({}), auditSnapshotPath: `${dir}/bad.json` }), 'dependencies'), 'bad');
  assert.equal(byId(securityPosture({ ...base, env: env({}), auditSnapshotPath: `${dir}/clean.json` }), 'dependencies'), 'good');
  assert.equal(byId(securityPosture({ ...base, env: env({}), auditSnapshotPath: `${dir}/offline.json` }), 'dependencies'), 'info');
  const alerting = securityPosture({ ...base, env: env({}), soc: { alertTo: null, keyStable: false, lastWriteError: null }, auditSnapshotPath: noSnapshot });
  assert.equal(byId(alerting, 'alerts'), 'warn', 'no alert address is a warning');
  console.log('  posture: passed');
}

// ---------------------------------------------------------------------------
console.log('— the dashboard script —');
{
  new Script(ADMIN_JS); // throws on a syntax error, which blanks the whole dashboard
  assert.match(ADMIN_JS, /id:'security'/, 'the Security tab exists');
  assert.match(ADMIN_JS, /\/api\/admin\/soc/, 'and reads the SOC endpoint');
  assert.match(ADMIN_JS, /\/api\/admin\/soc\/test-alert/);
  console.log('  dashboard script: parses, Security tab present');
}

// ---------------------------------------------------------------------------
async function storeContract(name: string, repo: SocRepository, reset?: () => Promise<void>): Promise<void> {
  await reset?.();
  const now = new Date('2026-09-16T12:00:00Z');
  const t = now.getTime();
  const minute = (msAgo: number): number => Math.floor((t - msAgo) / MIN) * MIN;
  await repo.addEvents([
    { minute: minute(5 * MIN), kind: 'login_failed', source: 'aaaaaaaaaaaa', route: 'POST /api/auth/login', subject: 'victim', count: 30 },
    { minute: minute(5 * MIN), kind: 'login_failed', source: 'bbbbbbbbbbbb', route: 'POST /api/auth/login', subject: 'victim', count: 5 },
    { minute: minute(3 * 24 * 60 * MIN), kind: 'login_failed', source: 'aaaaaaaaaaaa', route: 'POST /api/auth/login', subject: 'other', count: 7 },
    { minute: minute(10 * MIN), kind: 'scanner_probe', source: 'cccccccccccc', route: 'GET /.env', subject: '', count: 4 },
    { minute: minute(10 * MIN), kind: 'login_ok', source: 'dddddddddddd', route: 'POST /api/auth/login', subject: 'victim', count: 50 },
    { minute: minute(40 * 24 * 60 * MIN), kind: 'server_error', source: '', route: 'GET /api/tags', subject: '', count: 9 },
  ]);
  // The same key again adds to the count instead of failing.
  await repo.addEvents([{ minute: minute(5 * MIN), kind: 'login_failed', source: 'aaaaaaaaaaaa', route: 'POST /api/auth/login', subject: 'victim', count: 10 }]);
  const s = await repo.summary(now);
  const lf = s.totals.find((x) => x.kind === 'login_failed')!;
  assert.deepEqual([lf.day, lf.week, lf.month], [45, 52, 52], `${name}: day / week / month windows`);
  assert.equal(s.totals.find((x) => x.kind === 'server_error'), undefined, `${name}: older than retention is not counted`);
  assert.equal(s.topSources[0].source, 'aaaaaaaaaaaa', `${name}: busiest source first`);
  assert.ok(!s.topSources.some((x) => x.source === 'dddddddddddd'), `${name}: successful sign-ins are not "attack sources"`);
  assert.deepEqual(s.topSubjects.map((x) => [x.subject, x.failures, x.sources]), [['victim', 45, 2], ['other', 7, 1]], `${name}: targeted accounts`);
  assert.ok(s.topRoutes.some((r) => r.kind === 'scanner_probe' && r.route === 'GET /.env' && r.total === 4), `${name}: refused routes`);
  const hourSum = s.hourly.reduce((a, h) => a + h.signin, 0);
  assert.equal(hourSum, 45, `${name}: hourly series has the last 48 hours of sign-in attacks`);
  assert.ok(s.daily.length >= 2, `${name}: daily series`);

  await repo.addAudit({ at: new Date(t - 2 * MIN), actor: '@boss', action: 'took down a design', target: 'd1', outcome: 'ok', source: 'aaaaaaaaaaaa', detail: { reason: 'spam' } });
  await repo.addAudit({ at: new Date(t - MIN), actor: 'admin password (session abc123)', action: 'opened the dashboard', target: null, outcome: 'ok', source: 'bbbbbbbbbbbb', detail: null });
  const trail = await repo.listAudit(10);
  assert.deepEqual(trail.map((a) => a.action), ['opened the dashboard', 'took down a design'], `${name}: audit newest first`);
  assert.deepEqual(trail[1].detail, { reason: 'spam' }, `${name}: audit detail round-trips`);

  await repo.addAlert({ at: new Date(t - 30 * MIN), rule: 'signin-attack', count: 45, windowMin: 10, delivered: true, error: null, summary: 's' });
  await repo.addAlert({ at: new Date(t - 26 * 60 * MIN), rule: 'signin-attack', count: 41, windowMin: 10, delivered: true, error: null, summary: 'old' });
  assert.equal((await repo.alertsSince(new Date(t - 24 * 60 * MIN))).length, 1, `${name}: alerts since`);
  assert.equal((await repo.listAlerts(10)).length, 2);

  const removed = await repo.purge(now);
  assert.ok(removed >= 1, `${name}: purge removes what is past retention`);
  const after = await repo.summary(now);
  assert.equal(after.totals.find((x) => x.kind === 'login_failed')?.month, 52, `${name}: and keeps the rest`);
  console.log(`  ${name} store: passed`);
}

console.log('— stores —');
await storeContract('memory', new MemorySocRepository());
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const repo = new PgSocRepository(pool);
  await repo.init();
  await repo.init(); // idempotent
  await storeContract('postgres', repo, async () => {
    await pool.query('TRUNCATE soc_events, soc_audit, soc_alerts');
  });
  await pool.query('TRUNCATE soc_events, soc_audit, soc_alerts');
  await pool.end();
} else {
  console.log('  postgres store: skipped (set DATABASE_URL to run)');
}

console.log('soc: all assertions passed');
