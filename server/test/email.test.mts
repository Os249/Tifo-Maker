/**
 * Email verification, exercised the way the site actually calls it.
 *
 * The first version of this suite proved the server could report a refused
 * send, and every assertion passed while the Resend button was broken in
 * production. It injected `POST /api/auth/verify/resend` with nothing but an
 * Authorization header. The browser sends `content-type: application/json`
 * with no body, and Fastify refused that pairing with a 400
 * (FST_ERR_CTP_EMPTY_JSON_BODY) before the route ever ran. So every resend
 * request here now carries the browser's exact headers, and the last section
 * reads the client source to make sure nothing starts sending that pairing again.
 *
 * The provider is stubbed, because the point is what the SERVER does, not
 * whether Resend is up.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAuthRepository, MemoryDesignRepository } from '../src/memoryRepo';
import { buildApp, type AppOptions, type TemplateInfo } from '../src/routes';
import { configWarnings, logConfigWarnings } from '../src/preflight';
import { ADMIN_JS, ADMIN_UNLOCK_JS } from '../src/adminPage';
import { createEmailSender, DEFAULT_FROM, emailHealth, isNoReplyAddress, ResendEmailSender, type EmailSender, type EmailMessage } from '../src/email';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x: unknown = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

class Stub implements EmailSender {
  sent: EmailMessage[] = [];
  refuse: string | null = null;
  async send(msg: EmailMessage): Promise<void> {
    if (this.refuse) throw new Error(this.refuse);
    this.sent.push(msg);
  }
}

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [
  { id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeApp(opts: AppOptions = {}) {
  const mail = new Stub();
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const app = await buildApp(designs, auth, templates, { emailSender: mail, ...opts });
  return { app, mail };
}

const reg = async (app: FastifyInstance, n: string) => app.inject({
  method: 'POST', url: '/api/auth/register',
  payload: { username: n, password: 'correct-horse-battery-9', email: `${n}@example.com`, acceptedVersion: '1' },
});

/** Exactly what src/net/api.ts used to send: a JSON content-type and no body. */
const JSON_NO_BODY = { 'content-type': 'application/json' } as const;
const resend = (app: FastifyInstance, token: string) => app.inject({
  method: 'POST', url: '/api/auth/verify/resend',
  headers: { authorization: `Bearer ${token}`, ...JSON_NO_BODY },
});
const codeIn = (m: EmailMessage | undefined): string => /code: (\d{6})/.exec(m?.text ?? '')?.[1] ?? '';

