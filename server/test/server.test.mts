import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryEventsRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { MemoryDailyFeatureRepository } from '../src/featureRepo';
import { DailyFeaturePicker } from '../src/featured';
import { MemoryAdminStatsRepository } from '../src/statsRepo';
import { MemoryFeedbackRepository } from '../src/feedbackRepo';
import { PgAuthRepository, PgDesignRepository } from '../src/pgRepo';
import { PgSocialRepository } from '../src/pgSocial';
import { buildApp, SNAPSHOT_EVERY, type TemplateInfo } from '../src/routes';
import { schemaStatements } from '../src/schema';
import { toB64 } from '../src/codec';
import type { AuthRepository, DesignRepository } from '../src/repo';
import {
  buildVisit, classifyClient, classifySource, isBotUa, MemoryTrafficRepository,
  normCountry, primaryLang, referrerHost, visitorKeyFor,
} from '../src/trafficRepo';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [
  { id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count },
];
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
// Tiny valid PNG (1x1) for thumbnail round-trips.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function sampleCells(): Uint8Array {
  const cells = new Uint8Array(map.count).fill(1);
  for (let i = 0; i < map.count; i += 7) cells[i] = 2;
  return cells;
}

async function registerUser(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'harbor-kite-moss-31', email: `${username}@example.test`, acceptedVersion: 'test' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token as string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Capturing email sender: records the verification link from each message so the
// verify-flow test can follow it. Reset at the start of each suite run.
const sentEmails: { to: string; token: string }[] = [];
const captureSender = {
  async send(m: { to: string; subject: string; html: string; text?: string }): Promise<void> {
    const match = /(?:\/api\/auth\/verify|\/reset)\?token=([^\s"<&]+)/.exec(`${m.text ?? ''} ${m.html}`);
    sentEmails.push({ to: m.to, token: match ? match[1] : '' });
  },
};

async function runSuite(name: string, repo: DesignRepository, auth: AuthRepository): Promise<void> {
  sentEmails.length = 0;
  const app = await buildApp(repo, auth, templates, { emailSender: captureSender, aiUsage: new MemoryAiUsageRepository() });
  const cells = sampleCells();
  const gz = gzipSync(cells);
  const cellsGzB64 = gz.toString('base64');

  // ---- auth ----
  const aliceTok = await registerUser(app, 'alice');
  const bobTok = await registerUser(app, 'bob');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'harbor-kite-moss-31', email: 'alice2@example.test', acceptedVersion: 'test' } })).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrongpass99' } })).statusCode,
    401,
  );
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'harbor-kite-moss-31' } });
  assert.equal(login.statusCode, 200);

  // Sign-in accepts an email as well as a username. Accounts created in the
  // editor never pick a username (it is derived from the email), so without this
  // they would have no way back in.
  await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { username: 'emailer', password: 'harbor-kite-moss-31', email: 'emailer@example.test', acceptedVersion: 'test' },
  });
  const byEmail = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'emailer@example.test', password: 'harbor-kite-moss-31' },
  });
  assert.equal(byEmail.statusCode, 200, 'can sign in with an email address');
  assert.equal(byEmail.json().username, 'emailer', 'email sign-in resolves to the right account');
  assert.equal(
    (await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'emailer@example.test', password: 'wrongpass99' },
    })).statusCode,
    401,
    'a wrong password still fails when signing in by email',
  );
  assert.equal(
    (await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'nobody@example.test', password: 'harbor-kite-moss-31' },
    })).statusCode,
    401,
    'an unknown email fails the same way as an unknown username',
  );
  assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(aliceTok) })).statusCode, 200);

  // ---- email: required at signup, returned by /api/me, add/replace + uniqueness ----
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'noemail', password: 'harbor-kite-moss-31' } })).statusCode,
    400,
    'register without email is rejected',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'dupemail', password: 'harbor-kite-moss-31', email: 'alice@example.test', acceptedVersion: 'test' } })).statusCode,
    409,
    'duplicate email is rejected',
  );
  const meAlice = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(aliceTok) });
  assert.equal(meAlice.json().email, 'alice@example.test');
  assert.equal(meAlice.json().emailVerified, false);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(aliceTok), payload: { email: 'alice.new@example.test' } })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(aliceTok) })).json().email,
    'alice.new@example.test',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(aliceTok), payload: { email: 'bob@example.test' } })).statusCode,
    409,
    'cannot take another account\'s email',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(aliceTok), payload: { email: 'nope' } })).statusCode,
    400,
    'invalid email rejected',
  );

  // ---- email verification: signup emails a single-use link that verifies ----
  const carolTok = await registerUser(app, 'carol');
  const carolMail = sentEmails.find((e) => e.to === 'carol@example.test');
  assert.ok(carolMail?.token, 'verification email sent on signup');
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(carolTok) })).json().emailVerified,
    false,
  );
  const verify1 = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${carolMail!.token}` });
  assert.equal(verify1.statusCode, 302);
  assert.match(String(verify1.headers.location), /verified=1/);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(carolTok) })).json().emailVerified,
    true,
  );
  const verify2 = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${carolMail!.token}` });
  assert.match(String(verify2.headers.location), /verified=0/, 'verification token is single-use');
  const daveTok = await registerUser(app, 'dave');
  // The signup email starts the resend clock, so an immediate resend (the AI
  // panel fires one about two seconds after a signup) must not replace the code
  // in the message that just went out. Sent the way the browser sends it: a
  // JSON content-type and no body, which used to be a 400 before the route ran.
  const daveMails = sentEmails.filter((e) => e.to === 'dave@example.test').length;
  const earlyResend = await app.inject({
    method: 'POST', url: '/api/auth/verify/resend',
    headers: { ...bearer(daveTok), 'content-type': 'application/json' },
  });
  assert.equal(earlyResend.statusCode, 429, 'a resend straight after signup is a cooldown, not a 400');
  assert.equal(sentEmails.filter((e) => e.to === 'dave@example.test').length, daveMails, 'and sends nothing');

  // ---- password: change (authed) + forgot/reset via emailed token ----
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(daveTok), payload: { currentPassword: 'wrongpass99', newPassword: 'tundra-cobalt-58' } })).statusCode,
    401,
    'wrong current password rejected',
  );
  const pwChange = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(daveTok), payload: { currentPassword: 'harbor-kite-moss-31', newPassword: 'tundra-cobalt-58' } });
  assert.equal(pwChange.statusCode, 200);
  // Changing a password must end every other session, or it is useless as the
  // remedy for a stolen token: tokens live 30 days.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(daveTok) })).statusCode,
    401,
    'the pre-change token is revoked',
  );
  // The caller keeps working, on a freshly minted token handed back in the body.
  const rotated = (pwChange.json() as { token?: string }).token;
  assert.ok(rotated && rotated !== daveTok, 'a replacement token is issued');
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(rotated!) })).statusCode,
    200,
    'the rotated token works',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'dave', password: 'tundra-cobalt-58' } })).statusCode,
    200,
    'can log in with the changed password',
  );
  // forgot is always 200 (no account enumeration), known email or not
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@example.test' } })).statusCode,
    200,
  );
  const erinTok = await registerUser(app, 'erin');
  void erinTok;
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'erin@example.test' } })).statusCode,
    200,
  );
  await app.drainBackground(); // the reset email goes out after the reply, so known and unknown addresses take the same time
  const resetMail = [...sentEmails].reverse().find((e) => e.to === 'erin@example.test' && e.token);
  assert.ok(resetMail?.token, 'reset email sent');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetMail!.token, newPassword: 'erinreset1234' } })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'erin', password: 'erinreset1234' } })).statusCode,
    200,
    'can log in after reset',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetMail!.token, newPassword: 'again-marble-orbit' } })).statusCode,
    400,
    'reset token is single-use',
  );

  // ---- AI gate: signed-in + verified email required; free-for-all = unlimited ----
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/ai/quota' })).statusCode,
    401,
    'AI requires sign in',
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/ai/quota', headers: bearer(rotated!) })).statusCode,
    403,
    'AI requires a verified email',
  );
  const carolQuota = await app.inject({ method: 'GET', url: '/api/ai/quota', headers: bearer(carolTok) });
  assert.equal(carolQuota.statusCode, 200, 'verified user can access AI');
  assert.equal(carolQuota.json().unlimited, false, 'verified users are metered hourly');
  assert.equal(carolQuota.json().limit, 10, 'hourly cap is 10');

  // ---- AI safety screen + account export/delete (launch hardening) ----
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(carolTok), payload: { prompt: 'naked child' } })).statusCode,
    400,
    'unsafe prompt blocked before the model',
  );
  // No AI provider in tests → premium can't deliver, so we offer a choice (never an error)…
  const autoGen = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(carolTok), payload: { prompt: 'red and white stripes' } });
  assert.equal(autoGen.statusCode, 200);
  assert.equal(autoGen.json().needsChoice, true, 'premium busy offers a choice, never an error');
  // …and the free Quick Designer always returns a design without spending a credit.
  const quickGen = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(carolTok), payload: { prompt: 'red and white stripes', engine: 'offline' } });
  assert.equal(quickGen.statusCode, 200);
  assert.equal(quickGen.json().source, 'quick', 'Quick Designer is the free engine');
  assert.ok(quickGen.json().spec, 'Quick Designer produced a design');
  // Bilingual + club DB: an Arabic club brief maps to the right palette, offline.
  const quickAr = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(carolTok), payload: { prompt: 'الهلال نسر ذهبي على المدرج الجنوبي', engine: 'offline' } });
  assert.equal(quickAr.statusCode, 200);
  assert.ok((quickAr.json().spec.palette as string[]).includes('#0033a0'), 'Arabic "الهلال" → Al Hilal blue');
  // The free engine must not move the meter, and every success path must say
  // plainly what the caller got. A design is only charged when it is complete —
  // a hero picture that never arrived used to cost a premium design anyway, and
  // the holed result was then cached for half an hour.
  assert.equal(quickGen.json().outcome?.kind, 'full', 'the Quick Designer reports a full result');
  assert.equal(quickGen.json().outcome?.charged, false, 'the Quick Designer never charges');
  // ---- reading a photo of a real ground ----
  // The route is gated like every other AI route, refuses anything that is not
  // an image, and — with no provider configured, which is the state these tests
  // run in — says so plainly rather than returning an empty vote that would
  // read as "the model saw nothing in your photo".
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/stadium/photo', payload: { image: tinyPng } })).statusCode,
    401,
    'reading a ground photo requires sign in',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/stadium/photo', headers: bearer(carolTok), payload: { image: 'https://example.com/a.png' } })).statusCode,
    400,
    'a URL is not an image: the route takes a data URL or nothing',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/stadium/photo', headers: bearer(carolTok), payload: { image: 'data:text/html;base64,PGI+' } })).statusCode,
    400,
    'and it has to be an image type, not just a data URL',
  );
  const noProvider = await app.inject({ method: 'POST', url: '/api/stadium/photo', headers: bearer(carolTok), payload: { image: tinyPng } });
  assert.equal(noProvider.statusCode, 503, 'with no model configured it says so rather than voting on nothing');
  console.log('stadium photo: all assertions passed (auth gate, data-URL only, image types only, honest 503)');

  const afterQuick = await app.inject({ method: 'GET', url: '/api/ai/quota', headers: bearer(carolTok) });
  assert.equal(afterQuick.json().used, 0, 'three free designs later, nothing has been charged');
  assert.equal(afterQuick.json().remaining, 10, 'the hourly allowance is untouched by free designs');
  // "Busy" must not charge either — the earlier premium attempt returned a choice.
  assert.equal(autoGen.json().quota?.used ?? 0, 0, 'a refused premium attempt costs nothing');

  // ---- account: rename, verification code, real sign-out ----
  {
    const tok = await registerUser(app, 'renamer');
    const bad = await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(tok), payload: { username: 'x' } });
    assert.equal(bad.statusCode, 400, 'a two-character name is refused');
    const taken = await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(tok), payload: { username: 'alice' } });
    assert.equal(taken.statusCode, 409, 'an existing name is refused');
    const ok = await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(tok), payload: { username: 'renamed_1' } });
    assert.equal(ok.statusCode, 200, ok.body);
    const meNow = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) });
    assert.equal(meNow.json().username, 'renamed_1', 'the rename is reflected on /api/me');
    // The old name must be free, and must no longer resolve to this account.
    const reuse = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'renamer', password: 'harbor-kite-moss-31', email: 'someone.else@example.test', acceptedVersion: 'test' },
    });
    assert.equal(reuse.statusCode, 201, 'the vacated name can be registered by someone else');

    // Verification by code: wrong guesses are counted, then the code is burned.
    const vt = await registerUser(app, 'verifier');
    for (let i = 1; i <= 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(vt), payload: { code: '000000' } });
      assert.equal(r.statusCode, 400, `wrong code ${i} is rejected`);
      assert.equal(r.json().triesLeft, 5 - i, 'the caller is told how many tries remain');
    }
    const sixth = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(vt), payload: { code: '000000' } });
    assert.equal(sixth.statusCode, 429, 'the sixth attempt is refused outright');
    assert.equal(sixth.json().exhausted, true, 'and says a new code is needed');
    const st = await registerUser(app, 'shorty');
    const short = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(st), payload: { code: '12' } });
    assert.equal(short.statusCode, 400, 'a short code is refused');
    // …and it must not have spent one of that account's five real tries.
    const after = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(st), payload: { code: '000000' } });
    assert.equal(after.json().triesLeft, 4, 'a malformed code does not burn a try');
    const anon = await app.inject({ method: 'POST', url: '/api/auth/verify/code', payload: { code: '000000' } });
    assert.equal(anon.statusCode, 401, 'verification requires a session — this is what makes 6 digits safe');

    // Sign-out must actually end the session server-side.
    const outTok = await registerUser(app, 'signer');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(outTok) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(outTok) })).statusCode, 204);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(outTok) })).statusCode,
      401,
      'the token is dead after logout, not merely forgotten by the browser',
    );
  }

  const exported = await app.inject({ method: 'GET', url: '/api/account/export', headers: bearer(carolTok) });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.json().account.username, 'carol', 'export includes account data');
  const frankTok = await registerUser(app, 'frank');
  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(frankTok) })).statusCode,
    204,
    'account deletion succeeds',
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(frankTok) })).statusCode,
    401,
    'session is dead after account deletion',
  );

  // logout invalidates the token
  const tempTok = login.json().token as string;
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(tempTok) });
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tempTok) })).statusCode, 401);

  // ---- create: auth required ----
  const basePayload = {
    title: 'GLORY',
    templateId: DEFAULT_TEMPLATE.id,
    templateVersion: DEFAULT_TEMPLATE.version,
    palette: PALETTE,
    cellsGzB64,
  };
  assert.equal((await app.inject({ method: 'POST', url: '/api/designs', payload: basePayload })).statusCode, 401);
  const created = await app.inject({
    method: 'POST',
    url: '/api/designs',
    headers: bearer(aliceTok),
    payload: { ...basePayload, thumbnailPngB64: PNG_1PX.toString('base64') },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  assert.equal(created.json().isPublic, false);

  // wrong-length cells rejected
  const bad = await app.inject({
    method: 'POST',
    url: '/api/designs',
    headers: bearer(aliceTok),
    payload: { ...basePayload, cellsGzB64: gzipSync(new Uint8Array(123)).toString('base64') },
  });
  assert.equal(bad.statusCode, 400);

  // zip-bomb rejected: a tiny payload that decompresses past the 4 MB cap → 400, not OOM
  const bomb = await app.inject({
    method: 'POST',
    url: '/api/designs',
    headers: bearer(aliceTok),
    payload: { ...basePayload, cellsGzB64: gzipSync(new Uint8Array(5 * 1024 * 1024)).toString('base64') },
  });
  assert.equal(bomb.statusCode, 400, 'oversized decompression rejected');

  // ---- the scene: a design's banners ----
  //
  // Deliberately its own route pair, so the assertions that matter are about
  // isolation: the scene must be reachable exactly where the design is, must
  // be refused where the design would be, and — the point of the whole
  // arrangement — must never be able to take the design down with it.
  {
    const sceneJson = JSON.stringify({ v: 1, banners: { version: 1, banners: [{ id: 'bn_1', kind: 'drop', widthM: 24 }] } });
    const sceneGzB64 = gzipSync(Buffer.from(sceneJson)).toString('base64');

    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok) })).json().sceneGzB64,
      null,
      'a design with no banners answers null, not 404',
    );
    // A private design is 404 to anyone who cannot see it, and that includes
    // anonymous: the same answer `PUT /api/designs/:id` gives, so the scene
    // route leaks no more than the design route does.
    assert.equal(
      (await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, payload: { sceneGzB64 } })).statusCode,
      404,
      'anonymous cannot write a scene',
    );
    assert.equal(
      (await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(bobTok), payload: { sceneGzB64 } })).statusCode,
      404,
      'someone else cannot write your scene',
    );
    const put = await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok), payload: { sceneGzB64 } });
    assert.equal(put.statusCode, 200, put.body);
    const back = await app.inject({ method: 'GET', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok) });
    assert.equal(
      gunzipSync(Buffer.from(back.json().sceneGzB64 as string, 'base64')).toString('utf8'),
      sceneJson,
      'the scene comes back byte-exact',
    );
    // Writing again replaces rather than piles up — two tabs of one design is
    // an ordinary thing to have open.
    const second = JSON.stringify({ v: 1, banners: { version: 1, banners: [] } });
    await app.inject({
      method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok),
      payload: { sceneGzB64: gzipSync(Buffer.from(second)).toString('base64') },
    });
    assert.equal(
      gunzipSync(Buffer.from((await app.inject({ method: 'GET', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok) })).json().sceneGzB64 as string, 'base64')).toString('utf8'),
      second,
      'the second write replaces the first',
    );
    assert.equal(
      (await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok), payload: { sceneGzB64: toB64(new Uint8Array([1, 2, 3])) } })).statusCode,
      400,
      'a payload that is not gzip is refused',
    );
    assert.equal(
      (await app.inject({
        method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok),
        payload: { sceneGzB64: gzipSync(Buffer.from('not json at all')).toString('base64') },
      })).statusCode,
      400,
      'a scene that will not parse is refused HERE, not on somebody else\'s load',
    );
    assert.equal(
      (await app.inject({
        method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(aliceTok),
        // Incompressible, so it is genuinely over the cap rather than a bomb.
        payload: { sceneGzB64: toB64(Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, k) => (k * 2654435761) & 255)) },
      })).statusCode,
      413,
      'an oversized scene is refused with 413',
    );
    // And after all of that, the design itself is untouched.
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/designs/${id}`, headers: bearer(aliceTok) })).statusCode,
      200,
      'a rejected scene never damages the design',
    );
  }

  // ---- visibility: private design is 404 to bob and anonymous ----
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}`, headers: bearer(bobTok) })).statusCode, 404);

  // owner round-trip byte-exact
  const fetched = await app.inject({ method: 'GET', url: `/api/designs/${id}`, headers: bearer(aliceTok) });
  assert.equal(fetched.statusCode, 200);
  const back = new Uint8Array(gunzipSync(Buffer.from(fetched.json().cellsGzB64 as string, 'base64')));
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(cells)), 0);

  // thumbnail round-trip (owner)
  const thumb = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: bearer(aliceTok) });
  assert.equal(thumb.statusCode, 200);
  assert.equal(thumb.headers['content-type'], 'image/png');
  assert.equal(Buffer.compare(thumb.rawPayload, PNG_1PX), 0);

  // ---- publish via PATCH; gallery lists it with owner name ----
  assert.equal(
    (await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(bobTok), payload: { isPublic: true } })).statusCode,
    404, // private + not owner → existence hidden
  );
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/designs/${id}`,
    headers: bearer(aliceTok),
    payload: { isPublic: true, title: 'GLORY (public)' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().isPublic, true);

  const gallery = (await app.inject({ method: 'GET', url: '/api/gallery' })).json() as {
    id: string;
    ownerName: string;
    hasThumbnail: boolean;
  }[];
  const item = gallery.find((g) => g.id === id);
  assert.ok(item, 'published design in gallery');
  assert.equal(item!.ownerName, 'alice');
  assert.equal(item!.hasThumbnail, true);

  // now bob can READ but not WRITE (403, not 404)
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}`, headers: bearer(bobTok) })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'PUT', url: `/api/designs/${id}`, headers: bearer(bobTok), payload: { palette: PALETTE, cellsGzB64 } })).statusCode,
    403,
  );

  // ---- 25 sparse-diff revisions by the owner; snapshots at SNAPSHOT_EVERY ----
  const current = sampleCells();
  for (let r = 1; r <= 25; r++) {
    const n = 5;
    const indices = new Uint32Array(n);
    const before = new Uint8Array(n);
    const after = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const idx = (r * 997 + k * 131) % map.count;
      indices[k] = idx;
      before[k] = current[idx];
      after[k] = 3;
      current[idx] = 3;
    }
    const rev = await app.inject({
      method: 'POST',
      url: `/api/designs/${id}/revisions`,
      headers: bearer(aliceTok),
      payload: { indicesB64: toB64(indices), beforeB64: toB64(before), afterB64: toB64(after) },
    });
    assert.equal(rev.statusCode, 201, rev.body);
    assert.equal(rev.json().revisionCount, r);
  }
  // bob cannot append revisions
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/designs/${id}/revisions`,
        headers: bearer(bobTok),
        payload: {
          indicesB64: toB64(new Uint32Array([0])),
          beforeB64: toB64(new Uint8Array([1])),
          afterB64: toB64(new Uint8Array([2])),
        },
      })
    ).statusCode,
    403,
  );

  // server state equals locally replayed state
  const after25 = await app.inject({ method: 'GET', url: `/api/designs/${id}`, headers: bearer(aliceTok) });
  const serverCells = new Uint8Array(gunzipSync(Buffer.from(after25.json().cellsGzB64 as string, 'base64')));
  assert.equal(Buffer.compare(Buffer.from(serverCells), Buffer.from(current)), 0);

  const hist = (
    await app.inject({ method: 'GET', url: `/api/designs/${id}/revisions?limit=50`, headers: bearer(aliceTok) })
  ).json() as { seq: number; changed: number; hasSnapshot: boolean }[];
  assert.equal(hist.length, 25);
  for (const row of hist) {
    assert.equal(row.changed, 5);
    assert.equal(row.hasSnapshot, row.seq % SNAPSHOT_EVERY === 0, `seq ${row.seq}`);
  }

  // ---- fork: bob forks the PUBLIC design; fork is bob's and private ----
  const fork = await app.inject({ method: 'POST', url: `/api/designs/${id}/fork`, headers: bearer(bobTok), payload: { title: 'GLORY remix' } });
  assert.equal(fork.statusCode, 201, fork.body);
  const forkId = fork.json().id as string;
  assert.equal(fork.json().isPublic, false);
  const forkRec = await app.inject({ method: 'GET', url: `/api/designs/${forkId}`, headers: bearer(bobTok) });
  assert.equal(forkRec.json().cellsGzB64, after25.json().cellsGzB64);
  // alice cannot see bob's private fork
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${forkId}`, headers: bearer(aliceTok) })).statusCode, 404);
  // anonymous cannot fork
  assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${id}/fork` })).statusCode, 401);

  // ---- per-owner lists ----
  const aliceList = (await app.inject({ method: 'GET', url: '/api/designs', headers: bearer(aliceTok) })).json() as { id: string }[];
  const bobList = (await app.inject({ method: 'GET', url: '/api/designs', headers: bearer(bobTok) })).json() as { id: string }[];
  assert.ok(aliceList.some((d) => d.id === id) && !aliceList.some((d) => d.id === forkId));
  assert.ok(bobList.some((d) => d.id === forkId) && !bobList.some((d) => d.id === id));

  await app.close();
  console.log(
    `${name}: all assertions passed (auth, 401/403/404/409, visibility, round-trip, thumbnail, gallery, 25 revisions, snapshots, fork, per-owner lists)`,
  );
}

{
  const auth = new MemoryAuthRepository();
  await runSuite('memory repos', new MemoryDesignRepository((id) => auth.usernameOf(id)), auth);

  // ---- security guardrail: no eval / new Function anywhere in client source ----
  {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const offenders: string[] = [];
    try {
      const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
      const stack = [srcRoot];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name !== 'node_modules') stack.push(full);
          } else if (/\.(ts|mts)$/.test(ent.name)) {
            const code = readFileSync(full, 'utf8');
            if (/\beval\s*\(/.test(code) || /\bnew\s+Function\s*\(/.test(code)) offenders.push(ent.name);
          }
        }
      }
    } catch {
      /* path issues must not fail the suite */
    }
    assert.deepEqual(offenders, [], `eval/new Function in client source: ${offenders.join(', ')}`);
    console.log('  ✓ security guard: no eval / new Function in client source');
  }
}

// ---- Before/After match-day photos ----
{
  const auth = new MemoryAuthRepository();
  const app = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, templates);
  const cellsGzB64 = gzipSync(sampleCells()).toString('base64');
  const tok = await registerUser(app, 'photog');

  const created = await app.inject({
    method: 'POST',
    url: '/api/designs',
    headers: { authorization: `Bearer ${tok}` },
    payload: { title: 'Has Photo', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
  });
  const designId = (created.json() as { id: string }).id;
  await app.inject({ method: 'PATCH', url: `/api/designs/${designId}`, headers: { authorization: `Bearer ${tok}` }, payload: { isPublic: true } });

  const g0 = (await app.inject({ method: 'GET', url: '/api/gallery' })).json() as { id: string; hasPhoto: boolean }[];
  assert.equal(g0.find((d) => d.id === designId)?.hasPhoto, false, 'hasPhoto false before upload');

  const up = await app.inject({
    method: 'POST',
    url: `/api/designs/${designId}/photos`,
    headers: { authorization: `Bearer ${tok}` },
    payload: { imageB64: PNG_1PX.toString('base64'), width: 1, height: 1, caption: 'Final 2026' },
  });
  assert.equal(up.statusCode, 200);
  const photoId = (up.json() as { photoId: string }).photoId;

  const list = (await app.inject({ method: 'GET', url: `/api/designs/${designId}/photos` })).json() as { caption: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0].caption, 'Final 2026');
  const img = await app.inject({ method: 'GET', url: `/api/photos/${photoId}` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  const g1 = (await app.inject({ method: 'GET', url: '/api/gallery' })).json() as { id: string; hasPhoto: boolean }[];
  assert.equal(g1.find((d) => d.id === designId)?.hasPhoto, true, 'hasPhoto true after upload');

  const other = await registerUser(app, 'intruder');
  const denied = await app.inject({
    method: 'POST',
    url: `/api/designs/${designId}/photos`,
    headers: { authorization: `Bearer ${other}` },
    payload: { imageB64: PNG_1PX.toString('base64'), width: 1, height: 1 },
  });
  assert.equal(denied.statusCode, 404, 'non-owner upload rejected');
  const delDenied = await app.inject({ method: 'DELETE', url: `/api/photos/${photoId}`, headers: { authorization: `Bearer ${other}` } });
  assert.equal(delDenied.statusCode, 404, 'non-owner delete rejected');

  const del = await app.inject({ method: 'DELETE', url: `/api/photos/${photoId}`, headers: { authorization: `Bearer ${tok}` } });
  assert.equal(del.statusCode, 200);
  const g2 = (await app.inject({ method: 'GET', url: '/api/gallery' })).json() as { id: string; hasPhoto: boolean }[];
  assert.equal(g2.find((d) => d.id === designId)?.hasPhoto, false, 'hasPhoto false after delete');

  console.log('photos: all assertions passed (upload, list, serve, hasPhoto flag, owner-only, delete)');
}

// ---- moderation & trust review (admin gate, takedown, verify) ----
{
  const auth = new MemoryAuthRepository();
  // "chief" is the only designated admin.
  const app = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, templates, {
    adminUsernames: ['chief'],
  });
  const cellsGzB64 = gzipSync(sampleCells()).toString('base64');
  const adminTok = await registerUser(app, 'chief');
  const userTok = await registerUser(app, 'member');

  // /api/me reflects admin status.
  const meAdmin = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${adminTok}` } })).json() as { isAdmin: boolean };
  const meUser = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${userTok}` } })).json() as { isAdmin: boolean };
  assert.equal(meAdmin.isAdmin, true, 'designated user is admin');
  assert.equal(meUser.isAdmin, false, 'normal user is not admin');

  // The gate: non-admin and anonymous are refused the queue.
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/reports', headers: { authorization: `Bearer ${userTok}` } })).statusCode, 403, 'non-admin 403');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/reports' })).statusCode, 401, 'anonymous 401');

  // Publish a design and report it.
  const created = await app.inject({
    method: 'POST',
    url: '/api/designs',
    headers: { authorization: `Bearer ${userTok}` },
    payload: { title: 'Bad Tifo', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
  });
  const designId = (created.json() as { id: string }).id;
  await app.inject({ method: 'PATCH', url: `/api/designs/${designId}`, headers: { authorization: `Bearer ${userTok}` }, payload: { isPublic: true } });
  await app.inject({ method: 'POST', url: '/api/report', payload: { targetType: 'design', targetId: designId, reason: 'hateful' } });

  // Admin sees it with context.
  const reports = (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: { authorization: `Bearer ${adminTok}` } })).json() as { targetId: string; targetTitle: string; reason: string }[];
  const rep = reports.find((r) => r.targetId === designId);
  assert.ok(rep, 'report visible to admin');
  assert.equal(rep!.targetTitle, 'Bad Tifo');
  assert.equal(rep!.reason, 'hateful');

  // Takedown hides the design and clears the open report.
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${designId}/takedown`, headers: { authorization: `Bearer ${adminTok}` } })).statusCode, 200);
  const gallery = (await app.inject({ method: 'GET', url: '/api/gallery' })).json() as { id: string }[];
  assert.ok(!gallery.find((d) => d.id === designId), 'design hidden from gallery after takedown');
  const afterReports = (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: { authorization: `Bearer ${adminTok}` } })).json() as unknown[];
  assert.equal(afterReports.length, 0, 'open report cleared by takedown');

  // Photo verification: upload, appears unverified, admin verifies, leaves queue.
  const created2 = await app.inject({
    method: 'POST',
    url: '/api/designs',
    headers: { authorization: `Bearer ${userTok}` },
    payload: { title: 'Photo Design', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
  });
  const did2 = (created2.json() as { id: string }).id;
  await app.inject({ method: 'PATCH', url: `/api/designs/${did2}`, headers: { authorization: `Bearer ${userTok}` }, payload: { isPublic: true } });
  const up = await app.inject({
    method: 'POST',
    url: `/api/designs/${did2}/photos`,
    headers: { authorization: `Bearer ${userTok}` },
    payload: { imageB64: PNG_1PX.toString('base64'), width: 1, height: 1, caption: 'Match' },
  });
  const photoId = (up.json() as { photoId: string }).photoId;
  const unver = (await app.inject({ method: 'GET', url: '/api/admin/photos/unverified', headers: { authorization: `Bearer ${adminTok}` } })).json() as { id: string }[];
  assert.ok(unver.find((p) => p.id === photoId), 'new photo is unverified');
  // Non-admin cannot verify.
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/photos/${photoId}/verify`, headers: { authorization: `Bearer ${userTok}` }, payload: { verified: true } })).statusCode, 403, 'non-admin verify 403');
  // Admin verifies.
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/photos/${photoId}/verify`, headers: { authorization: `Bearer ${adminTok}` }, payload: { verified: true } })).statusCode, 200);
  const photoList = (await app.inject({ method: 'GET', url: `/api/designs/${did2}/photos` })).json() as { isVerified: boolean }[];
  assert.equal(photoList[0].isVerified, true, 'photo now verified');
  const unver2 = (await app.inject({ method: 'GET', url: '/api/admin/photos/unverified', headers: { authorization: `Bearer ${adminTok}` } })).json() as { id: string }[];
  assert.ok(!unver2.find((p) => p.id === photoId), 'verified photo left the queue');

  // With no admins configured, even the right person is denied (gate closed by default).
  const noAdminAuth = new MemoryAuthRepository();
  const noAdminApp = await buildApp(new MemoryDesignRepository((id) => noAdminAuth.usernameOf(id)), noAdminAuth, templates);
  const sameNameTok = await registerUser(noAdminApp, 'chief');
  assert.equal((await noAdminApp.inject({ method: 'GET', url: '/api/admin/reports', headers: { authorization: `Bearer ${sameNameTok}` } })).statusCode, 403, 'no ADMIN_USERNAMES → nobody is admin');

  console.log('moderation: all assertions passed (admin gate, report context, takedown, photo verify, default-closed)');
}

