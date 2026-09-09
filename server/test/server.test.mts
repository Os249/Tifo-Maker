import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryEventsRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { MemoryAdminStatsRepository } from '../src/statsRepo';
import { PgAuthRepository, PgDesignRepository } from '../src/pgRepo';
import { PgSocialRepository } from '../src/pgSocial';
import { buildApp, SNAPSHOT_EVERY, type TemplateInfo } from '../src/routes';
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
    payload: { username, password: 'hunter22pass', email: `${username}@example.test`, acceptedVersion: 'test' },
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
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'hunter22pass', email: 'alice2@example.test', acceptedVersion: 'test' } })).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrongpass99' } })).statusCode,
    401,
  );
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'hunter22pass' } });
  assert.equal(login.statusCode, 200);

  // Sign-in accepts an email as well as a username. Accounts created in the
  // editor never pick a username (it is derived from the email), so without this
  // they would have no way back in.
  await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { username: 'emailer', password: 'hunter22pass', email: 'emailer@example.test', acceptedVersion: 'test' },
  });
  const byEmail = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'emailer@example.test', password: 'hunter22pass' },
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
      payload: { username: 'nobody@example.test', password: 'hunter22pass' },
    })).statusCode,
    401,
    'an unknown email fails the same way as an unknown username',
  );
  assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(aliceTok) })).statusCode, 200);

  // ---- email: required at signup, returned by /api/me, add/replace + uniqueness ----
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'noemail', password: 'hunter22pass' } })).statusCode,
    400,
    'register without email is rejected',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'dupemail', password: 'hunter22pass', email: 'alice@example.test', acceptedVersion: 'test' } })).statusCode,
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
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: bearer(daveTok) })).statusCode,
    202,
  );

  // ---- password: change (authed) + forgot/reset via emailed token ----
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(daveTok), payload: { currentPassword: 'wrongpass99', newPassword: 'newpass1234' } })).statusCode,
    401,
    'wrong current password rejected',
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(daveTok), payload: { currentPassword: 'hunter22pass', newPassword: 'newpass1234' } })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'dave', password: 'newpass1234' } })).statusCode,
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
    (await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetMail!.token, newPassword: 'again123456' } })).statusCode,
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
    (await app.inject({ method: 'GET', url: '/api/ai/quota', headers: bearer(daveTok) })).statusCode,
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
  await pool.end();
} else {
  console.log('postgres repos: skipped (set DATABASE_URL to run)');
}