// ---------------------------------------------------------------------------
{
  const { app, mail } = await makeApp();

  console.log('\n— registration says whether the email went out —');
  let r = await reg(app, 'alpha1');
  check('a sent one reports emailSent: true', r.json().emailSent === true, JSON.stringify(r.json()).slice(0, 90));

  mail.refuse = 'The tifomaker.org domain is not verified';
  r = await reg(app, 'bravo1');
  check('registration still succeeds when mail is refused', r.statusCode === 201, String(r.statusCode));
  check('...and says emailSent: false', r.json().emailSent === false, JSON.stringify(r.json()).slice(0, 110));
  const tokenB = r.json().token;

  console.log('\n— resend, called the way the browser calls it —');
  let rs = await resend(app, tokenB);
  check('a JSON content-type with no body reaches the route instead of a 400', rs.statusCode !== 400 && !/FST_ERR_CTP_EMPTY_JSON_BODY/.test(rs.body), `${rs.statusCode} ${rs.body.slice(0, 90)}`);
  check('a refused resend is a 502, not a 202', rs.statusCode === 502, `${rs.statusCode} ${rs.body.slice(0, 80)}`);
  check('...and does not leak the provider text to the caller', !/tifomaker\.org domain/.test(rs.body), rs.body.slice(0, 80));

  mail.refuse = null;
  const before = mail.sent.length;
  rs = await resend(app, tokenB);
  check('a successful resend is a 202', rs.statusCode === 202 && rs.json().emailSent === true, `${rs.statusCode} ${rs.body.slice(0, 60)}`);
  check('...and a message really went to the provider', mail.sent.length === before + 1 && mail.sent.at(-1)?.to === 'bravo1@example.com', `${mail.sent.length - before} sent`);
  const plain = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: { authorization: `Bearer ${tokenB}` } });
  check('a resend with no content-type at all still reaches the route', plain.statusCode === 429, `${plain.statusCode} ${plain.body.slice(0, 60)}`);

  console.log('\n— the cooldown —');
  rs = await resend(app, tokenB);
  check('a second resend inside a minute is refused', rs.statusCode === 429, `${rs.statusCode} ${rs.body.slice(0, 80)}`);
  check('...and says how long to wait', typeof rs.json().retryInSeconds === 'number' && rs.json().retryInSeconds <= 60, rs.body.slice(0, 80));

  // The AI panel resends on its own the moment it meets an unverified account,
  // which for a new signup is about two seconds after registering. That must
  // not replace the code in the email that is arriving at that moment.
  const sentBefore = mail.sent.length;
  r = await reg(app, 'charlie1');
  const tokenC = r.json().token;
  const code = codeIn(mail.sent.at(-1));
  rs = await resend(app, tokenC);
  check('the registration email starts the clock: an immediate resend is a 429', rs.statusCode === 429, `${rs.statusCode} ${rs.body.slice(0, 80)}`);
  check('...which sends nothing', mail.sent.length === sentBefore + 1, `${mail.sent.length - sentBefore} sent`);
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify/code',
    headers: { authorization: `Bearer ${tokenC}` }, payload: { code },
  });
  check('...and the code in the registration email still verifies', code.length === 6 && v.statusCode === 200, `${code} → ${v.statusCode} ${v.body.slice(0, 60)}`);

  console.log('\n— the admin can ask what the mail is doing —');
  const open = await app.inject({ method: 'GET', url: '/api/admin/email' });
  check('it is admin-gated', open.statusCode === 403, String(open.statusCode));
  // The dashboard is one script inside a TypeScript template literal, where \'
  // is just '. The Email tab's note wrote provider\'s, so the served /admin.js
  // had a bare quote inside a quoted string and the whole dashboard failed to
  // parse. Every route test still passed.
  for (const [name, src] of [['/admin.js', ADMIN_JS], ['/admin-unlock.js', ADMIN_UNLOCK_JS]] as const) {
    let err = '';
    try { new Script(src, { filename: name }); } catch (e) { err = (e as Error).message; }
    check(`${name} is valid JavaScript`, err === '', err);
  }
  await app.close();
}

// ---------------------------------------------------------------------------
{
  // A short window so the clock can be watched run out.
  const { app, mail } = await makeApp({ verifyResendCooldownMs: 40 });
  console.log('\n— when the window has passed —');
  const r = await reg(app, 'delta1');
  const token = r.json().token;
  const first = codeIn(mail.sent.at(-1));
  await sleep(60);
  mail.refuse = 'rate_limit_exceeded';
  const refused = await resend(app, token);
  mail.refuse = null;
  const retried = await resend(app, token);
  check('a refused send does not spend the cooldown', refused.statusCode === 502 && retried.statusCode === 202, `${refused.statusCode} then ${retried.statusCode}`);
  const second = codeIn(mail.sent.at(-1));
  const stale = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: { authorization: `Bearer ${token}` }, payload: { code: first } });
  check('a new message replaces the old code', second !== first && stale.statusCode === 400, `${first}/${second} → ${stale.statusCode}`);
  const fresh = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: { authorization: `Bearer ${token}` }, payload: { code: second } });
  check('...and the new one verifies', fresh.statusCode === 200, `${fresh.statusCode} ${fresh.body.slice(0, 60)}`);
  const after = await resend(app, token);
  check('a verified account is told so rather than mailed again', after.statusCode === 200 && after.json().alreadyVerified === true, `${after.statusCode} ${after.body.slice(0, 60)}`);
  await app.close();
}