// ---- social layer: remix lineage, follows, comments, notifications ----
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const app = await buildApp(designs, auth, templates, { social });
  const cellsGzB64 = gzipSync(sampleCells()).toString('base64');

  const aliceTok = await registerUser(app, 'alice');
  const bobTok = await registerUser(app, 'bob');
  const aliceId = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(aliceTok) })).json().id as string;
  const bobId = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(bobTok) })).json().id as string;

  // Alice publishes a design with a creator explanation + remix allowed.
  const created = await app.inject({
    method: 'POST', url: '/api/designs', headers: bearer(aliceTok),
    payload: { title: 'El Clasico', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
  });
  const designId = (created.json() as { id: string }).id;

  // Bob follows Alice BEFORE she publishes publicly.
  assert.equal((await app.inject({ method: 'POST', url: `/api/users/${aliceId}/follow`, headers: bearer(bobTok) })).statusCode, 200);

  // Set publish meta (description + allowRemix), then publish.
  await app.inject({ method: 'PUT', url: `/api/designs/${designId}/publish-meta`, headers: bearer(aliceTok), payload: { description: 'For the derby, top tier gold.', allowRemix: true } });
  await app.inject({ method: 'PATCH', url: `/api/designs/${designId}`, headers: bearer(aliceTok), payload: { isPublic: true } });

  // Bob (a follower) gets a 'follow_post' notification about Alice's publish.
  const bobNotifs = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(bobTok) })).json() as { unread: number; items: { kind: string; designId: string }[] };
  assert.ok(bobNotifs.items.some((n) => n.kind === 'follow_post' && n.designId === designId), 'follower notified of new public post');
  assert.ok(bobNotifs.unread >= 1, 'unread count reflects the notification');

  // Bob remixes Alice's design → new design owned by Bob, lineage stamped.
  const remixed = await app.inject({ method: 'POST', url: `/api/designs/${designId}/remix`, headers: bearer(bobTok), payload: { title: 'My Clasico remix' } });
  assert.equal(remixed.statusCode, 201);
  const remix = remixed.json() as { id: string; ownerId: string; remixedFrom: string };
  assert.equal(remix.ownerId, bobId, 'remix owned by the remixer');
  assert.equal(remix.remixedFrom, designId, 'remixed_from points at the original');
  assert.notEqual(remix.id, designId, 'remix is a new design, original untouched');

  // Alice gets a 'remix' notification.
  const aliceNotifs = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(aliceTok) })).json() as { items: { kind: string }[] };
  assert.ok(aliceNotifs.items.some((n) => n.kind === 'remix'), 'creator notified of remix');

  // A non-remixable design refuses remixing.
  const locked = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(aliceTok), payload: { title: 'Locked', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
  const lockedId = (locked.json() as { id: string }).id;
  await app.inject({ method: 'PUT', url: `/api/designs/${lockedId}/publish-meta`, headers: bearer(aliceTok), payload: { description: null, allowRemix: false } });
  await app.inject({ method: 'PATCH', url: `/api/designs/${lockedId}`, headers: bearer(aliceTok), payload: { isPublic: true } });
  assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${lockedId}/remix`, headers: bearer(bobTok) })).statusCode, 403, 'remix blocked when not allowed');

  // Comments: Bob comments on Alice's design; Alice is notified; thread lists it.
  const c = await app.inject({ method: 'POST', url: `/api/designs/${designId}/comments`, headers: bearer(bobTok), payload: { body: 'This is class!' } });
  assert.equal(c.statusCode, 201);
  const commentId = (c.json() as { id: string }).id;
  const thread = (await app.inject({ method: 'GET', url: `/api/designs/${designId}/comments` })).json() as unknown[];
  assert.equal(thread.length, 1, 'comment appears in the thread');
  // A reply (threaded).
  await app.inject({ method: 'POST', url: `/api/designs/${designId}/comments`, headers: bearer(aliceTok), payload: { body: 'Thanks!', parentId: commentId } });
  const thread2 = (await app.inject({ method: 'GET', url: `/api/designs/${designId}/comments` })).json() as { parentId: string | null }[];
  assert.equal(thread2.length, 2);
  assert.ok(thread2.some((x) => x.parentId === commentId), 'reply is linked to its parent');
  // Author can delete own comment.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${commentId}`, headers: bearer(bobTok) })).statusCode, 200);

  // Follow graph in the profile.
  const aliceProfile = (await app.inject({ method: 'GET', url: `/api/users/${aliceId}/profile`, headers: bearer(bobTok) })).json() as { followerCount: number; isFollowing: boolean; designCount: number };
  assert.equal(aliceProfile.followerCount, 1, 'alice has one follower');
  assert.equal(aliceProfile.isFollowing, true, 'bob follows alice');
  assert.ok(aliceProfile.designCount >= 2, 'profile counts public designs');

  // User search: signed-in only, and a real prefix is required. As a public endpoint
  // answering "?q=a" it let anyone walk the whole account list one letter at a time.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/users/search?q=ali' })).statusCode,
    401,
    'user search rejects anonymous callers',
  );
  const oneLetter = (await app.inject({ method: 'GET', url: '/api/users/search?q=a', headers: bearer(bobTok) })).json() as unknown[];
  assert.equal(oneLetter.length, 0, 'single-letter search returns nothing (no enumeration)');
  const found = (await app.inject({ method: 'GET', url: '/api/users/search?q=ali', headers: bearer(bobTok) })).json() as { username: string }[];
  assert.ok(found.some((u) => u.username === 'alice'), 'user search matches by prefix for signed-in users');

  // Unfollow drops the follower count.
  await app.inject({ method: 'DELETE', url: `/api/users/${aliceId}/follow`, headers: bearer(bobTok) });
  const after = (await app.inject({ method: 'GET', url: `/api/users/${aliceId}/profile` })).json() as { followerCount: number };
  assert.equal(after.followerCount, 0, 'unfollow works');

  console.log('social: all assertions passed (remix lineage, follow graph, comments+threads, notifications, search)');
}