// ---------------------------------------------------------------------------
{
  console.log('\n— every other bodiless call the client makes reaches its route —');
  const { app } = await makeApp({ adminUsernames: ['boss1'] });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const boss = (await reg(app, 'boss1')).json().token as string;
  const fan = (await reg(app, 'fan1')).json().token as string;
  const cellsGzB64 = gzipSync(new Uint8Array(map.count)).toString('base64');
  const made = await app.inject({
    method: 'POST', url: '/api/designs', headers: bearer(fan),
    payload: { title: 'Report me', templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: ['#262a33', '#1c5fd9'], cellsGzB64 },
  });
  const designId = made.json().id as string;
  await app.inject({ method: 'PATCH', url: `/api/designs/${designId}`, headers: bearer(fan), payload: { isPublic: true } });
  await app.inject({ method: 'POST', url: '/api/report', headers: bearer(fan), payload: { targetType: 'design', targetId: designId, reason: 'test' } });
  const reports = (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: bearer(boss) })).json() as Array<{ id: string }>;
  const reportId = reports[0]?.id ?? '00000000-0000-4000-8000-000000000000';

  const dismiss = await app.inject({ method: 'POST', url: `/api/admin/reports/${reportId}/dismiss`, headers: { ...bearer(boss), ...JSON_NO_BODY } });
  check('dismissing a report', dismiss.statusCode === 200, `${dismiss.statusCode} ${dismiss.body.slice(0, 70)}`);
  const takedown = await app.inject({ method: 'POST', url: `/api/admin/designs/${designId}/takedown`, headers: { ...bearer(boss), ...JSON_NO_BODY } });
  check('taking a design down', takedown.statusCode === 200, `${takedown.statusCode} ${takedown.body.slice(0, 70)}`);
  const nobody = '00000000-0000-4000-8000-000000000000';
  const delPhoto = await app.inject({ method: 'DELETE', url: `/api/photos/${nobody}`, headers: { ...bearer(fan), ...JSON_NO_BODY } });
  check('deleting a photo gets as far as looking for it', delPhoto.statusCode === 404, `${delPhoto.statusCode} ${delPhoto.body.slice(0, 70)}`);
  const modPhoto = await app.inject({ method: 'DELETE', url: `/api/admin/photos/${nobody}`, headers: { ...bearer(boss), ...JSON_NO_BODY } });
  check('a moderator deleting a photo gets as far as looking for it', modPhoto.statusCode === 404, `${modPhoto.statusCode} ${modPhoto.body.slice(0, 70)}`);

  console.log('\n— the JSON parser still refuses what it should —');
  const broken = await app.inject({ method: 'POST', url: '/api/auth/login', headers: JSON_NO_BODY, payload: '{"username":' });
  check('malformed JSON is still a 400', broken.statusCode === 400 && /FST_ERR_CTP_INVALID_JSON_BODY/.test(broken.body), `${broken.statusCode} ${broken.body.slice(0, 70)}`);
  const poisoned = await app.inject({ method: 'POST', url: '/api/auth/login', headers: JSON_NO_BODY, payload: '{"__proto__":{"admin":true},"username":"x","password":"y"}' });
  check('a __proto__ key is still refused', poisoned.statusCode === 400, `${poisoned.statusCode} ${poisoned.body.slice(0, 70)}`);
  const real = await app.inject({ method: 'POST', url: '/api/auth/login', headers: JSON_NO_BODY, payload: '{"username":"fan1","password":"correct-horse-battery-9"}' });
  check('a real JSON body still parses', real.statusCode === 200 && typeof real.json().token === 'string', `${real.statusCode}`);
  await app.close();
}