// ---- tifo of the day: the daily pick, its stability, and the creator's notification ----
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const featured = new MemoryDailyFeatureRepository();
  const app = await buildApp(designs, auth, templates, { social, featured });
  const cellsGzB64 = gzipSync(sampleCells()).toString('base64');

  const aliceTok = await registerUser(app, 'alice');
  const bobTok = await registerUser(app, 'bob');

  // Publish one design WITH a thumbnail, one WITHOUT. Only the first can be
  // featured: the card is the thumbnail, so a design with none is not a card.
  const publish = async (token: string, title: string, withThumb: boolean): Promise<string> => {
    const payload: Record<string, unknown> = { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 };
    if (withThumb) payload.thumbnailPngB64 = PNG_1PX.toString('base64');
    const created = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload });
    const id = (created.json() as { id: string }).id;
    await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } });
    return id;
  };

  // Nothing published yet: the endpoint answers, with nothing in it. A young
  // site is not an error, and the home page has to render either way. Asked on
  // its own app because an empty answer is remembered for a minute — the pool
  // query is the expensive one and a cold site must not run it per request.
  const coldApp = await buildApp(designs, auth, templates, { social, featured });
  const cold = (await coldApp.inject({ method: 'GET', url: '/api/featured/today' })).json() as { day: string; item: unknown };
  assert.equal(cold.item, null, 'no community designs yet means no feature, not a failure');
  assert.match(cold.day, /^\d{4}-\d{2}-\d{2}$/, 'the day is a UTC date string');

  const shown = await publish(aliceTok, 'Curva Nord', true);
  await publish(bobTok, 'No thumbnail here', false);

  const first = (await app.inject({ method: 'GET', url: '/api/featured/today' })).json() as {
    day: string; item: { id: string; ownerName: string; hasThumbnail: boolean } | null;
  };
  assert.ok(first.item, 'a published design with a thumbnail gets featured');
  assert.equal(first.item!.id, shown, 'the design without a thumbnail is not eligible');
  assert.equal(first.item!.ownerName, 'alice');

  // Alice is told, once, with the design attached so the feed can name it.
  const notifs = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(aliceTok) })).json() as {
    items: { kind: string; designId: string | null; actorId: string | null }[];
  };
  const featuredNotes = notifs.items.filter((n) => n.kind === 'featured');
  assert.equal(featuredNotes.length, 1, 'the creator is notified exactly once');
  assert.equal(featuredNotes[0].designId, shown, 'the notification carries the design');
  assert.equal(featuredNotes[0].actorId, null, 'the site featured it, so there is no actor');

  // Asking again does not re-pick or re-notify, however many times the home
  // page is loaded — which is the whole reason the day is a stored row.
  for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: '/api/featured/today' });
  const again = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(aliceTok) })).json() as { items: { kind: string }[] };
  assert.equal(again.items.filter((n) => n.kind === 'featured').length, 1, 'one feature, one notification');

  // A second instance on the same day inherits the SAME pick from the store,
  // even though its own pool now favours a newer, more-liked design.
  const hyped = await publish(bobTok, 'Tifo with all the likes', true);
  await app.inject({ method: 'POST', url: `/api/designs/${hyped}/vote`, headers: bearer(aliceTok), payload: { value: 1 } });
  const second = await buildApp(designs, auth, templates, { social, featured });
  const stable = (await second.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
  assert.equal(stable.item!.id, shown, "today's pick is fixed for the day, across instances and restarts");
  const bobNotes = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(bobTok) })).json() as { items: { kind: string }[] };
  assert.equal(bobNotes.items.filter((n) => n.kind === 'featured').length, 0, 'a second instance does not notify for a day already claimed');

  // Tomorrow moves on to someone who has not had a turn, rather than repeating
  // the best design forever.
  const picker = new DailyFeaturePicker(designs, featured, social);
  const tomorrow = await picker.today(new Date(Date.now() + 86_400_000));
  assert.equal(tomorrow!.item.id, hyped, 'the next day goes to a design that has not been featured');
  assert.notEqual(tomorrow!.day, first.day, 'and it is a different day');

  // The starter library is not somebody's work to celebrate, so it never wins.
  const libraryOwner = await registerUser(app, 'tifomaker');
  const libraryId = await publish(libraryOwner, 'Library strip', true);
  const libraryUser = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(libraryOwner) })).json().id as string;
  await designs.setTemplate(libraryId, libraryUser, true);
  const day3 = await picker.today(new Date(Date.now() + 2 * 86_400_000));
  assert.notEqual(day3!.item.id, libraryId, 'templates are never the tifo of the day');

  // The card is rendered INTO the home page, not fetched by the browser: it is
  // the home page's first link to a design page, and an orphan design page is
  // what /community's crawler feed exists to fix. This is the assertion that
  // fails if landing.html's container is renamed and the injection stops
  // matching — which would fail silently, the page merely losing a section.
  if (existsSync(join(process.cwd(), 'landing.html'))) {
    const served = await buildApp(designs, auth, templates, { social, featured, staticDir: process.cwd() });
    const home = await served.inject({ method: 'GET', url: '/' });
    assert.equal(home.statusCode, 200);
    assert.ok(home.body.includes('id="featured-tifo"'), 'the home page still has the container to inject into');
    assert.ok(home.body.includes(`href="/t/${shown}"`), 'the home page links straight to the featured design page');
    assert.ok(home.body.includes('Curva Nord'), "the featured design's name is in the HTML a crawler gets");
    assert.ok(home.body.includes('data-i18n="daily.badge"'), 'the fixed labels stay translatable');
    assert.ok(/\/api\/designs\/[0-9a-f-]+\/thumbnail\.png/.test(home.body), 'and its thumbnail is a real image tag');
  }

  // Without the store the feature is simply absent — the endpoint still answers
  // so the home page never has to special-case a deployment that has it off.
  const noStore = await buildApp(designs, auth, templates, { social });
  const off = (await noStore.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: unknown };
  assert.equal(off.item, null, 'no store means no feature, not a 500');

  console.log('tifo of the day: all assertions passed (eligibility, one notification, stable for the day, rotation, templates excluded, rendered into the home page)');
}