// ---------------------------------------------------------------------------
{
  console.log('\n— the client never sends a JSON content-type without a body —');
  // A tripwire over the source, not a parser: every fetch( … ) call that asks
  // for a JSON content-type must also pass a body. The server now tolerates the
  // pairing, but the client sending it is how this broke, and a stricter
  // proxy or a future Fastify would break it again.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name)) files.push(p);
    }
  };
  walk(root);
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (let at = src.indexOf('fetch('); at !== -1; at = src.indexOf('fetch(', at + 6)) {
      let i = at + 6, depth = 1;
      while (i < src.length && depth) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      const call = src.slice(at, i);
      const asksJson = /authHeaders\(true\)|content-type['"]?\s*:\s*['"]application\/json/i.test(call);
      if (!asksJson) continue;
      scanned++;
      if (!/\bbody\s*:/.test(call)) {
        const line = src.slice(0, at).split('\n').length;
        offenders.push(`${file.slice(root.length + 1)}:${line}`);
      }
    }
  }
  check(`no JSON header without a body (${scanned} JSON calls scanned)`, scanned > 20 && offenders.length === 0, offenders.join(', '));
}

// ---------------------------------------------------------------------------
{
  console.log('\n— what a mailbox provider sees —');
  // The message that reached Gmail's spam folder passed SPF, DKIM and DMARC and
  // had no tracking rewrites. What it did have: a no-reply sender on a domain
  // with no inbox, and a body that was a bare HTML fragment with no footer.
  check('the default sender is not a no-reply address', !isNoReplyAddress(DEFAULT_FROM) && /@tifomaker\.org>$/.test(DEFAULT_FROM), DEFAULT_FROM);
  check('...and the old one would have been caught', isNoReplyAddress('TifoMaker <no-reply@tifomaker.org>') && isNoReplyAddress('noreply@x.org') && !isNoReplyAddress('Hello <hello@x.org>'));

  const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM, reply: process.env.EMAIL_REPLY_TO };
  process.env.RESEND_API_KEY = 're_test';
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  createEmailSender();
  check('with no EMAIL_FROM, mail goes out from the default', emailHealth().from === DEFAULT_FROM && emailHealth().replyTo === null, JSON.stringify(emailHealth().from));
  process.env.EMAIL_REPLY_TO = 'support@example.com';
  createEmailSender();
  check('EMAIL_REPLY_TO is picked up', emailHealth().replyTo === 'support@example.com');
  for (const [k, v] of Object.entries({ RESEND_API_KEY: saved.key, EMAIL_FROM: saved.from, EMAIL_REPLY_TO: saved.reply })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  // What actually goes over the wire to Resend.
  const bodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response('{"id":"stub"}', { status: 200 });
  }) as typeof fetch;
  try {
    const msg = { to: 'a@example.com', subject: 's', html: '<p>h</p>', text: 't' };
    await new ResendEmailSender('re_test', DEFAULT_FROM, 'support@example.com').send(msg);
    await new ResendEmailSender('re_test', DEFAULT_FROM, 'support@example.com').send(msg);
    await new ResendEmailSender('re_test', DEFAULT_FROM).send(msg);
  } finally {
    globalThis.fetch = realFetch;
  }
  const ref = (b: Record<string, unknown> | undefined) => (b?.headers as Record<string, string> | undefined)?.['X-Entity-Ref-ID'];
  check('replies are routed with reply_to when one is configured', bodies[0]?.reply_to === 'support@example.com', JSON.stringify(bodies[0]?.reply_to));
  check('...and it is left out when not', !('reply_to' in (bodies[2] ?? {})));
  check('every message carries its own X-Entity-Ref-ID, so Gmail does not thread them', !!ref(bodies[0]) && !!ref(bodies[1]) && ref(bodies[0]) !== ref(bodies[1]), `${ref(bodies[0])} / ${ref(bodies[1])}`);

  // The verification email itself, built by the real route.
  const { app, mail } = await makeApp({ publicUrl: 'https://tifomaker.org' });
  await reg(app, 'echo1');
  const m = mail.sent.at(-1)!;
  const html = m.html;
  const code = codeIn(m);
  check('the HTML is a whole document with a declared charset', /^<!doctype html>/i.test(html) && /<meta charset="utf-8">/.test(html) && /<\/html>$/.test(html));
  check('...with a title, and no hidden text (a spam-filter tell)', /<title>[^<]+<\/title>/.test(html) && !/display:\s*none|color:\s*transparent|opacity:\s*0/i.test(html));
  check('...both languages, each with its own direction', /dir="rtl" lang="ar"/.test(html) && /dir="ltr" lang="en"/.test(html));
  check('...and a footer that says who sent it and why', /tifomaker\.org<\/a>/.test(html) && /used for an account on TifoMaker/.test(html) && /استُخدم في حساب على تيفو ميكر/.test(html));
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
  check('every link is on the sending domain', hrefs.length >= 3 && hrefs.every((h) => /^https:\/\/tifomaker\.org(\/|$)/.test(h)), JSON.stringify(hrefs.map((h) => h.slice(0, 40))));
  check('no images, nothing loaded from anywhere else', !/<img\b|src=|url\(/i.test(html));
  // SpamAssassin reads background-color but not the background shorthand; with
  // the shorthand the white button label scored as hidden text (+0.7).
  check('backgrounds are longhand, so the white button label is not read as hidden text', !/background:\s*#/i.test(html) && /background-color:#15924d/.test(html));
  const kb = Buffer.byteLength(html) / 1024;
  check('well under Gmail\'s 102 KB clipping limit', kb < 30, `${kb.toFixed(1)} KB`);
  check('the plain-text part has the code, the link and the footer', !!code && new RegExp(`code: ${code}`).test(m.text ?? '') && /https:\/\/tifomaker\.org\/api\/auth\/verify\?token=/.test(m.text ?? '') && /You received this because/.test(m.text ?? ''));
  const forgot = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'echo1@example.com' } });
  const reset = mail.sent.at(-1)!;
  check('the password-reset email uses the same layout', forgot.statusCode < 300 && reset !== m && /^<!doctype html>/i.test(reset.html) && /\/reset\?token=/.test(reset.html) && /You received this because/.test(reset.text ?? ''), String(forgot.statusCode));
  await app.close();
}