// ---- threads, view counts, and the single-design card ----
//
// Three things the community page needed and did not have: a reply could not
// answer a reply (the server always allowed it; the client was the wall), the
// person you replied to was never told, and the feed's view count was always
// zero on Postgres because listPublic did not select the column.
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const app = await buildApp(designs, auth, templates, { social });
  const cellsGzB64 = gzipSync(sampleCells()).toString('base64');

  const aliceTok = await registerUser(app, 'alice');
  const bobTok = await registerUser(app, 'bob');
  const carolTok = await registerUser(app, 'carol');
  const idOf = async (token: string): Promise<string> =>
    (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string;
  const aliceId = await idOf(aliceTok);
  const bobId = await idOf(bobTok);
  const notifs = async (token: string): Promise<{ kind: string; commentId: string | null; designId: string | null }[]> =>
    ((await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(token) })).json() as {
      items: { kind: string; commentId: string | null; designId: string | null }[];
    }).items;

  const made = await app.inject({
    method: 'POST', url: '/api/designs', headers: bearer(aliceTok),
    payload: { title: 'Curva Sud', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG_1PX.toString('base64') },
  });
  const designId = (made.json() as { id: string }).id;
  await app.inject({ method: 'PATCH', url: `/api/designs/${designId}`, headers: bearer(aliceTok), payload: { isPublic: true } });

  // ---- one design, as the feed would show it ----
  const one = await app.inject({ method: 'GET', url: `/api/gallery/${designId}`, headers: bearer(bobTok) });
  assert.equal(one.statusCode, 200);
  const card = one.json() as { id: string; ownerName: string; hasThumbnail: boolean; likeScore: number; myVote: number; viewCount: number };
  assert.equal(card.id, designId);
  assert.equal(card.ownerName, 'alice', 'the single card carries the owner name, like the feed');
  assert.equal(card.hasThumbnail, true);
  await app.inject({ method: 'POST', url: `/api/designs/${designId}/vote`, headers: bearer(bobTok), payload: { value: 1 } });
  const voted = (await app.inject({ method: 'GET', url: `/api/gallery/${designId}`, headers: bearer(bobTok) })).json() as { likeScore: number; myVote: number };
  assert.equal(voted.myVote, 1, "and the caller's own vote, so the heart is right on arrival");
  assert.equal(voted.likeScore, 1);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/gallery/${designId}` })).json().myVote, 0,
    'an anonymous caller has no vote',
  );

  // A private design and an unknown id answer the same way: 404. Otherwise the
  // endpoint tells a stranger which ids exist.
  const secret = await app.inject({
    method: 'POST', url: '/api/designs', headers: bearer(aliceTok),
    payload: { title: 'Not ready', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
  });
  const secretId = (secret.json() as { id: string }).id;
  assert.equal((await app.inject({ method: 'GET', url: `/api/gallery/${secretId}`, headers: bearer(aliceTok) })).statusCode, 404, 'private stays private even to its owner here');
  assert.equal((await app.inject({ method: 'GET', url: '/api/gallery/00000000-0000-0000-0000-000000000000' })).statusCode, 404);

  // ---- views ----
  assert.equal(card.viewCount, 0, 'a design starts on zero views');
  await app.inject({ method: 'POST', url: `/api/designs/${designId}/view` });
  await app.inject({ method: 'POST', url: `/api/designs/${designId}/view`, headers: bearer(bobTok) });
  const seen = (await app.inject({ method: 'GET', url: `/api/gallery/${designId}` })).json() as { viewCount: number };
  assert.equal(seen.viewCount, 2, 'views reach the single card');
  const feed = (await app.inject({ method: 'GET', url: '/api/gallery' })).json() as { id: string; viewCount: number }[];
  assert.equal(feed.find((d) => d.id === designId)?.viewCount, 2, 'and the feed — the column the gallery query used to leave out');
  assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${secretId}/view`, headers: bearer(aliceTok) })).statusCode, 403, 'a private design counts no views');

  // ---- a reply to a reply to a reply ----
  const say = async (token: string, body: string, parentId: string | null): Promise<{ status: number; id?: string }> => {
    const res = await app.inject({ method: 'POST', url: `/api/designs/${designId}/comments`, headers: bearer(token), payload: { body, parentId } });
    return { status: res.statusCode, id: res.statusCode === 201 ? (res.json() as { id: string }).id : undefined };
  };
  const top = await say(bobTok, 'Top tier looks unreal', null);
  assert.equal(top.status, 201);
  const lvl2 = await say(aliceTok, 'Thanks! Took three weeks', top.id!);
  assert.equal(lvl2.status, 201, 'a reply to a comment');
  const lvl3 = await say(carolTok, 'Three weeks?! respect', lvl2.id!);
  assert.equal(lvl3.status, 201, 'a reply to a reply — the whole point of this change');
  const lvl4 = await say(bobTok, 'agreed', lvl3.id!);
  assert.equal(lvl4.status, 201, 'and it does not stop at three');

  const thread = (await app.inject({ method: 'GET', url: `/api/designs/${designId}/comments` })).json() as { id: string; parentId: string | null }[];
  assert.equal(thread.length, 4);
  assert.equal(thread.find((c) => c.id === lvl3.id)?.parentId, lvl2.id, 'the chain is stored as it was written, not flattened');
  assert.equal(thread.find((c) => c.id === lvl4.id)?.parentId, lvl3.id);

  // A parent from ANOTHER design is refused. Without this a reply lands in a
  // thread it can never be rendered in, and notifies a stranger.
  const other = await app.inject({
    method: 'POST', url: '/api/designs', headers: bearer(bobTok),
    payload: { title: 'Somebody else', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
  });
  const otherId = (other.json() as { id: string }).id;
  await app.inject({ method: 'PATCH', url: `/api/designs/${otherId}`, headers: bearer(bobTok), payload: { isPublic: true } });
  const crossed = await app.inject({
    method: 'POST', url: `/api/designs/${otherId}/comments`, headers: bearer(carolTok),
    payload: { body: 'wrong thread', parentId: top.id },
  });
  assert.equal(crossed.statusCode, 400, "a reply cannot be pinned to another design's comment");
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/designs/${designId}/comments`, headers: bearer(carolTok), payload: { body: 'ghost', parentId: '00000000-0000-0000-0000-000000000000' } })).statusCode,
    400,
    'nor to a comment that does not exist',
  );

  // ---- who hears about a reply ----
  const bobNotes = await notifs(bobTok);
  assert.ok(
    bobNotes.some((n) => n.kind === 'reply' && n.commentId === lvl2.id),
    'the person replied to is told — the notification that was missing',
  );
  const carolNotes = await notifs(carolTok);
  assert.ok(carolNotes.some((n) => n.kind === 'reply' && n.commentId === lvl4.id), 'at any depth');
  assert.equal(
    bobNotes.filter((n) => n.kind === 'comment' && n.commentId === lvl2.id).length, 0,
    'and not twice: a reply notification replaces the owner one when they are the same person',
  );
  // Alice owns the design AND wrote lvl2; carol replied to it. She should have
  // exactly one notification for that reply, as the person answered.
  const aliceNotes = await notifs(aliceTok);
  assert.equal(
    aliceNotes.filter((n) => n.commentId === lvl3.id).length, 1,
    'the owner who was also replied to hears once, not once per role',
  );
  assert.equal(aliceNotes.find((n) => n.commentId === lvl3.id)?.kind, 'reply', 'and hears the more precise of the two');
  // A top-level comment on somebody's design still notifies the owner.
  assert.ok(aliceNotes.some((n) => n.kind === 'comment' && n.commentId === top.id), 'a top-level comment still reaches the owner');
  // Replying to yourself notifies nobody.
  const before = (await notifs(bobTok)).length;
  await say(bobTok, 'one more thing', lvl4.id!);
  assert.equal((await notifs(bobTok)).length, before, 'replying to yourself is not news');

  // Every notification an owner can get carries what the client needs to open
  // it: a design for the design kinds, a comment for the comment kinds.
  for (const n of aliceNotes) {
    if (n.kind === 'comment' || n.kind === 'reply') {
      assert.ok(n.designId && n.commentId, `${n.kind} notification must carry both ids so it can be opened`);
    }
  }
  void aliceId; void bobId;

  console.log('community: all assertions passed (single card + vote + 404, views in feed and card, replies at any depth, cross-design parent refused, reply notifications)');
}

// ---- B2B lead capture ----
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const leads = new MemoryLeadsRepository();
  const app = await buildApp(designs, auth, templates, { leads });

  // Valid lead is stored.
  const ok = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Sara', email: 'sara@club.com', organization: 'Al Hilal', orgType: 'club', message: 'Want white-label.' } });
  assert.equal(ok.statusCode, 201);
  assert.equal(leads.leads.length, 1, 'lead stored');
  assert.equal(leads.leads[0].organization, 'Al Hilal');

  // Missing name / bad email are rejected.
  assert.equal((await app.inject({ method: 'POST', url: '/api/leads', payload: { email: 'x@y.com' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'No Email', email: 'not-an-email' } })).statusCode, 400);
  assert.equal(leads.leads.length, 1, 'invalid leads not stored');

  console.log('leads: all assertions passed (store valid, reject missing name / bad email)');
}

// ---- .tifo format validation endpoint ----
{
  const auth = new MemoryAuthRepository();
  const app = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, templates);
  const validate = async (doc: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/tifo/validate', payload: doc });

  // A valid v2 doc passes (RLE summing to the seat count).
  const good = await validate({
    format: 'tifo',
    schemaVersion: 2,
    stadium: { templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version },
    palette: ['#262a33', '#1c5fd9', '#f2f1ec'],
    layers: [{ id: 'base', kind: 'cells', cellsRle: [[1, map.count]] }],
  });
  assert.equal(good.statusCode, 200);
  assert.equal((good.json() as { valid: boolean }).valid, true, 'valid v2 doc passes');

  // Wrong seat count → invalid with a path-targeted error.
  const wrongCount = await validate({
    format: 'tifo',
    schemaVersion: 2,
    stadium: { templateId: DEFAULT_TEMPLATE.id, templateVersion: 1 },
    palette: ['#000000', '#ffffff'],
    layers: [{ id: 'base', kind: 'cells', cellsRle: [[1, 50]] }],
  });
  const wc = wrongCount.json() as { valid: boolean; errors: { path: string }[] };
  assert.equal(wc.valid, false);
  assert.ok(wc.errors.some((e) => e.path.includes('cellsRle')), 'wrong count flags cellsRle path');

  // Unknown stadium → invalid.
  const unknown = await validate({
    format: 'tifo',
    schemaVersion: 2,
    stadium: { templateId: 'nope', templateVersion: 1 },
    palette: ['#000000', '#ffffff'],
    layers: [{ id: 'b', kind: 'cells', cellsRle: [[1, 10]] }],
  });
  assert.equal((unknown.json() as { valid: boolean }).valid, false, 'unknown stadium rejected');

  // Legacy v1 migrates and validates.
  const v1 = await validate({
    format: 'tifo-v1',
    templateId: DEFAULT_TEMPLATE.id,
    templateVersion: 1,
    palette: ['#000000', '#ffffff'],
    cells: Array.from(new Uint8Array(map.count).fill(1)),
  });
  assert.equal((v1.json() as { valid: boolean }).valid, true, 'legacy v1 migrates + validates');

  console.log('tifo/validate: all assertions passed (v2 accept, precise errors, unknown stadium, v1 migration)');
}

{
  const auth = new MemoryAuthRepository();
  const events = new MemoryEventsRepository();
  const app = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, templates, {
    events,
    adminUsernames: ['boss'],
  });
  const bossTok = await registerUser(app, 'boss');

  const send = (session: string, name: string, signedIn = false) =>
    app.inject({ method: 'POST', url: '/api/events', payload: { session, name, signedIn } });

  // Three sessions land; two paint; one publishes. Models real drop-off.
  for (const s of ['s1', 's2', 's3']) await send(s, 'landed');
  await send('s1', 'paint_first');
  await send('s2', 'paint_first');
  await send('s1', 'published', true);
  // Duplicate events from the same session must not double-count.
  await send('s1', 'landed');
  await send('s1', 'landed');
  // Junk + unknown names are silently ignored (204, not recorded).
  const junk = await send('', 'landed');
  assert.equal(junk.statusCode, 204);
  const unknown = await send('s9', 'not_a_real_step');
  assert.equal(unknown.statusCode, 204);

  // The funnel exposes conversion rates and account counts, business intelligence,
  // and previously world-readable. It is admin-only now.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/funnel?days=1' })).statusCode,
    403,
    'funnel rejects anonymous callers',
  );
  const res = await app.inject({ method: 'GET', url: '/api/funnel?days=1', headers: bearer(bossTok) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { steps: { name: string; sessions: number; pctOfTop: number; pctOfPrev: number }[] };
  const by = Object.fromEntries(body.steps.map((s) => [s.name, s]));
  assert.equal(by.landed.sessions, 3, 'landed = 3 distinct sessions (dupes ignored)');
  assert.equal(by.paint_first.sessions, 2, 'paint_first = 2');
  assert.equal(by.published.sessions, 1, 'published = 1');
  // Conversion math: paint_first is 2/3 of the top step.
  assert.equal(by.paint_first.pctOfTop, 66.7);
  assert.equal(by.landed.pctOfTop, 100);
  // Unknown step never created a row.
  assert.ok(!('not_a_real_step' in by));
  console.log('events/funnel: all assertions passed (capture, dedupe, junk-rejection, conversion math, admin gate)');
}

// ---- traffic sources: the privacy guarantees, asserted ----
// These are not cosmetic tests. The whole legal basis for measuring traffic without
// a consent banner is that NO personal data is stored, so each of those properties
// is pinned here, if a future change starts persisting an IP or a raw user-agent,
// this block fails loudly instead of quietly creating a compliance problem.
{
  const IP = '203.0.113.77';
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  // A referrer is reduced to a bare hostname: the path and query of the referring
  // URL (which can carry search terms, tokens or personal identifiers) never land.
  assert.equal(referrerHost('https://www.google.com/search?q=how+to+make+a+tifo&hl=ar', 'tifomaker.org'), 'google.com');
  assert.equal(referrerHost('https://news.ycombinator.com/item?id=123', 'tifomaker.org'), 'news.ycombinator.com');
  // Same-site navigation is not a referral at all.
  assert.equal(referrerHost('https://tifomaker.org/app', 'tifomaker.org'), null);
  assert.equal(referrerHost('https://www.tifomaker.org/app', 'tifomaker.org'), null);
  assert.equal(referrerHost(undefined, 'tifomaker.org'), null);
  assert.equal(referrerHost('not a url', 'tifomaker.org'), null);

  // Source classification.
  assert.equal(classifySource('google.com', null, null, true).kind, 'search');
  assert.equal(classifySource('google.co.uk', null, null, true).kind, 'search');
  assert.equal(classifySource('tiktok.com', null, null, true).kind, 'social');
  assert.equal(classifySource('tiktok.com', null, null, true).label, 'TikTok');
  assert.equal(classifySource('chatgpt.com', null, null, true).kind, 'ai');
  assert.equal(classifySource('somefanblog.example', null, null, true).kind, 'referral');
  assert.equal(classifySource(null, null, null, false).kind, 'direct');
  assert.equal(classifySource(null, 'tiktok', 'social', false).kind, 'campaign');

  // Bots are recognised and kept out of the human counts.
  assert.equal(isBotUa('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isBotUa('curl/8.4.0'), true);
  assert.equal(isBotUa(''), true, 'a missing user-agent is a script, not a browser');
  assert.equal(isBotUa(UA), false);

  // In-app webviews are distinguishable from ordinary browsers.
  assert.equal(classifyClient(UA).device, 'Mobile');
  assert.equal(classifyClient(UA).os, 'iOS');
  assert.equal(classifyClient('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/119 Mobile Safari/537.36 musical_ly_2022 BytedanceWebview').browser, 'TikTok in-app');
  assert.equal(classifyClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36').device, 'Desktop');

  // Language is reduced to a primary subtag; country rejects non-countries.
  assert.equal(primaryLang('ar-SA,ar;q=0.9,en-US;q=0.8'), 'ar');
  assert.equal(primaryLang(undefined), null);
  assert.equal(normCountry('sa'), 'SA');
  assert.equal(normCountry('XX'), null, 'Cloudflare unknown is not a country');
  assert.equal(normCountry('T1'), null, 'Tor is not a country');

  // The visitor key is stable within a day, and changes with the visitor.
  assert.equal(visitorKeyFor(IP, UA), visitorKeyFor(IP, UA), 'same visitor, same key within a day');
  assert.notEqual(visitorKeyFor(IP, UA), visitorKeyFor('198.51.100.4', UA), 'different address, different key');
  assert.notEqual(visitorKeyFor(IP, UA), visitorKeyFor(IP, UA + ' Edg/120'), 'different client, different key');

  // THE important one: nothing identifying survives into the stored row.
  const visit = buildVisit({
    ip: IP,
    ua: UA,
    referer: 'https://www.google.com/search?q=tifo+maker',
    host: 'tifomaker.org',
    path: '/app?utm_source=tiktok&utm_campaign=hookA',
    query: { utm_source: 'tiktok', utm_campaign: 'hookA' },
    acceptLanguage: 'ar-SA,ar;q=0.9',
    country: 'SA',
  });
  const serialized = JSON.stringify(visit);
  assert.ok(!serialized.includes(IP), 'the IP address is never stored');
  assert.ok(!serialized.includes('AppleWebKit'), 'the raw user-agent is never stored');
  assert.ok(!serialized.includes('q=tifo+maker'), 'the referring query string is never stored');
  assert.ok(!visit.visitorKey.includes(IP), 'the visitor key does not embed the address');
  assert.equal(visit.visitorKey.length, 32);
  assert.equal(visit.path, '/app', 'the query string is stripped from the stored path');
  assert.equal(visit.source, 'campaign', 'utm tags win over the referrer');
  assert.equal(visit.utmSource, 'tiktok');
  assert.equal(visit.lang, 'ar');
  assert.equal(visit.country, 'SA');
  assert.equal(visit.device, 'Mobile');
  assert.equal(visit.isBot, false);

  // The store aggregates, and excludes bots from every human number.
  const traffic = new MemoryTrafficRepository();
  await traffic.record(visit);
  await traffic.record(buildVisit({ ip: '198.51.100.4', ua: UA, referer: 'https://www.google.com/', host: 'tifomaker.org', path: '/', query: {}, acceptLanguage: 'en-GB' }));
  await traffic.record(buildVisit({ ip: '198.51.100.9', ua: 'curl/8.4.0', host: 'tifomaker.org', path: '/', query: {} }));
  const sm = await traffic.summary(30);
  assert.equal(sm.totals.visits, 2, 'bot visits are excluded from the visit count');
  assert.equal(sm.totals.botVisits, 1);
  assert.equal(sm.totals.visitors, 2);
  assert.ok(sm.sources.some((b) => b.key === 'search'), 'the google visit is classified as search');
  assert.ok(sm.sources.some((b) => b.key === 'campaign'), 'the utm-tagged visit is classified as a campaign');
  assert.ok(sm.daily.length >= 1);

  // ChatGPT rewrites the links it recommends with ?utm_source=chatgpt.com. That
  // used to short-circuit to "campaign" before the AI list was consulted, which
  // hid the site's largest referrer inside a bucket that reads as "my own ads".
  const fromChatGpt = buildVisit({ ip: '203.0.113.20', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'chatgpt.com' } });
  assert.equal(fromChatGpt.source, 'ai', 'a utm_source naming an AI assistant is classified as ai, not campaign');
  // Matching is hostname-shaped on purpose. A bare "google" utm_source is how ad
  // platforms tag themselves, and that really is a campaign; "google.com" is a
  // referrer naming itself.
  const fromGoogleHost = buildVisit({ ip: '203.0.113.21', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'google.com' } });
  assert.equal(fromGoogleHost.source, 'search', 'a utm_source naming a search host is classified as search');
  const adTag = buildVisit({ ip: '203.0.113.23', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'google', utm_medium: 'cpc' } });
  assert.equal(adTag.source, 'campaign', 'a bare ad-platform tag stays a campaign');
  const realCampaign = buildVisit({ ip: '203.0.113.22', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'spring-flyer', utm_campaign: 'derby' } });
  assert.equal(realCampaign.source, 'campaign', 'an actual campaign tag is still a campaign');

  // And the "Tagged campaigns" panel must list campaigns only: the AI-tagged
  // arrivals are already shown as AI, and counting them twice in two panels
  // made the same 13 visits look like 26.
  const camps = new MemoryTrafficRepository();
  await camps.record(fromChatGpt);
  await camps.record(realCampaign);
  const cs = await camps.summary(30);
  assert.equal(cs.campaigns.length, 1, 'only the real campaign is listed');
  assert.ok(cs.campaigns[0].key.includes('spring-flyer'), 'and it is the flyer, not chatgpt.com');
  assert.ok(cs.sources.some((x) => x.key === 'ai'), 'the AI arrival still appears under its own source');

  console.log('traffic: all assertions passed (no IP/UA/query stored, referrer reduced to host, bot exclusion, utm attribution)');
}

// ---------- sharing ----------
// design_shares has been recording platform + kind since sharing shipped; the
// dashboard reads it through stats.shares(). What matters here is the gate and
// the fact that presses and opens never get added together.
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const app = await buildApp(designs, auth, templates, {
    stats: new MemoryAdminStatsRepository(),
    traffic: new MemoryTrafficRepository(),
    adminUsernames: ['boss'],
  });
  const bossTok = await registerUser(app, 'boss');
  const fanTok = await registerUser(app, 'fan');

  // Same class of business intelligence as the funnel, so the same gate.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/admin/shares?days=30' })).statusCode,
    403,
    'shares rejects anonymous callers',
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/admin/shares?days=30', headers: bearer(fanTok) })).statusCode,
    403,
    'shares rejects signed-in non-admins',
  );

  const res = await app.inject({ method: 'GET', url: '/api/admin/shares?days=30', headers: bearer(bossTok) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    days: number; shares: number; opens: number; designsShared: number;
    platforms: unknown[]; daily: unknown[]; topDesigns: unknown[];
    inbound: { visits: number; tifosOpened: number; pages: unknown[]; social: unknown[] } | null;
  };
  assert.equal(body.days, 30);
  // Presses and opens are separate fields, never one summed number.
  assert.equal(typeof body.shares, 'number');
  assert.equal(typeof body.opens, 'number');
  assert.ok(Array.isArray(body.platforms) && Array.isArray(body.daily) && Array.isArray(body.topDesigns));
  // The inbound half is present whenever traffic measurement is on.
  assert.ok(body.inbound && Array.isArray(body.inbound.pages), 'inbound half is derived from the visits table');

  // The window is clamped, so a hostile days value cannot become an unbounded scan.
  const wide = await app.inject({ method: 'GET', url: '/api/admin/shares?days=99999', headers: bearer(bossTok) });
  assert.equal((wide.json() as { days: number }).days, 365, 'days is clamped to a year');
  const negative = await app.inject({ method: 'GET', url: '/api/admin/shares?days=-5', headers: bearer(bossTok) });
  assert.equal((negative.json() as { days: number }).days, 1, 'a negative window is floored at one day');
  // 0 and junk are falsy through Number(), so both land on the 30-day default
  // rather than a zero-length window. Same rule as /api/funnel and /api/admin/traffic.
  const zero = await app.inject({ method: 'GET', url: '/api/admin/shares?days=0', headers: bearer(bossTok) });
  assert.equal((zero.json() as { days: number }).days, 30, 'a zero window falls back to the default');
  const junk = await app.inject({ method: 'GET', url: '/api/admin/shares?days=abc', headers: bearer(bossTok) });
  assert.equal((junk.json() as { days: number }).days, 30, 'an unparseable window falls back to the default');

  // Only visits to shared pages count toward the inbound half.
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const traffic = new MemoryTrafficRepository();
  for (const path of ['/d/abc', '/d/abc', '/t/xyz', '/app', '/']) {
    await traffic.record(buildVisit({ ip: '203.0.113.7', ua: DESKTOP_UA, host: 'tifomaker.org', path, query: {} }));
  }
  const sm = await traffic.summary(30);
  const sharedPages = sm.pages.filter((p) => /^\/(d|t)\//.test(p.key));
  assert.equal(sharedPages.reduce((n, p) => n + p.visits, 0), 3, '/d/ and /t/ visits count, /app and / do not');
  assert.equal(sharedPages.length, 2, 'two distinct shared pages were opened');
  // Why the endpoint reports visits and a page count but never a visitor total:
  // the summary buckets uniques PER PAGE, so summing them counts this single
  // visitor twice as soon as they open a second tifo.
  assert.equal(
    sharedPages.reduce((n, p) => n + p.visitors, 0), 2,
    'per-page unique columns sum to 2 for one visitor, which is why they are not summed in the API',
  );

  console.log('shares: all assertions passed (admin gate, share/open kept separate, day clamping, inbound from /d/ and /t/ only)');
}

// ---------- in-product feedback ----------
// An open, unauthenticated write endpoint. The traps below are the whole reason
// it can stay open without a CAPTCHA, so they are asserted rather than assumed.
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const feedback = new MemoryFeedbackRepository();
  const sent: { to: string; subject: string }[] = [];
  const app = await buildApp(designs, auth, templates, {
    feedback,
    feedbackTo: 'dev@example.test',
    emailSender: { async send(msg) { sent.push({ to: msg.to, subject: msg.subject }); } },
    adminUsernames: ['boss'],
  });
  const bossTok = await registerUser(app, 'boss');
  // Registering sends a verification mail through this same sender, so start
  // counting from here or the first entry is that, not the report.
  await new Promise((r) => setTimeout(r, 20));
  sent.length = 0;

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/feedback', payload: { elapsedMs: 9000, ...payload } });

  // A real report lands, and reaches the developer by mail.
  const ok = await post({ kind: 'bug', message: 'The save button does nothing on my phone', steps: 'painted, pressed save',
    context: { path: '/app', browser: 'Safari', os: 'iOS', device: 'Mobile', viewport: '390x844', language: 'en', signedIn: false } });
  assert.equal(ok.statusCode, 201, 'a genuine report is accepted');
  // The mail is deliberately fire-and-forget: the report is already stored, and
  // a slow or failing mail provider must never cost the person their report or
  // hold the response open. So let the microtask settle before checking.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, 'and is emailed to the developer');
  assert.ok(sent[0].subject.includes('bug'), 'the subject says what kind it is');

  // Honeypot: answered 200 so a bot learns nothing, but never stored.
  const trapped = await post({ kind: 'bug', message: 'buy cheap watches', website: 'http://spam.example' });
  assert.equal(trapped.statusCode, 200, 'the honeypot answers success rather than revealing the trap');

  // Time-trap: nothing a person typed is submitted in under two seconds.
  const tooFast = await app.inject({ method: 'POST', url: '/api/feedback',
    payload: { kind: 'bug', message: 'instant spam', elapsedMs: 40 } });
  assert.equal(tooFast.statusCode, 200, 'an instant submission is answered without storing');

  const stored = await feedback.list(50);
  assert.equal(stored.length, 1, 'neither trap wrote a row');
  assert.equal(stored[0].message, 'The save button does nothing on my phone');

  // Never stored: the IP and the raw user agent. The context is the coarse
  // facts only, exactly as shown to the person before they sent it.
  const blob = JSON.stringify(stored[0]);
  assert.ok(!/Mozilla|AppleWebKit|\d+\.\d+\.\d+\.\d+/.test(blob), 'no user agent or IP reaches storage');
  assert.equal(stored[0].context?.browser, 'Safari');

  // Opting out really drops it.
  await post({ kind: 'idea', message: 'Let me pick a stadium from a photo', context: null });
  const withoutCtx = (await feedback.list(50))[0];
  assert.equal(withoutCtx.context, null, 'declining diagnostics stores nothing about the device');
  assert.equal(withoutCtx.kind, 'idea');

  // Input guards.
  assert.equal((await post({ kind: 'bug', message: 'hm' })).statusCode, 400, 'a too-short message is refused');
  assert.equal((await post({ kind: 'nonsense', message: 'a real message' })).statusCode, 400, 'an unknown kind is refused');
  assert.equal((await post({ kind: 'bug', message: 'a real message', email: 'not-an-email' })).statusCode, 400, 'a malformed reply address is refused');

  // Reading them back is admin-only, like every other business signal here.
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/feedback' })).statusCode, 403, 'anonymous cannot read reports');
  const mine = await app.inject({ method: 'GET', url: '/api/admin/feedback', headers: bearer(bossTok) });
  assert.equal(mine.statusCode, 200);
  const body = mine.json() as { items: unknown[]; counts: { bugs: number; ideas: number } };
  assert.equal(body.counts.bugs, 1);
  assert.equal(body.counts.ideas, 1);

  console.log('feedback: all assertions passed (honeypot, time-trap, no UA/IP stored, opt-out honoured, admin gate, email delivery)');
}

// ---------- discoverability ----------
// Published tifos were orphan pages: /community built its grid client-side, so
// a crawler saw a heading and no links, and every design page carried the same
// boilerplate description. Both make a set of pages look worthless to search.
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  // Prefer a real build when one exists: dist/ is the only directory that has
  // og-card.png, and the card-fallback assertion below needs it. Without a
  // build the suite still runs, it just skips that one check.
  const distDir = join(process.cwd(), 'dist');
  const staticRoot = existsSync(join(distDir, 'og-card.png')) ? distDir : process.cwd();
  const hasCardAsset = existsSync(join(staticRoot, 'og-card.png'));
  const app = await buildApp(designs, auth, templates, { staticDir: staticRoot, adminUsernames: [] });
  const tok = await registerUser(app, 'ultra');
  const cellsGzB64 = gzipSync(sampleCells()).toString('base64');

  const mk = async (title: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(tok),
      payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 } });
    const id = (r.json() as { id: string }).id;
    await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(tok), payload: { isPublic: true } });
    return id;
  };
  const namedId = await mk('Riyadh derby');
  const otherId = await mk('North stand mosaic');

  // 1. The community page must carry real links, not just a loading message.
  const feed = await app.inject({ method: 'GET', url: '/community' });
  if (feed.statusCode === 200) {
    const html = feed.body;
    assert.ok(html.includes(`href="/t/${namedId}"`), 'community links the published design');
    assert.ok(html.includes(`href="/t/${otherId}"`), 'community links every published design');
    assert.ok(html.includes('Riyadh derby'), 'the link carries the design name as anchor text');
    // /t/ is canonical; linking /d/ as well would split the signal.
    assert.ok(!html.includes(`href="/d/${namedId}"`), 'links point at the canonical /t/ URL only');
  }

  // 2. Two different designs must not describe themselves identically.
  const descOf = (body: string): string => (body.match(/<meta name="description" content="([^"]*)"/i) ?? [])[1] ?? '';
  const a = await app.inject({ method: 'GET', url: `/t/${namedId}` });
  const b = await app.inject({ method: 'GET', url: `/t/${otherId}` });
  if (a.statusCode === 200 && b.statusCode === 200) {
    const da = descOf(a.body), db = descOf(b.body);
    assert.ok(da.length > 20 && db.length > 20, 'design pages carry a description');
    assert.notEqual(da, db, 'two designs must not share one boilerplate description');
    assert.ok(da.includes('Riyadh derby'), 'the description names the design');
    assert.ok(da.includes('@ultra'), 'the description credits the creator');
  }

  // 3. A private design stays invisible: no link, no metadata leak.
  const privR = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(tok),
    payload: { title: 'Secret plan', templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 } });
  const privId = (privR.json() as { id: string }).id;
  const feed2 = await app.inject({ method: 'GET', url: '/community' });
  if (feed2.statusCode === 200) {
    assert.ok(!feed2.body.includes(privId), 'a private design is never linked from the feed');
    assert.ok(!feed2.body.includes('Secret plan'), 'a private title never appears in the feed');
  }
  const privPage = await app.inject({ method: 'GET', url: `/t/${privId}` });
  if (privPage.statusCode === 200) {
    assert.ok(!descOf(privPage.body).includes('Secret plan'), 'a private title never reaches the meta description');
  }

  // ---- 4. Link preview cards -------------------------------------------
  // No social crawler runs JavaScript, so every one of these tags has to be in
  // the HTML the server sends. The site shipped for months with og:image and
  // twitter:card missing from every page except /t/:id, which is why a shared
  // link rendered as a grey placeholder with no picture.
  const SHAREABLE = ['/', '/app', '/community', '/clubs', '/legal', '/tifo-spec', `/t/${namedId}`];
  for (const path of SHAREABLE) {
    const r = await app.inject({ method: 'GET', url: path, headers: { host: 'tifomaker.org' } });
    if (r.statusCode !== 200) continue; // page absent in an API-only build
    const html = r.body;
    const one = (re: RegExp): string | null => (html.match(re) ?? [])[1] ?? null;

    const img = one(/<meta property="og:image" content="([^"]+)"/i);
    assert.ok(img, `${path}: og:image present`);
    // A relative og:image is never resolved by any crawler - the single most
    // common cause of an empty card.
    assert.ok(img!.startsWith('https://'), `${path}: og:image is absolute https (${img})`);

    // twitter:card has no Open Graph fallback. Without it X renders the small
    // thumbnail card and Discord crops the image to an 80px square.
    assert.equal(
      one(/<meta name="twitter:card" content="([^"]+)"/i),
      'summary_large_image',
      `${path}: twitter:card is summary_large_image`,
    );

    // Declared dimensions let the card render before the image downloads;
    // without them the image is commonly missing on the FIRST share of a URL.
    assert.equal(one(/<meta property="og:image:width" content="([^"]+)"/i), '1200', `${path}: og:image:width`);
    assert.equal(one(/<meta property="og:image:height" content="([^"]+)"/i), '630', `${path}: og:image:height`);
    assert.ok(one(/<meta property="og:image:alt" content="([^"]+)"/i), `${path}: og:image:alt`);

    const ogUrl = one(/<meta property="og:url" content="([^"]+)"/i);
    assert.ok(ogUrl?.startsWith('https://tifomaker.org'), `${path}: og:url is the canonical origin`);

    // Duplicated tags are resolved differently by each platform.
    assert.equal((html.match(/property="og:title"/gi) ?? []).length, 1, `${path}: exactly one og:title`);
    assert.equal((html.match(/<title>/gi) ?? []).length, 1, `${path}: exactly one <title>`);
  }

  // A forged Host must never be echoed into the card's own canonical URL.
  const forged = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example.com' } });
  if (forged.statusCode === 200) {
    assert.ok(
      !forged.body.includes('evil.example.com'),
      'a forged Host never reaches og:url or og:image',
    );
  }

  // The card image must never 404. A failed fetch is cached as a failure for up
  // to a week on X and a month on Facebook, so one missing thumbnail would kill
  // the preview for every share of that design long after the thumbnail lands.
  if (hasCardAsset) {
    const cardRes = await app.inject({ method: 'GET', url: `/og/t/${namedId}.png` });
    assert.equal(cardRes.statusCode, 200, 'a design with no image of its own falls back to the site card');
    assert.equal(cardRes.headers['content-type'], 'image/png', 'the fallback is served as a png');
  }

  // The card lives outside /api/ on purpose: robots.txt has to disallow /api/,
  // and Twitterbot, facebookexternalhit, LinkedInBot and TelegramBot obey it.
  const shared = await app.inject({ method: 'GET', url: `/t/${namedId}`, headers: { host: 'tifomaker.org' } });
  if (shared.statusCode === 200) {
    const cardUrl = (shared.body.match(/<meta property="og:image" content="([^"]+)"/i) ?? [])[1] ?? '';
    assert.ok(cardUrl.includes('/og/'), 'a design card is served from /og/, not from under /api/');
    assert.ok(!cardUrl.includes('/api/'), 'the card URL is not inside the robots-disallowed /api/ tree');
  }

  console.log('link cards: all assertions passed (image absolute + https, summary_large_image, dimensions, single tags, no host injection, never 404, outside /api/)');

  console.log('discoverability: all assertions passed (feed links designs, canonical /t/ only, unique descriptions, private stays hidden)');
}

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  await pool.query('TRUNCATE design_revisions, designs, auth_tokens, users CASCADE');
  await runSuite('postgres repos', new PgDesignRepository(pool), new PgAuthRepository(pool));

  // Social layer on real Postgres, guards pg-only bugs the memory suite cannot
  // catch, e.g. the JSONB palette round-trip in remix that shipped a 500.
  {
    const pAuth = new PgAuthRepository(pool);
    const pDesigns = new PgDesignRepository(pool);
    const pSocial = new PgSocialRepository(pool);
    const app = await buildApp(pDesigns, pAuth, templates, { social: pSocial });
    const u = (n: string): string => `${n}_${Math.random().toString(36).slice(2, 8)}`;
    const aliceTok = await registerUser(app, u('alice'));
    const bobTok = await registerUser(app, u('bob'));
    const cellsGzB64 = gzipSync(sampleCells()).toString('base64');
    const created = await app.inject({
      method: 'POST', url: '/api/designs', headers: bearer(aliceTok),
      payload: { title: 'PG Clasico', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
    });
    const designId = (created.json() as { id: string }).id;
    await app.inject({ method: 'PUT', url: `/api/designs/${designId}/publish-meta`, headers: bearer(aliceTok), payload: { description: 'derby', allowRemix: true } });
    await app.inject({ method: 'PATCH', url: `/api/designs/${designId}`, headers: bearer(aliceTok), payload: { isPublic: true } });
    const remixed = await app.inject({ method: 'POST', url: `/api/designs/${designId}/remix`, headers: bearer(bobTok), payload: { title: 'PG remix' } });
    assert.equal(remixed.statusCode, 201, `pg remix must succeed (regression guard for the JSONB palette bug): ${remixed.body}`);
    const remix = remixed.json() as { id: string; palette: string[]; remixedFrom: string };
    assert.deepEqual(remix.palette, PALETTE, 'palette survives the JSONB remix round-trip on Postgres');
    assert.equal(remix.remixedFrom, designId, 'remix lineage stamped on Postgres');
    console.log('social (postgres): remix + palette round-trip passed');
  }

  // ---- the deploy path, and the federated-identity code that only runs here ----
  //
  // Everything above ran against a database that already had the new schema.
  // What a real deploy does is different and is the part that can go wrong: an
  // EXISTING database, where users.password_hash is still NOT NULL, has the file
  // applied to it one statement at a time. So put the column back the old way
  // and walk that path for real.
  {
    const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    await pool.query('ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL');
    const before = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'",
    );
    assert.equal(before.rows[0].is_nullable, 'NO', 'starting from a pre-change database');
    await pool.query('DROP TABLE IF EXISTS oauth_identities');

    const failures: string[] = [];
    for (const stmt of schemaStatements(schemaSql)) {
      try {
        await pool.query(stmt);
      } catch (e) {
        failures.push(`${(e as Error).message} :: ${stmt.slice(0, 80)}`);
      }
    }
    assert.deepEqual(failures, [], 'every statement in schema.sql applies to an existing database');

    const after = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'",
    );
    assert.equal(after.rows[0].is_nullable, 'YES', 'the migration really dropped NOT NULL — a Google account has no password');

    // Idempotent: a second deploy must be a no-op, not a pile of errors.
    const twice: string[] = [];
    for (const stmt of schemaStatements(schemaSql)) {
      try { await pool.query(stmt); } catch (e) { twice.push((e as Error).message); }
    }
    assert.deepEqual(twice, [], 'applying schema.sql a second time changes nothing and raises nothing');

    // ---- the identity methods, on real SQL rather than a Map ----
    const pAuth = new PgAuthRepository(pool);
    const u = (n: string): string => `${n}_${Math.random().toString(36).slice(2, 8)}`;
    const mail = `${u('g')}@example.test`;
    const googler = await pAuth.createUser(u('googler'), null, { email: mail, emailVerified: true });
    assert.ok(googler, 'an account with no password inserts');
    assert.equal(googler!.passwordHash, null, 'and reads back as null rather than the string "null"');
    assert.ok(googler!.emailVerifiedAt, 'a provider-verified address arrives already verified');

    assert.equal(await pAuth.linkIdentity('google', 'sub-pg-1', googler!.id), true, 'the identity links');
    assert.equal(await pAuth.linkIdentity('google', 'sub-pg-1', googler!.id), true, 'linking the same pair twice is not an error');
    assert.equal(await pAuth.getUserIdByIdentity('google', 'sub-pg-1'), googler!.id);
    assert.deepEqual(await pAuth.identitiesFor(googler!.id), ['google']);

    // One Google account cannot be claimed by a second TifoMaker account: the
    // primary key is what decides that, and it has to be reported as a refusal
    // rather than thrown.
    const other = await pAuth.createUser(u('other'), 'x'.repeat(40), {});
    assert.equal(await pAuth.linkIdentity('google', 'sub-pg-1', other!.id), false, 'a taken identity is refused, not stolen');
    assert.equal(await pAuth.getUserIdByIdentity('google', 'sub-pg-1'), googler!.id, 'and the original owner still owns it');

    assert.equal(await pAuth.unlinkIdentity('google', googler!.id), true);
    assert.equal(await pAuth.unlinkIdentity('google', googler!.id), false, 'unlinking what is not there says so');

    // ON DELETE CASCADE: deleting the account must not leave an orphan row that
    // would hand the next person with that sub someone else's deleted account.
    await pAuth.linkIdentity('google', 'sub-pg-2', googler!.id);
    await pAuth.deleteUser(googler!.id);
    assert.equal(await pAuth.getUserIdByIdentity('google', 'sub-pg-2'), null, 'the identity goes with the account');

    console.log('postgres: deploy migration + federated identities passed (NOT NULL dropped, idempotent, link/unlink/conflict/cascade)');
  }
  await pool.end();
} else {
  console.log('postgres repos: skipped (set DATABASE_URL to run)');
}

// ---------- AI history ----------
//
// ai_usage is a METER: one row per user holding only the current hour, reset to
// 1 on the hour. Everything the admin AI section answers — how much has been
// generated, has anyone hit the cap, how often the model fails — needs the
// ai_events history instead, and the old dashboard KPI summed the meter and
// called it lifetime. These assertions are what keep the two apart.
{
  const { MemoryAiEventsRepository, MemoryAiUsageRepository } = await import('../src/memoryRepo.js');
  const events = new MemoryAiEventsRepository((id) => (id === 'u1' ? 'ahlawy' : 'someone'));

  for (let i = 0; i < 4; i++) await events.record({ userId: 'u1', mode: 'std', outcome: 'model' });
  await events.record({ userId: 'u1', mode: 'super', outcome: 'quota' });
  await events.record({ userId: 'u1', mode: 'std', outcome: 'quota' });
  await events.record({ userId: null, mode: 'std', outcome: 'quick' });
  await events.record({ userId: 'u1', mode: 'std', outcome: 'blocked' });

  const st = await events.stats(30);
  assert.equal(st.totals.model, 4, 'premium generations counted');
  assert.equal(st.totals.quota, 2, 'cap hits counted');
  assert.equal(st.totals.all, 8, 'every request counted, not just the billable ones');
  assert.equal(st.window.all, 8, 'all of them fall inside a 30-day window');
  assert.equal(st.modes.super, 1, 'whole-bowl mode split out');
  assert.equal(st.hitCap.length, 1, 'the account that hit the cap is named');
  assert.equal(st.hitCap[0].username, 'ahlawy');
  assert.equal(st.hitCap[0].times, 2);
  assert.equal(st.topUsers[0].username, 'ahlawy', 'busiest account first');
  assert.equal(st.topUsers[0].model, 4);
  assert.ok(st.topUsers.some((u) => u.username === 'admin / unlocked'), 'admin traffic is attributed, not dropped');
  assert.ok(st.perDay.length >= 1 && st.perDay[0].model === 4, 'per-day series carries premium counts');

  // The distinction the whole section exists for: the meter forgets, the
  // history does not. Consuming twice inside one hour leaves the meter at 2
  // forever-ish, while the history keeps every request that ever happened.
  const meter = new MemoryAiUsageRepository();
  await meter.consume('u1', 10);
  await meter.consume('u1', 10);
  const m = await meter.get('u1', 10);
  assert.equal(m.used, 2, 'the meter knows only this hour');
  assert.ok(st.totals.all > m.used, 'the history knows more than the meter ever could');

  console.log('ai history: all assertions passed (outcomes, cap attribution, mode split, meter-vs-history)');
}