// ---------------------------------------------------------------------------
console.log('\n— preflight says it out loud —');
const prodNoKey = configWarnings({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
const w = prodNoKey.find((x) => x.key === 'RESEND_API_KEY');
check('no key in production is a warning', !!w, w?.effect.slice(0, 60));
check('...and it says nobody is receiving anything', /NO EMAIL IS BEING SENT/.test(w?.effect ?? ''));
const devNoKey = configWarnings({} as NodeJS.ProcessEnv);
check('but not in development', !devNoKey.some((x) => x.key === 'RESEND_API_KEY'));
const oddFrom = configWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@gmail.com' } as NodeJS.ProcessEnv);
check('a From off the verified domain is a warning', oddFrom.some((x) => x.key === 'EMAIL_FROM'));
const okFrom = configWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'TifoMaker <hello@tifomaker.org>' } as NodeJS.ProcessEnv);
check('a From on the domain that can be replied to is not', !okFrom.some((x) => x.key === 'EMAIL_FROM'));
const noReply = configWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'TifoMaker <no-reply@tifomaker.org>' } as NodeJS.ProcessEnv);
const nr = noReply.find((x) => x.key === 'EMAIL_FROM');
check('a no-reply From is a warning', !!nr && nr.state === 'wrong' && /no-reply sender/.test(nr.effect), nr?.effect.slice(0, 70));
const unsetFrom = configWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k' } as NodeJS.ProcessEnv);
check('leaving EMAIL_FROM unset is fine now that the default can be replied to', !unsetFrom.some((x) => x.key === 'EMAIL_FROM'));
const logged: string[] = [];
logConfigWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'noreply@tifomaker.org' } as NodeJS.ProcessEnv, (line: string) => logged.push(line));
check('...and the boot line does not claim a set variable is unset', logged.some((l) => /EMAIL_FROM needs changing/.test(l)) && !logged.some((l) => /EMAIL_FROM is not set/.test(l)), logged.find((l) => /EMAIL_FROM/.test(l))?.slice(0, 60));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
