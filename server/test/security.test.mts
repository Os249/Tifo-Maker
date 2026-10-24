/**
 * Adversarial security tests. Unlike the functional suite (which checks the
 * happy path works), these actively TRY to break the access controls — they
 * assert that attacks FAIL. Run on memory repos; the auth/ownership logic is
 * shared with Postgres, so a pass here covers both.
 *
 * Coverage: auth bypass (missing/forged/garbage tokens), IDOR (acting on another
 * user's design/comment/photo), privilege escalation (non-admin → admin routes),
 * and the admin allow-list being closed by default.
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository } from '../src/memoryRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { mintUnlock } from '../src/aiRoutes';
import { hashPassword, hashToken } from '../src/auth';
import { checkPassword, suggestPassphrase, PASSWORD_MAX, PASSWORD_MIN } from '../../src/core/password';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
const cellsGzB64 = gzipSync(new Uint8Array(map.count)).toString('base64');
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function reg(app: FastifyInstance, u: string): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'quartz-lantern-echo7', email: `${u}@example.test`, acceptedVersion: 'test' } });
  const token = (r.json() as { token: string }).token;
  const id = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string;
  return { token, id };
}
async function makeDesign(app: FastifyInstance, token: string, isPublic = false): Promise<string> {
  const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
  const id = (d.json() as { id: string }).id;
  if (isPublic) await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } });
  return id;
}

{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const leads = new MemoryLeadsRepository();
  // No adminUsernames → admin must be closed by default.
  const app = await buildApp(designs, auth, templates, { social, leads });

  const alice = await reg(app, 'alice_sec');
  const bob = await reg(app, 'bob_sec');

  // ---- 1. Auth bypass: protected routes reject missing/garbage/forged tokens ----
  for (const headers of [undefined, bearer(''), bearer('garbage'), bearer('Bearer x'), { authorization: 'Basic abc' }]) {
    const r = await app.inject({ method: 'GET', url: '/api/me', ...(headers ? { headers } : {}) });
    assert.equal(r.statusCode, 401, `/, /api/me must 401 for bad auth (${JSON.stringify(headers)})`);
  }
  // A 64-hex string that isn't a real token hash must not authenticate.
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer('a'.repeat(64)) })).statusCode, 401, 'forged 64-hex token rejected');

  // ---- 2. IDOR: bob cannot mutate alice's private design ----
  const aliceDesign = await makeDesign(app, alice.token);
  // bob can't even SEE it (404, not 403 — no existence leak)
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${aliceDesign}`, headers: bearer(bob.token) })).statusCode, 404, 'private design hidden from non-owner');
  // bob can't overwrite cells
  assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${aliceDesign}`, headers: bearer(bob.token), payload: { palette: PALETTE, cellsGzB64 } })).statusCode, 404, 'IDOR write blocked');
  // bob can't flip it public or rename it
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${aliceDesign}`, headers: bearer(bob.token), payload: { isPublic: true } })).statusCode, 404, 'IDOR patch blocked');
  // bob can't set tags / template / publish-meta on it
  assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${aliceDesign}/tags`, headers: bearer(bob.token), payload: { tags: ['x'] } })).statusCode, 404, 'IDOR tags blocked');
  assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${aliceDesign}/publish-meta`, headers: bearer(bob.token), payload: { description: 'hijack', allowRemix: true } })).statusCode, 404, 'IDOR publish-meta blocked');

  // Even when alice's design is PUBLIC, bob still can't mutate it (403, ownership).
  const alicePublic = await makeDesign(app, alice.token, true);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${alicePublic}`, headers: bearer(bob.token), payload: { title: 'stolen' } })).statusCode, 403, 'public design still owner-locked for writes');
  assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${alicePublic}`, headers: bearer(bob.token), payload: { palette: PALETTE, cellsGzB64 } })).statusCode, 403, 'public design cells owner-locked');

  // ---- 3. Cross-user comment deletion ----
  // bob comments on alice's public design; alice (owner) can delete, a third party cannot.
  const carol = await reg(app, 'carol_sec');
  const c = await app.inject({ method: 'POST', url: `/api/designs/${alicePublic}/comments`, headers: bearer(bob.token), payload: { body: 'hi' } });
  const commentId = (c.json() as { id: string }).id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${commentId}`, headers: bearer(carol.token) })).statusCode, 404, 'stranger cannot delete others’ comment');
  // owner (alice) CAN delete it — legitimate moderation of her own design
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${commentId}`, headers: bearer(alice.token) })).statusCode, 200, 'design owner can delete comment on their design');

  // ---- 4. Privilege escalation: non-admins are refused on every admin route ----
  const adminRoutes: [string, string][] = [
    ['GET', '/api/admin/reports'],
    ['POST', '/api/admin/reports/abc/dismiss'],
    ['POST', `/api/admin/designs/${alicePublic}/takedown`],
    ['GET', '/api/admin/photos/unverified'],
    ['POST', '/api/admin/photos/abc/verify'],
    ['DELETE', '/api/admin/photos/abc'],
  ];
  for (const [method, url] of adminRoutes) {
    // Authenticated but non-admin → 403 (admin allow-list is empty / closed by default).
    const r = await app.inject({ method: method as 'GET', url, headers: bearer(bob.token), payload: {} });
    assert.equal(r.statusCode, 403, `${method} ${url} must 403 for non-admin (got ${r.statusCode})`);
    // Unauthenticated → 401.
    const r2 = await app.inject({ method: method as 'GET', url, payload: {} });
    assert.equal(r2.statusCode, 401, `${method} ${url} must 401 unauthenticated (got ${r2.statusCode})`);
  }

  // ---- 5. Photo IDOR: bob can't delete alice's photo (we just assert the route guards) ----
  // (Upload requires a real PNG; the delete guard is owner-or-moderator, validated in the functional suite.
  //  Here we assert an unauth delete is rejected.)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/photos/some-id' })).statusCode, 401, 'photo delete requires auth');

  // ---- 6. Self-follow & follow abuse ----
  // Can't follow yourself (no-op, but must not 500), and follow requires auth.
  assert.equal((await app.inject({ method: 'POST', url: `/api/users/${alice.id}/follow` })).statusCode, 401, 'follow requires auth');

  // ---- 7. Input hardening: oversized / wrong-type fields are rejected, not crashed ----
  // Title too long
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${alicePublic}`, headers: bearer(alice.token), payload: { title: 'x'.repeat(200) } })).statusCode, 400, 'overlong title rejected');
  // Wrong-type isPublic
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${alicePublic}`, headers: bearer(alice.token), payload: { isPublic: 'yes' } })).statusCode, 400, 'non-boolean isPublic rejected');
  // Bad gzip body
  assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${alicePublic}`, headers: bearer(alice.token), payload: { palette: PALETTE, cellsGzB64: 'bm90Z3ppcA==' } })).statusCode, 400, 'invalid gzip rejected');
  // Lead with bad email
  assert.equal((await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'x', email: 'nope' } })).statusCode, 400, 'bad lead email rejected');

  console.log('security: all assertions passed (auth bypass, IDOR, privilege escalation, cross-user delete, input hardening)');
}

// ---------- 2026-09 audit regressions ----------
// Every assertion below reproduces an exploit that WORKED against this code.
// They exist so the same door cannot be reopened quietly.
{
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  // A real allow-list, which is what made the case-collision reachable.
  const app = await buildApp(designs, auth, templates, { staticDir: process.cwd(), adminUsernames: ['admin', 'chief_r'], aiAdminPassword: 'case admin password' });
  const signUp = (username: string, adminPassword?: string, unlock?: string) => app.inject({
    method: 'POST', url: '/api/auth/register',
    ...(unlock ? { headers: { 'x-ai-unlock': unlock } } : {}),
    payload: { username, password: 'quartz-lantern-echo7', email: `${username.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.test`, acceptedVersion: 'test', ...(adminPassword !== undefined ? { adminPassword } : {}) },
  });

  // 0. HIGH was (October 2026, live): ADMIN_USERNAMES named an account nobody
  //    had registered, and admin rights follow the name, so whoever signed up
  //    with it first was a moderator. An allow-listed name is now reserved:
  //    sign-up refuses it like a taken name unless the request carries the
  //    admin password (round five: the admin-password SESSION is not enough).
  assert.equal((await signUp('admin')).statusCode, 409, 'an unclaimed admin name cannot be signed up for');
  assert.equal((await signUp('admin', 'some other password')).statusCode, 409, 'nor with another password');
  assert.equal((await signUp('admin', undefined, mintUnlock('case admin password'))).statusCode, 409, 'nor with a valid admin-password session alone');
  assert.equal(await auth.getUserByName('admin'), null, 'and nothing was created');
  const claimed = await signUp('admin', 'case admin password');
  assert.equal(claimed.statusCode, 201, `the admin password claims it (${claimed.body})`);
  const adminTok = (claimed.json() as { token: string }).token;
  assert.equal(((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(adminTok) })).json() as { isAdmin: boolean }).isAdmin, true, 'and it is the admin');
  // Renaming onto it is claiming it too, and takes the same proof. In practice
  // it is the operator's way in: sign-up derives the name from the email.
  const renamer = await reg(app, 'renamer');
  const rename = (adminPassword?: string, unlock?: string) => app.inject({ method: 'POST', url: '/api/account/username', headers: { ...bearer(renamer.token), ...(unlock ? { 'x-ai-unlock': unlock } : {}) }, payload: { username: 'chief_r', ...(adminPassword !== undefined ? { adminPassword } : {}) } });
  assert.equal((await rename()).statusCode, 409, 'an account cannot rename onto an unclaimed admin name');
  assert.equal((await rename('some other password')).statusCode, 409, 'nor with another password');
  assert.equal((await rename(undefined, mintUnlock('case admin password'))).statusCode, 409, 'nor with a valid admin-password session alone');
  assert.equal((await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(renamer.token), payload: { username: 'Chief_R', adminPassword: 'case admin password' } })).statusCode, 409, 'nor onto a lookalike with the password');
  assert.equal((await rename('case admin password')).statusCode, 200, 'the admin password can');
  assert.equal(((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(renamer.token) })).json() as { isAdmin: boolean }).isAdmin, true, 'and the renamed account is the admin');
  const noPwApp = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), new MemoryAuthRepository(), templates, { staticDir: process.cwd(), adminUsernames: ['admin'], aiAdminPassword: '' });
  const noPw = await noPwApp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'admin', password: 'quartz-lantern-echo7', email: 'x@example.test', acceptedVersion: 'test', adminPassword: '' } });
  assert.equal(noPw.statusCode, 409, 'with no admin password configured, the name stays reserved outright');
  await noPwApp.close();

  // 1. CRITICAL was: usernames are unique case-SENSITIVELY, but the admin
  //    allow-list matched case-INSENSITIVELY, so "Admin" registered beside the
  //    real "admin" and inherited moderator in one unauthenticated request.
  const lookalike = await signUp('Admin');
  assert.equal(lookalike.statusCode, 409, 'a username that case-folds onto an admin name is refused');
  assert.equal((await signUp('ADMIN', mintUnlock('case admin password'))).statusCode, 409, 'even from an admin-password session');
  const plain = await reg(app, 'nobody');
  assert.equal(
    ((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(plain.token) })).json() as { isAdmin: boolean }).isAdmin,
    false,
    'an ordinary account is not admin',
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: bearer(plain.token) })).statusCode,
    403,
    'moderation stays shut to non-admins',
  );

  // 2. CRITICAL was: String.replace expands $' in the replacement, and a design
  //    title reaches the injected <meta> block. A 400-byte title returned a
  //    31.6MB page; a 20KB one took the process out.
  const owner = await reg(app, 'titler');
  const dollarId = await makeDesign(app, owner.token, true);
  await app.inject({ method: 'PATCH', url: `/api/designs/${dollarId}`, headers: bearer(owner.token), payload: { title: "$'".repeat(60) } });
  const page = await app.inject({ method: 'GET', url: `/d/${dollarId}` });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.length < 200_000, `no dollar-expansion amplification (got ${page.body.length} bytes)`);

  // 3. Titles are bounded on EVERY write path, not just PATCH.
  const long = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title: 'x'.repeat(5000), templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
  assert.equal(long.statusCode, 400, 'an oversized title is refused at create');
  const forked = await app.inject({ method: 'POST', url: `/api/designs/${dollarId}/fork`, headers: bearer(owner.token), payload: { title: 'y'.repeat(5000) } });
  assert.ok((forked.json() as { title: string }).title.length <= 120, 'fork truncates the title');

  // 4. Photos on a PRIVATE design were world-readable while the design 404'd.
  const secret = await makeDesign(app, owner.token, false);
  // A small but well-formed JPEG (SOI, JFIF, one scan, EOI): since round three
  // the server refuses bytes that are not an image it can strip.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(1024, 3), Buffer.from([0xff, 0xd9]),
  ]).toString('base64');
  await auth.markEmailVerified(owner.id); // photos need a verified email (round five)
  const up = await app.inject({ method: 'POST', url: `/api/designs/${secret}/photos`, headers: bearer(owner.token), payload: { imageB64: jpeg, caption: 'venue, date, opponent' } });
  assert.equal(up.statusCode, 200, 'the owner can still attach a photo');
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${secret}` })).statusCode, 404, 'the design is hidden');
  assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${secret}/photos` })).statusCode, 404, 'and so are its photos');
  const ownerList = (await app.inject({ method: 'GET', url: `/api/designs/${secret}/photos`, headers: bearer(owner.token) })).json() as { id: string }[];
  assert.equal(ownerList.length, 1, 'the owner still sees their own photos');
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/photos/${ownerList[0].id}` })).statusCode,
    404,
    'the raw bytes are not served to anonymous callers either',
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/photos/${ownerList[0].id}`, headers: bearer(owner.token) })).statusCode,
    200,
    'the owner can still fetch their own photo bytes',
  );

  // 5. Registration was an email-enumeration oracle: a distinct "email already
  //    in use" told an anonymous caller which addresses had accounts.
  const known = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'titler', password: 'quartz-lantern-echo7', email: 'titler@example.test', acceptedVersion: 'test' } });
  const unknown = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'titler', password: 'quartz-lantern-echo7', email: 'nobody@example.test', acceptedVersion: 'test' } });
  assert.equal(known.statusCode, 409);
  assert.equal(unknown.statusCode, 409);
  assert.equal(known.body, unknown.body, 'registration cannot be used to test whether an email exists');

  // 6. A repeated query parameter arrives as an array and used to 500.
  assert.equal((await app.inject({ method: 'GET', url: '/api/gallery?search=a&search=b' })).statusCode, 200, 'a duplicated query param is handled, not a 500');

  // 7. Email links must never follow a forged Host header.
  const captured: string[] = [];
  const mailAuth = new MemoryAuthRepository();
  const mailApp = await buildApp(new MemoryDesignRepository((id) => mailAuth.usernameOf(id)), mailAuth, templates, {
    emailSender: { async send(msg: { to: string; subject: string; html?: string; text?: string }) { captured.push(`${msg.html ?? ''}${msg.text ?? ''}`); } },
  });
  await mailApp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'mailer', password: 'quartz-lantern-echo7', email: 'mailer@example.test', acceptedVersion: 'test' } });
  captured.length = 0;
  await mailApp.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'mailer@example.test' }, headers: { host: 'evil.attacker.test' } });
  await mailApp.drainBackground(); // the reset email is sent after the reply (round three)
  assert.ok(captured.length > 0, 'a reset email was sent');
  assert.ok(!captured[0].includes('evil.attacker.test'), 'the reset link does not follow a forged Host header');

  console.log('audit regressions: all assertions passed (admin case-collision, $-expansion DoS, title bounds, private photos, email enumeration, query arrays, Host-forged reset links)');

}

// ---------- 2026-09 audit, round two ----------
//
// The findings the first pass left open, each one reproduced the same way the
// first pass reproduced its own: assert the attack FAILS, not that the code
// looks right.
{
  const { scryptSync, createHmac } = await import('node:crypto');
  const { hashPassword, verifyPassword, SCRYPT_PARAMS } = await import('../src/auth');
  const { verifyUnlock } = await import('../src/aiRoutes');
  const { configWarnings } = await import('../src/preflight');
  const { escapeHtml } = await import('../../src/core/escape');
  const { MemoryAiUsageRepository } = await import('../src/memoryRepo');

  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const leads = new MemoryLeadsRepository();
  process.env.AI_ADMIN_PASSWORD = 'correct horse battery staple';
  // aiUsage is what registers the AI routes, and /api/ai/unlock is one of them.
  const app = await buildApp(designs, auth, templates, { social, leads, aiUsage: new MemoryAiUsageRepository() });

  // ---- MEDIUM: the login timing oracle ----
  // A missing account used to short-circuit in ~0.3 ms against ~35 ms for a real
  // one. The bodies were always identical; the clock was the oracle. Medians of
  // three, because one sample on a busy machine proves nothing either way.
  await reg(app, 'timing_alice');
  const timeLogin = async (username: string): Promise<number> => {
    const t0 = process.hrtime.bigint();
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'definitely wrong' } });
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const median = async (u: string): Promise<number> => {
    const runs = [await timeLogin(u), await timeLogin(u), await timeLogin(u)].sort((a, b) => a - b);
    return runs[1];
  };
  const realMs = await median('timing_alice');
  const missingMs = await median('nobody_has_this_name_at_all');
  assert.ok(
    missingMs > realMs / 3,
    `a missing account must not answer faster than a real one: ${missingMs.toFixed(0)}ms vs ${realMs.toFixed(0)}ms`,
  );

  // ---- MEDIUM: scrypt cost, and upgrading in place ----
  const fresh = await hashPassword('quartz-lantern-echo7');
  assert.match(fresh, /^s2:\d+:\d+:\d+:[0-9a-f]{32}:[0-9a-f]{64}$/, 'a new hash records the parameters it was made with');
  assert.ok(SCRYPT_PARAMS.N >= 65536, 'scrypt N is at or above the raised floor');
  assert.equal((await verifyPassword('quartz-lantern-echo7', fresh)).ok, true);
  assert.equal((await verifyPassword('wrong', fresh)).ok, false);
  assert.equal((await verifyPassword('quartz-lantern-echo7', fresh)).needsRehash, false, 'a current hash does not need rehashing');

  // A hash in the old unprefixed form still verifies — nobody is locked out —
  // and is flagged for upgrade.
  const legacySalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const legacy = `${legacySalt.toString('hex')}:${scryptSync('quartz-lantern-echo7', legacySalt, 32).toString('hex')}`;
  const legacyCheck = await verifyPassword('quartz-lantern-echo7', legacy);
  assert.equal(legacyCheck.ok, true, 'an old hash still verifies');
  assert.equal(legacyCheck.needsRehash, true, 'and is marked for upgrade');
  assert.equal((await verifyPassword('wrong', legacy)).needsRehash, false, 'a wrong password never triggers a rehash');

  // And the upgrade actually happens, on the one occasion the password is in
  // the clear: a successful sign-in.
  const bob = await reg(app, 'rehash_bob');
  await auth.setPasswordHash(bob.id, legacy);
  assert.equal((await auth.getUserById(bob.id))!.passwordHash, legacy);
  const relog = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'rehash_bob', password: 'quartz-lantern-echo7' } });
  assert.equal(relog.statusCode, 200, 'the old password still signs in');
  const after = (await auth.getUserById(bob.id))!.passwordHash!;
  assert.ok(after.startsWith('s2:'), 'and the stored hash was upgraded in place');
  assert.equal((await verifyPassword('quartz-lantern-echo7', after)).ok, true, 'the upgraded hash still matches the same password');

  // A stored row must not be able to ask for an unbounded allocation.
  assert.equal((await verifyPassword('x', 's2:1073741824:8:1:aa:bb')).ok, false, 'an absurd N in the stored hash is refused, not honoured');

  // ---- MEDIUM: the unlock token's key ----
  const pw = 'correct horse battery staple';
  const unlockRes = await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: pw } });
  assert.equal(unlockRes.statusCode, 200);
  const unlockToken = unlockRes.json().token as string;
  assert.equal(verifyUnlock(pw, unlockToken), true, 'a freshly issued token verifies');
  assert.equal(verifyUnlock('some other password', unlockToken), false);

  // The whole finding: the key used to BE the password, so one token recovered
  // it offline. A token signed with the raw password must no longer verify.
  const exp = Date.now() + 60_000;
  const jti = 'aabbccddeeff001122';
  const rawKeyed = `v2.${exp}.${jti}.${createHmac('sha256', pw).update(`ai-admin:${exp}:${jti}`).digest('hex')}`;
  assert.equal(verifyUnlock(pw, rawKeyed), false, 'the admin password is no longer the HMAC key');

  // Old-format tokens are refused rather than grandfathered.
  const oldFormat = `${exp}.${createHmac('sha256', pw).update(`ai-admin:${exp}`).digest('hex')}`;
  assert.equal(verifyUnlock(pw, oldFormat), false, 'a pre-derivation token is refused');

  // And the TTL is actually bounded: a token claiming to last a year is not
  // honoured even if it were correctly signed.
  const far = Date.now() + 365 * 24 * 3600 * 1000;
  assert.equal(verifyUnlock(pw, `v2.${far}.${jti}.deadbeef`), false, 'an expiry beyond the TTL horizon is refused');
  assert.equal(verifyUnlock(pw, `v2.${Date.now() - 1000}.${jti}.deadbeef`), false, 'an expired token is refused');

  // ---- STILL WORTH DOING #5: the /admin shell ----
  const cookieHeader = unlockRes.headers['set-cookie'];
  const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : String(cookieHeader ?? '');
  assert.match(cookie, /^tm_admin=/, 'unlocking sets the admin cookie');
  assert.match(cookie, /HttpOnly/, 'which script cannot read back');
  assert.match(cookie, /SameSite=Strict/, 'and which never leaves this site');

  const jsAnon = await app.inject({ method: 'GET', url: '/admin.js' });
  assert.equal(jsAnon.statusCode, 404, 'the dashboard module is not public');
  const jsAuthed = await app.inject({ method: 'GET', url: '/admin.js', headers: { cookie: cookie.split(';')[0] } });
  assert.equal(jsAuthed.statusCode, 200, 'and is served to an unlocked browser');
  assert.ok(jsAuthed.body.includes('/api/admin/'), 'the module really does carry the endpoint map that was being given away');

  const shellAnon = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(shellAnon.statusCode, 200, 'the shell still loads, or nobody could sign in');
  assert.ok(!shellAnon.body.includes('src="/admin.js"'), 'but it does not point at the module');
  assert.ok(shellAnon.body.includes('src="/admin-unlock.js"'), 'it points at the password form instead');
  const shellAuthed = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: cookie.split(';')[0] } });
  assert.ok(shellAuthed.body.includes('src="/admin.js"'), 'an unlocked browser gets the module');
  // Ordering is the mechanism that stops both modules binding the same form.
  assert.ok(
    shellAuthed.body.indexOf('src="/admin.js"') < shellAuthed.body.indexOf('src="/admin-unlock.js"'),
    'the dashboard module runs before the unlock module, so the unlock module can stand down',
  );
  assert.equal((await app.inject({ method: 'GET', url: '/admin-unlock.js' })).statusCode, 200, 'the password form is always reachable');
  const signedOut = await app.inject({ method: 'DELETE', url: '/api/ai/unlock' });
  assert.equal(signedOut.statusCode, 204);
  assert.match(String(signedOut.headers['set-cookie']), /Max-Age=0/, 'signing out clears the cookie');

  // ---- LOW: comments on private designs ----
  const owner = await reg(app, 'comment_owner');
  const stranger = await reg(app, 'comment_stranger');
  const priv = await makeDesign(app, owner.token, false);
  const pub = await makeDesign(app, owner.token, true);

  const postPriv = await app.inject({ method: 'POST', url: `/api/designs/${priv}/comments`, headers: bearer(stranger.token), payload: { body: 'hello' } });
  assert.equal(postPriv.statusCode, 404, 'a stranger cannot comment on a private design');
  const readPriv = await app.inject({ method: 'GET', url: `/api/designs/${priv}/comments` });
  assert.equal(readPriv.statusCode, 404, 'nor read its thread back anonymously');
  const ownerReads = await app.inject({ method: 'GET', url: `/api/designs/${priv}/comments`, headers: bearer(owner.token) });
  assert.equal(ownerReads.statusCode, 200, 'the owner still can');
  const postPub = await app.inject({ method: 'POST', url: `/api/designs/${pub}/comments`, headers: bearer(stranger.token), payload: { body: 'nice' } });
  assert.equal(postPub.statusCode, 201, 'and a public design still takes comments');

  // ---- LOW: ids that are not ids ----
  const badReport = await app.inject({ method: 'POST', url: '/api/report', payload: { targetType: 'design', targetId: 'not-a-uuid', reason: 'spam' } });
  assert.equal(badReport.statusCode, 400, 'a malformed id is a bad request, not a server error');
  const badFollow = await app.inject({ method: 'POST', url: '/api/users/not-a-uuid/follow', headers: bearer(stranger.token) });
  assert.equal(badFollow.statusCode, 400);
  const badUnfollow = await app.inject({ method: 'DELETE', url: '/api/users/not-a-uuid/follow', headers: bearer(stranger.token) });
  assert.equal(badUnfollow.statusCode, 400);
  const goodFollow = await app.inject({ method: 'POST', url: `/api/users/${owner.id}/follow`, headers: bearer(stranger.token) });
  assert.equal(goodFollow.statusCode, 200, 'a real id still works');

  // ---- LOW: escapeHtml and quotes ----
  assert.equal(escapeHtml(`a"b'c<d>e&f`), 'a&quot;b&#39;c&lt;d&gt;e&amp;f', 'quotes are escaped, so an attribute cannot be closed early');
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = `${dir}/${n}`;
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  const copies = walk('src').filter((f) => f !== 'src/core/escape.ts' && /function escapeHtml|function escapeAttr|function escapeHtmlLocal/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(copies, [], 'there is one escapeHtml, so the next one is an import');

  // ---- the boot-time config report ----
  const quiet = configWarnings({ NODE_ENV: 'development', AI_ADMIN_PASSWORD: 'x' } as NodeJS.ProcessEnv);
  assert.deepEqual(quiet, [], 'a configured dev box says nothing');
  const prodBare = configWarnings({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).map((w) => w.key);
  assert.deepEqual(
    prodBare.sort(),
    ['AI_ADMIN_PASSWORD', 'AI_POLLINATIONS_KEY', 'PUBLIC_URL', 'RESEND_API_KEY', 'SECURITY_ALERT_TO', 'TRUST_PROXY'],
    'production names what it was not told',
  );
  const silentPortraits = configWarnings({ AI_IMAGE_PROVIDER: 'gemini', AI_ADMIN_PASSWORD: 'x' } as NodeJS.ProcessEnv);
  assert.equal(silentPortraits.length, 1, 'gemini with no key is reported');
  assert.match(silentPortraits[0].effect, /face missing/, 'and says what it will actually look like');
  assert.deepEqual(
    configWarnings({ AI_IMAGE_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', AI_ADMIN_PASSWORD: 'x' } as NodeJS.ProcessEnv),
    [],
    'gemini with a key is fine',
  );
  // Unset is the safe default (Pollinations), so it must NOT warn — a warning
  // nobody needs to act on is how people learn to skip the whole block.
  assert.deepEqual(configWarnings({ AI_ADMIN_PASSWORD: 'x' } as NodeJS.ProcessEnv), [], 'an unset image provider is the free default, not a fault');

  delete process.env.AI_ADMIN_PASSWORD;
  console.log('audit round two: all assertions passed (login timing, scrypt cost + in-place upgrade, derived unlock key, gated /admin.js, private comments, id validation, one escapeHtml, boot config report)');
}

// ---------- 2026-09 audit, round three ----------
//
// A full pass over the server, the client, the dependencies and the deployment.
// Same standard as the earlier rounds: each block below is an attack that
// worked against the code before this round, asserted to fail now.
{
  const { stripImageMetadata, sniffImage } = await import('../src/imageMeta');
  const { proxyModeFrom, trustProxyFor, viaCloudflare, isCloudflareAddress } = await import('../src/proxyTrust');
  const { redactUrl } = await import('../src/routes');
  const { ADMIN_JS } = await import('../src/adminPage');
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const Fastify = (await import('fastify')).default;

  // An email sender that behaves like a real provider: it takes time.
  const sent: { to: string; subject: string; html: string; text?: string }[] = [];
  const slowSender = {
    async send(m: { to: string; subject: string; html: string; text?: string }): Promise<void> {
      await new Promise((r) => setTimeout(r, 150));
      sent.push(m);
    },
  };
  const logLines: string[] = [];
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const { MemoryFeedbackRepository } = await import('../src/feedbackRepo');
  const app = await buildApp(designs, auth, templates, {
    staticDir: process.cwd(),
    feedback: new MemoryFeedbackRepository(),
    emailSender: slowSender,
    logger: true,
    logStream: { write: (line: string) => { logLines.push(line); } },
    verifyResendCooldownMs: 0,
  });

  // ---- HIGH: anonymous CPU exhaustion through the PDF title ----
  // The one uncapped string on an unauthenticated route: pdfkit flowed it across
  // pages synchronously. 60 KB held the only event loop for 6.2 s.
  {
    const exportWith = async (title: string): Promise<{ status: number; ms: number; pages: number }> => {
      const started = Date.now();
      const pdf = await app.inject({
        method: 'POST', url: '/api/export/pdf',
        payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 },
      });
      const pages = (pdf.rawPayload.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
      return { status: pdf.statusCode, ms: Date.now() - started, pages };
    };
    await exportWith('warm-up'); // the first export loads fonts and compiles; that is not the title's cost
    const normal = await exportWith('Derby day');
    const long = await exportWith('W'.repeat(60_000));
    assert.equal(long.status, 200, 'the export still works');
    assert.equal(long.pages, normal.pages, `a long title adds no pages (${long.pages} vs ${normal.pages})`);
    assert.ok(long.ms < Math.max(1500, normal.ms * 4), `a 60 KB title no longer stalls the server (${long.ms} ms vs ${normal.ms} ms for a normal one)`);
  }

  // ---- MEDIUM: 500s repeated the error's own message ----
  {
    const leaky = designs as unknown as { popularTags: () => Promise<never> };
    const original = leaky.popularTags;
    leaky.popularTags = async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key" DETAIL: Key (email)=(ceo@club.example) already exists'), { code: '23505' });
    };
    const r = await app.inject({ method: 'GET', url: '/api/tags' });
    leaky.popularTags = original;
    assert.equal(r.statusCode, 500);
    assert.doesNotMatch(r.body, /duplicate key|users_email_key|ceo@club|23505/, 'no driver message, constraint name or someone else\'s email in the body');
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"username":' });
    assert.equal(bad.statusCode, 400, 'a deliberate client error keeps its status');
    assert.match(bad.body, /FST_ERR_CTP_INVALID_JSON_BODY/, '...and its explanation');
  }

  // ---- MEDIUM: one-time tokens in the request log ----
  {
    await app.inject({ method: 'GET', url: '/reset?token=RESETSECRET0123456789' });
    await app.inject({ method: 'GET', url: '/api/auth/verify?token=VERIFYSECRET0123456789' });
    const joined = logLines.join('');
    assert.ok(joined.includes('/api/auth/verify'), 'requests are still logged');
    assert.doesNotMatch(joined, /RESETSECRET|VERIFYSECRET/, 'but the tokens in them are not');
    assert.equal(redactUrl('/reset?token=abc&lang=ar'), '/reset?token=[redacted]&lang=ar');
    assert.equal(redactUrl('/community?search=token'), '/community?search=token', 'a word in a search is not a secret');
    const resetPage = readFileSync('src/reset.ts', 'utf8');
    assert.match(resetPage, /history\.replaceState\(/, 'the reset page takes the token out of the address bar');

    // With no RESEND_API_KEY in production the console sender "delivers" mail by
    // printing it, one-time code and reset link included, into the same log.
    const { ConsoleEmailSender } = await import('../src/email');
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
    try {
      const msg = { to: 'fan@example.test', subject: 'Reset your TifoMaker password', html: '<a href="https://tifomaker.org/reset?token=PRODSECRET42">reset</a>', text: 'https://tifomaker.org/reset?token=PRODSECRET42 code: 918273' };
      await new ConsoleEmailSender(true).send(msg);
      await new ConsoleEmailSender(false).send(msg);
    } finally {
      console.log = realLog;
    }
    assert.match(printed[0], /fan@example\.test/, 'production still records who a message was for');
    assert.doesNotMatch(printed[0], /PRODSECRET42|918273/, 'but not the link or the code');
    assert.match(printed[1], /PRODSECRET42/, 'development keeps the whole message, which the e2e tests read');
  }

  // ---- MEDIUM: reset mail as an enumeration oracle, and as a mail bomb ----
  {
    await reg(app, 'known_member');
    const time = async (email: string): Promise<number> => {
      const t0 = process.hrtime.bigint();
      await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email } });
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await time('known_member@example.test'));
      unknown.push(await time(`nobody${i}@example.test`));
    }
    await app.drainBackground();
    assert.ok(Math.abs(median(known) - median(unknown)) < 60, `forgot answers in the same time either way (${median(known).toFixed(1)} vs ${median(unknown).toFixed(1)} ms)`);
    const toKnown = sent.filter((m) => m.to === 'known_member@example.test' && /Reset/.test(m.subject));
    assert.equal(toKnown.length, 1, `five requests in a row mail the address once, not five times (got ${toKnown.length})`);
  }

  // ---- MEDIUM: a signed-in account mailing strangers through "change email" ----
  {
    const attacker = await reg(app, 'mailer_attacker');
    const before = sent.filter((m) => m.to === 'victim@example.test').length;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const target = i % 2 === 0 ? 'victim@example.test' : `decoy${i}@example.test`;
      statuses.push((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(attacker.token), payload: { email: target, password: 'quartz-lantern-echo7' } })).statusCode);
    }
    const toVictim = sent.filter((m) => m.to === 'victim@example.test').length - before;
    assert.equal(toVictim, 1, `alternating addresses still reaches the victim once a minute at most (got ${toVictim})`);
    assert.ok(statuses.includes(429), `the repeats are refused, not silently sent (${statuses.join(',')})`);

    // The same route answers 409 for an address that already has an account.
    // Those answers used to be free, so one account could test a whole mailing
    // list. Each now costs one of the account's ten daily emails.
    await auth.createUser('listed_member', 'not-a-real-hash', { email: 'listed@example.test', acceptedVersion: null });
    const prober = await reg(app, 'email_prober'); // the signup email is one of the ten
    const probes: number[] = [];
    for (let i = 0; i < 12; i++) {
      probes.push((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(prober.token), payload: { email: 'listed@example.test', password: 'quartz-lantern-echo7' } })).statusCode);
    }
    assert.equal(probes.filter((c) => c === 409).length, 9, `nine lookups, then the account is out of allowance (${probes.join(',')})`);
    assert.equal(probes.at(-1), 429);
  }

  // ---- LOW: unlimited codes per day made code guessing a matter of time ----
  {
    const guesser = await reg(app, 'code_guesser');
    let accepted = 0;
    for (let i = 0; i < 15; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: bearer(guesser.token) });
      if (r.statusCode === 202) accepted++;
    }
    // The signup message counts too: ten in a day, so 50 guesses, not 7,200.
    assert.equal(accepted, 9, `nine resends after the signup email, then the daily cap (got ${accepted})`);
  }

  // ---- LOW/MEDIUM: photo GPS metadata served to anyone ----
  {
    const u8 = (...parts: (number[] | string)[]): Buffer =>
      Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
    const seg = (marker: number, payload: Buffer): Buffer => {
      const h = Buffer.from([0xff, marker, 0, 0]);
      h.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([h, payload]);
    };
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe0, u8('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0])),
      seg(0xe1, u8('Exif\0\0', 'GPSLatitude 24.713552 GPSLongitude 46.675297')),
      seg(0xed, u8('Photoshop 3.0\0', 'IPTC by-line: A Supporter')),
      seg(0xfe, u8('taken at home')),
      seg(0xdb, Buffer.alloc(65, 1)),
      seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
      seg(0xc4, Buffer.alloc(29, 0)),
      seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
      Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
      Buffer.from([0xff, 0xd9]),
    ]);
    const cleanJpeg = stripImageMetadata(jpeg)!;
    assert.ok(cleanJpeg, 'a JPEG parses');
    assert.doesNotMatch(cleanJpeg.toString('latin1'), /Exif|GPS|Photoshop|IPTC|taken at home/, 'EXIF, IPTC and comments are gone');
    assert.match(cleanJpeg.toString('latin1'), /JFIF/, 'the JFIF header stays');
    assert.ok(cleanJpeg.subarray(-9).equals(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9])), 'scan data is untouched');

    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Buffer.alloc(13, 1)),
      chunk('tEXt', u8('Comment\0GPS 24.7135,46.6753')),
      chunk('eXIf', u8('MM\0*GPS')),
      chunk('IDAT', Buffer.alloc(10, 7)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const cleanPng = stripImageMetadata(png)!;
    assert.doesNotMatch(cleanPng.toString('latin1'), /GPS|Comment/, 'PNG text and EXIF chunks are gone');
    assert.match(cleanPng.toString('latin1'), /IHDR[\s\S]*IDAT[\s\S]*IEND/, 'the image chunks stay, in order');

    const riff = (fourcc: string, data: Buffer): Buffer => {
      const h = Buffer.alloc(8);
      h.write(fourcc, 0, 'latin1');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const webpBody = Buffer.concat([
      riff('VP8X', Buffer.from([0x08 | 0x04 | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      riff('VP8L', Buffer.alloc(12, 3)),
      riff('EXIF', u8('GPSLatitude 24.71')),
      riff('XMP ', u8('<x:xmpmeta>GPS</x:xmpmeta>')),
    ]);
    const webpHead = Buffer.alloc(12);
    webpHead.write('RIFF', 0, 'latin1');
    webpHead.writeUInt32LE(4 + webpBody.length, 4);
    webpHead.write('WEBP', 8, 'latin1');
    const cleanWebp = stripImageMetadata(Buffer.concat([webpHead, webpBody]))!;
    assert.doesNotMatch(cleanWebp.toString('latin1'), /GPS|xmpmeta/, 'WebP EXIF and XMP chunks are gone');
    assert.equal(cleanWebp[20] & 0x0c, 0, 'and VP8X no longer claims to have them');
    assert.equal(cleanWebp[20] & 0x10, 0x10, 'other flags are kept');
    assert.equal(cleanWebp.readUInt32LE(4), cleanWebp.length - 8, 'the RIFF size is rewritten');
    assert.equal(sniffImage(Buffer.from('<svg onload=alert(1)>')), null);

    // Through the real route: what anyone can download is the clean copy.
    const owner = await reg(app, 'photo_owner');
    await auth.markEmailVerified(owner.id); // photos need a verified email (round five)
    const designId = await makeDesign(app, owner.token, true);
    const html = await app.inject({ method: 'POST', url: `/api/designs/${designId}/photos`, headers: bearer(owner.token), payload: { imageB64: Buffer.from('<html><script>x</script></html>').toString('base64') } });
    assert.equal(html.statusCode, 400, 'a file that is not an image is refused');
    const up = await app.inject({ method: 'POST', url: `/api/designs/${designId}/photos`, headers: bearer(owner.token), payload: { imageB64: jpeg.toString('base64'), caption: 'derby' } });
    assert.equal(up.statusCode, 200);
    const served = await app.inject({ method: 'GET', url: `/api/photos/${up.json().photoId}` });
    assert.equal(served.statusCode, 200);
    assert.doesNotMatch(served.rawPayload.toString('latin1'), /GPS|Exif/, 'the served photo carries no location');
  }

  // ---- LOW: "$&" in a title rewrote the pages that list it ----
  {
    const owner = await reg(app, 'dollar_amp');
    const id = await makeDesign(app, owner.token, true);
    await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(owner.token), payload: { title: 'Ultras $& Co' } });
    const community = await app.inject({ method: 'GET', url: '/community' });
    assert.equal(community.statusCode, 200);
    assert.equal((community.body.match(/id="grid-loading"/g) ?? []).length, 1, 'one loader on /community, not one per "$&"');
    assert.match(community.body, /Ultras \$&amp; Co/, 'the title appears as written');
    const page = await app.inject({ method: 'GET', url: `/d/${id}` });
    const title = /<title>([^<]*)<\/title>/.exec(page.body)?.[1] ?? '';
    assert.doesNotMatch(title, /head/, `the share title is the design's, not a copy of <head> (${title})`);
  }

  // ---- LOW: a feedback reply address that smuggles mail headers ----
  {
    const fb = await app.inject({
      method: 'POST', url: '/api/feedback',
      payload: { kind: 'bug', message: 'The save button does nothing', email: 'dev@example.com?bcc=attacker%40evil.example&body=send+your+password', elapsedMs: 5000 },
    });
    assert.equal(fb.statusCode, 400, 'an address with a query string is not an address');
    assert.doesNotMatch(ADMIN_JS, /href="mailto:' \+ esc\(/, 'the dashboard no longer builds reply links from raw addresses');
    assert.match(ADMIN_JS, /function mailtoHref\(/);
  }

  // ---- LOW: escapers that do not escape quotes, and a raw name in innerHTML ----
  {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = `${dir}/${n}`;
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    // Any local function or const whose body HTML-escapes: the &amp; table, or
    // the textContent-then-innerHTML trick that leaves quotes alone.
    const localEscapers = walk('src')
      .filter((f) => f !== 'src/core/escape.ts')
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /(?:function\s+\w*esc\w*\s*\(|const\s+\w*esc\w*\s*=)[^\n]*(?:\n[^\n]*){0,4}(?:&amp;|\.innerHTML)/i.test(src);
      });
    assert.deepEqual(localEscapers, [], 'every HTML escape is the shared, quote-safe one');
    assert.doesNotMatch(readFileSync('src/main.ts', 'utf8'), /innerHTML = `design fitted to \$\{template\.name\}/, 'stadium names are not written as HTML');
  }

  // ---- LOW: premium AI calls that skipped the daily budget ----
  {
    const aiSrc = readFileSync('server/src/aiRoutes.ts', 'utf8');
    const critique = aiSrc.slice(aiSrc.indexOf("app.post('/api/ai/critique'"), aiSrc.indexOf("app.post('/api/stadium/photo'"));
    const photo = aiSrc.slice(aiSrc.indexOf("app.post('/api/stadium/photo'"));
    assert.match(critique, /premiumExhausted\(\)[\s\S]*notePremiumCall\(\)/, 'the critic checks and spends the budget');
    assert.match(photo, /premiumExhausted\(\)[\s\S]*notePremiumCall\(samples\)/, 'each photo reading spends the budget');
  }

  // ---- MEDIUM (latent): TRUST_PROXY=2 behind Cloudflare trusted a forged hop ----
  // CLOUDFLARE.md told the operator to set TRUST_PROXY=2 when the orange cloud
  // goes on. Cloudflare does not stop anyone connecting to Railway directly, and
  // "2" believed the second hop whoever wrote it: a script that skipped
  // Cloudflare rotated a fake first X-Forwarded-For entry and was never limited.
  {
    const { configWarnings } = await import('../src/preflight');
    /** How many of 14 logins from ONE real address get past the 10-a-minute limit. */
    const loginsAllowed = async (trust: string, connectingHop: string): Promise<number> => {
      const saved = process.env.TRUST_PROXY;
      process.env.TRUST_PROXY = trust;
      const a = new MemoryAuthRepository();
      const probe = await buildApp(new MemoryDesignRepository((id) => a.usernameOf(id)), a, templates, { rateLimit: true });
      if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved;
      let allowed = 0;
      for (let i = 0; i < 14; i++) {
        const r = await probe.inject({
          method: 'POST', url: '/api/auth/login', remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}, ${connectingHop}` },
          payload: { username: 'nobody', password: 'wrong password' },
        });
        if (r.statusCode !== 429) allowed++;
      }
      await probe.close();
      return allowed;
    };
    // Straight to the origin, skipping Cloudflare, rotating a forged first entry.
    assert.equal(await loginsAllowed('cloudflare', '198.51.100.7'), 10, 'a hop that is not Cloudflare is not believed: one address, one bucket');
    // Through Cloudflare the entry before its hop is written by Cloudflare: real, distinct visitors.
    assert.equal(await loginsAllowed('cloudflare', '172.64.3.9'), 14, 'a real Cloudflare hop is believed');
    assert.ok(isCloudflareAddress('2606:4700::6810:84e5') && !isCloudflareAddress('8.8.8.8') && !isCloudflareAddress('::ffff:8.8.8.8'));

    const ipOf = async (mode: string | undefined, xff: string): Promise<string> => {
      const probe = Fastify({ trustProxy: trustProxyFor(proxyModeFrom(mode, 'production')) });
      probe.get('/ip', async (req) => ({ ip: req.ip }));
      const r = await probe.inject({ method: 'GET', url: '/ip', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': xff } });
      await probe.close();
      return r.json().ip;
    };
    assert.equal(await ipOf(undefined, '203.0.113.99, 198.51.100.7'), '198.51.100.7', 'Railway alone still trusts one hop');
    assert.equal(await ipOf('0', '203.0.113.99'), '10.0.0.5', 'TRUST_PROXY=0 uses the socket');
    assert.equal(await ipOf('cloudfare', '203.0.113.99, 198.51.100.7'), '198.51.100.7', 'a typo fails closed to one hop');
    assert.equal(viaCloudflare(proxyModeFrom('cloudflare', 'production'), '1.2.3.4, 104.16.0.1'), true);
    assert.equal(viaCloudflare(proxyModeFrom(undefined, 'production'), '1.2.3.4, 104.16.0.1'), false, 'CF-IPCountry is ignored unless Cloudflare mode is on');

    // The operator is told, in the guide and at boot.
    const guide = readFileSync('CLOUDFLARE.md', 'utf8');
    assert.doesNotMatch(guide, /^TRUST_PROXY=2\s*$/m, 'the Cloudflare guide no longer says TRUST_PROXY=2');
    assert.match(guide, /^TRUST_PROXY=cloudflare\s*$/m);
    const warnFor = (v: string) => configWarnings({ NODE_ENV: 'production', TRUST_PROXY: v } as NodeJS.ProcessEnv).find((w) => w.key === 'TRUST_PROXY');
    assert.equal(warnFor('2')?.state, 'wrong', 'TRUST_PROXY=2 is flagged at boot');
    assert.equal(warnFor('cloudfare')?.state, 'wrong', 'and so is a misspelling');
    assert.equal(warnFor('cloudflare'), undefined);
    assert.equal(warnFor('1'), undefined);
  }

  // ---- LOW (availability): every asset revalidated on every page view ----
  // /assets/* were served max-age=0, so each view of /community re-requested
  // 109 files and three views a minute tripped the 300-a-minute limit.
  {
    const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dist = mkdtempSync(`${tmpdir()}/tifo-static-`);
    for (const f of readdirSync('.').filter((n) => n.endsWith('.html'))) copyFileSync(f, `${dist}/${f}`);
    mkdirSync(`${dist}/assets`);
    writeFileSync(`${dist}/assets/community-Ab12Cd34.js`, 'export {}');
    writeFileSync(`${dist}/theme-boot.js`, '/* not hashed */');
    const a = new MemoryAuthRepository();
    const staticApp = await buildApp(new MemoryDesignRepository((id) => a.usernameOf(id)), a, templates, { staticDir: dist });
    const hashed = await staticApp.inject({ method: 'GET', url: '/assets/community-Ab12Cd34.js' });
    const plain = await staticApp.inject({ method: 'GET', url: '/theme-boot.js' });
    await staticApp.close();
    assert.equal(hashed.statusCode, 200);
    assert.match(String(hashed.headers['cache-control']), /max-age=31536000.*immutable/, 'hashed assets are cached for good');
    assert.equal(plain.statusCode, 200);
    assert.doesNotMatch(String(plain.headers['cache-control']), /immutable/, 'a file whose name does not change is not');
  }

  // ---- INFO: inline scripts the CSP blocks on every load ----
  {
    const pages = readdirSync('.').filter((f) => f.endsWith('.html'));
    const inline = pages.filter((f) => /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(readFileSync(f, 'utf8')));
    assert.deepEqual(inline, [], 'no page relies on an inline script the policy refuses to run');
  }


  // ---- PASSWORD POLICY: src/core/password.ts, and the three routes that set one ----
  //
  // The rules are NIST SP 800-63B rev 4 and OWASP ASVS 5.0 as they actually
  // read: a length floor, a blocklist, and NO composition rules. The tests that
  // matter most here are the last three — that an account made before this
  // policy still opens, that a refused password does not spend a reset link,
  // and that a long password is refused rather than quietly cut short.
  {
    const verdict = (pw: string, ctx?: { email?: string; username?: string }) => {
      const v = checkPassword(pw, ctx);
      return v.ok ? null : v.problem;
    };

    // The rule, on its own.
    assert.equal(verdict('short1'), 'short', 'under the minimum');
    assert.equal(verdict('x'.repeat(PASSWORD_MAX + 1)), 'long', 'over the maximum');
    assert.equal(verdict('   '.repeat(8)), 'blank', 'whitespace is not a password');
    assert.equal(verdict('123456789012'), 'digits', 'a keypad run');
    assert.equal(verdict('abcabcabcabc'), 'repeated', 'one unit typed four times');
    assert.equal(verdict('abcdefghijkl'), 'sequence', 'straight down the alphabet');
    // Folding: the blocklist has to catch the costume, not just the word.
    for (const dressed of ['password1234', 'Password2026!', 'P@ssw0rd1234', 'passwordpassword']) {
      assert.equal(verdict(dressed), 'common', `${dressed} is 'password' wearing a hat`);
    }
    // ASVS 6.2.11's context-specific words. On a tifo site, that is the clubs.
    for (const local of ['liverpoolfc!!', 'L1verp00l2026', 'halamadrid1234', 'tifomaker2026']) {
      assert.equal(verdict(local), 'common', `${local} is the first thing this audience types`);
    }
    // ...and the person's own identifiers (ASVS 6.2.11 again).
    assert.equal(verdict('osamah.fan.2026!', { email: 'osamah.fan@example.test' }), 'context', 'their own email');
    assert.equal(verdict('curvanorth-fan-77', { username: 'curvanorth' }), 'context', 'their own username');
    // No composition rules: a phrase of lower-case words and spaces is fine,
    // which is the whole point of dropping them.
    for (const good of ['the curva sings at midnight', 'coffee-table-lamp', 'arsenal-is-my-life-99', 'x7#Qm2vL9pR4']) {
      assert.equal(verdict(good), null, `${good} must be accepted`);
    }
    // What the "suggest" button hands people has to clear the bar it is
    // suggested against — every time, not usually.
    for (let i = 0; i < 500; i++) {
      const made = suggestPassphrase();
      assert.equal(verdict(made), null, `suggested password refused: ${made}`);
    }

    const GOOD = 'thistle-anchor-92x';
    const pwUser = 'pw_policy';
    const mail = `${pwUser}@example.test`;
    const register = (password: string, username = pwUser, email = mail) =>
      app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password, email, acceptedVersion: 'test' } });

    // Registration applies it, and says which rule was broken.
    for (const [password, code] of [
      ['elevenchars', 'password_short'],
      ['password1234', 'password_common'],
      [`${pwUser}-and-more`, 'password_context'],
      ['y'.repeat(PASSWORD_MAX + 1), 'password_long'],
    ] as const) {
      const r = await register(password);
      assert.equal(r.statusCode, 400, `register must refuse ${JSON.stringify(password.slice(0, 20))}`);
      assert.equal((r.json() as { code: string }).code, code, 'and say why');
    }
    const born = await register(GOOD);
    assert.equal(born.statusCode, 201, 'a good password registers');
    const pwToken = (born.json() as { token: string }).token;

    // Changing a password: ownership is proven FIRST, so a stale token cannot
    // be used to probe the blocklist for free.
    const wrongCurrent = await app.inject({
      method: 'POST', url: '/api/account/password', headers: bearer(pwToken),
      payload: { currentPassword: 'not-the-password-99', newPassword: 'password1234' },
    });
    assert.equal(wrongCurrent.statusCode, 401, 'a wrong current password answers 401, not a grading of the new one');
    const weakNext = await app.inject({
      method: 'POST', url: '/api/account/password', headers: bearer(pwToken),
      payload: { currentPassword: GOOD, newPassword: 'password1234' },
    });
    assert.equal(weakNext.statusCode, 400, 'the policy applies to a change, not only to sign-up');
    assert.equal((weakNext.json() as { code: string }).code, 'password_common');

    // An account created BEFORE this policy must still be able to sign in.
    // Nothing about raising the bar is worth locking out the people who
    // signed up first.
    const legacy = await auth.createUser('pw_legacy', await hashPassword('old8char'), { email: 'pw_legacy@example.test' });
    assert.ok(legacy, 'legacy account created');
    const legacyIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pw_legacy', password: 'old8char' } });
    assert.equal(legacyIn.statusCode, 200, 'an eight-character password from before the policy still signs in');

    // A refused new password must not spend the reset link. Someone who fat-
    // fingers the form should not have to go back and ask for another email.
    const resetSecret = 'reset-token-for-the-policy-test';
    await auth.createEmailToken(legacy!.id, hashToken(resetSecret), 'reset_password', new Date(Date.now() + 3600_000));
    const refused = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetSecret, newPassword: 'qwertyuiop12' } });
    assert.equal(refused.statusCode, 400, 'a weak new password is refused');
    const accepted = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetSecret, newPassword: 'pebble-saffron-40' } });
    assert.equal(accepted.statusCode, 200, 'and the same link still works on the second try');

    // ASVS 6.2.8: verified exactly as received. A password at the ceiling is
    // stored and matched whole; one character more is refused, not trimmed.
    // Deliberately not 'z9'.repeat(64): that is one unit typed sixty-four times,
    // which the policy refuses on its own merits. Stepping through the alphabet
    // by seven gives a string with no run, no repeat and no word in it.
    const ALPHA = 'abcdefghijkmnopqrstuvwxyz23456789';
    const long = Array.from({ length: PASSWORD_MAX }, (_, i) => ALPHA[(i * 7 + 3) % ALPHA.length]).join('');
    assert.equal(long.length, PASSWORD_MAX);
    assert.equal(verdict(long), null, 'the ceiling-length password is otherwise fine');
    assert.equal((await register(long, 'pw_long', 'pw_long@example.test')).statusCode, 201, 'the ceiling itself is allowed');
    const longIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pw_long', password: long } });
    assert.equal(longIn.statusCode, 200, 'and signs in whole');
    const truncated = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pw_long', password: long.slice(0, 72) } });
    assert.equal(truncated.statusCode, 401, 'a prefix of it is not the password');

    // NIST's NFC normalisation, which is the difference between the same Arabic
    // or accented password typed on two keyboards matching and not.
    const composed = 'café-lantern-river-7';
    const decomposed = 'café-lantern-river-7';
    assert.notEqual(composed, decomposed, 'the two spellings really are different strings');
    assert.equal((await register(decomposed, 'pw_nfc', 'pw_nfc@example.test')).statusCode, 201, 'a decomposed password registers');
    for (const [form, name] of [[composed, 'composed'], [decomposed, 'decomposed']] as const) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pw_nfc', password: form } });
      assert.equal(r.statusCode, 200, `the ${name} spelling signs in`);
    }
    assert.ok(PASSWORD_MIN >= 12, 'the floor has not been quietly lowered');
    console.log('password policy: all assertions passed (rules, folding, context, three routes, legacy sign-in, reset link not spent, no truncation, NFC)');
  }


  // ---- SIGN IN WITH GOOGLE: the round trip, and the linking rule ----
  //
  // The dangerous step in federated sign-in is not the crypto, it is deciding
  // which existing account an identity may be attached to. The row that matters
  // most below is `verify_first`: CVE-2026-53516 (Better Auth, CVSS 8.3) was
  // exactly this check, done on the provider's claim alone.
  {
    const realFetch = globalThis.fetch;
    let nextProfile: Record<string, unknown> | null = null;
    let tokenCalls = 0;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        tokenCalls++;
        return json({ access_token: 'stub-access-token' });
      }
      if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
        return nextProfile ? json(nextProfile) : json({ error: 'nope' }, 500);
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      const gAuth = new MemoryAuthRepository();
      const gDesigns = new MemoryDesignRepository((id) => gAuth.usernameOf(id));
      const gApp = await buildApp(gDesigns, gAuth, templates, {
        oauth: { google: { id: 'test-client-id', secret: 'test-client-secret' } },
      });

      const cookiesFrom = (res: { headers: Record<string, unknown> }): Map<string, string> => {
        const raw = res.headers['set-cookie'];
        const lines = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
        const out = new Map<string, string>();
        for (const line of lines) {
          const [pair] = line.split(';');
          const eq = pair!.indexOf('=');
          out.set(pair!.slice(0, eq), decodeURIComponent(pair!.slice(eq + 1)));
        }
        return out;
      };
      const cookieHeader = (jar: Map<string, string>): string =>
        [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

      /** Walk the whole flow and return the final redirect plus its cookies. */
      const signInWith = async (
        profile: Record<string, unknown>,
        opts: { returnTo?: string; claim?: boolean; bearer?: string; link?: boolean; password?: string } = {},
      ) => {
        const start = opts.link
          ? await gApp.inject({
              method: 'POST',
              url: `/api/account/link/google?returnTo=${encodeURIComponent(opts.returnTo ?? '/account')}`,
              headers: bearer(opts.bearer!),
              payload: opts.password ? { password: opts.password } : {},
            })
          : await gApp.inject({
              method: 'GET',
              url: `/api/auth/google?returnTo=${encodeURIComponent(opts.returnTo ?? '/app')}${opts.claim ? '&claim=1' : ''}`,
            });
        const jar = cookiesFrom(start);
        const authorize = opts.link ? (start.json() as { url: string }).url : String(start.headers.location);
        const state = new URL(authorize).searchParams.get('state')!;
        nextProfile = profile;
        const back = await gApp.inject({
          method: 'GET',
          url: `/api/auth/google/callback?code=stub-code&state=${encodeURIComponent(state)}`,
          headers: { cookie: cookieHeader(jar) },
        });
        return { start, authorize, state, back, backCookies: cookiesFrom(back) };
      };

      // ---- the outward leg
      const listed = await gApp.inject({ method: 'GET', url: '/api/auth/providers' });
      assert.deepEqual((listed.json() as { providers: string[] }).providers, ['google'], 'a configured provider is offered');

      const start = await gApp.inject({ method: 'GET', url: '/api/auth/google' });
      assert.equal(start.statusCode, 302);
      const consent = new URL(String(start.headers.location));
      assert.equal(consent.origin + consent.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.equal(consent.searchParams.get('scope'), 'openid email profile', 'non-sensitive scopes only: no verification review');
      assert.equal(consent.searchParams.get('code_challenge_method'), 'S256', 'PKCE, as RFC 9700 recommends even for a confidential client');
      assert.ok(consent.searchParams.get('code_challenge'), 'and a challenge to go with it');
      assert.ok(cookiesFrom(start).get('tm_oauth'), 'the state rides in a cookie, so it is bound to this browser');
      const pendingLine = (start.headers['set-cookie'] as string[]).find((l) => l.startsWith('tm_oauth='))!;
      assert.match(pendingLine, /HttpOnly/, 'script must not be able to read the state');
      assert.match(pendingLine, /SameSite=Lax/, 'Strict would withhold it on the callback and break every sign-in');

      // ---- a callback with nothing to match it against
      const noCookie = await gApp.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=x&state=${encodeURIComponent(consent.searchParams.get('state')!)}`,
      });
      assert.equal(noCookie.statusCode, 302);
      assert.match(String(noCookie.headers.location), /signin=failed&reason=state/, 'no pending cookie, no sign-in');

      // ---- a forged state
      const fresh = await gApp.inject({ method: 'GET', url: '/api/auth/google' });
      const forged = await gApp.inject({
        method: 'GET',
        url: '/api/auth/google/callback?code=x&state=not-the-one',
        headers: { cookie: cookieHeader(cookiesFrom(fresh)) },
      });
      assert.match(String(forged.headers.location), /reason=state/, 'a state that does not match the cookie is refused');

      // ---- a brand-new person
      const newcomer = await signInWith({ sub: 'g-new-1', email: 'newfan@example.test', email_verified: true, name: 'New Fan' });
      assert.equal(newcomer.back.statusCode, 302);
      assert.match(String(newcomer.back.headers.location), /^\/app\?signedin=google/, 'signed in, and the token is NOT in the URL');
      assert.doesNotMatch(String(newcomer.back.headers.location), /token/i, 'nothing token-shaped in the address bar');
      const handoff = newcomer.backCookies.get('tm_handoff');
      assert.ok(handoff, 'the session is handed over in a cookie instead');

      const adopted = await gApp.inject({
        method: 'POST',
        url: '/api/auth/handoff',
        headers: { cookie: `tm_handoff=${encodeURIComponent(handoff!)}` },
      });
      assert.equal(adopted.statusCode, 200);
      const newcomerToken = (adopted.json() as { token: string }).token;
      assert.ok(newcomerToken);
      // Spent, not merely cleared: a replay of the same cookie is dead.
      const replay = await gApp.inject({
        method: 'POST',
        url: '/api/auth/handoff',
        headers: { cookie: `tm_handoff=${encodeURIComponent(handoff!)}` },
      });
      assert.equal(replay.statusCode, 401, 'the handoff cookie works exactly once');

      const meNew = (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(newcomerToken) })).json() as {
        email: string;
        emailVerified: boolean;
        providers: string[];
        hasPassword: boolean;
        needsUsername: boolean;
      };
      assert.equal(meNew.email, 'newfan@example.test');
      assert.equal(meNew.emailVerified, true, 'Google verified it, so the inbox round trip is skipped');
      assert.deepEqual(meNew.providers, ['google']);
      assert.equal(meNew.hasPassword, false, 'no password was ever chosen');

      // ---- the handle is theirs to pick, and the wall says so
      //
      // A provider gives an email and no handle. Rather than stamping
      // `gfan1789865580969` on someone, the account is created wearing that as a
      // placeholder and held until its owner chooses. The wall is server-side
      // because a wall only in the browser is a suggestion.
      assert.equal(meNew.needsUsername, true, 'a Google account has not named itself yet');
      const walled = await gApp.inject({
        method: 'POST',
        url: '/api/designs',
        headers: bearer(newcomerToken),
        payload: { title: 'nope', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
      });
      assert.equal(walled.statusCode, 428, 'everything else is refused until a name is picked');
      assert.equal((walled.json() as { code: string }).code, 'needs_username');
      // ...but not the few things needed to get past it, or to leave.
      assert.equal(
        (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(newcomerToken) })).statusCode,
        200,
        'they can still find out who they are',
      );
      const badName = await gApp.inject({
        method: 'POST', url: '/api/account/username', headers: bearer(newcomerToken), payload: { username: 'no' },
      });
      assert.equal(badName.statusCode, 400, 'and the name still has to be a legal one');
      const named = await gApp.inject({
        method: 'POST', url: '/api/account/username', headers: bearer(newcomerToken), payload: { username: 'curva_north' },
      });
      assert.equal(named.statusCode, 200, 'picking one works');
      const afterNaming = (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(newcomerToken) })).json() as {
        username: string; needsUsername: boolean;
      };
      assert.equal(afterNaming.username, 'curva_north');
      assert.equal(afterNaming.needsUsername, false, 'and the wall comes down');
      assert.equal(
        (await gApp.inject({
          method: 'POST', url: '/api/designs', headers: bearer(newcomerToken),
          payload: { title: 'now', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 },
        })).statusCode,
        201,
        'the thing that was refused a moment ago now works',
      );

      // An account made with a password names itself, so it never sees any of this.
      const pwAccount = await gApp.inject({
        method: 'POST', url: '/api/auth/register',
        payload: { username: 'chose_own', password: 'thistle-anchor-92x', email: 'chose@example.test', acceptedVersion: 'test' },
      });
      const pwTok = (pwAccount.json() as { token: string }).token;
      assert.equal(
        ((await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(pwTok) })).json() as { needsUsername: boolean }).needsUsername,
        false,
        'someone who typed their own name is never asked again',
      );

      // ---- the same person again: one account, not two
      const again = await signInWith({ sub: 'g-new-1', email: 'newfan@example.test', email_verified: true });
      const againToken = (
        await gApp.inject({
          method: 'POST',
          url: '/api/auth/handoff',
          headers: { cookie: `tm_handoff=${encodeURIComponent(again.backCookies.get('tm_handoff')!)}` },
        })
      ).json() as { token: string };
      const meAgain = (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(againToken.token) })).json() as { id: string };
      assert.equal(meAgain.id, meNew ? (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(newcomerToken) })).json().id : '', 'same sub, same account');

      // ---- the identity is keyed on `sub`, not the address
      const renamed = await signInWith({ sub: 'g-new-1', email: 'moved@example.test', email_verified: true });
      const renamedTok = (
        await gApp.inject({
          method: 'POST',
          url: '/api/auth/handoff',
          headers: { cookie: `tm_handoff=${encodeURIComponent(renamed.backCookies.get('tm_handoff')!)}` },
        })
      ).json() as { token: string };
      assert.equal(
        ((await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(renamedTok.token) })).json() as { id: string }).id,
        meAgain.id,
        'a changed email still lands on the same account, because sub is the key',
      );

      // ---- CVE-2026-53516: the pre-registered, never-verified account
      const victimMail = 'victim@example.test';
      await gApp.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'victim_acct', password: 'thistle-anchor-92x', email: victimMail, acceptedVersion: 'test' },
      });
      const victim = (await gAuth.getUserByEmail(victimMail))!;
      assert.equal(victim.emailVerifiedAt, null, 'the attacker never verified it — that is the whole trick');
      const hijack = await signInWith({ sub: 'g-victim', email: victimMail, email_verified: true });
      assert.match(
        String(hijack.back.headers.location),
        /reason=verify_first/,
        'Google saying the address is verified is NOT enough to link to an unverified local account',
      );
      assert.equal(hijack.backCookies.get('tm_handoff'), undefined, 'and no session is handed out');
      assert.equal(await gAuth.getUserIdByIdentity('google', 'g-victim'), null, 'nothing was linked');

      // ---- the same thing, once the local account IS verified
      await gAuth.markEmailVerified(victim.id);
      const linkedOk = await signInWith({ sub: 'g-victim', email: victimMail, email_verified: true });
      const linkedTok = (
        await gApp.inject({
          method: 'POST',
          url: '/api/auth/handoff',
          headers: { cookie: `tm_handoff=${encodeURIComponent(linkedOk.backCookies.get('tm_handoff')!)}` },
        })
      ).json() as { token: string };
      assert.equal(
        ((await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(linkedTok.token) })).json() as { id: string }).id,
        victim.id,
        'both sides verified: now it links',
      );

      // ---- an unverified address from the provider never links either
      const strangerMail = 'stranger@example.test';
      await gApp.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'stranger_acct', password: 'pebble-saffron-40', email: strangerMail, acceptedVersion: 'test' },
      });
      const stranger = (await gAuth.getUserByEmail(strangerMail))!;
      await gAuth.markEmailVerified(stranger.id);
      const unverified = await signInWith({ sub: 'g-stranger', email: strangerMail, email_verified: false });
      const unverifiedTok = (
        await gApp.inject({
          method: 'POST',
          url: '/api/auth/handoff',
          headers: { cookie: `tm_handoff=${encodeURIComponent(unverified.backCookies.get('tm_handoff')!)}` },
        })
      ).json() as { token: string };
      const strangerNew = (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(unverifiedTok.token) })).json() as {
        id: string;
        email: string | null;
      };
      assert.notEqual(strangerNew.id, stranger.id, 'an unverified provider email is not a claim on anyone else’s account');
      assert.equal(strangerNew.email, null, 'and the contested address is not written onto the new account either');

      // ---- what the provider sends is input, not truth
      //
      // Google will not do any of this. The point is that the account row a
      // provider can create has to be one the rest of the app could also have
      // created — an address that would be refused at the sign-up form must not
      // get in through this door instead.
      for (const [label, profile] of [
        ['an address that is not one', { sub: 'g-bad-1', email: 'not an email', email_verified: true }],
        ['an address over the 254 limit', { sub: 'g-bad-2', email: `${'a'.repeat(250)}@example.test`, email_verified: true }],
        ['an address with a comma in it', { sub: 'g-bad-3', email: 'a,b@example.test', email_verified: true }],
      ] as const) {
        const r = await signInWith(profile as Record<string, unknown>);
        const tok = (
          await gApp.inject({
            method: 'POST',
            url: '/api/auth/handoff',
            headers: { cookie: `tm_handoff=${encodeURIComponent(r.backCookies.get('tm_handoff')!)}` },
          })
        ).json() as { token?: string };
        assert.ok(tok.token, `${label}: the sign-in still works`);
        const who = (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(tok.token!) })).json() as {
          email: string | null;
          username: string;
        };
        assert.equal(who.email, null, `${label}: but it is not written to the account`);
        assert.match(who.username, /^[a-zA-Z0-9_]{3,24}$/, `${label}: and the derived username is still a legal one`);
      }
      // A display name cannot smuggle anything into the username either.
      const nasty = await signInWith({ sub: 'g-nasty', name: '<script>alert(1)</script>', email_verified: false });
      const nastyTok = (
        await gApp.inject({
          method: 'POST',
          url: '/api/auth/handoff',
          headers: { cookie: `tm_handoff=${encodeURIComponent(nasty.backCookies.get('tm_handoff')!)}` },
        })
      ).json() as { token: string };
      const nastyMe = (await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(nastyTok.token) })).json() as { username: string };
      assert.match(nastyMe.username, /^[a-zA-Z0-9_]{3,24}$/, 'a hostile display name still produces a legal username');
      assert.doesNotMatch(nastyMe.username, /[<>()/]/, 'with none of it surviving');

      // ---- open redirect
      for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example']) {
        const evil = await gApp.inject({ method: 'GET', url: `/api/auth/google?returnTo=${encodeURIComponent(bad)}` });
        const st = new URL(String(evil.headers.location)).searchParams.get('state')!;
        nextProfile = { sub: 'g-redirect', email: 'r@example.test', email_verified: true };
        const landed = await gApp.inject({
          method: 'GET',
          url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(st)}`,
          headers: { cookie: cookieHeader(cookiesFrom(evil)) },
        });
        assert.match(String(landed.headers.location), /^\/app\?/, `returnTo=${bad} must not leave this origin`);
      }

      // ---- the provider refusing, and the user cancelling
      //
      // Which word the user gets depends on which refusal it was. Being told
      // "cancelled" when Google simply will not run inside an app's browser
      // blames them for something they did not do — and that case is common
      // here, because the traffic arrives from TikTok and X links.
      for (const [raw, reason] of [
        ['access_denied', 'cancelled'],
        ['disallowed_useragent', 'inapp'],
        ['server_error', 'provider'],
      ] as const) {
        const started = await gApp.inject({ method: 'GET', url: '/api/auth/google' });
        const came = await gApp.inject({
          method: 'GET',
          url: `/api/auth/google/callback?error=${raw}&state=x`,
          headers: { cookie: cookieHeader(cookiesFrom(started)) },
        });
        assert.match(String(came.headers.location), new RegExp(`reason=${reason}`), `${raw} must read as "${reason}"`);
        assert.doesNotMatch(String(came.headers.location), /error=/, 'and nothing the provider wrote is echoed back into our URL');
      }

      const broken = await gApp.inject({ method: 'GET', url: '/api/auth/google' });
      nextProfile = null; // userinfo answers 500
      const brokenBack = await gApp.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(new URL(String(broken.headers.location)).searchParams.get('state')!)}`,
        headers: { cookie: cookieHeader(cookiesFrom(broken)) },
      });
      assert.match(String(brokenBack.headers.location), /reason=provider/, 'a provider that fails lands on the normal form, not a stack trace');

      // ---- an account must never be left with no way in
      const lastWay = await gApp.inject({ method: 'DELETE', url: '/api/account/link/google', headers: bearer(newcomerToken) });
      assert.equal(lastWay.statusCode, 400, 'unlinking the only sign-in method is refused');
      assert.equal((lastWay.json() as { code: string }).code, 'last_method');

      // ...until a password is set. Not with the session alone: a stolen one
      // could set a password the thief knows (audit round six). The proven
      // address decides, through the set-a-password link sent to it.
      const setFirst = await gApp.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: bearer(newcomerToken),
        payload: { newPassword: 'quartz-lantern-echo7' },
      });
      assert.equal(setFirst.statusCode, 403, 'a Google account sets its first password through its mailbox');
      assert.equal((setFirst.json() as { code: string }).code, 'use_email_link');
      const newcomerId = ((await gApp.inject({ method: 'GET', url: '/api/me', headers: bearer(newcomerToken) })).json() as { id: string }).id;
      const mailed = 'newcomer-set-password-link-0123456789';
      await gAuth.createEmailToken(newcomerId, hashToken(mailed), 'reset_password', new Date(Date.now() + 3600_000));
      assert.equal((await gApp.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: mailed, newPassword: 'quartz-lantern-echo7' } })).statusCode, 200);
      assert.deepEqual(await gAuth.identitiesFor(newcomerId), [], 'which, like any reset, removes the Google sign-in; it can be connected again');
      const signedBackIn = await gApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'curva_north', password: 'quartz-lantern-echo7' } });
      assert.equal(signedBackIn.statusCode, 200, 'and the password opens the account');
      const afterSet = (signedBackIn.json() as { token: string }).token;
      // And the policy still applies to that first password.
      const weakFirst = await gApp.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: bearer(afterSet),
        payload: { currentPassword: 'quartz-lantern-echo7', newPassword: 'password1234' },
      });
      assert.equal(weakFirst.statusCode, 400, 'the password policy did not stop applying');

      // ---- linking from inside a session is the escape hatch the CVE row points at
      const linkStart = await gApp.inject({
        method: 'POST',
        url: '/api/account/link/google?returnTo=%2Faccount',
        headers: bearer(afterSet),
        payload: { password: 'quartz-lantern-echo7' },
      });
      assert.equal(linkStart.statusCode, 200);
      const linkState = new URL((linkStart.json() as { url: string }).url).searchParams.get('state')!;
      nextProfile = { sub: 'g-relink', email: 'newfan@example.test', email_verified: true };
      const linkBack = await gApp.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(linkState)}`,
        headers: { cookie: cookieHeader(cookiesFrom(linkStart)) },
      });
      assert.match(String(linkBack.headers.location), /^\/account\?linked=google/, 'linking returns to the account page');

      // ---- an identity already spoken for
      const stealStart = await gApp.inject({
        method: 'POST',
        url: '/api/account/link/google?returnTo=%2Faccount',
        headers: bearer(linkedTok.token),
        payload: { password: 'thistle-anchor-92x' },
      });
      nextProfile = { sub: 'g-relink', email: 'newfan@example.test', email_verified: true };
      const stealBack = await gApp.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(new URL((stealStart.json() as { url: string }).url).searchParams.get('state')!)}`,
        headers: { cookie: cookieHeader(cookiesFrom(stealStart)) },
      });
      assert.match(String(stealBack.headers.location), /reason=linked_elsewhere/, 'one Google account, one TifoMaker account');

      assert.ok(tokenCalls > 0, 'the code really was exchanged server-side');
      await gApp.close();
      console.log('sign in with google: all assertions passed (PKCE + state, sub as the key, the CVE row, unverified emails, open redirect, single-use handoff, last-way-in, linking)');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  await app.close();
  console.log('audit round three: all assertions passed (PDF title DoS, 500 bodies, tokens in logs + console mail, reset timing + mail bomb, change-email mail bomb + lookup cost, code-guess cap, photo metadata, $& injection, feedback mailto, local escapers, AI budget, Cloudflare hop trust, asset caching, inline scripts)');
}

// ---------- 2026-09: AI failures and the review queues ----------
// Three things the operator reported, each reproduced here before it was fixed:
//  1. a model failure put the provider's raw reply — vendor, model id, HTTP
//     503, the JSON body — into the editor's Arabic card and status line;
//  2. /admin → AI said "busy or failed" and nothing about why, or whose;
//  3. the dashboard is opened with the admin PASSWORD, but the review queues
//     it counts only accepted an ADMIN_USERNAMES account, so following
//     "4 pending stadiums" ended in a 403.
{
  const { classifyAiFailure, publicCause, sanitizeDetail } = await import('../src/aiFailure');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository } = await import('../src/memoryRepo');
  const { MemoryStadiumRepository } = await import('../src/stadiumRepo');
  const { KOP_TEMPLATE } = await import('../../src/core/template');

  // ---- the classifier, on the exact text from the screenshot ----
  const shot = 'gemini "gemini-3.5-flash": HTTP 503: { "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE" } }';
  assert.equal(classifyAiFailure(shot, 503).reason, 'overloaded');
  assert.equal(classifyAiFailure(shot).reason, 'overloaded', 'the status is read out of the text when none is passed');
  assert.equal(publicCause('overloaded'), 'busy');
  assert.equal(classifyAiFailure('gemini "x": HTTP 429: RESOURCE_EXHAUSTED', 429).reason, 'rate_limited');
  assert.equal(publicCause('budget'), 'resting');
  assert.equal(classifyAiFailure('gemini: timed out').reason, 'timeout');
  assert.equal(classifyAiFailure('openai: network error').reason, 'network');
  assert.equal(classifyAiFailure('gemini "nope-1": HTTP 404: models/nope-1 is not found', 404).reason, 'model_not_found');
  assert.equal(classifyAiFailure('claude: HTTP 401: invalid x-api-key', 401).reason, 'auth');
  assert.equal(classifyAiFailure('gemini "m": prompt blocked by the safety filter (blockReason SAFETY)').reason, 'safety');
  assert.equal(classifyAiFailure('gemini "m": ran out of output tokens before finishing the JSON (finishReason MAX_TOKENS, limit 4096)').reason, 'truncated');
  assert.equal(classifyAiFailure('claude: response was not valid JSON').reason, 'bad_output');
  assert.equal(classifyAiFailure('something new entirely').reason, 'unknown');
  assert.equal(publicCause('unknown'), 'unavailable');
  const masked = sanitizeDetail('GET https://x.test/v1?key=AIzaSyA1234567890abcdef&alt=json Bearer abc.def.ghi sk-ant-api03-SECRETSECRET');
  assert.ok(!masked.includes('AIzaSyA1234567890') && !masked.includes('abc.def.ghi') && !masked.includes('SECRETSECRET'), `credential-shaped text is masked: ${masked}`);
  assert.ok(sanitizeDetail('x'.repeat(2000)).length <= 400, 'and the detail is bounded');

  // ---- a real generation against a provider that answers 503 ----
  const realFetch = globalThis.fetch;
  const saved = { key: process.env.GEMINI_API_KEY, pw: process.env.AI_ADMIN_PASSWORD, delay: process.env.AI_RETRY_DELAY_MS, prov: process.env.AI_PROVIDER };
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_RETRY_DELAY_MS = '100';
  process.env.AI_ADMIN_PASSWORD = 'correct horse battery staple';
  let providerCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('generativelanguage.googleapis.com')) {
      providerCalls++;
      return new Response('{ "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary.", "status": "UNAVAILABLE" } }', { status: 503 });
    }
    return realFetch(input as RequestInfo);
  }) as typeof fetch;
  try {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const events = new MemoryAiEventsRepository((id) => auth.usernameOf(id));
    const stadiums = new MemoryStadiumRepository();
    const app = await buildApp(designs, auth, templates, {
      social, leads: new MemoryLeadsRepository(), aiUsage: new MemoryAiUsageRepository(), aiEvents: events, stadiums, adminUsernames: ['boss'],
    });
    const fan = await reg(app, 'fan_ahlawy');
    await auth.markEmailVerified(fan.id);
    const op = await reg(app, 'osamah_op'); // an ordinary account: NOT in ADMIN_USERNAMES
    const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'correct horse battery staple' } })).json().token as string;
    const asAdmin = { 'x-ai-unlock': unlock };

    // 1. What the editor receives: one vendor-free word, nothing else.
    for (const headers of [bearer(fan.token), { ...asAdmin, ...bearer(op.token) }]) {
      const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers, payload: { prompt: 'red and white stripes' } });
      assert.equal(r.statusCode, 200);
      const j = r.json() as Record<string, unknown>;
      assert.equal(j.needsChoice, true);
      assert.equal(j.cause, 'busy', 'a 503 reads as "busy" to the person designing');
      assert.equal(j.detail, undefined, 'no raw detail, admins included');
      // The provider's own words, not a bare 503: the body carries numbers of
      // its own (resetInSec was once exactly 503 and failed this check).
      assert.ok(!/gemini|HTTP|high demand|spikes in demand|AIza/i.test(r.body) && !/UNAVAILABLE|"code":\s*503/.test(r.body), `nothing of the provider's reply reaches the editor: ${r.body}`);
    }
    assert.equal(providerCalls, 4, 'each generation tried the model and retried the 503 once');

    // A refused picture used to put the provider's error in the notes too.
    const src = (await import('node:fs')).readFileSync('server/src/aiRoutes.ts', 'utf8');
    assert.ok(!/notes\.push\(`Picture not generated: \$\{/.test(src), 'picture failures are not echoed into notes');
    assert.ok(!/Critique unavailable: \$\{/.test(src), 'nor critique failures');

    // The critic, the same way.
    const quick = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'red and white stripes', engine: 'offline' } })).json();
    const crit = await app.inject({ method: 'POST', url: '/api/ai/critique', headers: bearer(fan.token), payload: { spec: quick.spec } });
    assert.equal(crit.statusCode, 200);
    assert.equal(crit.json().cause, 'busy', 'a failed critique says why in one word');
    assert.ok(!/gemini|HTTP|503/i.test(crit.body), 'and nothing more');

    // Blocked briefs: which list matched is recorded, the brief never is.
    await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'neo-nazi banner' } });

    // 2. What the operator sees: reason, account, door, provider text.
    await new Promise((r) => setTimeout(r, 20)); // note() is fire-and-forget
    // (/api/admin/ai serves exactly this; it is registered only with a stats repo.)
    const ai = await events.stats(30);
    const by = Object.fromEntries(ai.failures.map((f) => [f.reason, f.count]));
    assert.equal(by.overloaded, 3, 'two generations and one critique failed as overloaded');
    assert.equal(by.prompt_screen, 1, 'the blocked brief is on file with its reason');
    const fanRow = ai.recentFailures.find((f) => f.username === 'fan_ahlawy' && f.mode === 'std' && f.reason === 'overloaded')!;
    assert.ok(fanRow, 'the account that hit the failure is named');
    assert.match(fanRow.detail, /HTTP 503/, 'the provider text is kept for the operator');
    assert.match(fanRow.detail, /high demand/);
    assert.ok(!fanRow.detail.includes('AIzaSyTESTKEY'), 'the API key never lands in the row');
    const opRow = ai.recentFailures.find((f) => f.username === 'osamah_op')!;
    assert.ok(opRow, 'an admin-password run is attributed to the account it was signed into');
    assert.equal(opRow.via, 'password', 'and says which door it came through');
    assert.ok(ai.recentFailures.some((f) => f.mode === 'polish' && f.reason === 'overloaded'), 'critique failures are recorded as polish');
    const blockedRow = ai.recentFailures.find((f) => f.reason === 'prompt_screen')!;
    assert.match(blockedRow.detail, /extremism/, 'the matched list is named');
    assert.ok(!/nazi|banner/i.test(blockedRow.detail), 'the brief itself is not stored');

    // 3. The review queues, from the password session.
    await stadiums.submit({ template: KOP_TEMPLATE, name: '<img src=x onerror=alert(1)> Park', country: 'EG', submitterId: fan.id });
    const pub = await makeDesign(app, fan.token, false); // private: the public photo route hides it
    await designs.report('design', pub, op.id, 'spam');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const photoId = (await designs.addPhoto(pub, fan.id, png, 1, 1, 'north stand'))!;

    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/queue' })).statusCode, 401, 'anonymous: sign in');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/queue', headers: bearer(op.token) })).statusCode, 403, 'an ordinary account alone: refused');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/queue', headers: { 'x-ai-unlock': 'v2.1.abc.def', ...bearer(op.token) } })).statusCode, 403, 'a forged token does not help');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/queue', headers: { cookie: `tm_admin=${encodeURIComponent(unlock)}` } })).statusCode, 401, 'the tm_admin cookie is not accepted: only the header is');
    const q = await app.inject({ method: 'GET', url: '/api/admin/queue', headers: asAdmin });
    assert.equal(q.statusCode, 200, 'the admin password opens the queue');
    const queue = q.json() as { stadiums: { id: string; submitter: string; seats: number; planSvg: string }[]; photos: { id: string }[]; reports: { id: string }[] };
    assert.equal(queue.stadiums.length, 1);
    assert.equal(queue.stadiums[0].submitter, 'fan_ahlawy', 'the submitter is named');
    assert.ok(queue.stadiums[0].seats > 1000, 'with its real seat count');
    assert.match(queue.stadiums[0].planSvg, /^<svg [^>]*>(<rect [^>]*\/>)+<\/svg>$/, 'and a seat plan made only of numbers');
    assert.ok(queue.stadiums[0].planSvg.length < 60_000, `the plan stays small (${queue.stadiums[0].planSvg.length} bytes)`);
    assert.ok(!queue.stadiums[0].planSvg.includes('onerror'), 'no submitted text inside the SVG');
    assert.equal(queue.photos.length, 1);
    assert.equal(queue.reports.length, 1);

    // Every legacy endpoint accepts the same session…
    for (const [method, url] of [['GET', '/api/stadiums/pending'], ['GET', '/api/admin/reports'], ['GET', '/api/admin/photos/unverified']] as const) {
      assert.equal((await app.inject({ method, url, headers: asAdmin })).statusCode, 200, `${url} opens with the admin password`);
    }
    // …and the pictures a reviewer has to see, even on a private design.
    assert.equal((await app.inject({ method: 'GET', url: `/api/photos/${photoId}` })).statusCode, 404, 'the public route still hides it');
    const img = await app.inject({ method: 'GET', url: `/api/admin/photos/${photoId}/image`, headers: asAdmin });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.equal((await app.inject({ method: 'GET', url: `/api/admin/photos/${photoId}/image` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/admin/designs/${pub}/thumbnail.png`, headers: bearer(op.token) })).statusCode, 403);

    // Decisions.
    assert.equal((await app.inject({ method: 'POST', url: `/api/stadiums/${queue.stadiums[0].id}/review`, headers: asAdmin, payload: { approve: true } })).statusCode, 200, 'approve');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/photos/${photoId}/verify`, headers: asAdmin, payload: { verified: true } })).statusCode, 200, 'verify');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/reports/${queue.reports[0].id}/dismiss`, headers: asAdmin })).statusCode, 200, 'dismiss');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/photos/${photoId}`, headers: asAdmin })).statusCode, 200, 'delete');
    const after = (await app.inject({ method: 'GET', url: '/api/admin/queue', headers: asAdmin })).json() as typeof queue;
    assert.equal(after.stadiums.length + after.photos.length + after.reports.length, 0, 'and the queue is empty afterwards');
    assert.equal(((await app.inject({ method: 'GET', url: '/api/stadiums/community' })).json() as { stadiums: unknown[] }).stadiums.length, 1, 'the approved stadium is live');
    // An ordinary account still cannot decide anything.
    assert.equal((await app.inject({ method: 'POST', url: `/api/stadiums/${queue.stadiums[0].id}/review`, headers: bearer(op.token), payload: { approve: false } })).statusCode, 403);

    await app.close();
    console.log('ai failures + review queues: all assertions passed (classifier, masking, vendor-free editor replies, reason + account + door on file, password session opens the queues, cookie refused, private photo visible to reviewers only)');
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['GEMINI_API_KEY', saved.key], ['AI_ADMIN_PASSWORD', saved.pw], ['AI_RETRY_DELAY_MS', saved.delay], ['AI_PROVIDER', saved.prov]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ============================================================================
// Audit round four (October 2026). Every block below is an exploit that worked
// against commit fc8ddd7, now asserted to fail. See SECURITY-AUDIT.md.
// ============================================================================
{
  const { MemoryAiUsageRepository, MemoryAiEventsRepository } = await import('../src/memoryRepo');
  const { MemoryDailyFeatureRepository } = await import('../src/featureRepo');
  const { issueToken, TOKEN_TTL_MS } = await import('../src/auth');
  const { existsSync } = await import('node:fs');
  const PW = 'quartz-lantern-echo7';
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // A fake Google, the way the round-three OAuth test does it.
  let nextProfile: Record<string, unknown> | null = null;
  let geminiCalls = 0;
  const realFetch = globalThis.fetch;
  const asJson = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return asJson({ access_token: 'stub' });
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return nextProfile ? asJson(nextProfile) : asJson({ error: 'x' }, 500);
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      const text = JSON.stringify({ tiers: 2, roof: 'partial', track: false, floodlights: 'roof', facade: 'concrete' });
      return asJson({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const savedEnv = { key: process.env.GEMINI_API_KEY, prov: process.env.AI_PROVIDER, budget: process.env.AI_DAILY_BUDGET };
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_DAILY_BUDGET = '1000';

  try {
    const mail: { to: string; subject: string; text: string }[] = [];
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const leads = new MemoryLeadsRepository();
    const featured = new MemoryDailyFeatureRepository();
    const app = await buildApp(designs, auth, templates, {
      social, leads, featured,
      adminUsernames: ['mod_r4'], aiAdminPassword: 'r4 admin password',
      oauth: { google: { id: 'cid', secret: 'csecret' } },
      emailSender: { async send(m: { to: string; subject: string; text?: string }) { mail.push({ to: m.to, subject: m.subject, text: m.text ?? '' }); } },
      verifyResendCooldownMs: 0,
      aiUsage: new MemoryAiUsageRepository(),
      aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
      ...(existsSync('dist/index.html') ? { staticDir: (await import('node:path')).resolve('dist') } : {}),
    } as Parameters<typeof buildApp>[3]);
    const r4 = async (u: string, email = `${u}@example.test`): Promise<{ token: string; id: string }> => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: PW, email, acceptedVersion: 'test', adminPassword: 'r4 admin password' } });
      assert.equal(r.statusCode, 201, r.body);
      const token = (r.json() as { token: string }).token;
      return { token, id: (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string };
    };
    const design = async (token: string, pub: boolean, title = 'D'): Promise<string> => {
      const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG_B64 } });
      const id = (d.json() as { id: string }).id;
      if (pub) assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } })).statusCode, 200);
      return id;
    };
    const jar = (res: { headers: Record<string, unknown> }): Map<string, string> => {
      const raw = res.headers['set-cookie'];
      const lines = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
      const out = new Map<string, string>();
      for (const line of lines) { const [pair] = line.split(';'); const eq = pair!.indexOf('='); out.set(pair!.slice(0, eq), decodeURIComponent(pair!.slice(eq + 1))); }
      return out;
    };
    const cookie = (j: Map<string, string>): string => [...j].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    /** Finish a Google round trip that was started by `start`. */
    const finish = async (start: { headers: Record<string, unknown>; json: () => unknown }, profile: Record<string, unknown>, link: boolean) => {
      const authorize = link ? (start.json() as { url: string }).url : String(start.headers.location);
      nextProfile = profile;
      return app.inject({ method: 'GET', url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(new URL(authorize).searchParams.get('state')!)}`, headers: { cookie: cookie(jar(start)) } });
    };
    const linkStart = (token: string, password?: string) =>
      app.inject({ method: 'POST', url: '/api/account/link/google?returnTo=%2Faccount', headers: bearer(token), payload: password ? { password } : {} });
    const verifyNow = async (id: string): Promise<void> => { await auth.markEmailVerified(id); };

    // ---- HIGH: pre-sign-up takeover by linking Google to an unverified account ----
    const squat = await r4('v_fan_r4', 'victim.r4@example.test');
    const early = await linkStart(squat.token, PW);
    assert.equal(early.statusCode, 403, 'an account whose email is unverified cannot connect another sign-in');
    assert.equal((early.json() as { code: string }).code, 'verify_first');
    // …and a reset (how the real owner takes the account back) removes any link already there.
    await verifyNow(squat.id);
    const linked = await finish(await linkStart(squat.token, PW), { sub: 'g-squatter', email: 'someone@gmail.test', email_verified: true }, true);
    assert.match(String(linked.headers.location), /linked=google/);
    assert.deepEqual(await auth.identitiesFor(squat.id), ['google']);
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'victim.r4@example.test' } });
    await app.drainBackground();
    const resetTok = /reset\?token=([a-f0-9]+)/.exec(mail.filter((m) => m.to === 'victim.r4@example.test').at(-1)!.text)![1];
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetTok, newPassword: 'owner-takes-it-back-9' } })).statusCode, 200);
    assert.deepEqual(await auth.identitiesFor(squat.id), [], 'a reset removes every connected sign-in');
    const squatterBack = await finish(await app.inject({ method: 'GET', url: '/api/auth/google?returnTo=%2Fapp' }), { sub: 'g-squatter', email: 'someone@gmail.test', email_verified: true }, false);
    const squatterSession = jar(squatterBack).get('tm_handoff');
    if (squatterSession) {
      const h = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { cookie: `tm_handoff=${encodeURIComponent(squatterSession)}` } });
      const meNow = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer((h.json() as { token: string }).token) })).json() as { id: string };
      assert.notEqual(meNow.id, squat.id, 'the old Google sign-in no longer opens the account');
    }

    // ---- MEDIUM: a stolen session alone could cut a permanent second key ----
    const alice = await r4('alice_r4');
    await verifyNow(alice.id);
    assert.equal((await linkStart(alice.token)).statusCode, 401, 'connecting needs the current password');
    assert.equal((await linkStart(alice.token, 'wrong-password-here')).statusCode, 401);
    // A link started before the owner changed the password cannot finish afterwards.
    const started = await linkStart(alice.token, PW);
    assert.equal(started.statusCode, 200);
    const changed = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(alice.token), payload: { currentPassword: PW, newPassword: 'fresh-harbor-lantern-4' } });
    assert.equal(changed.statusCode, 200);
    const late = await finish(started, { sub: 'g-thief', email: 'thief@gmail.test', email_verified: true }, true);
    assert.match(String(late.headers.location), /reason=state/, 'the link died with the session that started it');
    assert.deepEqual(await auth.identitiesFor(alice.id), []);
    // The owner hears about a link that does go through.
    const aliceTok2 = (changed.json() as { token: string }).token;
    const before = mail.length;
    await finish(await linkStart(aliceTok2, 'fresh-harbor-lantern-4'), { sub: 'g-alice', email: 'alice.g@gmail.test', email_verified: true }, true);
    await app.drainBackground();
    assert.ok(mail.slice(before).some((m) => m.to === 'alice_r4@example.test' && /security notice/i.test(m.subject) && /Google sign-in was connected/.test(m.text)), 'a security notice goes to the account');

    // ---- LOW: the handoff cookie was a 30-day session, and could be traded twice ----
    const fresh = await finish(await app.inject({ method: 'GET', url: '/api/auth/google?returnTo=%2Fapp' }), { sub: 'g-newcomer-r4', email: 'newcomer.r4@gmail.test', email_verified: true }, false);
    const ticket = jar(fresh).get('tm_handoff')!;
    assert.ok(ticket);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(ticket) })).statusCode, 401, 'the ticket is not a session');
    const trades = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { cookie: `tm_handoff=${encodeURIComponent(ticket)}` } })));
    assert.deepEqual(trades.map((t) => t.statusCode).sort(), [200, 401], 'only one trade of a ticket gets a session');

    // ---- LOW: a forged line in the log through the provider's error parameter ----
    {
      const lines: string[] = [];
      const realError = console.error;
      console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
      try {
        const start = await app.inject({ method: 'GET', url: '/api/auth/google?returnTo=%2Fapp' });
        const state = new URL(String(start.headers.location)).searchParams.get('state')!;
        await app.inject({ method: 'GET', url: `/api/auth/google/callback?error=x%0A[tifo]%20admin%20login%20ok&state=${state}`, headers: { cookie: cookie(jar(start)) } });
      } finally {
        console.error = realError;
      }
      assert.ok(lines.length > 0 && lines.every((l) => !l.includes('\n')), `no newline reaches the log (${JSON.stringify(lines)})`);
    }

    // ---- MEDIUM: verifying the account, not the address the mail went to ----
    {
      const sly = await r4('sly_r4', 'sly.own@example.test');
      const firstMail = mail.filter((m) => m.to === 'sly.own@example.test').at(-1)!;
      const heldLink = /verify\?token=([a-f0-9]+)/.exec(firstMail.text)![1];
      const heldCode = /: (\d{6})/.exec(firstMail.text)![1];
      assert.equal((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(sly.token), payload: { email: 'not.mine.r4@example.test', password: PW } })).statusCode, 200);
      const viaLink = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${heldLink}` });
      assert.match(String(viaLink.headers.location), /verified=0/, "a link for the old address does not verify the new one");
      const viaCode = await app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(sly.token), payload: { code: heldCode } });
      assert.equal(viaCode.statusCode, 400, 'nor does its code');
      assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(sly.token) })).json().emailVerified, false);
      // A real link for the current address still works.
      const current = mail.filter((m) => m.to === 'not.mine.r4@example.test').at(-1)!;
      const okLink = /verify\?token=([a-f0-9]+)/.exec(current.text)![1];
      assert.match(String((await app.inject({ method: 'GET', url: `/api/auth/verify?token=${okLink}` })).headers.location), /verified=1/);
    }

    // ---- LOW: change email with a session alone, silently, and a reset link outliving it ----
    {
      const carol = await r4('carol_r4');
      await verifyNow(carol.id); // only a verified address is told about a change
      await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'carol_r4@example.test' } });
      await app.drainBackground();
      const oldReset = /reset\?token=([a-f0-9]+)/.exec(mail.filter((m) => m.to === 'carol_r4@example.test').at(-1)!.text)![1];
      assert.equal((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(carol.token), payload: { email: 'carol.thief@example.test' } })).statusCode, 401, 'moving the address needs the password');
      const n = mail.length;
      assert.equal((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(carol.token), payload: { email: 'carol.new@example.test', password: PW } })).statusCode, 200);
      await app.drainBackground();
      assert.ok(mail.slice(n).some((m) => m.to === 'carol_r4@example.test' && /c•••@example\.test/.test(m.text)), `the old address is told where the account went ${JSON.stringify(mail.slice(n).map((m) => [m.to, m.subject, m.text.slice(0, 200)]))}`);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: oldReset, newPassword: 'some-new-lantern-77' } })).statusCode, 400, 'a reset link sent before the move is dead');
    }

    // ---- MEDIUM: the Host allow-list checked only the part before the colon ----
    {
      const dave = await r4('dave_r4');
      void dave;
      const n = mail.length;
      await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'dave_r4@example.test' }, headers: { host: 'tifomaker.org:@evil.example' } });
      await app.drainBackground();
      const link = /(\S+\/reset\?token=)/.exec(mail.slice(n).find((m) => m.to === 'dave_r4@example.test')!.text)![1];
      assert.ok(!link.includes('evil'), `a forged Host does not reach the reset link (${link})`);
      assert.ok(link.startsWith('https://tifomaker.org/'), link);
      if (existsSync('dist/index.html')) {
        const page = await app.inject({ method: 'GET', url: '/community', headers: { host: 'localhost:"><img src=x onerror=alert(1)>' } });
        assert.ok(!page.body.includes('<img src=x'), 'nor the page HTML');
      }
    }

    // ---- HIGH: a moderator's takedown undone by its owner ----
    {
      const troll = await r4('troll_r4');
      const mod = await r4('mod_r4');
      const bad = await design(troll.token, true, 'Offensive');
      assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${bad}/takedown`, headers: bearer(mod.token) })).statusCode, 200);
      const again = await app.inject({ method: 'PATCH', url: `/api/designs/${bad}`, headers: bearer(troll.token), payload: { isPublic: true } });
      assert.equal(again.statusCode, 403, 'publishing it again is refused');
      assert.equal((await app.inject({ method: 'GET', url: `/api/gallery/${bad}` })).statusCode, 404);
      // Through the Trash.
      const bad2 = await design(troll.token, true, 'Offensive 2');
      await app.inject({ method: 'DELETE', url: `/api/designs/${bad2}`, headers: bearer(troll.token) });
      await app.inject({ method: 'POST', url: `/api/admin/designs/${bad2}/takedown`, headers: bearer(mod.token) });
      const restored = (await app.inject({ method: 'POST', url: `/api/designs/${bad2}/restore`, headers: bearer(troll.token) })).json() as { isPublic: boolean };
      assert.equal(restored.isPublic, false, 'restoring it from the Trash leaves it private');
      // Through a copy.
      const copy = (await app.inject({ method: 'POST', url: `/api/designs/${bad}/fork`, headers: bearer(troll.token) })).json() as { id: string };
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${copy.id}`, headers: bearer(troll.token), payload: { isPublic: true } })).statusCode, 403, 'publishing a copy is refused too');
      // And the repository refuses even if a route forgot to.
      await designs.patchMeta(bad, { isPublic: true });
      assert.equal((await designs.get(bad))!.isPublic, false);

      // ---- MEDIUM: Tifo of the day kept showing it until midnight ----
      const star = await r4('star_r4');
      const starred = await design(star.token, true, 'Featured then gone');
      const today = (await app.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
      if (today.item?.id === starred) {
        await app.inject({ method: 'POST', url: `/api/admin/designs/${starred}/takedown`, headers: bearer(mod.token) });
        const after = (await app.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
        assert.notEqual(after.item?.id, starred, 'a taken-down design leaves the home page at once');
      } else {
        // Whatever was picked, taking it down removes it.
        const picked = today.item!.id;
        await app.inject({ method: 'POST', url: `/api/admin/designs/${picked}/takedown`, headers: bearer(mod.token) });
        const after = (await app.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
        assert.notEqual(after.item?.id, picked, 'a taken-down design leaves the home page at once');
      }

      // ---- MEDIUM: admin rights followed a name its owner could give up ----
      const renamed = await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(mod.token), payload: { username: 'mod_r4_old' } });
      assert.equal(renamed.statusCode, 403, 'an admin account keeps its name');
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(mod.token) })).statusCode, 403, 'and is not deleted from the account page');
    }

    // ---- MEDIUM: a private source's title on a public remix card ----
    {
      const src = await r4('src_r4');
      const rem = await r4('rem_r4');
      const original = await design(src.token, true, 'Original');
      const remix = (await app.inject({ method: 'POST', url: `/api/designs/${original}/remix`, headers: bearer(rem.token), payload: {} })).json() as { id: string };
      await app.inject({ method: 'PATCH', url: `/api/designs/${remix.id}`, headers: bearer(rem.token), payload: { isPublic: true } });
      await app.inject({ method: 'PATCH', url: `/api/designs/${original}`, headers: bearer(src.token), payload: { isPublic: false, title: 'SECRET: surprise for block C' } });
      const card = (await app.inject({ method: 'GET', url: `/api/gallery/${remix.id}` })).json() as { remixedFromTitle: string | null };
      assert.equal(card.remixedFromTitle, null, "a private source's title is not shown");

      // ---- LOW: fork ignored "no remixes" ----
      const closed = await design(src.token, true, 'Mine alone');
      await app.inject({ method: 'PUT', url: `/api/designs/${closed}/publish-meta`, headers: bearer(src.token), payload: { allowRemix: false } });
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${closed}/fork`, headers: bearer(rem.token) })).statusCode, 403, 'fork honours allowRemix');
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${closed}/fork`, headers: bearer(src.token) })).statusCode, 201, 'the owner can still copy their own');
    }

    // ---- MEDIUM: unverified throwaway accounts deciding the likes ----
    {
      const sock = await r4('sock_r4');
      const fan = await r4('fan_r4');
      const target = await design(fan.token, true, 'Something');
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${target}/vote`, headers: bearer(sock.token), payload: { value: 1 } })).statusCode, 403, 'an unverified account cannot vote');
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${target}/vote`, headers: bearer(sock.token), payload: { value: 0 } })).statusCode, 200, 'but can take a vote back');
      await verifyNow(sock.id);
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${target}/vote`, headers: bearer(sock.token), payload: { value: 1 } })).statusCode, 200, 'a verified account votes');

      // ---- LOW: notification spam ----
      for (let i = 0; i < 5; i++) {
        await app.inject({ method: 'POST', url: `/api/users/${fan.id}/follow`, headers: bearer(sock.token) });
        await app.inject({ method: 'DELETE', url: `/api/users/${fan.id}/follow`, headers: bearer(sock.token) });
      }
      const fanNotes = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(fan.token) })).json() as { items: { kind: string }[] };
      assert.equal(fanNotes.items.filter((n) => n.kind === 'new_follower').length, 1, 'following five times tells them once');
      await app.inject({ method: 'POST', url: `/api/users/${fan.id}/follow`, headers: bearer(sock.token) });
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'PATCH', url: `/api/designs/${target}`, headers: bearer(fan.token), payload: { isPublic: false } });
        await app.inject({ method: 'PATCH', url: `/api/designs/${target}`, headers: bearer(fan.token), payload: { isPublic: true } });
      }
      const sockNotes = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(sock.token) })).json() as { items: { kind: string }[] };
      assert.equal(sockNotes.items.filter((n) => n.kind === 'follow_post').length, 1, 'republishing does not tell followers again');

      // ---- LOW: anonymous view and share inflation ----
      for (let i = 0; i < 10; i++) await app.inject({ method: 'POST', url: `/api/designs/${target}/view` });
      for (let i = 0; i < 10; i++) await app.inject({ method: 'POST', url: `/api/designs/${target}/share`, payload: { platform: 'whatsapp' } });
      const stats = (await app.inject({ method: 'GET', url: `/api/designs/${target}/stats` })).json() as { views: number; shares: number };
      assert.equal(stats.views, 1, 'ten views from one visitor count once a day');
      assert.equal(stats.shares, 1, 'and so do ten shares');

      // ---- LOW: flooding the moderation queue ----
      const { randomUUID } = await import('node:crypto');
      assert.equal((await app.inject({ method: 'POST', url: '/api/report', payload: { targetType: 'design', targetId: randomUUID(), reason: 'spam' } })).statusCode, 404, 'a report on nothing is refused');
      for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/report', headers: bearer(sock.token), payload: { targetType: 'design', targetId: target, reason: 'spam' } });
      const mod = await auth.getUserByName('mod_r4');
      const modTok = issueToken();
      await auth.createToken(mod!.id, modTok.tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
      const reports = (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: bearer(modTok.token) })).json() as { targetId: string }[];
      assert.equal(reports.filter((r) => r.targetId === target).length, 1, 'one reporter, one report');
    }

    // ---- LOW: a placeholder handle published through routes outside requireUser ----
    {
      const { deriveUsername } = await import('../../src/core/handle');
      const u = (await auth.createUser(deriveUsername('jane.private.r4@gmail.test', 0), null, { email: 'jane.private.r4@gmail.test', emailVerified: true, usernameChosen: false }))!;
      const t = issueToken();
      await auth.createToken(u.id, t.tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
      const someone = await r4('pub_r4');
      const pub = await design(someone.token, true, 'Public one');
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${pub}/fork`, headers: bearer(t.token) })).statusCode, 428, 'fork is behind the wall');
      const search = (await app.inject({ method: 'GET', url: `/api/users/search?q=${u.username.slice(0, 4)}`, headers: bearer(someone.token) })).json() as { username: string }[];
      assert.ok(!search.some((x) => x.username === u.username), 'and the placeholder is not searchable');
    }

    // ---- MEDIUM: one account draining the site-wide premium AI budget ----
    {
      const reader = await r4('reader_r4');
      await verifyNow(reader.id);
      const img = 'data:image/jpeg;base64,' + Buffer.alloc(3000, 7).toString('base64');
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await app.inject({ method: 'POST', url: '/api/stadium/photo', headers: bearer(reader.token), payload: { image: img, samples: 8 } })).statusCode);
      }
      assert.ok(geminiCalls <= 24, `one free account gets 24 photo readings a day, not the whole budget (${geminiCalls} calls, ${statuses.join(',')})`);
      assert.equal(statuses.at(-1), 503);
    }

    // ---- MEDIUM: scene stripping on every anonymous view; revisions without end ----
    {
      const owner = await r4('scene_r4');
      const pub = await design(owner.token, true, 'Fat scene');
      const layers = Array.from({ length: 40000 }, (_, i) => ({ id: `l${i}`, kind: 'text', text: `layer ${i} ${Math.random()}` }));
      const sceneGzB64 = gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ text: 'hi' }], layers }))).toString('base64');
      assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${pub}/scene`, headers: bearer(owner.token), payload: { sceneGzB64 } })).statusCode, 200);
      // A second design with its own scene warms the stripping path first, so
      // the comparison below is cold-cache against warm-cache, not JIT warm-up.
      const warm = await design(owner.token, true, 'Warm-up');
      const warmScene = gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [], layers: layers.slice(0, 20000).map((l) => ({ ...l, text: l.text + 'w' })) }))).toString('base64');
      await app.inject({ method: 'PUT', url: `/api/designs/${warm}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: warmScene } });
      for (let i = 0; i < 2; i++) await app.inject({ method: 'GET', url: `/api/designs/${warm}/scene` });
      const timeGet = async (): Promise<number> => {
        const t0 = process.hrtime.bigint();
        const r = await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene` });
        assert.equal(r.statusCode, 200);
        return Number(process.hrtime.bigint() - t0) / 1e6;
      };
      const firstMs = await timeGet();
      const laterMs = Math.min(await timeGet(), await timeGet(), await timeGet());
      assert.ok(laterMs < firstMs / 4, `a stripped scene is computed once (first ${firstMs.toFixed(1)} ms, then ${laterMs.toFixed(1)} ms)`);

      const seats = generateSeatMap(DEFAULT_TEMPLATE).count;
      const huge = new Uint32Array(seats + 1);
      const b = (a: ArrayBufferView): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
      const tooLong = await app.inject({ method: 'POST', url: `/api/designs/${pub}/revisions`, headers: bearer(owner.token), payload: { indicesB64: b(huge), beforeB64: b(new Uint8Array(seats + 1)), afterB64: b(new Uint8Array(seats + 1)) } });
      assert.equal(tooLong.statusCode, 400, 'a diff larger than the stadium is refused');
      const one = { indicesB64: b(new Uint32Array([1])), beforeB64: b(new Uint8Array([0])), afterB64: b(new Uint8Array([1])) };
      for (let i = 0; i < 205; i++) await app.inject({ method: 'POST', url: `/api/designs/${pub}/revisions`, headers: bearer(owner.token), payload: one });
      const kept = (await app.inject({ method: 'GET', url: `/api/designs/${pub}/revisions?limit=500`, headers: bearer(owner.token) })).json() as unknown[];
      assert.ok(kept.length <= 200, `revisions are capped (${kept.length})`);
      const stored = ((designs as unknown as { rows: Map<string, { revisions: unknown[] }> }).rows.get(pub)!.revisions.length);
      assert.ok(stored <= 200, `and so is what is stored (${stored})`);

      // ---- LOW: anything stored as a thumbnail ----
      const notPng = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title: 'x', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: Buffer.from('<html>not a png</html>').toString('base64') } });
      assert.equal(notPng.statusCode, 400, 'a thumbnail must be a PNG');
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${pub}/og-image`, headers: bearer(owner.token), payload: { ogPngB64: Buffer.from('GIF89a').toString('base64') } })).statusCode, 400, 'and so must a share card');

      // ---- LOW: leads with no caps ----
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'n'.repeat(5000), email: 'club@example.test', message: 'm'.repeat(50_000) } });
      const lead = leads.leads.at(-1)!;
      assert.ok(lead.name.length <= 120 && (lead.message ?? '').length <= 2000, 'lead fields are capped');
    }

    await app.close();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['GEMINI_API_KEY', savedEnv.key], ['AI_PROVIDER', savedEnv.prov], ['AI_DAILY_BUDGET', savedEnv.budget]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // ---- Postgres only: names that differ only in case ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { readFileSync } = await import('node:fs');
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const { PgSocialRepository } = await import('../src/pgSocial');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
      const pAuth = new PgAuthRepository(pool);
      const pDesigns = new PgDesignRepository(pool);
      const papp = await buildApp(pDesigns, pAuth, templates, { social: new PgSocialRepository(pool) });
      const s = Math.random().toString(36).slice(2, 7);
      const reg2 = (u: string, e: string) => papp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: PW, email: e, acceptedVersion: 'test' } });
      assert.equal((await reg2(`casey${s}`, `one${s}@example.test`)).statusCode, 201);
      assert.equal((await reg2(`Casey${s}`, `two${s}@example.test`)).statusCode, 409, 'Postgres: a case variant of a name cannot be registered');
      const other = (await reg2(`other${s}`, `three${s}@example.test`)).json() as { token: string };
      assert.equal((await papp.inject({ method: 'POST', url: '/api/account/username', headers: bearer(other.token), payload: { username: `CASEY${s}` } })).statusCode, 409, 'Postgres: nor taken by a rename');
      // A takedown holds in the database itself.
      const d = await papp.inject({ method: 'POST', url: '/api/designs', headers: bearer(other.token), payload: { title: 'pg', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
      const id = (d.json() as { id: string }).id;
      await pDesigns.patchMeta(id, { isPublic: true });
      await pDesigns.takedownDesign(id);
      await pDesigns.patchMeta(id, { isPublic: true });
      assert.equal((await pDesigns.get(id))!.isPublic, false, 'Postgres: a taken-down design stays private');
      assert.equal((await pDesigns.get(id))!.takenDown, true);
      await papp.close();
    } finally {
      await pool.end();
    }
  }

  console.log('audit round four: all assertions passed (pre-signup link takeover, re-auth for links and email changes, links bound to their session, reset clears links, handoff ticket, oauth log line, verification bound to the address, reset links outliving changes, Host port bypass, permanent takedowns, featured re-check, remix source titles, admin names, verified votes, notification + counter + report spam, unnamed wall, fork allowRemix, per-account premium AI share, cached scene stripping, revision caps, PNG-only thumbnails, lead caps, case-insensitive names on Postgres)');
}

// ---------- 2026-10: the AI failures queue ----------
// Four failures from /admin → AI, reproduced against a stubbed provider:
//  - Polish ×3: "critique spec failed validation: layers[1].colors colors must be
//    2+ palette indices in range 0..10" and "layers[6].orientation orientation
//    must be vertical|horizontal|diagonal" — the critic's rewrite was thrown away
//    whole over one field;
//  - Premium: "gemini: timed out (model gemini-3.1-flash-lite)" — the fast tier's
//    slow calls land right on the old 20 s limit, and there was no second try.
{
  const { validateModelSpec, coerceModelSpec, validateSpec } = await import('../../src/core/tifoSpec');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository } = await import('../src/memoryRepo');

  // ---- the repairs, on their own ----
  const PAL = ['#262a33', '#0033a0', '#ffffff', '#d4af37'];
  const broken = {
    palette: PAL,
    layers: [
      { id: 'L0', kind: 'fill', region: 'all', colorIndex: 1 },
      { id: 'L1', kind: 'gradient', region: 'north', colors: ['#0033a0', '#FFFFFF'], direction: 'Vertical' },
      { id: 'L2', kind: 'stripes', region: 'sides', colors: [1, 2], direction: 'horizontal' },
      { id: 'L3', kind: 'stripes', region: 'south', colors: ['1', '3'] },
      { id: 'L4', kind: 'Pattern', region: 'east', colors: [1, 2], pattern: 'Checkerboard', scale: 10 },
      { id: 'L5', kind: 'stripes', region: 'west', colors: [2], orientation: 'vertical' },
      { id: 'L6', kind: 'text', region: 'south', text: 'ZAEEM', colorIndex: '#fefefe', fontId: 'poster', heightFrac: 0.6 },
    ],
  };
  assert.equal(validateSpec(broken).valid, false, 'the strict validator still refuses it');
  const fixed = validateModelSpec(broken);
  assert.equal(fixed.valid, true, `repaired: ${JSON.stringify(fixed.errors)}`);
  const L = fixed.spec!.layers;
  assert.deepEqual((L[1] as { colors: number[] }).colors, [1, 2], 'hex colours become their palette cards');
  assert.equal((L[2] as { orientation: string }).orientation, 'horizontal', 'a stripes "direction" is its orientation');
  assert.equal((L[3] as { orientation: string }).orientation, 'vertical', 'a missing orientation takes the default');
  assert.deepEqual((L[3] as { colors: number[] }).colors, [1, 3], 'numeric strings are indices');
  assert.equal((L[4] as { pattern: string }).pattern, 'checker', 'pattern names are read loosely');
  assert.equal(L[5].kind, 'fill', 'one-colour stripes are a fill');
  assert.equal((L[6] as { colorIndex: number }).colorIndex, 2, 'a hex colorIndex is the nearest card');
  assert.ok(fixed.repairs.length >= 6, 'and every repair is reported');
  assert.deepEqual(coerceModelSpec(broken).spec !== broken && broken.layers[2].direction, 'horizontal', 'the input is not modified');

  // A layer with no reading at all is left out — or, for the critic, replaced by
  // the layer it was rewriting.
  const hopeless = { ...broken, layers: [...broken.layers.slice(0, 1), { id: 'L1', kind: 'gradient', region: 'north', colors: [99, 98] }, ...broken.layers.slice(2)] };
  const dropped = validateModelSpec(hopeless);
  assert.equal(dropped.valid, true);
  assert.ok(!dropped.spec!.layers.some((l) => l.id === 'L1'), 'without a twin, the broken layer is left out');
  const original = validateSpec({ palette: PAL, layers: [{ id: 'L0', kind: 'fill', region: 'all', colorIndex: 1 }, { id: 'L1', kind: 'gradient', region: 'north', colors: [1, 3] }] }).spec!;
  const twin = validateModelSpec(hopeless, original);
  assert.deepEqual((twin.spec!.layers.find((l) => l.id === 'L1') as { colors: number[] }).colors, [1, 3], 'with one, the original layer comes back');
  const mostlyBroken = { palette: PAL, layers: [0, 1, 2, 3].map((i) => ({ id: `L${i}`, kind: 'stripes', region: 'all', colors: [77, 78] })) };
  assert.equal(validateModelSpec(mostlyBroken).valid, false, 'a design that is mostly broken is still a failure');

  // ---- regions written loosely (the std "region must be a stand" failures) ----
  const { coerceRegion, normalizeRegion } = await import('../../src/core/tifoSpec');
  const reads: Array<[unknown, unknown]> = [
    ['North', 'north'], ['north stand', 'north'], ['South End', 'south'], [' WEST ', 'west'], ['N', 'north'],
    ['lower north', { stand: 'north', tier: 0 }], ['North - Upper Tier', { stand: 'north', tier: 1 }],
    ['both ends', { stand: 'all', tier: 'all', stands: ['north', 'south'] }], ['Sides', { stand: 'all', tier: 'all', stands: ['east', 'west'] }],
    ['whole stadium', 'all'], ['upper tier', 'upper'], ['north and south', { stand: 'all', tier: 'all', stands: ['north', 'south'] }],
    [{ stand: 'North', tier: 'upper' }, { stand: 'north', tier: 1 }], [{ stand: 'north', tier: [0, 1] }, 'north'], [{ stand: 'north', tier: '0' }, { stand: 'north', tier: 0 }],
    [{ stand: 'east', tier: 'all tiers' }, 'east'], [{ stand: 'ends', tier: 0 }, { stand: 'all', tier: 0, stands: ['north', 'south'] }],
    [{ stand: 'all', stands: [] }, 'all'], [{ stands: 'north, south' }, { stand: 'all', tier: 'all', stands: ['north', 'south'] }],
    [{ stand: 'all', stands: ['North', 'South'] }, { stand: 'all', tier: 'all', stands: ['north', 'south'] }],
    [{ stand: 'north', rows: { from: 0, to: 0.5 } }, { stand: 'north', tier: 'all', rows: [0, 0.5] }],
    [['north', 'east'], { stand: 'all', tier: 'all', stands: ['north', 'east'] }],
  ];
  for (const [raw, want] of reads) {
    const got = coerceRegion(raw);
    assert.deepEqual(got, want, `region ${JSON.stringify(raw)} reads as ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    assert.ok(normalizeRegion(got), `and the result is a valid region: ${JSON.stringify(got)}`);
  }
  for (const raw of ['the kop', { stand: 'kop' }, { stand: 'north', tier: -1 }, 42]) assert.equal(coerceRegion(raw), null, `no single reading: ${JSON.stringify(raw)}`);
  assert.equal(coerceRegion('north'), 'north', 'a valid region is returned as it is');
  // A design the std model wrote against the new stadium context: every layer
  // used a capitalised stand or a tier word. It used to fail whole.
  const loose = validateModelSpec({ palette: PAL, layers: [
    { kind: 'fill', region: 'All', colorIndex: 1 },
    { kind: 'stripes', region: { stand: 'East', tier: 'lower' }, colors: [1, 2], orientation: 'vertical' },
    { kind: 'text', region: 'South Stand', text: 'ZAEEM', colorIndex: 2, fontId: 'poster', heightFrac: 0.8 },
    { kind: 'symbol', region: { stand: 'North', tier: [0, 1] }, symbol: 'star', colorIndex: 2, scaleFrac: 0.9 },
  ] });
  assert.equal(loose.valid, true, `loosely written regions are read: ${JSON.stringify(loose.errors)}`);
  assert.deepEqual(loose.spec!.layers.map((l) => [l.region.stand, l.region.tier]), [['all', 'all'], ['east', 0], ['south', 'all'], ['north', 'all']]);
  assert.ok(loose.repairs.some((r) => r.includes('"South Stand" → "south"')), 'and each repair is logged');
  // What still cannot be read says what it got, so the admin queue shows it.
  const unread = validateSpec({ palette: PAL, layers: [{ kind: 'fill', region: 'the kop', colorIndex: 1 }] });
  assert.ok(unread.errors[0].message.includes('"the kop"'), unread.errors[0].message);

  // ---- through the routes, against a stubbed Gemini ----
  const realFetch = globalThis.fetch;
  const saved = { key: process.env.GEMINI_API_KEY, prov: process.env.AI_PROVIDER, t: process.env.AI_TIMEOUT_MS, tp: process.env.AI_TIMEOUT_PREMIUM_MS };
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_TIMEOUT_MS = '1200';
  process.env.AI_TIMEOUT_PREMIUM_MS = '1200';
  const reply = (spec: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(spec) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  let plan: Array<'hang' | unknown> = [];
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input as RequestInfo, init);
    calls++;
    const step = plan.shift();
    if (step === 'hang') {
      // Answer only when aborted, like a call that runs past the deadline.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return reply(step);
  }) as typeof fetch;
  try {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), aiUsage: new MemoryAiUsageRepository(), aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
    });
    const fan = await reg(app, 'fan_q4');
    await auth.markEmailVerified(fan.id);
    const good = { title: 'Zaeem', palette: PAL, layers: [{ kind: 'fill', region: 'all', colorIndex: 1 }, { kind: 'text', region: 'south', text: 'ZAEEM', colorIndex: 2, fontId: 'poster', heightFrac: 0.7 }] };

    // 1. A timed-out call is tried once more.
    plan = ['hang', good];
    calls = 0;
    const gen = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Al Hilal zaeem' } });
    const g = gen.json() as { spec?: { layers: unknown[] }; source?: string; needsChoice?: boolean };
    assert.equal(calls, 2, 'the timed-out call was retried once');
    assert.equal(g.source, 'model', `and the second answer is the design: ${gen.body.slice(0, 200)}`);

    // Twice timed out is still a failure, and only two tries are spent.
    plan = ['hang', 'hang'];
    calls = 0;
    const gen2 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Ittihad tigers' } })).json() as { needsChoice?: boolean };
    assert.equal(calls, 2);
    assert.equal(gen2.needsChoice, true, 'two timeouts offer the Quick Designer, as before');

    // 1b. A standard design with a stadium context and capitalised regions is
    //     delivered, not reported as "spec failed validation".
    plan = [{ title: 'Zaeem', palette: PAL, layers: [
      { kind: 'fill', region: 'All', colorIndex: 1 },
      { kind: 'text', region: { stand: 'South', tier: 'all' }, text: 'ZAEEM', colorIndex: 2, fontId: 'poster', heightFrac: 0.8 },
      { kind: 'symbol', region: 'North Stand', symbol: 'star', colorIndex: 2, scaleFrac: 0.9 },
    ] }];
    calls = 0;
    const genR = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Al Hilal star', stadium: '- north: 900 seats, tiers 0 and 1. Holds: ...' } });
    const gr = genR.json() as { spec?: { layers: Array<{ region: { stand: string } }> }; source?: string };
    assert.equal(gr.source, 'model', `loose regions no longer fail the design: ${genR.body.slice(0, 200)}`);
    assert.deepEqual(gr.spec!.layers.slice(0, 3).map((l) => l.region.stand), ['all', 'south', 'north']);

    // 2. The critic's rewrite with the three faults from the queue is used.
    const current = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'blue and white stripes ZAEEM', engine: 'offline' } })).json().spec;
    plan = [{
      ...current,
      layers: [
        ...current.layers.slice(0, 1),
        { id: 'NEW1', kind: 'gradient', region: 'north', colors: [current.palette.length, 1] }, // one past the palette
        { id: 'NEW2', kind: 'stripes', region: 'sides', colors: [1, 2], direction: 'horizontal' }, // "direction"
        ...current.layers.slice(1),
      ],
    }];
    const crit = await app.inject({ method: 'POST', url: '/api/ai/critique', headers: bearer(fan.token), payload: { spec: current } });
    const c = crit.json() as { source?: string; cause?: string; spec?: { layers: Array<{ id: string; kind: string; orientation?: string }> } };
    assert.equal(c.cause, undefined, `the polish no longer fails: ${crit.body.slice(0, 200)}`);
    assert.equal(c.source, 'model', 'the critic\'s design is the one returned');
    assert.equal(c.spec!.layers.find((l) => l.id === 'NEW2')?.orientation, 'horizontal');
    assert.equal(c.spec!.layers.find((l) => l.id === 'NEW1')?.kind, 'fill', 'one usable colour left: drawn as a fill');
    await app.close();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['GEMINI_API_KEY', saved.key], ['AI_PROVIDER', saved.prov], ['AI_TIMEOUT_MS', saved.t], ['AI_TIMEOUT_PREMIUM_MS', saved.tp]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  console.log('ai failures queue (October): all assertions passed (model output repaired, broken layers left out or restored, a timed-out call retried once, polish survives the critic\'s faults, loose regions read)');
}

// ---------- 2026-10: audit round five ----------
// Every exploit below worked against the code before it (commit 9084903 plus
// the ultras grounds): run this block there and its checks fail. See
// claude/security-audit-2026-10-round5.md in the project notes.
{
  const { clientKey } = await import('../src/proxyTrust');
  const { SocMonitor } = await import('../src/soc');
  const { MemorySocRepository } = await import('../src/socRepo');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository, MemoryEventsRepository } = await import('../src/memoryRepo');
  const { premiumCallsToday } = await import('../src/aiRoutes');
  const { printAssetPanels } = await import('../../src/render/simulator/printPanels');
  const { AssetStore } = await import('../../src/core/sceneAssets');
  const { readFileSync } = await import('node:fs');
  const R5PW = 'quartz-lantern-echo7';
  const fresh = () => {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    return { auth, designs, social };
  };
  const JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(256, 3), Buffer.from([0xff, 0xd9]),
  ]).toString('base64');

  // ---- HIGH: every per-address limit was unlimited over IPv6 ----
  // @fastify/rate-limit before 11.2.0 (CVE-2026-15144) counted the raw address
  // string: 199 of 200 sign-in attempts from one /64 got past a limit of 10 a
  // minute, and one address written five ways was five clients.
  {
    const { auth, designs } = fresh();
    const app = await buildApp(designs, auth, templates, { rateLimit: true });
    // /api/report: 10 a minute, and a bad body answers at once.
    const probe = (ip: string) => app.inject({ method: 'POST', url: '/api/report', remoteAddress: ip, payload: {} });
    let through = 0;
    for (let i = 1; i <= 40; i++) if ((await probe(`2001:db8:abcd:1234::${i.toString(16)}`)).statusCode !== 429) through++;
    assert.equal(through, 10, `one /64 is one client (${through} of 40 got through)`);
    through = 0;
    const spellings = ['2001:db8:0:99::1', '2001:0db8:0000:0099:0000:0000:0000:0001', '2001:DB8:0:99::1', '2001:db8:0:99:0:0:0:1', '2001:db8::99:0:0:0:1'];
    for (let i = 0; i < 20; i++) if ((await probe(spellings[i % 5])).statusCode !== 429) through++;
    assert.equal(through, 10, `one address written five ways is one client (${through} of 20 got through)`);
    assert.notEqual((await probe('2001:db8:abcd:9999::1')).statusCode, 429, 'another /64 is someone else');
    assert.notEqual((await probe('198.51.100.7')).statusCode, 429, 'and IPv4 is counted as before');
    await app.close();
    assert.equal(clientKey('::ffff:198.51.100.7'), '198.51.100.7', 'an IPv4-mapped address is the IPv4 address');
    assert.equal(clientKey('2001:db8:abcd:1234::1'), clientKey('2001:DB8:ABCD:1234:ffff::9'));
    assert.notEqual(clientKey('198.51.100.7'), clientKey('198.51.100.8'));
    // The security log and the view counters count the same way, or one
    // machine walking its /64 never sets off a per-address alert.
    const soc = new SocMonitor({ repo: new MemorySocRepository(), flushMs: 0 });
    assert.equal(soc.tag('2001:db8:abcd:1234::1'), soc.tag('2001:db8:abcd:1234:9::2'), 'the security log counts a /64 as one source');
    assert.notEqual(soc.tag('2001:db8:abcd:1234::1'), soc.tag('2001:db8:abcd:1235::1'));
    // The lockfile carries the fixed plugin.
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };
    const [maj, min] = lock.packages['node_modules/@fastify/rate-limit'].version.split('.').map(Number);
    assert.ok(maj > 11 || (maj === 11 && min >= 2), `@fastify/rate-limit is 11.2.0 or later (${lock.packages['node_modules/@fastify/rate-limit'].version})`);
  }

  // ---- MEDIUM: a copied admin session became a lasting moderator account ----
  {
    const { auth, designs, social } = fresh();
    const app = await buildApp(designs, auth, templates, { social, adminUsernames: ['chief_r5'], aiAdminPassword: 'r5 admin password' });
    const body = (username: string, extra: Record<string, unknown> = {}) => ({ username, password: R5PW, email: `${username}-${Math.random().toString(36).slice(2, 7)}@example.test`, acceptedVersion: 'test', ...extra });
    const viaSession = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-ai-unlock': mintUnlock('r5 admin password') }, payload: body('chief_r5') });
    assert.equal(viaSession.statusCode, 409, 'a valid admin-password session alone no longer claims an admin name');
    // A claim survives changing AI_ADMIN_PASSWORD, so it must take the password.
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: body('chief_r5', { adminPassword: 'r5 admin password' }) })).statusCode, 201, 'the admin password does');
    // And sign-up no longer lists the admin names: a bare probe gets the same
    // answer for one as for any other name.
    const { auth: a2, designs: d2 } = fresh();
    const app2 = await buildApp(d2, a2, templates, { adminUsernames: ['boss_r5'], aiAdminPassword: 'x admin password' });
    const bare = async (username: string) => (await app2.inject({ method: 'POST', url: '/api/auth/register', payload: { username } })).statusCode;
    assert.equal(await bare('boss_r5'), await bare('nobody_r5'), 'an admin name and an ordinary one answer a bare probe alike');
    assert.equal(await bare('BOSS_R5'), 400);
    await app2.close();
    await app.close();
  }

  // ---- MEDIUM: guesses sent together got past the 5-try limit on the code ----
  {
    class SlowAuth extends MemoryAuthRepository {
      override async consumeEmailToken(tokenHash: string, purpose: string): Promise<string | null> {
        await new Promise((r) => setTimeout(r, 15)); // a database round trip
        return super.consumeEmailToken(tokenHash, purpose);
      }
    }
    const auth = new SlowAuth();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const sent: { text?: string; html: string }[] = [];
    const app = await buildApp(designs, auth, templates, { emailSender: { send: async (m: { text?: string; html: string }) => { sent.push(m); } } as never });
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'racer_r5', password: R5PW, email: 'not-mine@example.test', acceptedVersion: 'test' } });
    const tok = (r.json() as { token: string }).token;
    const code = /Your TifoMaker code: (\d{6})/.exec(sent.at(-1)?.text ?? '')?.[1];
    assert.ok(code, 'the code was mailed');
    const wrong = [...Array(12).keys()].map((i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
    const all = await Promise.all([...wrong, code!].map((c) => app.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(tok), payload: { code: c } })));
    const checked = all.filter((x) => x.statusCode === 400).length;
    assert.equal(checked, 5, `at most five guesses are checked, however they are sent (${checked} were)`);
    assert.equal(all.at(-1)!.statusCode, 429, 'the right code after them does not get in');
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json() as { id: string };
    assert.equal((await auth.getUserById(me.id))!.emailVerifiedAt, null, 'and the address is not verified');
    await app.close();
  }

  // ---- MEDIUM: Super AI pictures had no per-account or per-design limit ----
  {
    const realFetch = globalThis.fetch;
    const saved = { key: process.env.GEMINI_API_KEY, prov: process.env.AI_PROVIDER, poll: process.env.AI_POLLINATIONS_KEY, fb: process.env.AI_IMAGE_FALLBACK, cw: process.env.AI_COPYWRITER, t: process.env.AI_TIMEOUT_MS, tp: process.env.AI_TIMEOUT_PREMIUM_MS };
    process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_POLLINATIONS_KEY = 'poll-test-key';
    process.env.AI_IMAGE_FALLBACK = 'none';
    process.env.AI_COPYWRITER = '0';
    process.env.AI_TIMEOUT_MS = '1200';
    process.env.AI_TIMEOUT_PREMIUM_MS = '1200';
    const PAL = ['#000000', '#1c5fd9', '#f2f1ec', '#e8b73a'];
    let images = 0;
    let n = 0;
    let pictureLayers = 2;
    let pictureFails = false;
    let hangNext = false;
    const regions = ['north', 'south', 'east', 'west', 'north', 'south'];
    const spec = () => ({ title: 'T', palette: PAL, layers: [
      { kind: 'fill', id: 'bg', region: 'all', colorIndex: 1 },
      ...regions.slice(0, pictureLayers).map((region, i) => ({ kind: 'image', id: `img${i}`, region, prompt: `eagle ${n} ${i}`, scaleFrac: 0.9 })),
    ] });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('generativelanguage.googleapis.com')) {
        if (hangNext) {
          hangNext = false;
          return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        }
        n++;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(spec()) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('pollinations')) {
        images++;
        return pictureFails ? new Response('down', { status: 500 }) : new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const { auth, designs, social } = fresh();
      const app = await buildApp(designs, auth, templates, { social, aiUsage: new MemoryAiUsageRepository(), aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)), aiFreeLimit: 1000 });
      const fan = await reg(app, 'picture_fan_r5');
      await auth.markEmailVerified(fan.id);
      let brief = 0;
      const superRun = async () => (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: `club brief ${brief++}`, mode: 'super' } })).json() as { spec?: { layers: { kind: string }[] }; outcome?: { kind: string; charged: boolean } };

      // One run asked for six pictures and got six (and up to twelve requests).
      pictureLayers = 6;
      let before = images;
      const six = await superRun();
      assert.equal(images - before, 4, `one design asks for at most four pictures (${images - before})`);
      assert.equal(six.spec!.layers.filter((l) => l.kind === 'image').length, 4, 'the extra picture layers are left out');

      // Each account has a daily share of picture requests (60): 4 used above.
      pictureLayers = 2;
      for (let i = 0; i < 28; i++) await superRun();
      assert.equal(images, 60, `the share is spent (${images} picture requests)`);
      before = images;
      const over = await superRun();
      assert.equal(images - before, 0, 'past the share no picture is requested');
      assert.equal(over.outcome?.kind, 'degraded');

      // And a run without its picture is free only so often. Before, 50 of
      // them from one account cost 50 model calls and none of its quota.
      const chargedRuns: boolean[] = [over.outcome!.charged];
      for (let i = 0; i < 20; i++) chargedRuns.push(!!(await superRun()).outcome?.charged);
      assert.deepEqual(chargedRuns.slice(0, 20), Array(20).fill(false), 'the first twenty incomplete runs of the day are not charged');
      assert.equal(chargedRuns[20], true, 'the twenty-first is');

      // A retried call is two calls to the provider, and two of the budget.
      const fan2 = await reg(app, 'retry_fan_r5');
      await auth.markEmailVerified(fan2.id);
      pictureLayers = 0;
      hangNext = true;
      const b0 = premiumCallsToday();
      const timed = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan2.token), payload: { prompt: 'a brief that times out once' } })).json() as { source?: string };
      assert.equal(timed.source, 'model', 'the retry delivered the design');
      assert.equal(premiumCallsToday() - b0, 2, `a retried call counts twice against AI_DAILY_BUDGET (${premiumCallsToday() - b0})`);
      void pictureFails;
      await app.close();
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of [['GEMINI_API_KEY', saved.key], ['AI_PROVIDER', saved.prov], ['AI_POLLINATIONS_KEY', saved.poll], ['AI_IMAGE_FALLBACK', saved.fb], ['AI_COPYWRITER', saved.cw], ['AI_TIMEOUT_MS', saved.t], ['AI_TIMEOUT_PREMIUM_MS', saved.tp]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  // ---- MEDIUM: one account could fill the database ----
  {
    const { auth, designs, social } = fresh();
    const app = await buildApp(designs, auth, templates, { social });
    const owner = await reg(app, 'hoarder_r5');
    const pub = await makeDesign(app, owner.token, true);
    const photo = (id: string) => app.inject({ method: 'POST', url: `/api/designs/${id}/photos`, headers: bearer(owner.token), payload: { imageB64: JPEG } });
    assert.equal((await photo(pub)).statusCode, 403, 'a photo needs a verified email, like a vote');
    await auth.markEmailVerified(owner.id);
    for (let i = 0; i < 20; i++) assert.equal((await photo(pub)).statusCode, 200);
    assert.equal((await photo(pub)).statusCode, 403, 'twenty photos to a design');
    const second = await makeDesign(app, owner.token, true);
    for (let i = 0; i < 10; i++) assert.equal((await photo(second)).statusCode, 200);
    assert.equal((await photo(second)).statusCode, 429, 'thirty photos a day');
    // New designs: 100 a day (two made above).
    let made = 2;
    while (made < 100) { await makeDesign(app, owner.token); made++; }
    const extra = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    assert.equal(extra.statusCode, 429, 'a hundred new designs a day');
    // And a thousand in all, whichever way they are made.
    const full = await reg(app, 'full_r5');
    for (let i = 0; i < 1000; i++) await designs.create({ title: `old ${i}`, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: full.id, thumbnailPng: null });
    assert.equal((await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(full.token), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } })).statusCode, 403, 'a thousand designs to an account');
    assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${pub}/fork`, headers: bearer(full.token), payload: {} })).statusCode, 403, 'a copy counts too');
    await app.close();
  }

  // ---- LOW: comment reports flooded the moderators' queue ----
  // ---- LOW: an ownerless private design was readable by anonymous visitors ----
  // ---- LOW: owner-only fields in public JSON ----
  {
    const { auth, designs, social } = fresh();
    const app = await buildApp(designs, auth, templates, { social });
    const owner = await reg(app, 'owner_r5');
    const pub = await makeDesign(app, owner.token, true);
    const c = (await app.inject({ method: 'POST', url: `/api/designs/${pub}/comments`, headers: bearer(owner.token), payload: { body: 'hello' } })).json() as { id: string };
    const report = (targetId: string) => app.inject({ method: 'POST', url: '/api/report', payload: { targetType: 'comment', targetId, reason: 'spam' } });
    assert.equal((await report('7f000000-0000-4000-8000-000000000001')).statusCode, 404, 'a report on a comment that does not exist is refused');
    assert.ok(((await report(c.id)).json() as { reportId: string | null }).reportId, 'a real one is filed');

    const orphan = await designs.create({ title: 'before accounts', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: null as unknown as string, thumbnailPng: null });
    for (const url of [`/api/designs/${orphan.id}`, `/api/designs/${orphan.id}/scene`, `/api/designs/${orphan.id}/photos`, `/og/t/${orphan.id}.png`]) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, `a private design with no owner is private to anonymous visitors too: ${url}`);
    }

    await designs.setPinned(pub, true);
    const anon = (await app.inject({ method: 'GET', url: `/api/designs/${pub}` })).json() as Record<string, unknown>;
    for (const k of ['pinned', 'deletedAt', 'takenDown', 'origin']) assert.ok(!(k in anon), `anonymous visitors do not get "${k}"`);
    assert.equal(((await app.inject({ method: 'GET', url: `/api/designs/${pub}`, headers: bearer(owner.token) })).json() as { pinned: boolean }).pinned, true, 'the owner still does');
    const card = ((await app.inject({ method: 'GET', url: '/api/gallery' })).json() as Record<string, unknown>[]).find((g) => g.id === pub)!;
    assert.ok(card && !('pinned' in card), 'nor does a gallery card');
    await app.close();
  }

  // ---- LOW: funnel events: no route limit, kept forever ----
  {
    const { auth, designs } = fresh();
    const events = new MemoryEventsRepository();
    const app = await buildApp(designs, auth, templates, { rateLimit: true, events });
    let ok = 0;
    for (let i = 0; i < 70; i++) if ((await app.inject({ method: 'POST', url: '/api/events', remoteAddress: '198.51.100.40', payload: { session: `s${i}`, name: 'landed' } })).statusCode === 204) ok++;
    assert.equal(ok, 60, `sixty events a minute from one address (${ok})`);
    assert.equal(await events.purge(new Date(Date.now() + 1000)), 60, 'and they can be purged');
    assert.equal((await events.funnel(['landed'], 30))[0].sessions, 0);
    await app.close();
  }

  // ---- LOW: markup in a print-panels popup, from someone else's scene ----
  {
    const hostile = '"></div><b id=PWN>x</b><img src=x onerror=alert(1)>';
    assert.equal(printAssetPanels(hostile, 2, 2), false, 'print panels refuse anything but an image data URL');
    const store = new AssetStore();
    store.loadJSON({ version: 1, assets: [
      { id: 'a', type: 'banner', imageRef: hostile },
      { id: 'b', type: 'banner', imageRef: 'data:image/png;base64,iVBORw0KGgo=' },
    ] } as never);
    const refs = (store.toJSON() as { assets: { imageRef: string | null }[] }).assets.map((a) => a.imageRef);
    assert.deepEqual(refs, [null, 'data:image/png;base64,iVBORw0KGgo='], 'a loaded scene keeps only image data URLs');
  }

  // ---- parity: the memory store let "Alice" in next to "alice" ----
  {
    const { auth, designs } = fresh();
    const app = await buildApp(designs, auth, templates, {});
    const r = (u: string) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: R5PW, email: `${u.toLowerCase()}${Math.random().toString(36).slice(2, 6)}@example.test`, acceptedVersion: 'test' } });
    assert.equal((await r('CaseR5')).statusCode, 201);
    assert.equal((await r('caser5')).statusCode, 409, 'memory: a case variant of a name cannot be registered');
    await app.close();
  }

  // ---- found by the independent check of these fixes ----
  {
    // Sign-up refused an admin name before hashing the password, so it
    // answered in 1 ms where any other taken name took ~390: a moderator test.
    const socRepo = new MemorySocRepository();
    const soc = new SocMonitor({ repo: socRepo, flushMs: 0 });
    const { auth, designs } = fresh();
    class RacySocial extends MemorySocialRepository {
      override async addComment(): Promise<never> { throw Object.assign(new Error('insert or update on table "comments" violates foreign key constraint'), { code: '23503' }); }
    }
    const social = new RacySocial(designs, auth);
    const app = await buildApp(designs, auth, templates, { social, soc, adminUsernames: ['mod_t5'], aiAdminPassword: 't5 admin password' });
    await reg(app, 'taken_t5');
    const timed = async (username: string) => {
      const t0 = performance.now();
      const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: R5PW, email: `${username}-${Math.random().toString(36).slice(2, 7)}@example.test`, acceptedVersion: 'test' } });
      return { status: r.statusCode, ms: performance.now() - t0 };
    };
    const admin = await timed('mod_t5');
    const taken = await timed('taken_t5');
    assert.equal(admin.status, 409);
    assert.equal(taken.status, 409);
    assert.ok(admin.ms > taken.ms / 3, `an admin name is refused as slowly as a taken one (${admin.ms.toFixed(0)} ms vs ${taken.ms.toFixed(0)} ms)`);
    // A claim is in the audit trail.
    const claimer = await reg(app, 'claimer_t5');
    assert.equal((await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(claimer.token), payload: { username: 'mod_t5', adminPassword: 't5 admin password' } })).statusCode, 200);
    await soc.flush();
    const trail = await socRepo.listAudit(20);
    assert.ok(trail.some((a) => a.action === 'claimed an admin name' && a.target === '@mod_t5'), `the claim is in the audit trail: ${JSON.stringify(trail.map((a) => a.action))}`);
    // A row that changed under the request is a 409, not a 500 for the alert.
    const pub = await makeDesign(app, claimer.token, true);
    const raced = await app.inject({ method: 'POST', url: `/api/designs/${pub}/comments`, headers: bearer(claimer.token), payload: { body: 'reply', parentId: '7f000000-0000-4000-8000-000000000002' } });
    assert.equal(raced.statusCode, 409, `a foreign-key race answers 409 (${raced.statusCode})`);
    await app.close();
    await soc.close();
  }
  {
    // A refused copy does not use up the day's designs.
    const { auth, designs, social } = fresh();
    const app = await buildApp(designs, auth, templates, { social });
    const owner = await reg(app, 'noremix_t5');
    const closed = await makeDesign(app, owner.token, true);
    await app.inject({ method: 'PUT', url: `/api/designs/${closed}/publish-meta`, headers: bearer(owner.token), payload: { description: 'mine', allowRemix: false } });
    const fan = await reg(app, 'remixer_t5');
    for (let i = 0; i < 101; i++) await app.inject({ method: 'POST', url: `/api/designs/${closed}/remix`, headers: bearer(fan.token), payload: {} });
    assert.equal((await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(fan.token), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } })).statusCode, 201, 'refused remixes do not count against the day');
    // And many accounts from one client share one daily allowance (300).
    let made = 2; // the closed design and the one just above, from the same client
    let refused = 0;
    for (let a = 0; a < 4 && !refused; a++) {
      const acc = await reg(app, `rot${a}_t5`);
      for (let i = 0; i < 100; i++) {
        const r = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(acc.token), payload: { title: 'D', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
        if (r.statusCode === 201) made++; else { refused = r.statusCode; break; }
      }
    }
    assert.equal(made, 300, `one client makes at most 300 designs a day across accounts (${made})`);
    assert.equal(refused, 429);
    await app.close();
  }

  // ---- hardening: no local escaper left in the server ----
  {
    const src = readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
    assert.ok(!/\.replace\(\/<\/g, '&lt;'\)/.test(src), 'routes.ts uses the shared escaper, not a local one');
  }

  // ---- Postgres only ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const { PgSocialRepository } = await import('../src/pgSocial');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
      const pAuth = new PgAuthRepository(pool);
      const pDesigns = new PgDesignRepository(pool);
      const sent: { text?: string; html: string }[] = [];
      const papp = await buildApp(pDesigns, pAuth, templates, { social: new PgSocialRepository(pool), emailSender: { send: async (m: { text?: string; html: string }) => { sent.push(m); } } as never });
      const s = Math.random().toString(36).slice(2, 7);
      const preg = async (u: string): Promise<{ token: string; id: string }> => {
        const r = await papp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: `${u}${s}`, password: R5PW, email: `${u}${s}@example.test`, acceptedVersion: 'test' } });
        assert.equal(r.statusCode, 201, r.body);
        const token = (r.json() as { token: string }).token;
        return { token, id: ((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json() as { id: string }).id };
      };

      // The verification race, on a real database.
      const racer = await preg('racer');
      const code = /Your TifoMaker code: (\d{6})/.exec(sent.at(-1)?.text ?? '')?.[1]!;
      const wrong = [...Array(30).keys()].map((i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
      const all = await Promise.all([...wrong, code].map((c) => papp.inject({ method: 'POST', url: '/api/auth/verify/code', headers: bearer(racer.token), payload: { code: c } })));
      assert.equal(all.filter((x) => x.statusCode === 400).length, 5, 'Postgres: at most five guesses are checked');
      assert.equal((await pAuth.getUserById(racer.id))!.emailVerifiedAt, null, 'Postgres: and the address is not verified');

      // Replies survive their parent: deleting a comment, or the account.
      const x = await preg('xr');
      const y = await preg('yr');
      const d = (await papp.inject({ method: 'POST', url: '/api/designs', headers: bearer(x.token), payload: { title: 'pg', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } })).json() as { id: string };
      await papp.inject({ method: 'PATCH', url: `/api/designs/${d.id}`, headers: bearer(x.token), payload: { isPublic: true } });
      const say = async (who: { token: string }, body: string, parentId?: string) => ((await papp.inject({ method: 'POST', url: `/api/designs/${d.id}/comments`, headers: bearer(who.token), payload: { body, ...(parentId ? { parentId } : {}) } })).json() as { id: string }).id;
      const c1 = await say(x, 'X says something wrong');
      await say(y, 'Y: here is the proof', c1);
      assert.equal((await papp.inject({ method: 'DELETE', url: `/api/comments/${c1}`, headers: bearer(x.token) })).statusCode, 200);
      const left = (await papp.inject({ method: 'GET', url: `/api/designs/${d.id}/comments` })).json() as { body: string; parentId: string | null }[];
      assert.deepEqual(left.map((c) => [c.body, c.parentId]), [['Y: here is the proof', null]], 'Postgres: deleting your comment leaves the replies to it');
      // Another design of Y's, where X comments and Y answers; then X goes.
      const dy = (await papp.inject({ method: 'POST', url: '/api/designs', headers: bearer(y.token), payload: { title: 'pg2', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } })).json() as { id: string };
      await papp.inject({ method: 'PATCH', url: `/api/designs/${dy.id}`, headers: bearer(y.token), payload: { isPublic: true } });
      const cx = ((await papp.inject({ method: 'POST', url: `/api/designs/${dy.id}/comments`, headers: bearer(x.token), payload: { body: 'X again' } })).json() as { id: string }).id;
      await papp.inject({ method: 'POST', url: `/api/designs/${dy.id}/comments`, headers: bearer(y.token), payload: { body: 'Y answers', parentId: cx } });
      assert.equal((await papp.inject({ method: 'DELETE', url: '/api/account', headers: bearer(x.token), payload: { password: R5PW } })).statusCode, 204);
      const after = (await papp.inject({ method: 'GET', url: `/api/designs/${dy.id}/comments` })).json() as { body: string }[];
      assert.deepEqual(after.map((c) => c.body), ['Y answers'], 'Postgres: deleting an account leaves the replies to its comments');

      // A bad id is a 400 on every route, not a 500.
      const anyone = await preg('anyone');
      for (const [method, url, payload] of [
        ['GET', '/api/gallery/not-a-uuid', undefined],
        ['POST', '/api/users/not-a-uuid/follow', {}],
        ['DELETE', '/api/comments/not-a-uuid', undefined],
        ['POST', `/api/designs/${dy.id}/comments`, { body: 'hi', parentId: 'not-a-uuid' }],
        ['POST', '/api/notifications/read', { ids: ['not-a-uuid'] }],
      ] as const) {
        const r = await papp.inject({ method, url, headers: bearer(anyone.token), ...(payload ? { payload } : {}) });
        assert.ok(r.statusCode < 500, `Postgres: ${method} ${url} with a bad id is not a server error (${r.statusCode})`);
      }

      // Pro reaches the account on Postgres (functional; it failed closed).
      await pAuth.setPro(anyone.id, true);
      assert.equal((await pAuth.getUserById(anyone.id))!.isPro, true, 'Postgres: a Pro account reads as Pro');
      await papp.close();
    } finally {
      await pool.end();
    }
  }

  console.log('audit round five: all assertions passed (IPv6 rate limits, admin names need the password and take as long as a taken name, claims audited, verification race, AI picture limits, storage caps per account and per client, refused copies refunded, foreign-key races are 409, comment reports, ownerless designs, owner-only fields, event limits, print-panel markup, memory name case, shared escaper, Postgres reply cascade, bad ids, Pro on Postgres)');
}

// ---------- 2026-10-17: AI Phase 0 — fallback model, pinned ids, usage, budgets ----------
// From the October AI analysis: 112 premium requests in 30 days ended "busy",
// 45 of the last 50 on the premium model (Google's 503s and quota 429s), and
// nothing tried another model. Nothing recorded tokens, so cost was a guess;
// Polish and photo successes were not recorded at all; the daily budget lived
// in a variable that every deploy reset; pictures were counted by nothing
// site-wide; the Gemini key travelled in the URL; a retired model id was asked
// for by name; and every call sent a temperature Google has deprecated.
{
  const prov = await import('../src/aiProvider');
  const pricing = await import('../src/aiPricing');
  const { configWarnings } = await import('../src/preflight');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository, MemoryAiBudgetRepository } = await import('../src/memoryRepo');
  const { premiumCallsToday, picturesToday, forgetBudgetMemoryForTests } = await import('../src/aiRoutes');
  const KEYS = [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_MODEL_PREMIUM', 'AI_MODEL_FAST', 'AI_MODEL_FALLBACK',
    'AI_MODEL_FALLBACK_PREMIUM', 'AI_MODEL_FALLBACK_FAST', 'AI_TIMEOUT_MS', 'AI_TIMEOUT_PREMIUM_MS', 'AI_TIMEOUT_RETRY', 'AI_RETRY_DELAY_MS',
    'AI_POLLINATIONS_KEY', 'POLLINATIONS_KEY', 'AI_IMAGE_FALLBACK', 'AI_IMAGE_PROVIDER', 'AI_DAILY_PICTURE_BUDGET', 'AI_COPYWRITER',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_RESPONSE_SCHEMA',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_MODEL_PREMIUM = 'gemini-3.5-flash';
  process.env.AI_MODEL_FAST = 'gemini-3.1-flash-lite';
  process.env.AI_TIMEOUT_MS = '1500';
  process.env.AI_TIMEOUT_PREMIUM_MS = '1500';
  process.env.AI_RETRY_DELAY_MS = '100';

  // ---- pinned ids, the fallback model, prices ----
  assert.equal(prov.currentModelId('gemini-3.5-flash'), 'gemini-3.6-flash');
  assert.equal(prov.geminiModel('premium'), 'gemini-3.6-flash', 'a retired premium id is asked for by its replacement');
  assert.equal(prov.geminiModel('fast'), 'gemini-3.1-flash-lite');
  assert.equal(prov.geminiFallback('premium'), 'gemini-3.5-flash-lite', 'the default fallback');
  process.env.AI_MODEL_FALLBACK = 'none';
  assert.equal(prov.geminiFallback('fast'), null, '"none" turns the fallback off');
  process.env.AI_MODEL_FALLBACK_PREMIUM = 'gemini-2.5-flash';
  assert.equal(prov.geminiFallback('premium'), 'gemini-2.5-flash', 'a per-tier setting wins over AI_MODEL_FALLBACK');
  delete process.env.AI_MODEL_FALLBACK;
  delete process.env.AI_MODEL_FALLBACK_PREMIUM;
  assert.ok(
    configWarnings({ AI_MODEL_PREMIUM: 'gemini-3.5-flash' } as NodeJS.ProcessEnv).some((w) => w.key === 'AI_MODEL_PREMIUM' && w.state === 'wrong' && w.effect.includes('gemini-3.6-flash')),
    'the boot report names a retired model id and its replacement',
  );
  assert.equal(configWarnings({ AI_MODEL_PREMIUM: 'gemini-3.6-flash' } as NodeJS.ProcessEnv).filter((w) => w.key === 'AI_MODEL_PREMIUM').length, 0, 'and says nothing about a current one');

  const dec = new Date(Date.UTC(2026, 11, 31, 12));
  const jan = new Date(Date.UTC(2027, 0, 1, 0, 1));
  const mil = { in: 1_000_000, out: 0, thought: 0, cached: 0 };
  assert.equal(pricing.textCostMicros('gemini-3.6-flash', mil, dec), 750_000);
  assert.equal(pricing.textCostMicros('gemini-3.6-flash', mil, jan), 1_500_000, 'the January price applies from its date');
  assert.equal(pricing.textCostMicros('gemini-3.6-flash', { in: 0, out: 1000, thought: 1000, cached: 0 }, dec), 7500, 'thinking is billed as output');
  assert.equal(pricing.textCostMicros('gemini-3.6-flash', { ...mil, cached: 1_000_000 }, dec), 75_000, 'cached input at the cached rate');
  assert.equal(pricing.textCostMicros('gemini-3.1-flash-lite', { in: 2000, out: 1000, thought: 0, cached: 0 }), 2000, 'Flash-Lite: 2,000 in + 1,000 out = $0.002');
  assert.equal(pricing.textCostMicros('a-model-with-no-price', { in: 10, out: 10, thought: 0, cached: 0 }), null, 'an unknown price is unknown, not free');
  assert.equal(pricing.textCostMicros('a-model-with-no-price', { in: 0, out: 0, thought: 0, cached: 0 }), 0, 'a call that billed nothing costs nothing');
  assert.equal(pricing.pictureCostMicros('pollinations', 'flux'), 2000);
  assert.equal(pricing.pictureCostMicros('gemini', 'gemini-2.5-flash-image'), 39_000);
  assert.equal(pricing.addUsage({ ...pricing.zeroUsage(), costMicros: 5 }, { ...pricing.zeroUsage(), costMicros: null }).costMicros, null, 'one unpriced call leaves the total unpriced');
  const gu = prov.geminiUsage('gemini-3.6-flash', { usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 1200, thoughtsTokenCount: 2000 } });
  assert.deepEqual([gu.in, gu.out, gu.thought, gu.cached, gu.calls], [3000, 1200, 2000, 0, 1]);
  assert.ok((gu.costMicros ?? 0) > 0);

  // ---- the independent review (17 October) ----
  // An answer that carried no token counts is billed all the same: unknown, not $0.
  assert.equal(prov.geminiUsage('gemini-3.6-flash', { candidates: [] }).costMicros, null, 'no usageMetadata: the cost is unknown');
  // Google answers a bad key with 400, not 401; a region or an image every model
  // refuses is a 400 too. Only a 400 about THIS model is worth a second one.
  const KEY_400 = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}';
  assert.equal(prov.isTransient(400, KEY_400), false, 'a refused key (400) is not transient');
  assert.equal(prov.isTransient(400, '{"error":{"message":"User location is not supported for the API use."}}'), false);
  assert.equal(prov.isTransient(400, '{"error":{"message":"Unsupported MIME type: image/heic"}}'), false);
  assert.equal(prov.isTransient(400, '{"error":{"message":"Thinking level is not supported for this model."}}'), true, 'a setting this model does not take is');
  assert.equal(prov.isTransient(400, '{"error":{"message":"Invalid JSON payload received."}}'), false);
  assert.equal(prov.isTransient(503, ''), true);
  assert.equal(prov.isTransient(401, ''), false);
  // An EMPTY per-tier variable inherits; it does not switch the fallback off.
  process.env.AI_MODEL_FALLBACK = 'gemini-2.5-flash';
  process.env.AI_MODEL_FALLBACK_PREMIUM = '';
  assert.equal(prov.geminiFallback('premium'), 'gemini-2.5-flash', 'a blank AI_MODEL_FALLBACK_PREMIUM inherits AI_MODEL_FALLBACK');
  process.env.AI_MODEL_FALLBACK = '  ';
  assert.equal(prov.geminiFallback('premium'), 'gemini-3.5-flash-lite', 'blank everywhere: the default');
  delete process.env.AI_MODEL_FALLBACK;
  delete process.env.AI_MODEL_FALLBACK_PREMIUM;
  {
    // An unknown price never reads as $0 per design, and our own limits are
    // not the model failing.
    const { costStats, modeOutcomes } = await import('../src/aiStats');
    const g = (o: Partial<import('../src/aiStats').AiGroup>): import('../src/aiStats').AiGroup => ({
      day: '2026-10-17', mode: 'super', outcome: 'model', model: 'gemini-3.6-flash', n: 1, limited: 0, measured: 1, unpriced: 0, costMicros: 0,
      tokensIn: 0, tokensOut: 0, tokensThought: 0, tokensCached: 0, pictures: 0, latencySum: 0, latencyN: 0, ...o,
    });
    const onlyUnpriced = costStats([g({ model: 'claude-x', unpriced: 1 })], null);
    assert.equal(onlyUnpriced.byMode.super.perDelivered, null, 'nothing priced: "—", not $0');
    assert.equal(onlyUnpriced.models[0].usd, null, 'and the model has no price, not $0');
    const mixed = costStats([g({ costMicros: 40_000 }), g({ model: 'claude-x', unpriced: 1 }), g({ outcome: 'busy', costMicros: 10_000 })], null);
    assert.equal(mixed.byMode.super.perDelivered, 0.05, 'all priced spend over the priced deliveries');
    const mo = modeOutcomes([g({ n: 3 }), g({ outcome: 'busy', n: 5, limited: 4, measured: 1 })]);
    assert.deepEqual([mo.super.model, mo.super.busy, mo.super.limited], [3, 5, 4]);
  }

  // ---- a stubbed Gemini (and Pollinations) ----
  const realFetch = globalThis.fetch;
  type Call = { url: string; headers: Record<string, string>; body: { systemInstruction?: unknown; generationConfig?: Record<string, unknown> } | null };
  const calls: Call[] = [];
  const modelIn = (u: string): string | undefined => /models\/([^:]+):/.exec(u)?.[1];
  const USAGE = { promptTokenCount: 3000, candidatesTokenCount: 900, thoughtsTokenCount: 1500 };
  const specReply = (spec: unknown, usage: Record<string, number> = USAGE) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(spec) }] }, finishReason: 'STOP' }], usageMetadata: usage }), { status: 200, headers: { 'content-type': 'application/json' } });
  const refuse = (status: number, message: string) => new Response(JSON.stringify({ error: { code: status, message } }), { status, headers: { 'content-type': 'application/json' } });
  let respond: (url: string, body: Call['body']) => Response = () => refuse(500, 'no plan');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('pollinations')) return new Response(Buffer.alloc(400, 7), { status: 200, headers: { 'content-type': 'image/png' } });
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input as RequestInfo, init);
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers, body });
    return respond(url, body);
  }) as typeof fetch;

  const GOOD = {
    title: 'Zaeem', palette: ['#262a33', '#0033a0', '#ffffff', '#d4af37'],
    layers: [{ kind: 'fill', region: 'all', colorIndex: 1 }, { kind: 'text', region: 'south', text: 'ZAEEM', colorIndex: 2, fontId: 'poster', heightFrac: 0.7 }],
  };
  try {
    // 1. The request itself: the current model, the key in a header, no temperature.
    calls.length = 0;
    respond = () => specReply(GOOD);
    const ok = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.ok(ok.spec);
    assert.equal(calls.length, 1);
    assert.equal(modelIn(calls[0].url), 'gemini-3.6-flash', 'the retired id is not what is asked for');
    assert.ok(!/[?&]key=/.test(calls[0].url), `no key in the URL: ${calls[0].url}`);
    assert.equal(calls[0].headers['x-goog-api-key'], 'AIzaSyTESTKEY0000000000', 'the key travels in x-goog-api-key');
    assert.equal(calls[0].body?.generationConfig?.temperature, undefined, 'no temperature (deprecated from 3.6 Flash on)');
    assert.equal(ok.model, 'gemini-3.6-flash');
    assert.deepEqual([ok.usage!.calls, ok.usage!.in, ok.usage!.out, ok.usage!.thought], [1, 3000, 900, 1500], 'usage read from usageMetadata');

    // 2. Google's "high demand" 503: the fallback model answers.
    calls.length = 0;
    respond = (u) => (modelIn(u) === 'gemini-3.6-flash' ? refuse(503, 'This model is currently experiencing high demand.') : specReply(GOOD));
    const fb = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.ok(fb.spec, 'the fallback model answered');
    assert.deepEqual(calls.map((c) => modelIn(c.url)), ['gemini-3.6-flash', 'gemini-3.5-flash-lite'], 'two calls, the second to the fallback');
    assert.equal(fb.model, 'gemini-3.5-flash-lite');
    assert.equal(fb.fellBackFrom, 'gemini-3.6-flash');
    assert.equal(fb.usage!.calls, 2, 'the refused call is counted');

    // 3. A quota 429: THIS model's quota. The fallback has its own.
    calls.length = 0;
    respond = (u) => (modelIn(u) === 'gemini-3.6-flash' ? refuse(429, 'You exceeded your current quota, please check your plan and billing details.') : specReply(GOOD));
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec, 'a quota refusal is answered by the fallback');
    assert.equal(calls.length, 2);

    // 4. A refused key: every model refuses it, so nothing else is asked.
    calls.length = 0;
    respond = () => refuse(401, 'API key not valid.');
    const k = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.equal(k.spec, null);
    assert.equal(calls.length, 1, 'a refused key is not tried on another model');

    // 4b. ...and Google's way of refusing a key, a 400: one call, not two.
    calls.length = 0;
    respond = () => new Response(KEY_400, { status: 400, headers: { 'content-type': 'application/json' } });
    assert.equal((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec, null);
    assert.equal(calls.length, 1, 'a 400 API_KEY_INVALID is not tried on another model');
    // 4c. A 400 about the model itself still falls back.
    calls.length = 0;
    respond = (u) => (modelIn(u) === 'gemini-3.6-flash' ? refuse(400, 'Thinking level is not supported for this model.') : specReply(GOOD));
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec);
    assert.equal(calls.length, 2, 'a 400 about this model goes to the fallback');

    // 5. Both refuse: still two calls, and the error names both.
    calls.length = 0;
    respond = () => refuse(503, 'high demand');
    const both = await prov.generateSpecViaProvider('brief', { tier: 'fast' });
    assert.equal(both.spec, null);
    assert.equal(calls.length, 2, 'never more than two calls');
    assert.ok(both.error!.includes('gemini-3.5-flash-lite') && both.error!.includes('gemini-3.1-flash-lite'), both.error);
    assert.equal(both.status, 503);

    // 6. A timeout: the second try goes to the fallback. (The fast model never
    //    answers here; the call's own timeout aborts it.)
    calls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input as RequestInfo, init);
      calls.push({ url, headers: {}, body: null });
      if (modelIn(url) === 'gemini-3.1-flash-lite') {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return specReply(GOOD);
    }) as typeof fetch;
    const slow = await prov.generateSpecViaProvider('brief', { tier: 'fast' });
    assert.ok(slow.spec, 'a timed-out call is answered by the fallback');
    assert.deepEqual(calls.map((c) => modelIn(c.url)), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('pollinations')) return new Response(Buffer.alloc(400, 7), { status: 200, headers: { 'content-type': 'image/png' } });
      if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input as RequestInfo, init);
      const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, headers, body });
      return respond(url, body);
    }) as typeof fetch;

    // 7. AI_MODEL_FALLBACK=none brings back the old rules exactly.
    process.env.AI_MODEL_FALLBACK = 'none';
    calls.length = 0;
    respond = () => refuse(503, 'high demand');
    await prov.generateSpecViaProvider('brief', { tier: 'fast' });
    assert.deepEqual(calls.map((c) => modelIn(c.url)), ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'], 'no fallback: a 503 retries the same model');
    calls.length = 0;
    respond = () => refuse(429, 'quota');
    await prov.generateSpecViaProvider('brief', { tier: 'fast' });
    assert.equal(calls.length, 1, 'no fallback: a 429 is still not retried');
    delete process.env.AI_MODEL_FALLBACK;

    // 8. A model Google has switched off (404) falls back too.
    process.env.AI_MODEL_FAST = 'gemini-1.0-pro';
    calls.length = 0;
    respond = (u) => (modelIn(u) === 'gemini-1.0-pro' ? refuse(404, 'models/gemini-1.0-pro is not found for API version v1beta') : specReply(GOOD));
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'fast' })).spec, 'a retired model that answers 404 falls back');
    process.env.AI_MODEL_FAST = 'gemini-3.1-flash-lite';

    // ---- through the routes: what lands in ai_events ----
    forgetBudgetMemoryForTests();
    process.env.AI_POLLINATIONS_KEY = 'pk_test_phase0';
    process.env.AI_IMAGE_FALLBACK = 'none';
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const events = new MemoryAiEventsRepository((id) => auth.usernameOf(id));
    const budget = new MemoryAiBudgetRepository();
    const app = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), aiUsage: new MemoryAiUsageRepository(), aiEvents: events, aiBudget: budget,
    });
    const fan = await reg(app, 'fan_phase0');
    await auth.markEmailVerified(fan.id);
    const COPY = { phrase: 'الزعيم', support: '', language: 'ar', mood: 'pride', voice: 'poster' };
    const isCopywriter = (b: Call['body']): boolean => JSON.stringify(b?.systemInstruction ?? '').includes('COPYWRITER');
    const withPicture = (n: number) => ({
      ...GOOD,
      layers: [...GOOD.layers, ...(['north', 'west'] as const).slice(0, n).map((stand) => ({ kind: 'image', region: stand, prompt: 'an eagle', scaleFrac: 0.9 }))],
    });

    // A Super design: copywriter + director + one picture, all on one row.
    respond = (_u, b) => (isCopywriter(b) ? specReply(COPY, { promptTokenCount: 500, candidatesTokenCount: 40 }) : specReply(withPicture(1)));
    const s1 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Hilal zaeem eagle', mode: 'super', stadium: '- north: 900 seats' } })).json();
    assert.equal(s1.source, 'model', JSON.stringify(s1).slice(0, 300));
    assert.equal(s1.outcome.kind, 'full');
    const st1 = await events.stats(30);
    assert.equal(st1.cost.measured, 1);
    assert.equal(st1.cost.byMode.super.delivered, 1);
    assert.deepEqual([st1.cost.tokens.in, st1.cost.tokens.out, st1.cost.tokens.thought], [3500, 940, 1500], 'the copywriter and the director are both counted');
    assert.equal(st1.cost.pictures, 1);
    assert.ok(st1.cost.usd > 0.002, `priced, the picture included: ${st1.cost.usd}`);
    assert.deepEqual(st1.cost.models.map((m) => m.model), ['gemini-3.6-flash'], 'the model that answered is on file');
    assert.ok(st1.cost.latencyMs.super !== null && st1.cost.latencyMs.super! >= 0);
    assert.equal(st1.modeOutcomes.super.model, 1);
    assert.equal(picturesToday(), 1, 'the picture is counted in the day\'s picture budget');

    // A Standard design the fast model could not make, made by the fallback.
    respond = (u) => (modelIn(u) === 'gemini-3.1-flash-lite' ? refuse(503, 'high demand') : specReply(GOOD));
    const s2 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Ittihad tigers gold' } })).json();
    assert.equal(s2.source, 'model', `the fallback made the design instead of "busy": ${JSON.stringify(s2).slice(0, 200)}`);
    const st2 = await events.stats(30);
    assert.ok(st2.cost.models.some((m) => m.model === 'gemini-3.5-flash-lite'), 'and the fallback is named as the model that answered');
    assert.equal(st2.modeOutcomes.std.model, 1);

    // A Polish that works is on file now, and is not a design.
    respond = () => specReply(s2.spec);
    const p = (await app.inject({ method: 'POST', url: '/api/ai/critique', headers: bearer(fan.token), payload: { spec: s2.spec } })).json();
    assert.equal(p.source, 'model', JSON.stringify(p).slice(0, 200));
    const st3 = await events.stats(30);
    assert.equal(st3.modeOutcomes.polish.model, 1, 'a successful Polish is recorded');
    assert.equal(st3.window.model, 2, 'and not counted as a design');
    assert.equal(st3.perDay.reduce((n, d) => n + d.model, 0), 2);
    assert.equal(st3.window.all, 3);

    // A request that failed is measured too: it made calls.
    respond = () => refuse(503, 'high demand');
    const s4 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Nassr yellow storm' } })).json();
    assert.equal(s4.needsChoice, true);
    const st4 = await events.stats(30);
    assert.equal(st4.modeOutcomes.std.busy, 1);
    assert.equal(st4.cost.byMode.std.measured, 2, 'the failed request is measured');
    assert.ok(st4.recentFailures[0].detail.includes('gemini-3.5-flash-lite') && st4.recentFailures[0].detail.includes('gemini-3.1-flash-lite'), st4.recentFailures[0].detail);

    // Both models refuse for DIFFERENT reasons: the first model's is the
    // reason. A busy premium model is "try again", not "resting till tomorrow".
    respond = (u) => (modelIn(u) === 'gemini-3.1-flash-lite' ? refuse(503, 'This model is currently experiencing high demand.') : refuse(429, 'You exceeded your current quota.'));
    const s5 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Shabab green wave' } })).json();
    assert.equal(s5.needsChoice, true);
    assert.equal(s5.cause, 'busy', `the first model's reason reaches the user: ${s5.cause}`);
    const st5 = await events.stats(30);
    assert.equal(st5.recentFailures[0].reason, 'overloaded', 'and the operator\'s reason is the first model\'s');
    assert.ok(st5.recentFailures[0].detail.includes('quota'), `the fallback's answer stays in the detail: ${st5.recentFailures[0].detail}`);

    // The budget store has every call the memory counter has.
    const today = new Date().toISOString().slice(0, 10);
    const stored = await budget.load(today);
    assert.equal(stored.calls, premiumCallsToday(), `stored ${stored.calls}, counted ${premiumCallsToday()}`);
    assert.equal(stored.pictures, 1);

    // ---- the daily budget survives a restart ----
    forgetBudgetMemoryForTests(); // what a deploy does to the memory count
    await budget.add(today, 1_000_000, 0);
    const app2 = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), aiUsage: new MemoryAiUsageRepository(), aiEvents: events, aiBudget: budget,
    });
    calls.length = 0;
    respond = () => specReply(GOOD);
    const r2 = (await app2.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'after the deploy' } })).json();
    assert.equal(r2.needsChoice, true, 'the day\'s spent budget is read back after a restart');
    assert.equal(r2.reason, 'busy');
    assert.equal(calls.length, 0, 'and no model is called');
    const st6 = await events.stats(30);
    assert.equal(st6.modeOutcomes.std.limited, 1, 'a budget refusal is our limit, not the model failing');
    await app2.close();

    // ---- a read-back that fails is tried again, and never holds a request up ----
    forgetBudgetMemoryForTests();
    let loads = 0;
    const flaky = {
      load: (_day: string) => (++loads === 1 ? new Promise<{ calls: number; pictures: number }>(() => {}) : Promise.resolve({ calls: 1_000_000, pictures: 0 })),
      add: async () => {},
    };
    const app4 = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), aiUsage: new MemoryAiUsageRepository(), aiEvents: events, aiBudget: flaky,
    });
    respond = () => specReply(GOOD);
    const t0 = Date.now();
    const h1 = (await app4.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'store hangs' } })).json();
    assert.equal(h1.source, 'model', 'a store that does not answer does not stop the design');
    assert.ok(Date.now() - t0 < 6000, `and the wait for it is bounded: ${Date.now() - t0} ms`);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      const h2 = (await app4.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'store is back' } })).json();
      assert.equal(loads, 2, 'the read-back is tried again a minute later');
      assert.equal(h2.needsChoice, true, 'and the stored count it finds applies the same day');
    } finally {
      Date.now = realNow;
    }
    await app4.close();

    // ---- the site-wide picture budget ----
    forgetBudgetMemoryForTests();
    process.env.AI_DAILY_PICTURE_BUDGET = '1';
    const app3 = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), aiUsage: new MemoryAiUsageRepository(), aiEvents: events, aiBudget: new MemoryAiBudgetRepository(),
    });
    respond = (_u, b) => (isCopywriter(b) ? specReply(COPY) : specReply(withPicture(2)));
    const pr = (await app3.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'two pictures please', mode: 'super' } })).json();
    assert.equal(pr.outcome.kind, 'degraded', JSON.stringify(pr.outcome));
    assert.deepEqual([pr.outcome.missingCount, pr.outcome.of], [1, 2], 'the second picture was not asked for');
    assert.equal(pr.outcome.charged, false, 'and the incomplete design is not charged');
    assert.equal(picturesToday(), 1);
    await app3.close();
    await app.close();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    forgetBudgetMemoryForTests();
  }
  console.log('ai phase 0 (17 October): all assertions passed (retired id pinned, key in a header, no temperature, fallback on 503/429/timeout/404 and not on a refused key (401 or Google’s 400), old rules with the fallback off, usage + cost + model + latency on file, Polish successes recorded and not counted as designs, failed requests measured, budget survives a restart and a failed read-back is retried, site-wide picture budget, the first model’s reason when both fail, unknown prices never read as $0, our own limits apart from failures)');
}

// ---------- 2026-10-18: Claude first, Gemini behind it ----------
// The Max plan carries $100 of Claude API credit a month, used or lost, so
// Claude writes the designs and Gemini (free tier) takes over when Claude
// cannot: busy, down, out of the month's credit, a refused key.
{
  const prov = await import('../src/aiProvider');
  const pricing = await import('../src/aiPricing');
  const { classifyAiFailure } = await import('../src/aiFailure');
  const { configWarnings } = await import('../src/preflight');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository, MemoryAiBudgetRepository } = await import('../src/memoryRepo');
  const { forgetBudgetMemoryForTests } = await import('../src/aiRoutes');
  const KEYS = [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_MODEL_PREMIUM', 'AI_MODEL_FAST', 'AI_MODEL_FALLBACK',
    'AI_MODEL_FALLBACK_PREMIUM', 'AI_MODEL_FALLBACK_FAST', 'AI_TIMEOUT_MS', 'AI_TIMEOUT_PREMIUM_MS', 'AI_TIMEOUT_RETRY', 'AI_RETRY_DELAY_MS',
    'AI_POLLINATIONS_KEY', 'POLLINATIONS_KEY', 'AI_IMAGE_FALLBACK', 'AI_IMAGE_PROVIDER', 'AI_DAILY_PICTURE_BUDGET', 'AI_COPYWRITER',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_RESPONSE_SCHEMA', 'AI_CLAUDE_MODEL_FAST', 'AI_CLAUDE_MODEL_PREMIUM', 'AI_CLAUDE_EFFORT_FAST',
    'AI_CLAUDE_EFFORT_PREMIUM', 'AI_CLAUDE_MAX_TOKENS', 'AI_PROVIDER_FALLBACK', 'AI_PROVIDER_COOLDOWN_MS', 'AI_CLOUDFLARE_ACCOUNT_ID', 'AI_CLOUDFLARE_API_TOKEN',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-TESTKEY000000000000';
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';
  // What Railway may well hold from the Gemini days: Claude must not be asked for it.
  process.env.AI_MODEL = 'gemini-3.6-flash';
  process.env.AI_MODEL_PREMIUM = 'gemini-3.6-flash';
  process.env.AI_MODEL_FAST = 'gemini-3.1-flash-lite';
  process.env.AI_TIMEOUT_MS = '1500';
  process.env.AI_TIMEOUT_PREMIUM_MS = '1500';
  process.env.AI_RETRY_DELAY_MS = '100';
  prov.resetProviderCooldownForTests();

  // ---- who answers, with which model ----
  assert.equal(prov.activeProvider(), 'anthropic', 'with both keys, Claude first');
  assert.equal(prov.backupProvider(), 'gemini', 'and Gemini behind it');
  assert.equal(prov.claudeModel('fast'), 'claude-haiku-5-5');
  assert.equal(prov.claudeModel('premium'), 'claude-sonnet-5-5', 'a Gemini id in AI_MODEL is not sent to Claude');
  process.env.AI_CLAUDE_MODEL_PREMIUM = 'claude-opus-5-5';
  assert.equal(prov.claudeModel('premium'), 'claude-opus-5-5');
  delete process.env.AI_CLAUDE_MODEL_PREMIUM;
  assert.equal(prov.claudeEffort('premium'), 'low');
  assert.equal(prov.claudeEffort('fast'), 'medium');
  process.env.AI_CLAUDE_EFFORT_PREMIUM = 'hard';
  assert.equal(prov.claudeEffort('premium'), 'low', 'an unknown effort falls back to the default');
  delete process.env.AI_CLAUDE_EFFORT_PREMIUM;
  assert.deepEqual(prov.claudeThinking('claude-haiku-5-5', 'fast', 'medium'), { type: 'disabled' });
  assert.deepEqual(prov.claudeThinking('claude-sonnet-5-5', 'fast', 'medium'), { type: 'between_tools' });
  assert.equal(prov.claudeThinking('claude-opus-5-5', 'fast', 'medium'), undefined, 'Opus cannot turn thinking off');
  assert.equal(prov.claudeThinking('claude-haiku-5-5', 'fast', 'xhigh'), undefined);
  assert.equal(prov.claudeThinking('claude-sonnet-5-5', 'premium', 'low'), undefined, 'premium thinks');
  process.env.AI_PROVIDER_FALLBACK = 'none';
  assert.equal(prov.backupProvider(), null);
  delete process.env.AI_PROVIDER_FALLBACK;
  process.env.AI_PROVIDER = 'gemini';
  assert.equal(prov.backupProvider(), null, 'Gemini as main has its fallback model, nothing behind it');
  delete process.env.AI_PROVIDER;
  assert.equal(pricing.textCostMicros('claude-sonnet-5-5', { in: 1_000_000, out: 0, thought: 0, cached: 0 }), 2_000_000);
  assert.equal(pricing.textCostMicros('claude-haiku-5-5', { in: 0, out: 1_000_000, thought: 0, cached: 0 }), 500_000);
  assert.equal(pricing.textCostMicros('claude-opus-5-5', { in: 1000, out: 1000, thought: 0, cached: 0 }), 24_000);
  const CREDIT = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
  assert.equal(prov.isAccountProblem(400, CREDIT), true);
  assert.equal(prov.isAccountProblem(401, 'invalid x-api-key'), true);
  assert.equal(prov.isAccountProblem(529, 'Overloaded'), false);
  assert.equal(prov.isAccountProblem(400, 'messages: field required'), false);
  assert.equal(classifyAiFailure(`claude "claude-sonnet-5-5": HTTP 400: ${CREDIT}`, 400).reason, 'rate_limited', 'spent credit reads as a quota, and the user is told "resting"');

  // ---- the boot report ----
  const prodEnv = { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv;
  assert.ok(configWarnings(prodEnv).some((w) => w.key === 'GEMINI_API_KEY' && /no backup/.test(w.effect)), 'Claude with nothing behind it is said out loud');
  assert.equal(configWarnings({ ...prodEnv, GEMINI_API_KEY: 'g' }).filter((w) => w.key === 'GEMINI_API_KEY').length, 0);
  assert.ok(configWarnings({ ...prodEnv, AI_CLAUDE_MODEL_PREMIUM: 'gemini-3.6-flash' }).some((w) => w.key === 'AI_CLAUDE_MODEL_PREMIUM' && w.state === 'wrong'));
  assert.ok(configWarnings({ ...prodEnv, AI_CLAUDE_EFFORT_PREMIUM: 'hard' }).some((w) => w.key === 'AI_CLAUDE_EFFORT_PREMIUM' && w.state === 'wrong'));

  // ---- a stubbed Claude and Gemini ----
  const realFetch = globalThis.fetch;
  type Body = Record<string, unknown> & { model?: string; output_config?: { effort?: string }; thinking?: unknown; max_tokens?: number; system?: unknown };
  type Call = { who: 'claude' | 'gemini'; model: string; headers: Record<string, string>; body: Body };
  const calls: Call[] = [];
  const modelIn = (u: string): string => /models\/([^:]+):/.exec(u)?.[1] ?? '';
  const USAGE = { input_tokens: 3000, output_tokens: 1400, cache_read_input_tokens: 0 };
  const claudeReply = (spec: unknown, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: 'about { braces }' }, { type: 'text', text: JSON.stringify(spec) }], stop_reason: 'end_turn', usage: USAGE, ...extra }), { status: 200 });
  const geminiReply = (spec: unknown) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(spec) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 800 } }), { status: 200 });
  const err = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  let onClaude: (b: Body) => Response | Promise<Response> = () => err(500, 'no plan');
  let onGemini: (model: string) => Response = () => err(500, 'no plan');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Body;
    if (url === 'https://api.anthropic.com/v1/messages') {
      calls.push({ who: 'claude', model: String(body.model), headers, body });
      return onClaude(body);
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      calls.push({ who: 'gemini', model: modelIn(url), headers, body });
      return onGemini(modelIn(url));
    }
    if (url.includes('pollinations')) return new Response(Buffer.alloc(400, 7), { status: 200, headers: { 'content-type': 'image/png' } });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const GOOD = {
    title: 'Zaeem', palette: ['#262a33', '#0033a0', '#ffffff', '#d4af37'],
    layers: [{ kind: 'fill', region: 'all', colorIndex: 1 }, { kind: 'text', region: 'south', text: 'ZAEEM', colorIndex: 2, fontId: 'poster', heightFrac: 0.7 }],
  };
  const OVERLOADED = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  const who = (): string[] => calls.map((c) => `${c.who}:${c.model}`);

  try {
    // 1. Claude answers: the request it gets, and what the result carries.
    calls.length = 0;
    onClaude = () => claudeReply(GOOD);
    const p1 = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.ok(p1.spec, String(p1.error));
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5']);
    const c = calls[0];
    assert.equal(c.headers['x-api-key'], 'sk-ant-api03-TESTKEY000000000000');
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.equal(c.body.output_config?.effort, 'low');
    assert.equal(c.body.thinking, undefined, 'premium keeps adaptive thinking');
    assert.equal(c.body.max_tokens, 16000);
    assert.equal(typeof c.body.system, 'string');
    assert.equal(p1.provider, 'anthropic');
    assert.equal(p1.model, 'claude-sonnet-5-5');
    assert.deepEqual([p1.usage!.calls, p1.usage!.in, p1.usage!.out], [1, 3000, 1400]);
    assert.equal(p1.usage!.costMicros, 20_000, '3,000 in + 1,400 out on Sonnet 5.5 = $0.02');
    calls.length = 0;
    await prov.generateSpecViaProvider('brief', { tier: 'fast' });
    assert.deepEqual(who(), ['claude:claude-haiku-5-5']);
    assert.deepEqual(calls[0].body.thinking, { type: 'disabled' }, 'the fast tier does not think');
    assert.equal(calls[0].body.output_config?.effort, 'medium');

    // 2. Claude overloaded: Gemini answers, its tier model.
    calls.length = 0;
    onClaude = () => err(529, OVERLOADED);
    onGemini = () => geminiReply(GOOD);
    const p2 = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.ok(p2.spec);
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5', 'gemini:gemini-3.6-flash']);
    assert.equal(p2.provider, 'gemini');
    assert.equal(p2.fellBackFrom, 'claude-sonnet-5-5');
    assert.equal(p2.usage!.calls, 2);

    // 3. ...and when Gemini's model is busy too, Gemini's own fallback model.
    calls.length = 0;
    onGemini = (m) => (m === 'gemini-3.6-flash' ? err(503, '{"error":{"code":503,"message":"high demand"}}') : geminiReply(GOOD));
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec);
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5', 'gemini:gemini-3.6-flash', 'gemini:gemini-3.5-flash-lite']);

    // 4. All three fail: the reason is Claude's, the detail has every answer.
    calls.length = 0;
    onGemini = () => err(429, '{"error":{"code":429,"message":"You exceeded your current quota"}}');
    const p4 = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.equal(p4.spec, null);
    assert.equal(calls.length, 3, 'three calls at most');
    assert.equal(p4.firstFailure?.status, 529);
    assert.ok(/claude-sonnet-5-5.*then fallback/.test(p4.error!), p4.error);
    assert.equal(classifyAiFailure(p4.firstFailure!.error, p4.firstFailure!.status).reason, 'overloaded');

    // 5. A timeout: one quick call to Gemini's fallback model, not two more.
    calls.length = 0;
    onClaude = (b) => new Promise<Response>(() => { void b; }); // never answers; the call's own timeout aborts it
    const stuck = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://api.anthropic.com/v1/messages') {
        calls.push({ who: 'claude', model: 'claude', headers: {}, body: {} });
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return stuck(input, init);
    }) as typeof fetch;
    onGemini = () => err(503, '{"error":{"code":503,"message":"high demand"}}');
    const p5 = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.equal(p5.spec, null);
    assert.deepEqual(who(), ['claude:claude', 'gemini:gemini-3.5-flash-lite'], 'after a timeout, one call to the quick model');
    globalThis.fetch = stuck;

    // 6. Claude declines the brief: not shopped around to Gemini.
    calls.length = 0;
    onClaude = () => claudeReply({}, { content: [], stop_reason: 'refusal' });
    const p6 = await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.equal(p6.spec, null);
    assert.equal(p6.refused, true);
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5'], 'a refusal is a decision about the content');
    assert.equal(classifyAiFailure(p6.error!).reason, 'safety');

    // 7. A reply that is not JSON goes to Gemini.
    calls.length = 0;
    onClaude = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Here is a lovely tifo idea!' }], stop_reason: 'end_turn', usage: USAGE }), { status: 200 });
    onGemini = () => geminiReply(GOOD);
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'fast' })).spec);
    assert.deepEqual(who(), ['claude:claude-haiku-5-5', 'gemini:gemini-3.1-flash-lite']);

    // 8. An older model that does not take a setting: asked again without
    //    THAT setting only, and the extra call is counted.
    calls.length = 0;
    process.env.AI_CLAUDE_MODEL_FAST = 'claude-haiku-4-5';
    onClaude = (b) => (b.thinking ? err(400, '{"type":"error","error":{"type":"invalid_request_error","message":"thinking.type: disabled is not supported on this model"}}') : claudeReply(GOOD));
    const p8 = await prov.generateSpecViaProvider('brief', { tier: 'fast' });
    assert.ok(p8.spec, String(p8.error));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.thinking, undefined, 'the thinking setting is dropped');
    assert.equal(calls[1].body.output_config?.effort, 'medium', 'the effort level is kept');
    assert.equal(p8.usage!.calls, 2, 'the refused first try is counted');
    calls.length = 0;
    onClaude = (b) => (b.output_config ? err(400, '{"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: Extra inputs are not permitted"}}') : claudeReply(GOOD));
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'fast' })).spec);
    assert.equal(calls[1].body.output_config, undefined, 'and an effort the model refuses is dropped');
    assert.deepEqual(calls[1].body.thinking, { type: 'disabled' });
    delete process.env.AI_CLAUDE_MODEL_FAST;
    assert.equal(prov.claudeThinking('claude-sonnet-5', 'fast', 'medium'), undefined, '"between_tools" is a Sonnet 5.5 setting only');

    // 8b. A slow failure (an answer after half the time limit): one quick
    //     Gemini call, not two more. AI_TIMEOUT_RETRY=0: none after a timeout.
    calls.length = 0;
    onClaude = () => new Promise<Response>((res) => setTimeout(() => res(err(500, '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}')), 900));
    onGemini = () => err(503, '{"error":{"code":503,"message":"high demand"}}');
    await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5', 'gemini:gemini-3.5-flash-lite']);
    // A Gemini AI_MODEL left over from Claude's old setup is never asked of Google.
    process.env.AI_MODEL = 'claude-sonnet-4-6';
    delete process.env.AI_MODEL_PREMIUM;
    assert.equal(prov.geminiModel('premium'), 'gemini-2.5-flash', 'a Claude id in AI_MODEL is not a Gemini model');
    assert.equal(prov.claudeModel('premium'), 'claude-sonnet-4-6', 'it still names the Claude model, as before');
    process.env.AI_MODEL = 'gemini-3.6-flash';
    process.env.AI_MODEL_PREMIUM = 'gemini-3.6-flash';
    onGemini = () => geminiReply(GOOD);

    // 8c. The tier's monthly spend cap answers 429, and pauses Claude too.
    assert.equal(prov.isAccountProblem(429, '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits. You will regain access on 2026-11-01"},"error_code":"enforced_spend_limit_reached"}'), true);
    assert.equal(prov.isAccountProblem(429, '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), false, 'a per-minute limit is a busy minute');

    // 9. The month's credit is spent: Gemini answers, and Claude is skipped
    //    until the pause ends, then asked again.
    calls.length = 0;
    process.env.AI_PROVIDER_COOLDOWN_MS = '300';
    onClaude = () => err(400, CREDIT);
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec);
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5', 'gemini:gemini-3.6-flash']);
    assert.ok(prov.providerCooldown(), 'Claude is paused');
    assert.match(prov.textModelsStatus().paused!.why, /credit balance is too low/);
    calls.length = 0;
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec);
    assert.deepEqual(who(), ['gemini:gemini-3.6-flash'], 'while paused, no doomed round trip to Claude');
    await new Promise((r) => setTimeout(r, 350));
    calls.length = 0;
    onClaude = () => claudeReply(GOOD);
    assert.ok((await prov.generateSpecViaProvider('brief', { tier: 'premium' })).spec);
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5'], 'the new month\'s credit heals on its own');
    delete process.env.AI_PROVIDER_COOLDOWN_MS;
    prov.resetProviderCooldownForTests();

    // 9b. AI_TIMEOUT_RETRY=0 still means one call after a timeout.
    const stuck2 = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://api.anthropic.com/v1/messages') {
        calls.push({ who: 'claude', model: 'claude', headers: {}, body: {} });
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return stuck2(input, init);
    }) as typeof fetch;
    process.env.AI_TIMEOUT_RETRY = '0';
    calls.length = 0;
    await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.deepEqual(who(), ['claude:claude']);
    delete process.env.AI_TIMEOUT_RETRY;
    globalThis.fetch = stuck2;

    // 10. No Gemini key: Claude alone, with a same-model retry when overloaded.
    delete process.env.GEMINI_API_KEY;
    calls.length = 0;
    onClaude = () => err(529, OVERLOADED);
    await prov.generateSpecViaProvider('brief', { tier: 'premium' });
    assert.deepEqual(who(), ['claude:claude-sonnet-5-5', 'claude:claude-sonnet-5-5'], 'one retry on 529, as on Google\'s 503');
    process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY0000000000';

    // ---- through the routes ----
    forgetBudgetMemoryForTests();
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const events = new MemoryAiEventsRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, {
      social: new MemorySocialRepository(designs, auth), aiUsage: new MemoryAiUsageRepository(), aiEvents: events, aiBudget: new MemoryAiBudgetRepository(),
    });
    const fan = await reg(app, 'fan_claude');
    await auth.markEmailVerified(fan.id);
    process.env.AI_POLLINATIONS_KEY = 'pk_test_claude';
    const COPY = { phrase: 'الزعيم', support: '', language: 'ar', mood: 'pride', voice: 'poster' };
    onClaude = (b) => (JSON.stringify(b.system ?? '').includes('COPYWRITER') ? claudeReply(COPY) : claudeReply(GOOD));
    calls.length = 0;
    const s1 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Hilal zaeem', mode: 'super', stadium: '- north: 900 seats' } })).json();
    assert.equal(s1.source, 'model', JSON.stringify(s1).slice(0, 300));
    assert.deepEqual(who(), ['claude:claude-haiku-5-5', 'claude:claude-sonnet-5-5'], 'the copywriter on Haiku, the director on Sonnet');
    const st = await events.stats(30);
    assert.deepEqual(st.cost.models.map((m) => m.model), ['claude-sonnet-5-5'], 'Claude is on file as the model that answered');
    assert.ok(st.cost.usd > 0, 'and priced');
    // A Standard design Claude cannot make, made by Gemini, is a success.
    onClaude = () => err(529, OVERLOADED);
    onGemini = () => geminiReply(GOOD);
    const s2 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Ittihad tigers' } })).json();
    assert.equal(s2.source, 'model');
    assert.ok((await events.stats(30)).cost.models.some((m) => m.model === 'gemini-3.1-flash-lite'), 'and Gemini is named as the model that answered');
    // Everything refuses: the user is told "busy", the operator gets Claude's reason.
    onGemini = () => err(503, '{"error":{"code":503,"message":"high demand"}}');
    const s3 = (await app.inject({ method: 'POST', url: '/api/ai/generate', headers: bearer(fan.token), payload: { prompt: 'Nassr yellow' } })).json();
    assert.equal(s3.needsChoice, true);
    assert.equal(s3.cause, 'busy');
    const f = (await events.stats(30)).recentFailures[0];
    assert.equal(f.reason, 'overloaded');
    assert.ok(/claude-haiku-5-5/.test(f.detail) && /gemini/.test(f.detail), f.detail);
    assert.ok(!/sk-ant-api03-TESTKEY/.test(JSON.stringify(await events.stats(30))), 'no key on file');
    await app.close();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    prov.resetProviderCooldownForTests();
    forgetBudgetMemoryForTests();
  }
  console.log('claude first (18 October): all assertions passed (Haiku fast + Sonnet premium, a Gemini AI_MODEL never sent to Claude, effort and thinking per tier, Gemini behind Claude then its own fallback, three calls at most, one quick call after a slow failure, refusals not shopped around, an older model asked again without the setting it refuses, spent credit or the spend cap pauses Claude and heals, a Claude AI_MODEL never sent to Google, Claude alone retries 529, routes record Claude and Gemini, the first model\'s reason)');
}

// ---------- 2026-10: audit round six ----------
// Found during the October performance review: caching that a CDN would turn
// into leaks, checks that opened when the database failed, and a few smaller
// holes. Every block here fails on the code before the fix.
{
  const { existsSync } = await import('node:fs');
  const { gunzipSync } = await import('node:zlib');
  const { resolve } = await import('node:path');
  const { MemoryDailyFeatureRepository } = await import('../src/featureRepo');
  const { safeEqual: eq6, mintUnlock: mint6, verifyUnlock: verify6 } = await import('../src/aiRoutes');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const R6PW = 'quartz-lantern-echo7';
  const R6PW2 = 'harbour-violet-signal4';
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const SECRET_PIC = 'data:image/png;base64,T1dORVJTLVBJQ1RVUkUtUjY=';

  /** Repositories that can be told to fail, for the paths that must fail closed. */
  class FlakyAuth extends MemoryAuthRepository {
    failUsernameCheck = false;
    /** Fail the next N account reads: the first lookup a route makes. */
    failGetUserCalls = 0;
    failPasswordWrites = false;
    override async hasChosenUsername(userId: string): Promise<boolean> {
      if (this.failUsernameCheck) throw new Error('connection terminated');
      return super.hasChosenUsername(userId);
    }
    // The name check is read with the session now, in one statement
    // (performance plan P2.17), so the same switch breaks that read.
    override async getSessionUser(tokenHash: string): ReturnType<MemoryAuthRepository['getSessionUser']> {
      if (this.failUsernameCheck) throw new Error('connection terminated');
      return super.getSessionUser(tokenHash);
    }
    override async getUserById(userId: string): ReturnType<MemoryAuthRepository['getUserById']> {
      if (this.failGetUserCalls > 0) {
        this.failGetUserCalls--;
        throw new Error('connection terminated');
      }
      return super.getUserById(userId);
    }
    override async deleteUserTokens(userId: string): Promise<void> {
      if (this.failPasswordWrites) throw new Error('connection terminated');
      return super.deleteUserTokens(userId);
    }
    /**
     * A reset (to this hash) that lands between a change's password check and
     * its write: the next password change or email change runs it first.
     */
    resetDuring: string | null = null;
    private async landReset(userId: string): Promise<void> {
      const h = this.resetDuring;
      this.resetDuring = null;
      if (h) await super.replacePassword(userId, h, { dropIdentities: true });
    }
    /** Another sign-in upgrading the same password's hash, mid-change (to this new hash). */
    rehashDuring: string | null = null;
    override async replacePassword(...args: Parameters<MemoryAuthRepository['replacePassword']>): Promise<boolean> {
      if (this.failPasswordWrites) throw new Error('connection terminated');
      if (this.resetDuring && args[2]?.expectedHash !== undefined) await this.landReset(args[0]);
      if (this.rehashDuring && typeof args[2]?.expectedHash === 'string') {
        const next = this.rehashDuring;
        this.rehashDuring = null;
        await super.upgradePasswordHash(args[0], args[2].expectedHash, next);
      }
      return super.replacePassword(...args);
    }
    override async setEmail(...args: Parameters<MemoryAuthRepository['setEmail']>): Promise<boolean> {
      if (this.resetDuring) await this.landReset(args[0]);
      return super.setEmail(...args);
    }
    /** An email change that lands while a forgot-password request is being handled. */
    moveDuringLookup: string | null = null;
    override async getUserByEmail(email: string): ReturnType<MemoryAuthRepository['getUserByEmail']> {
      const u = await super.getUserByEmail(email);
      const snap = u ? { ...u } : null;
      if (u && this.moveDuringLookup) {
        const to = this.moveDuringLookup;
        this.moveDuringLookup = null;
        await super.setEmail(u.id, to);
      }
      return snap;
    }
    failDeleteEmailTokens = false;
    override async deleteEmailTokens(userId: string, purpose: string): Promise<void> {
      if (this.failDeleteEmailTokens) throw new Error('connection terminated');
      return super.deleteEmailTokens(userId, purpose);
    }
    /**
     * A reset that lands while a sign-in is checking the password: the sign-in
     * has read the account (a copy, as Postgres hands back), then the password
     * is replaced and every session ended, then the sign-in carries on.
     */
    raceReset: string | null = null;
    override async getUserByName(username: string): ReturnType<MemoryAuthRepository['getUserByName']> {
      const u = await super.getUserByName(username);
      const snap = u ? { ...u } : null;
      if (u && this.raceReset) {
        const next = this.raceReset;
        this.raceReset = null;
        await this.replacePassword(u.id, next);
      }
      return snap;
    }
  }
  class FlakyDesigns extends MemoryDesignRepository {
    failTakedown = false;
    override async takedownDesign(designId: string): Promise<boolean> {
      if (this.failTakedown) throw new Error('connection terminated');
      return super.takedownDesign(designId);
    }
    /** A repository that forgot to carry a takedown into the copy. */
    forkLosesTakedown = false;
    override async fork(id: string, title: string, ownerId: string): ReturnType<MemoryDesignRepository['fork']> {
      const meta = await super.fork(id, title, ownerId);
      if (!meta || !this.forkLosesTakedown) return meta;
      const row = (this as unknown as { rows: Map<string, { takenDown?: boolean }> }).rows.get(meta.id);
      if (row) row.takenDown = false;
      return { ...meta, takenDown: false };
    }
  }

  const auth = new FlakyAuth();
  const designs = new FlakyDesigns((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const featured = new MemoryDailyFeatureRepository();
  const dist = existsSync('dist/index.html') ? resolve('dist') : process.cwd();
  const sent6: { to: string; subject?: string; text?: string; html: string }[] = [];
  const app = await buildApp(designs, auth, templates, {
    social, featured, leads: new MemoryLeadsRepository(),
    staticDir: dist, adminUsernames: ['mod_r6', 'chief_r6'], aiAdminPassword: 'r6 admin password',
    emailSender: { send: async (m: { to: string; subject?: string; text?: string; html: string }) => { sent6.push(m); } } as never,
  });
  const r6 = async (u: string): Promise<{ token: string; id: string }> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: R6PW, email: `${u}@example.test`, acceptedVersion: 'test', adminPassword: 'r6 admin password' } });
    assert.equal(r.statusCode, 201, r.body);
    const token = (r.json() as { token: string }).token;
    return { token, id: (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string };
  };
  const design = async (token: string, pub: boolean, title = 'R6'): Promise<string> => {
    const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG_B64 } });
    assert.equal(d.statusCode, 201, d.body);
    const id = (d.json() as { id: string }).id;
    if (pub) assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } })).statusCode, 200);
    return id;
  };
  const issueR6Session = async (userId: string): Promise<string> => {
    const raw = `r6-session-${userId}-${Math.random().toString(36).slice(2)}`;
    await auth.createToken(userId, hashToken(raw), new Date(Date.now() + 3600_000));
    return raw;
  };
  const owner = await r6('owner_r6');
  const other = await r6('other_r6');
  const mod = await r6('mod_r6');

  // ---- MEDIUM: a private design's card and picture were cacheable by anyone ----
  {
    const priv = await design(owner.token, false);
    const pub = await design(owner.token, true);
    const ogPriv = await app.inject({ method: 'GET', url: `/og/t/${priv}.png`, headers: bearer(owner.token) });
    assert.equal(ogPriv.statusCode, 200);
    assert.equal(ogPriv.headers['cache-control'], 'private, no-store', 'a private design’s card is never public');
    const ogLegacy = await app.inject({ method: 'GET', url: `/api/designs/${priv}/og.png`, headers: bearer(owner.token) });
    assert.equal(ogLegacy.headers['cache-control'], 'private, no-store', 'on the old URL too');
    assert.equal((await app.inject({ method: 'GET', url: `/og/t/${pub}.png` })).headers['cache-control'], 'public, max-age=3600', 'a public card still caches');
    const thPriv = await app.inject({ method: 'GET', url: `/api/designs/${priv}/thumbnail.png`, headers: bearer(owner.token) });
    assert.equal(thPriv.headers['cache-control'], 'private, no-store', 'a private thumbnail is not kept in any cache');
    // `public, no-cache` with its content-hash ETag since performance plan
    // P2.4: kept, but asked about every time, and the visibility check runs
    // before the ETag is compared (the stage 2 block at the end of this file).
    assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${pub}/thumbnail.png` })).headers['cache-control'], 'public, no-cache', 'a public one keeps its own policy');

    // ---- MEDIUM: answers about one person carried no Cache-Control ----
    await app.inject({ method: 'PUT', url: `/api/designs/${priv}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [] }))).toString('base64') } });
    const personal: [string, string][] = [
      ['/api/me', owner.token],
      [`/api/designs/${priv}`, owner.token],
      [`/api/designs/${priv}/scene`, owner.token],
      ['/api/gallery', owner.token],
      ['/api/notifications', owner.token],
      ['/api/account/export', owner.token],
      [`/api/users/${owner.id}/profile`, other.token],
    ];
    for (const [url, token] of personal) {
      const r = await app.inject({ method: 'GET', url, headers: bearer(token) });
      assert.equal(r.statusCode, 200, `${url}: ${r.body.slice(0, 120)}`);
      // The export carries everything the account holds, so it also says
      // no-transform (performance plan P2.3: no edge compresses a secret).
      assert.equal(r.headers['cache-control'], url === '/api/account/export' ? 'no-store, no-transform' : 'no-store', `${url} must say no-store`);
    }
    for (const url of ['/api/nope', `/api/designs/${priv}`, '/admin.js', '/og/t/00000000-0000-4000-8000-000000000000.png']) {
      const r = await app.inject({ method: 'GET', url });
      assert.ok(r.statusCode >= 400, `${url} refused (${r.statusCode})`);
      check(/no-store|no-cache/.test(String(r.headers['cache-control'] ?? '')), `${url}: a refusal says how it may be cached (${r.headers['cache-control']})`);
    }
    // Decided on the route that answered, not on how the path was spelled.
    const spelled = await app.inject({ method: 'GET', url: '/%61pi/me', headers: bearer(owner.token) });
    if (spelled.statusCode === 200) check(spelled.headers['cache-control'] === 'no-store', `/%61pi/me is /api/me (${spelled.headers['cache-control']})`);
    // A route that chose its own policy keeps it.
    const proj = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(owner.token) });
    assert.equal(proj.headers['cache-control'], 'no-store');

    // ---- LOW: server-rendered pages named no cache policy ----
    for (const url of ['/community', `/t/${pub}`, `/d/${pub}`, `/s/${pub}`, '/clubs', '/legal', '/tifo-spec']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, `${url} (${r.statusCode})`);
      assert.equal(r.headers['cache-control'], 'no-cache', `${url} must say no-cache`);
    }
  }

  // ---- LOW: a forged port went into the canonical URL ----
  {
    const page = await app.inject({ method: 'GET', url: '/community', headers: { host: 'tifomaker.org:1234' } });
    check(!page.body.includes('tifomaker.org:1234'), 'a port on a public name is not echoed into the page');
    check(page.body.includes('https://tifomaker.org/community'), 'it falls back to the canonical address');
    const dev = await app.inject({ method: 'GET', url: '/community', headers: { host: 'localhost:5173' } });
    check(dev.body.includes('http://localhost:5173/community'), 'a dev host keeps its port');
  }

  // ---- LOW-MEDIUM: "signed out everywhere" when it had not happened ----
  {
    const u = await r6('pw_r6');
    const login = async (password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pw_r6', password } });
    const second = (await login(R6PW)).json().token as string;
    auth.failPasswordWrites = true;
    const r = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(u.token), payload: { currentPassword: R6PW, newPassword: R6PW2 } });
    auth.failPasswordWrites = false;
    check(r.statusCode !== 200 && !/signedOutEverywhereElse/.test(r.body), `a failed sign-out is not reported as done (${r.statusCode} ${r.body.slice(0, 120)})`);
    check((await login(R6PW)).statusCode === 200, 'and nothing changed: the old password still works');
    // When it works, it all works.
    const ok = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(u.token), payload: { currentPassword: R6PW, newPassword: R6PW2 } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(second) })).statusCode, 401, 'the other session is gone');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(ok.json().token as string) })).statusCode, 200, 'this one stays signed in');
    assert.equal((await login(R6PW)).statusCode, 401);

    // The reset path: all of it, or none of it.
    const resetSecret = 'r6-reset-secret-0123456789abcdef';
    await auth.createEmailToken(u.id, hashToken(resetSecret), 'reset_password', new Date(Date.now() + 3600_000));
    await auth.linkIdentity('google', 'g-sub-r6', u.id);
    auth.failPasswordWrites = true;
    const bad = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetSecret, newPassword: 'meadow-copper-orbit9' } });
    auth.failPasswordWrites = false;
    check(bad.statusCode === 503, `a reset that could not finish says so (${bad.statusCode})`);
    check((await login(R6PW2)).statusCode === 200, 'and the password it was meant to replace still works');
    const resetAgain = 'r6-reset-secret-fedcba9876543210';
    await auth.createEmailToken(u.id, hashToken(resetAgain), 'reset_password', new Date(Date.now() + 3600_000));
    const good = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetAgain, newPassword: 'meadow-copper-orbit9' } });
    assert.equal(good.statusCode, 200, good.body);
    assert.deepEqual(await auth.identitiesFor(u.id), [], 'a reset still removes the connected sign-ins');
    assert.equal((await login('meadow-copper-orbit9')).statusCode, 200);
  }

  // ---- MEDIUM: a sign-in that overlapped a reset kept its session ----
  {
    const { randomBytes, scryptSync } = await import('node:crypto');
    const { hashPassword: hash6 } = await import('../src/auth');
    const victim = await r6('race_r6');
    const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'race_r6', password } });
    // The thief signs in with the old password just as the owner resets it.
    auth.raceReset = await hash6('lantern-crimson-quay8');
    const thief = await login(R6PW);
    check(thief.statusCode === 401, `a sign-in checked against the old password gets no session once the reset lands (${thief.statusCode})`);
    if (thief.statusCode === 200) {
      check((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(thief.json().token as string) })).statusCode === 401, 'or at least not one that outlives the reset');
    }
    assert.equal((await login('lantern-crimson-quay8')).statusCode, 200, 'the new password works');
    void victim;

    // An account with a legacy hash: the sign-in's rehash used to write the
    // OLD password back over the new one.
    const salt = randomBytes(16);
    const legacy = `${salt.toString('hex')}:${scryptSync('ember-quill-harbor5', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
    const old = await auth.createUser('legacy_r6', legacy, { email: 'legacy_r6@example.test' });
    assert.ok(old);
    auth.raceReset = await hash6('signal-amber-forest2');
    const raced = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'legacy_r6', password: 'ember-quill-harbor5' } });
    check(raced.statusCode === 401, `the legacy sign-in that overlapped gets no session (${raced.statusCode})`);
    const afterOld = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'legacy_r6', password: 'ember-quill-harbor5' } });
    check(afterOld.statusCode === 401, 'and the old password is not written back');
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'legacy_r6', password: 'signal-amber-forest2' } })).statusCode, 200, 'the reset password stands');
    // Without a race, a legacy sign-in still upgrades in place and signs in.
    const clean = await auth.createUser('legacy2_r6', `${salt.toString('hex')}:${scryptSync('ember-quill-harbor5', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`, { email: 'legacy2_r6@example.test' });
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'legacy2_r6', password: 'ember-quill-harbor5' } })).statusCode, 200);
    check(((await auth.getUserById(clean!.id))?.passwordHash ?? '').startsWith('s2:'), 'and its hash is upgraded');
  }

  // ---- MEDIUM: a provider sign-in still in flight survived a reset ----
  {
    const held = await r6('handoff_r6');
    // A ticket minted by the provider callback seconds before the owner resets.
    const ticket = 'r6-handoff-ticket-0123456789abcdef';
    await auth.createEmailToken(held.id, hashToken(ticket), 'oauth_handoff', new Date(Date.now() + 120_000));
    const link = 'r6-handoff-reset-0123456789abcdef';
    await auth.createEmailToken(held.id, hashToken(link), 'reset_password', new Date(Date.now() + 3600_000));
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: link, newPassword: 'cobalt-meadow-rally6' } })).statusCode, 200);
    const traded = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { cookie: `tm_handoff=${encodeURIComponent(ticket)}` } });
    check(traded.statusCode === 401, `a reset ends a provider sign-in that had not been collected yet (${traded.statusCode})`);
    // The same for a password change.
    const ticket2 = 'r6-handoff-ticket-fedcba9876543210';
    const relog = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'handoff_r6', password: 'cobalt-meadow-rally6' } })).json().token as string;
    await auth.createEmailToken(held.id, hashToken(ticket2), 'oauth_handoff', new Date(Date.now() + 120_000));
    assert.equal((await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(relog), payload: { currentPassword: 'cobalt-meadow-rally6', newPassword: R6PW2 } })).statusCode, 200);
    const traded2 = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { cookie: `tm_handoff=${encodeURIComponent(ticket2)}` } });
    check(traded2.statusCode === 401, `and so does a password change (${traded2.statusCode})`);
  }

  // ---- HIGH: a password or email change confirmed just before a reset undid it ----
  {
    const { hashPassword: hashR6 } = await import('../src/auth');
    const vic = await r6('undo_r6');
    const signIn = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'undo_r6', password } });
    // The thief has a session and the password; the owner resets meanwhile.
    const thief = (await signIn(R6PW)).json().token as string;
    auth.resetDuring = await hashR6('owner-takes-back-9');
    const changed = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(thief), payload: { currentPassword: R6PW, newPassword: 'thief-keeps-it-77' } });
    auth.resetDuring = null;
    check(changed.statusCode === 401, `a change checked against the old password does not land after the reset (${changed.statusCode})`);
    check((await signIn('owner-takes-back-9')).statusCode === 200, 'the reset stands');
    check((await signIn('thief-keeps-it-77')).statusCode === 401, 'and the thief\u2019s password was never set');
    if (changed.statusCode === 200) check((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(changed.json().token as string) })).statusCode === 401, 'nor its session kept');
    // The same race on an email change: the address must not move after the reset.
    const againRes = await signIn('owner-takes-back-9');
    assert.equal(againRes.statusCode, 200, 'the owner signs in with the reset password');
    const again = againRes.json().token as string;
    auth.resetDuring = await hashR6('owner-again-lantern-5');
    const moved = await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(again), payload: { email: 'undo_thief@example.test', password: 'owner-takes-back-9' } });
    auth.resetDuring = null;
    check(moved.statusCode === 401, `an email change checked against the old password does not land after the reset (${moved.statusCode})`);
    check((await auth.getUserById(vic.id))?.email === 'undo_r6@example.test', 'the address did not move');
  }

  // ---- MEDIUM: a password change spent the owner's reset links ----
  {
    const keep = await r6('keep_r6');
    const link = 'r6-keep-reset-link-0123456789abcd';
    await auth.createEmailToken(keep.id, hashToken(link), 'reset_password', new Date(Date.now() + 3600_000));
    // Someone with the session and the password changes it, as often as they like.
    assert.equal((await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(keep.token), payload: { currentPassword: R6PW, newPassword: 'thief-changed-it-3' } })).statusCode, 200);
    const back = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: link, newPassword: 'owner-recovers-8' } });
    check(back.statusCode === 200, `the mailbox can still take the account back after a change (${back.statusCode})`);
  }

  // ---- MEDIUM: a stolen session could add a first email, then reset the password ----
  {
    const { hashPassword: hashR6 } = await import('../src/auth');
    const bare = await auth.createUser('noemail_r6', await hashR6(R6PW), {});
    assert.ok(bare);
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noemail_r6', password: R6PW } })).json().token as string;
    const noPw = await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(tok), payload: { email: 'thief_r6@example.test' } });
    check(noPw.statusCode === 401, `a first address needs the password too (${noPw.statusCode})`);
    check(!(await auth.getUserById(bare!.id))?.email, 'and was not added');
    const withPw = await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(tok), payload: { email: 'noemail_r6@example.test', password: R6PW } });
    assert.equal(withPw.statusCode, 200, withPw.body);
    // An account with no password has none to give, and adds one with its session.
    const oauthOnly = await auth.createUser('oauthonly_r6', null, {});
    const t2 = issueR6Session(oauthOnly!.id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(await t2), payload: { email: 'oauthonly_r6@example.test' } })).statusCode, 200);
  }

  // ---- MEDIUM: a stolen session alone could take over a Google-only account ----
  {
    // Signed up with Google: a proven address, no password.
    const gOnly = await auth.createUser('gonly_r6', null, { email: 'gonly_r6@example.test', emailVerified: true });
    const gTok = await issueR6Session(gOnly!.id);
    const setFirst = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(gTok), payload: { newPassword: 'thief-sets-this-6' } });
    check(setFirst.statusCode === 403 && setFirst.json().code === 'use_email_link', `a first password is set through the mailbox, not the session (${setFirst.statusCode})`);
    check((await auth.getUserById(gOnly!.id))?.passwordHash === null, 'and none was set');
    const moveIt = await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(gTok), payload: { email: 'gonly_thief@example.test' } });
    check(moveIt.statusCode === 403 && moveIt.json().code === 'set_password_first', `nor is its proven address moved by the session (${moveIt.statusCode})`);
    check((await auth.getUserById(gOnly!.id))?.email === 'gonly_r6@example.test', 'the address stays');
    // The mailbox route works: the link goes to the proven address and sets it.
    const n = sent6.length;
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'gonly_r6@example.test' } });
    await app.drainBackground();
    const link = /reset\?token=([a-f0-9]+)/.exec(sent6.slice(n).find((m) => m.to === 'gonly_r6@example.test')?.text ?? '')?.[1];
    assert.ok(link, 'the set-a-password link went to the proven address');
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: link, newPassword: 'owner-sets-this-4' } })).statusCode, 200);
    // Without a proven address there is nothing else to ask: the session sets it.
    const bareG = await auth.createUser('gbare_r6', null, {});
    const bTok = await issueR6Session(bareG!.id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(bTok), payload: { newPassword: 'bare-sets-this-5' } })).statusCode, 200);
  }

  // ---- MEDIUM: a session alone connected a second sign-in, or deleted the account ----
  {
    const ga = new MemoryAuthRepository();
    const gd = new MemoryDesignRepository((id) => ga.usernameOf(id));
    const gapp = await buildApp(gd, ga, templates, { oauth: { google: { id: 'cid', secret: 'csecret' } } });
    const gOnly = await ga.createUser('glink_r6', null, { email: 'glink_r6@example.test', emailVerified: true });
    await ga.linkIdentity('google', 'g-owner-r6', gOnly!.id);
    const raw = 'r6-glink-session-0123456789';
    await ga.createToken(gOnly!.id, hashToken(raw), new Date(Date.now() + 3600_000));
    const started = await gapp.inject({ method: 'POST', url: '/api/account/link/google', headers: bearer(raw) });
    check(started.statusCode === 403 && started.json().code === 'set_password_first', `a Google-only account cannot connect another sign-in with its session alone (${started.statusCode})`);
    // Two Google sign-ins on it: removing "google" removes both, so it is the last method.
    await ga.linkIdentity('google', 'g-second-r6', gOnly!.id);
    const unlinked = await gapp.inject({ method: 'DELETE', url: '/api/account/link/google', headers: bearer(raw) });
    check(unlinked.statusCode === 400, `removing every sign-in of a passwordless account is refused (${unlinked.statusCode})`);
    // Deleting needs the password when there is one.
    const pwd = await r6('delete_r6');
    check((await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(pwd.token) })).statusCode === 401, 'a session alone does not delete an account that has a password');
    check((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(pwd.token) })).statusCode === 200, 'and it is still there');
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(pwd.token), payload: { password: R6PW } })).statusCode, 204);
    await gapp.close();
  }

  // ---- AVAILABILITY: a few kilobytes of scene held the event loop for seconds ----
  {
    const sa = new MemoryAuthRepository();
    const sd = new MemoryDesignRepository((id) => sa.usernameOf(id));
    const sapp = await buildApp(sd, sa, templates, {});
    const reg = await sapp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'bomb_r6', password: R6PW, email: 'bomb_r6@example.test', acceptedVersion: 'test' } });
    const btok = reg.json().token as string;
    const made = await sapp.inject({ method: 'POST', url: '/api/designs', headers: bearer(btok), payload: { title: 'b', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    const did = made.json().id as string;
    const gz = (doc: string) => gzipSync(Buffer.from(doc)).toString('base64');
    const put = (doc: string) => putGz(gz(doc));
    const putGz = (sceneGzB64: string) => sapp.inject({ method: 'PUT', url: `/api/designs/${did}/scene`, headers: bearer(btok), payload: { sceneGzB64 } });
    // 16 MB of empty objects took 3.4 s to parse; 15 MB of zeros 0.4 s; two
    // million repeated keys 0.45 s.
    for (const [name, doc] of [
      ['objects', `[${'{},'.repeat(5_000_000)}{}]`],
      ['numbers', `{"x":[${'0,'.repeat(7_500_000)}0]}`],
      ['keys', `{${'"a":"",'.repeat(2_000_000)}"a":""}`],
    ] as const) {
      // Refused with scene_complex, which the route answers before it parses.
      const r = await putGz(gz(doc));
      check(r.statusCode === 413 && r.json().code === 'scene_complex', `a scene of millions of ${name} is refused unparsed (${r.statusCode})`);
    }
    // A big real one goes through: banners full of freehand strokes (points at
    // full precision, as the editor keeps them), and layer grids.
    const real = JSON.stringify({
      v: 1,
      banners: Array.from({ length: 40 }, (_, k) => ({ id: `b${k}`, items: Array.from({ length: 25 }, () => ({ kind: 'stroke', pts: Array.from({ length: 60 }, () => Math.random() * 100) })) })),
      layers: { layers: Array.from({ length: 10 }, () => ({ grid: { cols: 500, rows: 300, b64: 'AAEA'.repeat(75_000) } })) },
    });
    const ok = await put(real);
    check(ok.statusCode === 200, `a large real scene still saves (${ok.statusCode} ${ok.body.slice(0, 80)})`);
    await sapp.close();
  }

  // ---- LOW: a hash upgraded by another sign-in failed a password change ----
  {
    const { hashPassword: hashR6 } = await import('../src/auth');
    const up = await r6('rehash_r6');
    auth.rehashDuring = await hashR6(R6PW);
    const ch = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(up.token), payload: { currentPassword: R6PW, newPassword: 'after-rehash-lantern-2' } });
    auth.rehashDuring = null;
    check(ch.statusCode === 200, `the change goes ahead over the same password\u2019s new hash (${ch.statusCode})`);
    check((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'rehash_r6', password: 'after-rehash-lantern-2' } })).statusCode === 200, 'and the new password works');
  }

  // ---- LOW: a reset link mailed to the address an account had just left ----
  {
    await r6('left_r6');
    await app.drainBackground();
    auth.moveDuringLookup = 'left_r6_new@example.test';
    const n = sent6.length;
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'left_r6@example.test' } });
    await app.drainBackground();
    auth.moveDuringLookup = null;
    check(!sent6.slice(n).some((m) => m.to === 'left_r6@example.test' && /reset\?token=/.test(`${m.text ?? ''} ${m.html}`)), 'no reset link goes to the address the account left');
  }

  // ---- LOW: two sign-ins upgrading one legacy password at once ----
  {
    const { randomBytes, scryptSync } = await import('node:crypto');
    const salt = randomBytes(16);
    await auth.createUser('legacy3_r6', `${salt.toString('hex')}:${scryptSync('ember-quill-harbor5', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`, { email: 'legacy3_r6@example.test' });
    const both = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'legacy3_r6', password: 'ember-quill-harbor5' } })));
    check(both.every((r) => r.statusCode === 200), `both sign-ins succeed (${both.map((r) => r.statusCode)})`);
  }

  // ---- LOW: an email change kept the old address's reset links on a failure ----
  {
    const mover = await r6('mover_r6');
    const link = 'r6-old-mailbox-reset-link-0123456789';
    await auth.createEmailToken(mover.id, hashToken(link), 'reset_password', new Date(Date.now() + 3600_000));
    auth.failDeleteEmailTokens = true;
    const moved = await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(mover.token), payload: { email: 'mover_r6_new@example.test', password: R6PW } });
    auth.failDeleteEmailTokens = false;
    if (moved.statusCode === 200) {
      const used = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: link, newPassword: 'orchid-basalt-rally3' } });
      check(used.statusCode === 400, `a reset link sent to the old address dies with the move (${used.statusCode})`);
    } else {
      check(moved.statusCode === 503, `or the move is refused (${moved.statusCode})`);
    }
  }

  // ---- LOW: an unreadable scene went out with its owner's pictures ----
  {
    const pub = await design(owner.token, true);
    // Bytes that gunzip but do not parse, with the owner's picture in them. A
    // save cannot store this (PUT parses first); a strip must not depend on it.
    await designs.putScene(pub, gzipSync(Buffer.from(`{"v":1,"layers":[{"src":"${SECRET_PIC}"}],"banners":[`)));
    const anon = (await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene` })).json() as { sceneGzB64: string | null };
    check(anon.sceneGzB64 === null, 'a scene that cannot be stripped is not shown to others');
    const mine = (await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene`, headers: bearer(owner.token) })).json() as { sceneGzB64: string | null };
    assert.ok(mine.sceneGzB64, 'its owner still gets it back');
    const copy = await app.inject({ method: 'POST', url: `/api/designs/${pub}/fork`, headers: bearer(other.token) });
    assert.equal(copy.statusCode, 201, copy.body);
    const copied = (await app.inject({ method: 'GET', url: `/api/designs/${(copy.json() as { id: string }).id}/scene`, headers: bearer(other.token) })).json() as { sceneGzB64: string | null };
    check(!copied.sceneGzB64 || !gunzipSync(Buffer.from(copied.sceneGzB64, 'base64')).toString().includes(SECRET_PIC), 'nor copied into someone else’s fork');
  }

  // ---- LOW: a taken-down design's copy could be published ----
  {
    const bad = await design(owner.token, true, 'Taken down r6');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${bad}/takedown`, headers: bearer(mod.token) })).statusCode, 200);
    designs.failTakedown = true;
    const fork = await app.inject({ method: 'POST', url: `/api/designs/${bad}/fork`, headers: bearer(owner.token) });
    designs.failTakedown = false;
    if (fork.statusCode === 201) {
      const id = (fork.json() as { id: string }).id;
      await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(owner.token), payload: { isPublic: true } });
      check((await app.inject({ method: 'GET', url: `/api/designs/${id}` })).statusCode === 404, 'the copy of a taken-down design never becomes public');
    } else {
      check(fork.statusCode === 503, `or the copy is refused (${fork.statusCode})`);
    }
    // And if a copy ever came back without the takedown, the route refuses it
    // and leaves nothing behind.
    const before = (await app.inject({ method: 'GET', url: '/api/designs', headers: bearer(owner.token) })).json() as unknown[];
    designs.forkLosesTakedown = true;
    const lost = await app.inject({ method: 'POST', url: `/api/designs/${bad}/fork`, headers: bearer(owner.token) });
    designs.forkLosesTakedown = false;
    assert.equal(lost.statusCode, 503, `a copy without its takedown is refused (${lost.statusCode})`);
    const after = (await app.inject({ method: 'GET', url: '/api/designs', headers: bearer(owner.token) })).json() as unknown[];
    assert.equal(after.length, before.length, 'and is not left in the account');
  }

  // ---- LOW: the username wall opened when the database failed ----
  {
    const mine = await design(owner.token, false);
    auth.failUsernameCheck = true;
    const make = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title: 'X', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    const scene = await app.inject({ method: 'PUT', url: `/api/designs/${mine}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: gzipSync(Buffer.from('{"v":1}')).toString('base64') } });
    auth.failUsernameCheck = false;
    check(make.statusCode === 503, `a write is refused when the name check cannot be made (${make.statusCode})`);
    check(scene.statusCode === 503, `on design routes too (${scene.statusCode})`);
    assert.equal((await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title: 'Y', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } })).statusCode, 201, 'and open again once it can');
  }

  // ---- LOW: admin-name guards opened when the database failed ----
  {
    const chief = await r6('chief_r6');
    auth.failGetUserCalls = 1;
    const rename = await app.inject({ method: 'POST', url: '/api/account/username', headers: bearer(chief.token), payload: { username: 'chief_r6_gone' } });
    auth.failGetUserCalls = 1;
    const del = await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(chief.token) });
    auth.failGetUserCalls = 0;
    check(rename.statusCode >= 500, `an admin account is not renamed when it cannot be checked (${rename.statusCode})`);
    check(del.statusCode >= 500, `nor deleted (${del.statusCode})`);
    check((await auth.getUserByName('chief_r6'))?.id === chief.id, 'it still has its name');
  }

  // ---- INFO: the admin password's length leaked through timing ----
  {
    assert.equal(eq6('same text', 'same text'), true);
    assert.equal(eq6('short', 'a much longer guess'), false);
    assert.equal(eq6('', 'x'), false);
    check(!/\.length/.test(eq6.toString()), 'no early exit on a length mismatch');
    // And the unlock key is derived when the app is built, not on a stranger's request.
    const fresh = 'r6 fresh admin password';
    const tok = mint6('r6 other password'); // a well-formed token for a different key
    await buildApp(new MemoryDesignRepository(() => 'x'), new MemoryAuthRepository(), templates, { aiAdminPassword: fresh });
    const t0 = performance.now();
    verify6(fresh, tok);
    const ms = performance.now() - t0;
    check(ms < 200, `the first unlock check after boot does not derive the key (${ms.toFixed(1)} ms)`);
  }

  // ---- INFO: a deleted account's design stayed on the home page ----
  {
    const a3 = new MemoryAuthRepository();
    class SlowDelete extends MemoryDesignRepository {
      onDelete: (() => Promise<void>) | null = null;
      override async deleteByOwner(ownerId: string): Promise<void> {
        // Someone opens the home page while the deletion is under way.
        if (this.onDelete) await this.onDelete();
        return super.deleteByOwner(ownerId);
      }
    }
    const d3 = new SlowDelete((id) => a3.usernameOf(id));
    const home = await buildApp(d3, a3, templates, { featured: new MemoryDailyFeatureRepository(), social: new MemorySocialRepository(d3, a3) });
    const reg3 = await home.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'star_r6', password: R6PW, email: 'star_r6@example.test', acceptedVersion: 'test' } });
    const tok3 = (reg3.json() as { token: string }).token;
    const made3 = await home.inject({ method: 'POST', url: '/api/designs', headers: bearer(tok3), payload: { title: 'Featured, then deleted', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG_B64 } });
    const starred = (made3.json() as { id: string }).id;
    await home.inject({ method: 'PATCH', url: `/api/designs/${starred}`, headers: bearer(tok3), payload: { isPublic: true } });
    const today = (await home.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
    assert.equal(today.item?.id, starred, 'the only public design is the pick');
    d3.onDelete = async () => {
      await home.inject({ method: 'GET', url: '/api/featured/today' });
    };
    assert.equal((await home.inject({ method: 'DELETE', url: '/api/account', headers: bearer(tok3), payload: { password: R6PW } })).statusCode, 204);
    const after = (await home.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
    check(after.item?.id !== starred, 'a deleted account\u2019s design leaves the home page at once');
    await home.close();

    // A pick being worked out while the account goes: it must not land after.
    const a4 = new MemoryAuthRepository();
    class SlowList extends MemoryDesignRepository {
      gate: Promise<void> | null = null;
      reached: (() => void) | null = null;
      override async listPublic(...args: Parameters<MemoryDesignRepository['listPublic']>): ReturnType<MemoryDesignRepository['listPublic']> {
        const rows = await super.listPublic(...args);
        if (this.gate) {
          const g = this.gate;
          this.gate = null;
          this.reached?.();
          await g;
        }
        return rows;
      }
    }
    const d4 = new SlowList((id) => a4.usernameOf(id));
    const home4 = await buildApp(d4, a4, templates, { featured: new MemoryDailyFeatureRepository(), social: new MemorySocialRepository(d4, a4) });
    const reg4 = await home4.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'star2_r6', password: R6PW, email: 'star2_r6@example.test', acceptedVersion: 'test' } });
    const tok4 = (reg4.json() as { token: string }).token;
    const made4 = await home4.inject({ method: 'POST', url: '/api/designs', headers: bearer(tok4), payload: { title: 'Picked, mid-deletion', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG_B64 } });
    const starred4 = (made4.json() as { id: string }).id;
    await home4.inject({ method: 'PATCH', url: `/api/designs/${starred4}`, headers: bearer(tok4), payload: { isPublic: true } });
    let release: () => void = () => {};
    d4.gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (d4.reached = r));
    const picking = home4.inject({ method: 'GET', url: '/api/featured/today' });
    await reached; // the pick has read the feed, the design still in it
    assert.equal((await home4.inject({ method: 'DELETE', url: '/api/account', headers: bearer(tok4), payload: { password: R6PW } })).statusCode, 204);
    release();
    const landed = (await picking).json() as { item: { id: string } | null };
    check(landed.item?.id !== starred4, 'a pick made from before the deletion is not shown after it');
    const next = (await home4.inject({ method: 'GET', url: '/api/featured/today' })).json() as { item: { id: string } | null };
    check(next.item?.id !== starred4, 'nor kept for the next visitor');
    await home4.close();
  }

  // ---- LOW: a 404 was never rate limited; a scene save only by the global 300 ----
  {
    const a2 = new MemoryAuthRepository();
    const d2 = new MemoryDesignRepository((id) => a2.usernameOf(id));
    const limited = await buildApp(d2, a2, templates, { rateLimit: true });
    let refused = 0;
    for (let i = 0; i < 310; i++) {
      const r = await limited.inject({ method: 'GET', url: i % 2 ? '/.env' : '/api/nothing-here' });
      if (r.statusCode === 429) refused++;
    }
    check(refused > 0, `probes to unknown paths are limited too (${refused} of 310 refused)`);
    const garbled = await limited.inject({ method: 'POST', url: '/nope', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    check(garbled.statusCode === 429, `a malformed body does not get a probe past the limit (${garbled.statusCode})`);
    const scanner = await limited.inject({ method: 'GET', url: '/api/templates', remoteAddress: '203.0.113.66' });
    assert.equal(scanner.statusCode, 200, 'another address is unaffected');

    const reg2 = await limited.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '198.51.100.6', payload: { username: 'scener_r6', password: R6PW, email: 'scener_r6@example.test', acceptedVersion: 'test' } });
    const tok2 = (reg2.json() as { token: string }).token;
    const made = await limited.inject({ method: 'POST', url: '/api/designs', remoteAddress: '198.51.100.6', headers: bearer(tok2), payload: { title: 'S', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    const sid = (made.json() as { id: string }).id;
    const body = { sceneGzB64: gzipSync(Buffer.from('{"v":1,"banners":[]}')).toString('base64') };
    let sceneRefused = 0;
    for (let i = 0; i < 40; i++) {
      const r = await limited.inject({ method: 'PUT', url: `/api/designs/${sid}/scene`, remoteAddress: '198.51.100.6', headers: bearer(tok2), payload: body });
      if (r.statusCode === 429) sceneRefused++;
    }
    check(sceneRefused >= 10, `scene saves have their own limit (${sceneRefused} of 40 refused)`);
    await limited.close();
  }

  // ---- LOW: CSP still allowed origins nothing uses ----
  {
    const csp = String((await app.inject({ method: 'GET', url: '/api/templates' })).headers['content-security-policy'] ?? '');
    check(!/googleapis|gstatic|jsdelivr/.test(csp), `no third-party style or font origins (${csp})`);
  }

  // ---- Postgres: the same guarantees, races included, on a real database ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { readFileSync: read6 } = await import('node:fs');
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(read6(new URL('../schema.sql', import.meta.url), 'utf8'));
      const pAuth = new PgAuthRepository(pool);
      const pDesigns = new PgDesignRepository(pool);
      const papp = await buildApp(pDesigns, pAuth, templates, {});
      const s6 = Math.random().toString(36).slice(2, 7);
      const exp = () => new Date(Date.now() + 3600_000);
      const preg = async (u: string): Promise<{ token: string; id: string }> => {
        const r = await papp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: `${u}${s6}`, password: R6PW, email: `${u}${s6}@example.test`, acceptedVersion: 'test' } });
        assert.equal(r.statusCode, 201, r.body);
        const token = (r.json() as { token: string }).token;
        return { token, id: ((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json() as { id: string }).id };
      };
      const plogin = (u: string, password: string) => papp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${u}${s6}`, password } });

      // A password change: one transaction, this session kept, the rest gone.
      const a = await preg('pga');
      const other = (await plogin('pga', R6PW)).json().token as string;
      const ch = await papp.inject({ method: 'POST', url: '/api/account/password', headers: bearer(a.token), payload: { currentPassword: R6PW, newPassword: R6PW2 } });
      assert.equal(ch.statusCode, 200, ch.body);
      check((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(other) })).statusCode === 401, 'Postgres: the other session ends');
      check((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(ch.json().token as string) })).statusCode === 200, 'Postgres: this one stays');
      check((await plogin('pga', R6PW)).statusCode === 401, 'Postgres: the old password is gone');

      // A sign-in checked against the old password while the change commits.
      const b = await preg('pgb');
      const oldHash = (await pAuth.getUserById(b.id))!.passwordHash!;
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query('UPDATE users SET password_hash = $2 WHERE id = $1', [b.id, 'changed-in-flight']);
      const raceTok = hashToken(`pg-race-session-${s6}`);
      // Started as a promise either way, so a failure cannot leave the row held.
      const signIn = Promise.resolve().then(() => pAuth.createTokenIfPassword(b.id, oldHash, raceTok, exp()));
      signIn.catch(() => {});
      await new Promise((r) => setTimeout(r, 250)); // waiting on the row the change holds
      await holder.query('DELETE FROM auth_tokens WHERE user_id = $1', [b.id]);
      await holder.query('COMMIT');
      holder.release();
      check((await signIn) === false, 'Postgres: a sign-in that waited behind the change stores nothing');
      check((await pool.query('SELECT 1 FROM auth_tokens WHERE token_hash = $1', [raceTok])).rowCount === 0, 'Postgres: and no session row exists');
      check((await pAuth.upgradePasswordHash(b.id, oldHash, 'stale-rehash')) === false, 'Postgres: a rehash from the old hash changes nothing');
      check((await pAuth.getUserById(b.id))!.passwordHash === 'changed-in-flight', 'Postgres: the new hash stands');
      check((await pAuth.createTokenIfPassword(b.id, 'changed-in-flight', hashToken(`pg-ok-${s6}`), exp())) === true, 'Postgres: a sign-in with the current hash works');

      // Provider handoff tickets: only for a linked account, spent once, ended by a reset.
      const c = await preg('pgc');
      const sub = `pg-sub-${s6}`;
      check((await pAuth.createHandoffIfLinked(c.id, 'google', sub, hashToken(`t1${s6}`), exp())) === false, 'Postgres: no ticket for an identity that is not linked');
      assert.equal(await pAuth.linkIdentity('google', sub, c.id), true);
      check((await pAuth.createHandoffIfLinked(c.id, 'google', sub, hashToken(`t1${s6}`), exp())) === true, 'Postgres: a ticket for a linked one');
      check((await pAuth.exchangeHandoff(hashToken(`t1${s6}`), hashToken(`s1${s6}`), exp())) === c.id, 'Postgres: the ticket trades for a session');
      check((await pAuth.exchangeHandoff(hashToken(`t1${s6}`), hashToken(`s2${s6}`), exp())) === null, 'Postgres: once');
      assert.equal(await pAuth.createHandoffIfLinked(c.id, 'google', sub, hashToken(`t2${s6}`), exp()), true);
      await pAuth.replacePassword(c.id, await hashPassword('pg-reset-lantern-4'), { dropIdentities: true });
      check((await pAuth.exchangeHandoff(hashToken(`t2${s6}`), hashToken(`s3${s6}`), exp())) === null, 'Postgres: a reset ends a ticket not yet collected');
      check((await pAuth.createHandoffIfLinked(c.id, 'google', sub, hashToken(`t3${s6}`), exp())) === false, 'Postgres: and the link it removed mints no more');
      check((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(c.token) })).statusCode === 401, 'Postgres: and every session ended');

      // Many trades of one ticket at once: one session.
      const c2 = await preg('pgc2');
      assert.equal(await pAuth.linkIdentity('google', `${sub}-2`, c2.id), true);
      assert.equal(await pAuth.createHandoffIfLinked(c2.id, 'google', `${sub}-2`, hashToken(`t4${s6}`), exp()), true);
      const trades = await Promise.all([...Array(12).keys()].map((i) => pAuth.exchangeHandoff(hashToken(`t4${s6}`), hashToken(`s4-${i}-${s6}`), exp())));
      check(trades.filter(Boolean).length === 1, `Postgres: a ticket traded twelve times at once gives one session (${trades.filter(Boolean).length})`);

      // An email change: the old address's reset links go with it, or nothing moves.
      const d = await preg('pgd');
      await pAuth.createEmailToken(d.id, hashToken(`rl${s6}`), 'reset_password', exp());
      check((await pAuth.setEmail(d.id, `pgd2${s6}@example.test`)) === true, 'Postgres: the address moves');
      check((await pAuth.consumeEmailToken(hashToken(`rl${s6}`), 'reset_password')) === null, 'Postgres: and the old mailbox\u2019s reset link is dead');
      check((await pAuth.setEmail(d.id, `pga${s6}@example.test`)) === false, 'Postgres: a taken address is refused');
      check((await pAuth.getUserById(d.id))!.email === `pgd2${s6}@example.test`, 'Postgres: and nothing moved');

      // A change only over the password it checked; a change keeps reset links.
      const e = await preg('pge');
      const eHash = (await pAuth.getUserById(e.id))!.passwordHash!;
      await pAuth.createEmailToken(e.id, hashToken(`kl${s6}`), 'reset_password', exp());
      check((await pAuth.replacePassword(e.id, 'stale-change', { expectedHash: 'not-the-hash', keepResetLinks: true })) === false, 'Postgres: a change over a password that moved is refused');
      check((await pAuth.getUserById(e.id))!.passwordHash === eHash, 'Postgres: and changes nothing');
      check((await pAuth.replacePassword(e.id, 'fresh-change', { expectedHash: eHash, keepResetLinks: true })) === true, 'Postgres: a change over the checked password lands');
      check((await pAuth.consumeEmailToken(hashToken(`kl${s6}`), 'reset_password')) === e.id, 'Postgres: and the owner\u2019s reset link still works');
      check((await pAuth.replacePassword('00000000-0000-4000-8000-000000000000', 'x')) === false, 'Postgres: no account, no change');
      // An email move only over the password it checked.
      check((await pAuth.setEmail(e.id, `pge2${s6}@example.test`, null, 'not-the-hash')) === false, 'Postgres: an email move over a password that moved is refused');
      check((await pAuth.getUserById(e.id))!.email === `pge${s6}@example.test`, 'Postgres: and the address stays');
      check((await pAuth.setEmail(e.id, `pge2${s6}@example.test`, null, 'fresh-change')) === true, 'Postgres: over the right one it moves');
      // A reset link only for the address the account still has.
      check((await pAuth.createEmailTokenForAddress(e.id, `pge${s6}@example.test`, hashToken(`old${s6}`), 'reset_password', exp())) === false, 'Postgres: no link for an address the account left');
      check((await pAuth.createEmailTokenForAddress(e.id, `PGE2${s6}@example.test`, hashToken(`new${s6}`), 'reset_password', exp())) === true, 'Postgres: one for the address it has');
      // A link mid-way while the move commits: it waits, then the move removes it.
      {
        const holder2 = await pool.connect();
        await holder2.query('BEGIN');
        await holder2.query(
          `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
           SELECT $1, u.id, 'reset_password', $3 FROM (SELECT id FROM users WHERE id = $2 AND lower(email) = lower($4) FOR SHARE) u`,
          [hashToken(`mid${s6}`), e.id, exp(), `pge2${s6}@example.test`],
        );
        const moving = pAuth.setEmail(e.id, `pge3${s6}@example.test`, null, 'fresh-change');
        moving.catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
        await holder2.query('COMMIT');
        holder2.release();
        check((await moving) === true, 'Postgres: the move goes through');
        check((await pAuth.consumeEmailToken(hashToken(`mid${s6}`), 'reset_password')) === null, 'Postgres: and the link being stored as it moved is dead');
      }

      // A provider link racing a reset, both ways round.
      {
        const f = await preg('pgf');
        const fSession = hashToken(f.token);
        // The reset gets there first: the link waits, then finds the session gone.
        const resetter = await pool.connect();
        await resetter.query('BEGIN');
        await resetter.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [f.id]);
        await resetter.query('SELECT 1 FROM auth_tokens WHERE user_id = $1 FOR UPDATE', [f.id]);
        const linking = Promise.resolve().then(() => pAuth.linkIdentityForSession('google', `pgf-a-${s6}`, f.id, fSession));
        linking.catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
        await resetter.query('DELETE FROM oauth_identities WHERE user_id = $1', [f.id]);
        await resetter.query('DELETE FROM auth_tokens WHERE user_id = $1', [f.id]);
        await resetter.query('COMMIT');
        resetter.release();
        check((await linking) === false, 'Postgres: a link that waited behind a reset stores nothing');
        check((await pAuth.getUserIdByIdentity('google', `pgf-a-${s6}`)) === null, 'Postgres: and no sign-in was added');
        // The link gets there first: the reset waits for it, then removes it.
        const g = await preg('pgg');
        const linker = await pool.connect();
        await linker.query('BEGIN');
        const held = await linker.query(
          `INSERT INTO oauth_identities (provider, provider_user_id, user_id)
           SELECT 'google', $1, t.user_id FROM (SELECT user_id FROM auth_tokens WHERE token_hash = $2 AND user_id = $3 FOR SHARE) t`,
          [`pgg-a-${s6}`, hashToken(g.token), g.id],
        );
        assert.equal(held.rowCount, 1);
        const resetting = pAuth.replacePassword(g.id, await hashPassword('pgg-reset-lantern-2'), { dropIdentities: true });
        resetting.catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
        await linker.query('COMMIT');
        linker.release();
        check((await resetting) === true, 'Postgres: the reset goes through');
        check((await pAuth.getUserIdByIdentity('google', `pgg-a-${s6}`)) === null, 'Postgres: and removes the sign-in linked just before it');
        // And with a live session, the link works.
        const h = await preg('pgh');
        check((await pAuth.linkIdentityForSession('google', `pgh-a-${s6}`, h.id, hashToken(h.token))) === true, 'Postgres: a live session links');
        check((await pAuth.linkIdentityForSession('google', `pgh-a-${s6}`, f.id, hashToken(h.token))) === false, 'Postgres: not onto someone else\u2019s session');
      }

      // A copy of a taken-down design is born taken down.
      const made = await papp.inject({ method: 'POST', url: '/api/designs', headers: bearer(d.token), payload: { title: 'Taken down on Postgres', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
      assert.equal(made.statusCode, 201, made.body);
      const src = (made.json() as { id: string }).id;
      assert.equal(await pDesigns.takedownDesign(src), true);
      const copy = await pDesigns.fork(src, 'copy', b.id);
      check(copy?.takenDown === true, 'Postgres: the copy carries the takedown');
      await papp.close();
    } finally {
      await pool.end();
    }
  }

  // ---- AVAILABILITY: a dropped idle database connection killed the server ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    let pool: InstanceType<typeof pg.Pool> | null = null;
    try {
      const { createPool } = await import('../src/db');
      pool = createPool(process.env.DATABASE_URL);
    } catch {
      check(false, 'the server builds its pool with createPool (server/src/db.ts)');
    }
    if (pool) {
      const client = await pool.connect();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      client.release(); // idle in the pool now
      const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await killer.connect();
      check(pool.listenerCount('error') > 0, 'the pool has its own error handler');
      const lost = new Promise<boolean>((r) => {
        pool!.once('error', () => r(true));
        setTimeout(() => r(false), 5000);
      });
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await killer.end();
      assert.ok(await lost, 'the dropped connection was reported to the pool');
      // Still here, and the pool reconnects.
      assert.equal((await pool.query('SELECT 1 AS one')).rows[0].one, 1, 'the pool survives a dropped idle connection');
      // And one dropped mid-transaction, while checked out of the pool.
      const busy = await pool.connect();
      check(busy.listenerCount('error') > 0, 'a checked-out connection has an error handler too');
      await busy.query('BEGIN');
      const busyPid = (await busy.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const killer2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await killer2.connect();
      await killer2.query('SELECT pg_terminate_backend($1)', [busyPid]);
      await killer2.end();
      await new Promise((r) => setTimeout(r, 300));
      await busy.query('SELECT 1').then(() => check(false, 'the dead connection does not answer'), () => {});
      busy.release(true);
      assert.equal((await pool.query('SELECT 1 AS one')).rows[0].one, 1, 'the pool survives a connection dropped mid-transaction');
      await pool.end();
    }
  }

  await app.close();
  console.log('audit round six: all assertions passed (private og cards and thumbnails, no-store by default for /api and errors, no-cache on server pages, dev-only ports, atomic password change and reset, sign-ins racing a reset, atomic email change, fail-closed scene strip, born-taken-down forks, fail-closed username wall and admin guards, length-blind compare, unlock key at boot, deleted account leaves the home page, limited 404s and scene saves, no dead CSP origins, pool error handler)');
}

// ---------- 2026-10: performance plan, stage 1 (server) ----------
// The speed work changes how the security headers are built (helmet once per
// process, P1.30), how requests are counted (a bucket for hashed assets,
// P1.27), what the database is asked (comment counts, facets, profiles,
// P1.11/P1.12) and how the server boots (P1.31). Each of those sits next to a
// control, so the controls are pinned first: P0.1 the exact headers on every
// kind of response, P0.2 who may cache what. Then one section per item.
{
  const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readdirSync: listDir, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository, MemoryEventsRepository } = await import('../src/memoryRepo');
  const { MemoryDailyFeatureRepository } = await import('../src/featureRepo');
  const { MemoryStadiumRepository } = await import('../src/stadiumRepo');
  const { MemoryAdminStatsRepository } = await import('../src/statsRepo');
  const { MemoryTrafficRepository } = await import('../src/trafficRepo');
  const { MemoryFeedbackRepository } = await import('../src/feedbackRepo');
  const { MemorySocRepository } = await import('../src/socRepo');
  const { SocMonitor } = await import('../src/soc');
  const { seatTable } = await import('../src/seatTable');
  const { createHash } = await import('node:crypto');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const S1PW = 'orchid-ledger-pivot3';
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const NO_SUCH = '7f000000-0000-4000-8000-0000000000ee';
  const mailStub = { send: async () => {} } as never;

  // A build output of the shape vite writes: the pages, hashed assets (a
  // module worker among them) and the public files, copied as they are.
  const dist = mkdtempSync(`${tmpdir()}/tifo-perf-s1-`);
  for (const f of listDir('.').filter((n) => n.endsWith('.html'))) copyFileSync(f, `${dist}/${f}`);
  mkdirSync(`${dist}/assets`);
  mkdirSync(`${dist}/news`);
  const WORKER = '/assets/heavy.worker-Ab12Cd34.js';
  writeFileSync(`${dist}${WORKER}`, 'self.onmessage = () => {};\n');
  writeFileSync(`${dist}/assets/index-Ab12Cd34.js`, 'export {};\n');
  // The build's compressed copies beside it (performance plan P2.3).
  writeFileSync(`${dist}/assets/index-Ab12Cd34.js.br`, (await import('node:zlib')).brotliCompressSync(Buffer.from('export {};\n')));
  writeFileSync(`${dist}/assets/index-Ab12Cd34.js.gz`, gzipSync(Buffer.from('export {};\n')));
  writeFileSync(`${dist}/assets/index-Ab12Cd34.css`, 'body{margin:0}\n');
  writeFileSync(`${dist}/assets/inter-latin-400-Ab12Cd34.woff2`, Buffer.alloc(64, 1));
  writeFileSync(`${dist}/favicon.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(`${dist}/favicon.ico`, Buffer.alloc(32, 1));
  for (const f of ['apple-touch-icon.png', 'icon-512.png', 'og-card.png', 'og-default.png']) writeFileSync(`${dist}/${f}`, PNG);
  writeFileSync(`${dist}/hero-stadium.webp`, Buffer.from('RIFF\0\0\0\0WEBPVP8 '));
  writeFileSync(`${dist}/hero-stadium-640.webp`, Buffer.from('RIFF\0\0\0\0WEBPVP8 '));
  writeFileSync(`${dist}/news/leagues-saudi.webp`, Buffer.from('RIFF\0\0\0\0WEBPVP8 '));
  writeFileSync(`${dist}/robots.txt`, 'User-agent: *\nDisallow: /api/\n');
  // A script outside /assets whose name never changes (theme-boot.js today).
  writeFileSync(`${dist}/boot-script.js`, '/* unhashed */\n');
  writeFileSync(`${dist}/verify-site.html`, '<!doctype html><title>v</title>\n');

  /** Repositories that can be told to break, for the 500 and fail-closed paths. */
  class S1Designs extends MemoryDesignRepository {
    failGallery = false;
    override async listPublic(q: Parameters<MemoryDesignRepository['listPublic']>[0]): ReturnType<MemoryDesignRepository['listPublic']> {
      if (this.failGallery) throw new Error('connection terminated');
      return super.listPublic(q);
    }
  }
  let ipSeq = 0;
  /** A fresh client address, so one section's requests never use another's budget. */
  const freshIp = (): string => `198.18.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
  const s1reg = async (app: FastifyInstance, u: string, ip = freshIp(), adminPassword?: string): Promise<{ token: string; id: string }> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { username: u, password: S1PW, email: `${u}@example.test`, acceptedVersion: 'test', adminPassword } });
    assert.equal(r.statusCode, 201, r.body);
    const token = (r.json() as { token: string }).token;
    return { token, id: ((await app.inject({ method: 'GET', url: '/api/me', remoteAddress: ip, headers: bearer(token) })).json() as { id: string }).id };
  };

  // ---- P0.1: the exact security headers, on every kind of response ----
  //
  // Nothing tested the headers themselves until now: "the CSP is unchanged"
  // was a claim checked by reading. This pins every header helmet sets, byte
  // for byte, on HTML, JSON, the module worker, images, static files (200 and
  // 304), every error status the server produces, the admin pages and the AI
  // routes. A change to any of them fails here; a deliberate tightening
  // updates this table in the same commit, and nothing may ever loosen it.
  {
    const CSP = "default-src 'self';script-src 'self' 'unsafe-eval';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data:;connect-src 'self';object-src 'none';frame-ancestors 'none';base-uri 'self';form-action 'self';script-src-attr 'none';upgrade-insecure-requests";
    const PINNED: Record<string, string> = {
      'content-security-policy': CSP,
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'origin-agent-cluster': '?1',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'x-dns-prefetch-control': 'off',
      'x-download-options': 'noopen',
      'x-frame-options': 'SAMEORIGIN',
      'x-permitted-cross-domain-policies': 'none',
      'x-xss-protection': '0',
    };
    // Headers that would each loosen something if they ever appeared.
    const NEVER = ['x-powered-by', 'content-security-policy-report-only', 'access-control-allow-origin', 'access-control-allow-credentials', 'cross-origin-embedder-policy'];
    /** The policy, read as directives, for the rules that hold whatever the exact string. */
    const directivesOf = (csp: string): Map<string, string[]> =>
      new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
    const pinned = (r: { statusCode: number; headers: Record<string, unknown> }, label: string): void => {
      for (const [h, v] of Object.entries(PINNED)) {
        assert.equal(r.headers[h], v, `${label} (${r.statusCode}): ${h}`);
      }
      for (const h of NEVER) assert.equal(r.headers[h], undefined, `${label}: no ${h}`);
      const d = directivesOf(String(r.headers['content-security-policy'] ?? ''));
      assert.deepEqual(d.get('script-src'), ["'self'", "'unsafe-eval'"], `${label}: script-src is exactly 'self' 'unsafe-eval'`);
      check(!d.has('worker-src') || d.get('worker-src')!.join(' ') === "'self'", `${label}: workers only from this origin`);
      check((d.get('img-src') ?? []).every((s) => s === "'self'" || s === 'data:'), `${label}: img-src is 'self' and data: at most`);
      assert.deepEqual(d.get('connect-src'), ["'self'"], `${label}: connect-src 'self'`);
      assert.deepEqual(d.get('frame-ancestors'), ["'none'"], `${label}: never framed`);
      assert.deepEqual(d.get('object-src'), ["'none'"], `${label}: no plugins`);
      assert.deepEqual(d.get('script-src-attr'), ["'none'"], `${label}: no inline handlers`);
      for (const [k, v] of d) {
        if (!k.startsWith('script') && k !== 'default-src' && k !== 'worker-src') continue;
        check(v.every((s) => !/unsafe-inline|^blob:|^data:|^https?:|^'nonce-|^'sha(256|384|512)-|^\*$/.test(s)), `${label}: ${k} allows no inline, blob:, data:, remote host, nonce or hash (${v.join(' ')})`);
      }
    };

    const hAuth = new MemoryAuthRepository();
    const hDesigns = new S1Designs((id) => hAuth.usernameOf(id));
    const hApp = await buildApp(hDesigns, hAuth, templates, {
      staticDir: dist,
      rateLimit: true,
      social: new MemorySocialRepository(hDesigns, hAuth),
      featured: new MemoryDailyFeatureRepository(),
      leads: new MemoryLeadsRepository(),
      aiUsage: new MemoryAiUsageRepository(),
      aiEvents: new MemoryAiEventsRepository(),
      adminUsernames: ['mod_s1'],
      aiAdminPassword: 'stage one admin password',
      oauth: { google: { id: 'client-id', secret: 'client-secret' } },
      emailSender: mailStub,
    });
    const owner = await s1reg(hApp, 'owner_s1');
    await hAuth.markEmailVerified(owner.id);
    const made = await hApp.inject({ method: 'POST', url: '/api/designs', remoteAddress: freshIp(), headers: bearer(owner.token), payload: { title: 'Pinned headers', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG.toString('base64') } });
    assert.equal(made.statusCode, 201, made.body);
    const pub = (made.json() as { id: string }).id;
    assert.equal((await hApp.inject({ method: 'PATCH', url: `/api/designs/${pub}`, remoteAddress: freshIp(), headers: bearer(owner.token), payload: { isPublic: true } })).statusCode, 200);
    const photo = await hApp.inject({ method: 'POST', url: `/api/designs/${pub}/photos`, remoteAddress: freshIp(), headers: bearer(owner.token), payload: { imageB64: PNG.toString('base64'), width: 1, height: 1 } });
    assert.equal(photo.statusCode, 200, photo.body);
    const photoId = (photo.json() as { photoId: string }).photoId;
    const unlock = await hApp.inject({ method: 'POST', url: '/api/ai/unlock', remoteAddress: freshIp(), payload: { password: 'stage one admin password' } });
    assert.equal(unlock.statusCode, 200, unlock.body);
    pinned(unlock, 'POST /api/ai/unlock');
    const unlockToken = (unlock.json() as { token: string }).token;

    type Case = { label: string; status: number; method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS'; url: string; headers?: Record<string, string>; payload?: unknown };
    const own = bearer(owner.token);
    const cases: Case[] = [
      // Pages, server-rendered and static.
      { label: 'landing', status: 200, url: '/' },
      { label: 'landing HEAD', status: 200, method: 'HEAD', url: '/' },
      { label: 'editor', status: 200, url: `/app?design=${pub}` },
      { label: 'bare editor, sent to Projects', status: 302, url: '/app' },
      { label: 'community', status: 200, url: '/community' },
      { label: 'share page', status: 200, url: `/t/${pub}` },
      { label: 'design page', status: 200, url: `/d/${pub}` },
      { label: 'seat page', status: 200, url: `/s/${pub}` },
      { label: 'clubs', status: 200, url: '/clubs' },
      { label: 'legal', status: 200, url: '/legal' },
      { label: 'spec', status: 200, url: '/tifo-spec' },
      { label: 'reset page', status: 200, url: '/reset?token=abc' },
      { label: 'account page', status: 200, url: '/account' },
      { label: 'projects page', status: 200, url: '/projects' },
      { label: 'sitemap', status: 200, url: '/sitemap.xml' },
      { label: 'static html file', status: 200, url: '/verify-site.html' },
      { label: 'admin shell', status: 200, url: '/admin' },
      { label: 'admin module, locked', status: 404, url: '/admin.js' },
      { label: 'admin module, unlocked', status: 200, url: '/admin.js', headers: { cookie: `tm_admin=${encodeURIComponent(unlockToken)}` } },
      { label: 'admin unlock module', status: 200, url: '/admin-unlock.js' },
      // JSON.
      { label: 'health', status: 200, url: '/health' },
      { label: 'templates', status: 200, url: '/api/templates' },
      { label: 'gallery', status: 200, url: '/api/gallery' },
      { label: 'gallery signed in', status: 200, url: '/api/gallery', headers: own },
      { label: 'facets', status: 200, url: '/api/gallery/facets' },
      { label: 'design JSON', status: 200, url: `/api/designs/${pub}` },
      { label: 'me', status: 200, url: '/api/me', headers: own },
      { label: 'unread count', status: 200, url: '/api/notifications/unread', headers: own },
      { label: 'unread count, signed out', status: 401, url: '/api/notifications/unread' },
      { label: 'admin overview without access', status: 403, url: '/api/funnel' },
      { label: 'admin data with the unlock', status: 200, url: '/api/funnel', headers: { 'x-ai-unlock': unlockToken } },
      // The module worker and the other static files, fresh and revalidated.
      { label: 'module worker', status: 200, url: WORKER },
      { label: 'hashed script', status: 200, url: '/assets/index-Ab12Cd34.js' },
      { label: 'hashed script, brotli copy', status: 200, url: '/assets/index-Ab12Cd34.js', headers: { 'accept-encoding': 'br' } },
      { label: 'hashed script, gzip copy', status: 200, url: '/assets/index-Ab12Cd34.js', headers: { 'accept-encoding': 'gzip' } },
      { label: 'a copy asked for by name', status: 404, url: '/assets/index-Ab12Cd34.js.br', headers: { 'accept-encoding': 'br' } },
      { label: 'hashed stylesheet', status: 200, url: '/assets/index-Ab12Cd34.css' },
      { label: 'hashed font', status: 200, url: '/assets/inter-latin-400-Ab12Cd34.woff2' },
      { label: 'unhashed script', status: 200, url: '/boot-script.js' },
      { label: 'favicon svg', status: 200, url: '/favicon.svg' },
      { label: 'favicon ico', status: 200, url: '/favicon.ico' },
      { label: 'robots', status: 200, url: '/robots.txt' },
      { label: 'site card', status: 200, url: '/og-card.png' },
      { label: 'hero picture', status: 200, url: '/hero-stadium.webp' },
      { label: 'news picture', status: 200, url: '/news/leagues-saudi.webp' },
      // Pictures served by routes.
      { label: 'thumbnail', status: 200, url: `/api/designs/${pub}/thumbnail.png` },
      { label: 'share card', status: 200, url: `/og/t/${pub}.png` },
      { label: 'share card, old URL', status: 200, url: `/api/designs/${pub}/og.png` },
      { label: 'match photo', status: 200, url: `/api/photos/${photoId}` },
      // Redirects.
      { label: 'provider sign-in', status: 302, url: '/api/auth/google' },
      // Every refusal the server writes.
      { label: '404 api', status: 404, url: '/api/nope' },
      { label: '404 page', status: 404, url: '/nope' },
      { label: '404 asset', status: 404, url: '/assets/nope.js' },
      { label: '404 card', status: 404, url: `/og/t/${NO_SUCH}.png` },
      { label: '404 picture', status: 404, url: `/api/designs/${NO_SUCH}/thumbnail.png` },
      { label: '404 preflight', status: 404, method: 'OPTIONS', url: '/api/me', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } },
      { label: '400 bad id', status: 400, method: 'POST', url: '/api/report', payload: { targetType: 'design', targetId: 'abc', reason: 'x' } },
      { label: '400 broken JSON', status: 400, method: 'POST', url: '/api/designs', headers: { ...own, 'content-type': 'application/json' }, payload: '{bad' },
      { label: '401', status: 401, url: '/api/me' },
      { label: '403', status: 403, method: 'PUT', url: `/api/designs/${pub}/tags`, headers: bearer('not-a-session'), payload: { tags: [] } },
      { label: '413', status: 413, method: 'POST', url: '/api/designs', headers: own, payload: { title: 'x'.repeat(1_100_000) } },
      { label: '415', status: 415, method: 'POST', url: '/api/designs', headers: { ...own, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'title=x' },
      // The AI routes, refused and answered.
      { label: 'AI unlock, wrong password', status: 401, method: 'POST', url: '/api/ai/unlock', payload: { password: 'nope' } },
      { label: 'AI quota, signed out', status: 401, url: '/api/ai/quota' },
      { label: 'AI quota, unlocked', status: 200, url: '/api/ai/quota', headers: { 'x-ai-unlock': unlockToken } },
      { label: 'AI generate, signed out', status: 401, method: 'POST', url: '/api/ai/generate', payload: { prompt: 'a red tifo' } },
      { label: 'AI sign out', status: 204, method: 'DELETE', url: '/api/ai/unlock' },
    ];
    // 403 above is a forged token on an owner route: 401 is what it answers.
    cases.find((c) => c.label === '403')!.status = 401;
    for (const c of cases) {
      const r = await hApp.inject({ method: c.method ?? 'GET', url: c.url, remoteAddress: freshIp(), headers: c.headers, payload: c.payload as never });
      assert.equal(r.statusCode, c.status, `${c.label}: ${c.method ?? 'GET'} ${c.url} answered ${r.statusCode} (${r.body.slice(0, 120)})`);
      pinned(r, c.label);
    }
    // 304s: a static file revalidated, the worker and a compressed copy
    // included; and the routes that revalidate (stage 2): a public picture by
    // its hash (P2.4) and the HTML shells (P2.9).
    const revalidated: [string, Record<string, string>?][] = [
      [WORKER], ['/favicon.svg'], ['/robots.txt'], ['/assets/index-Ab12Cd34.js', { 'accept-encoding': 'br' }],
      [`/api/designs/${pub}/thumbnail.png`], ['/clubs'], ['/legal'], ['/tifo-spec'], [`/app?design=${pub}`],
    ];
    for (const [url, extra] of revalidated) {
      const ip = freshIp();
      const first = await hApp.inject({ method: 'GET', url, remoteAddress: ip, headers: extra });
      const etag = String(first.headers.etag ?? '');
      check(etag, `${url} has an ETag`);
      const again = await hApp.inject({ method: 'GET', url, remoteAddress: ip, headers: { ...extra, 'if-none-match': etag } });
      assert.equal(again.statusCode, 304, `${url} revalidates`);
      pinned(again, `${url} 304`);
    }
    // 429: the sign-in limit, and the global one.
    {
      const ip = freshIp();
      let last = null as Awaited<ReturnType<FastifyInstance['inject']>> | null;
      for (let i = 0; i < 11; i++) last = await hApp.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { username: 'nobody_s1', password: 'wrong password here' } });
      assert.equal(last!.statusCode, 429, 'the 11th sign-in in a minute is refused');
      pinned(last!, 'sign-in 429');
      const ip2 = freshIp();
      for (let i = 0; i < 300; i++) await hApp.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip2 });
      const over = await hApp.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip2 });
      assert.equal(over.statusCode, 429, 'the 301st request in a minute is refused');
      pinned(over, 'global 429');
      const over404 = await hApp.inject({ method: 'GET', url: '/nope', remoteAddress: ip2 });
      assert.equal(over404.statusCode, 429, 'and so is a probe from the same client');
      pinned(over404, '404 429');
    }
    // 500: a database failure, through the error handler.
    hDesigns.failGallery = true;
    const failed = await hApp.inject({ method: 'GET', url: '/api/gallery', remoteAddress: freshIp() });
    hDesigns.failGallery = false;
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { error: 'internal error' }, 'no driver message');
    pinned(failed, '500');
    // The origin lock's refusals (P2.2): on a page, the API, a 404, an asset
    // and a URL the router cannot read; and its 429.
    let stage2 = 0;
    {
      const lockApp = await buildApp(hDesigns, hAuth, templates, { staticDir: dist, rateLimit: true, originSecret: 'pinned-origin-secret-0123456789abcdef' });
      for (const [label, url] of [['locked page', '/'], ['locked API', '/api/templates'], ['locked 404', '/nope'], ['locked asset', '/assets/index-Ab12Cd34.js'], ['locked unreadable URL', '/%E0%A4%A']]) {
        const r = await lockApp.inject({ method: 'GET', url, remoteAddress: freshIp() });
        assert.equal(r.statusCode, 403, `${label}: ${r.statusCode}`);
        pinned(r, label);
        stage2++;
      }
      const ip = freshIp();
      for (let i = 0; i < 300; i++) await lockApp.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip });
      const over = await lockApp.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip });
      assert.equal(over.statusCode, 429, 'the lock counts in the limit');
      pinned(over, 'locked 429');
      stage2++;
      await lockApp.close();
    }
    // Work the worker could not take (P2.14): a scene strip, a scene check and a PDF, 503.
    {
      const { WorkerPool } = await import('../src/workerPool');
      const dead = new WorkerPool({ name: 'pin', file: { url: new URL(`data:text/javascript,${encodeURIComponent("import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => process.exit(5)); parentPort.postMessage({ ready: true });")}`) }, size: 1, maxQueue: 1, timeoutMs: 2_000, idleMs: 1_000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
      const poolApp = await buildApp(hDesigns, hAuth, templates, { staticDir: dist, workers: { scene: dead as never, pdf: dead as never } });
      const scene = gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: 'pin' }] }))).toString('base64');
      assert.equal((await hApp.inject({ method: 'PUT', url: `/api/designs/${pub}/scene`, remoteAddress: freshIp(), headers: own, payload: { sceneGzB64: scene } })).statusCode, 200);
      for (const [label, method, url, headers, payload] of [
        ['scene strip 503', 'GET', `/api/designs/${pub}/scene`, undefined, undefined],
        ['scene check 503', 'PUT', `/api/designs/${pub}/scene`, own, { sceneGzB64: scene }],
        ['PDF 503', 'POST', '/api/export/pdf', undefined, { title: 'x', templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 }],
      ] as const) {
        const r = await poolApp.inject({ method, url, remoteAddress: freshIp(), headers, payload: payload as never });
        assert.equal(r.statusCode, 503, `${label}: ${r.statusCode} ${r.body.slice(0, 120)}`);
        pinned(r, label);
        assert.equal(r.headers['cache-control'], 'no-store', `${label}: not cached`);
        stage2++;
      }
      await poolApp.close();
      await dead.close();
    }
    await hApp.close();
    console.log(`  P0.1 header pin: ${cases.length + revalidated.length + 3 + 1 + stage2} responses carry exactly the pinned headers`);
  }

  // ---- P0.2: who may cache what ----
  //
  // Every route that serves a design, for every kind of design and every kind
  // of caller. The rules: a response that says `public` is about a public
  // design, is the same for everyone, and carries nothing that belongs to its
  // owner; anything about a design that is not public says `private` or
  // `no-store` (or, for a generic HTML page, `no-cache` with the design kept
  // out of it); every refusal says how it may be cached.
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const app = await buildApp(designs, auth, templates, {
      staticDir: dist, social, featured: new MemoryDailyFeatureRepository(),
      adminUsernames: ['mod_m'], aiAdminPassword: 'matrix admin password', emailSender: mailStub,
    });
    const owner = await s1reg(app, 'owner_m');
    const other = await s1reg(app, 'other_m');
    const mod = await s1reg(app, 'mod_m', freshIp(), 'matrix admin password');
    await auth.markEmailVerified(owner.id);
    const SECRET_LAYER = 'data:image/png;base64,T1dORVItTEFZRVItTTI=';
    const sceneB64 = gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: 'b1' }], layers: [{ id: 'l1', src: SECRET_LAYER }] }))).toString('base64');
    const OWNER_ONLY = ['pinned', 'deletedAt', 'takenDown', 'origin'];
    type Kind = 'public' | 'private' | 'taken down' | 'trashed' | 'ownerless private' | 'ownerless public';
    const ids = new Map<Kind, { id: string; title: string; photo: string | null }>();
    const mk = async (kind: Kind): Promise<void> => {
      const title = `Matrix ${kind} ${Math.random().toString(36).slice(2, 7)}`;
      if (kind.startsWith('ownerless')) {
        const m = await designs.create({ title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: null as unknown as string, thumbnailPng: PNG });
        if (kind === 'ownerless public') await designs.patchMeta(m.id, { isPublic: true });
        await designs.putScene(m.id, Buffer.from(sceneB64, 'base64'));
        ids.set(kind, { id: m.id, title, photo: null });
        return;
      }
      const r = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: PNG.toString('base64') } });
      assert.equal(r.statusCode, 201, r.body);
      const id = (r.json() as { id: string }).id;
      const ownH = bearer(owner.token);
      assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: ownH, payload: { sceneGzB64: sceneB64 } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${id}/og-image`, headers: ownH, payload: { ogPngB64: PNG.toString('base64') } })).statusCode, 200);
      const ph = await app.inject({ method: 'POST', url: `/api/designs/${id}/photos`, headers: ownH, payload: { imageB64: PNG.toString('base64'), width: 1, height: 1 } });
      assert.equal(ph.statusCode, 200, ph.body);
      await app.inject({ method: 'POST', url: `/api/designs/${id}/revisions`, headers: ownH, payload: { indicesB64: Buffer.from(new Uint32Array([0]).buffer).toString('base64'), beforeB64: Buffer.from([0]).toString('base64'), afterB64: Buffer.from([1]).toString('base64') } });
      if (kind !== 'private') assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: ownH, payload: { isPublic: true } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${id}/comments`, headers: ownH, payload: { body: `a comment on ${kind}` } })).statusCode, 201);
      await designs.setPinned(id, true);
      if (kind === 'taken down') assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${id}/takedown`, headers: bearer(mod.token) })).statusCode, 200);
      if (kind === 'trashed') assert.equal((await app.inject({ method: 'DELETE', url: `/api/designs/${id}`, headers: ownH })).statusCode, 200);
      ids.set(kind, { id, title, photo: (ph.json() as { photoId: string }).photoId });
    };
    for (const k of ['public', 'private', 'taken down', 'trashed', 'ownerless private', 'ownerless public'] as Kind[]) await mk(k);
    const isPublicKind = (k: Kind): boolean => k === 'public' || k === 'ownerless public';
    const callers: [string, Record<string, string> | undefined][] = [['anon', undefined], ['other', bearer(other.token)], ['owner', bearer(owner.token)], ['moderator', bearer(mod.token)]];
    let checked = 0;
    for (const [kind, d] of ids) {
      const urls = [
        `/api/designs/${d.id}`, `/api/designs/${d.id}/scene`, `/api/designs/${d.id}/thumbnail.png`,
        `/og/t/${d.id}.png`, `/api/designs/${d.id}/og.png`, `/api/designs/${d.id}/comments`,
        `/api/designs/${d.id}/revisions`, `/api/designs/${d.id}/photos`, `/api/designs/${d.id}/stats`,
        `/api/gallery/${d.id}`, `/t/${d.id}`, `/d/${d.id}`, `/s/${d.id}`,
        `/api/admin/designs/${d.id}/thumbnail.png`,
        ...(d.photo ? [`/api/photos/${d.photo}`] : []),
      ];
      for (const url of urls) {
        const anonBody = (await app.inject({ method: 'GET', url })).rawPayload;
        for (const [who, headers] of callers) {
          const r = await app.inject({ method: 'GET', url, headers });
          const label = `${kind} design, ${who}: GET ${url} (${r.statusCode})`;
          const cc = String(r.headers['cache-control'] ?? '');
          check(cc, `${label} says how it may be cached`);
          const html = String(r.headers['content-type'] ?? '').startsWith('text/html');
          const json = String(r.headers['content-type'] ?? '').startsWith('application/json');
          const text = r.body;
          const ownerOnly = json && r.statusCode === 200 && (OWNER_ONLY.some((k) => new RegExp(`"${k}"\\s*:`).test(text)) || text.includes(SECRET_LAYER) || /"sceneGzB64":"[^"]/.test(text) && who === 'owner');
          if (/\bpublic\b/.test(cc)) {
            check(isPublicKind(kind), `${label}: only a public design's answer may be public (${cc})`);
            check(!json || !OWNER_ONLY.some((k) => new RegExp(`"${k}"\\s*:`).test(text)), `${label}: a public answer has no owner-only field`);
            check(!text.includes(SECRET_LAYER), `${label}: a public answer has no layer`);
            check(Buffer.compare(r.rawPayload, anonBody) === 0, `${label}: a public answer is the same for everyone`);
          }
          if (r.statusCode === 200 && !isPublicKind(kind)) {
            if (html) {
              assert.equal(cc, 'no-cache', `${label}: a page about a design that is not public is generic and revalidated`);
              check(!text.includes(d.title), `${label}: and does not name it`);
            } else {
              check(/\bprivate\b|no-store/.test(cc) && !/\bpublic\b/.test(cc), `${label}: never shared-cacheable (${cc})`);
            }
          }
          if (ownerOnly) check(/no-store|\bprivate\b/.test(cc), `${label}: an answer with the owner's own fields is no-store (${cc})`);
          if (r.statusCode >= 400) check(/no-store|no-cache/.test(cc), `${label}: a refusal is not cached (${cc})`);
          checked++;
          // With an ETag in hand (stage 2, P2.4): the one it was given, or the
          // picture's hash, which anyone who once saw it while public knows.
          // A 304 only ever for a public design, and only after the visibility
          // check: otherwise exactly the answer it gets without one.
          const tag = String(r.headers.etag ?? `"${createHash('sha256').update(PNG).digest('hex')}"`);
          const again = await app.inject({ method: 'GET', url, headers: { ...headers, 'if-none-match': tag } });
          if (again.statusCode === 304) {
            check(isPublicKind(kind), `${label}: a 304 only for a public design`);
            check(/\bpublic\b|no-cache/.test(String(again.headers['cache-control'])) && !/\bprivate\b|no-store/.test(String(again.headers['cache-control'])), `${label}: and only for an answer that may be kept (${again.headers['cache-control']})`);
            assert.equal(again.rawPayload.byteLength, 0);
          } else {
            assert.equal(again.statusCode, r.statusCode, `${label}: an ETag changes nothing else (${again.statusCode})`);
            assert.equal(again.headers['cache-control'], r.headers['cache-control'], `${label}: nor how it may be cached`);
          }
          if (/\bprivate\b|no-store/.test(cc)) check(!r.headers.etag, `${label}: an answer nobody may keep has no ETag`);
          checked++;
        }
      }
    }
    // The lists: never a design that is not public, whoever asks.
    const hidden = [...ids].filter(([k]) => !isPublicKind(k)).map(([, d]) => d);
    for (const url of ['/api/gallery', '/api/gallery?limit=120', '/api/gallery/facets', `/api/users/${owner.id}/profile`, '/sitemap.xml', '/community', '/']) {
      for (const [who, headers] of callers) {
        const r = await app.inject({ method: 'GET', url, headers });
        assert.equal(r.statusCode, 200, `${url} as ${who}`);
        check(r.headers['cache-control'], `${url} as ${who} says how it may be cached`);
        for (const h of hidden) check(!r.body.includes(h.id) && !r.body.includes(h.title), `${url} as ${who} does not list a design that is not public`);
        if (url.startsWith('/api/') && headers) assert.equal(r.headers['cache-control'], 'no-store', `${url} for a signed-in caller is per-viewer: no-store`);
        checked++;
      }
    }
    for (const url of ['/api/designs', '/api/projects']) {
      const r = await app.inject({ method: 'GET', url, headers: bearer(owner.token) });
      assert.equal(r.headers['cache-control'], 'no-store', `${url}: the owner's own list`);
    }
    await app.close();
    console.log(`  P0.2 cache matrix: ${checked} answers checked (6 kinds of design x 4 callers x every route that serves one, with and without an ETag, and the lists)`);
  }

  // ---- P0.2: every /api answer and every 404 says how it may be cached ----
  //
  // Walked from the routes the app actually registers, so a route added later
  // is checked without anyone remembering to add it here.
  {
    const routes: { method: string | string[]; url: string }[] = [];
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const app = await buildApp(designs, auth, templates, {
      onRoute: (r) => routes.push(r),
      staticDir: dist, social, featured: new MemoryDailyFeatureRepository(), leads: new MemoryLeadsRepository(),
      events: new MemoryEventsRepository(), aiUsage: new MemoryAiUsageRepository(), aiEvents: new MemoryAiEventsRepository(),
      stadiums: new MemoryStadiumRepository(), stats: new MemoryAdminStatsRepository(), traffic: new MemoryTrafficRepository(),
      feedback: new MemoryFeedbackRepository(), soc: new SocMonitor({ repo: new MemorySocRepository() }),
      adminUsernames: ['walk_mod'], aiAdminPassword: 'walk admin password', emailSender: mailStub,
      oauth: { google: { id: 'client-id', secret: 'client-secret' } },
    });
    const u = await s1reg(app, 'walker_s1');
    const d = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(u.token), payload: { title: 'Walked', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    const designId = (d.json() as { id: string }).id;
    const values: Record<string, string> = { id: designId, provider: 'google', photoId: NO_SUCH, commentId: NO_SUCH };
    const api = routes.filter((r) => r.url.startsWith('/api/'));
    check(api.length > 100, `the walk sees the API (${api.length} routes)`);
    // Sign-out and account deletion last, so the session lasts the walk.
    const last = (r: { url: string }) => (r.url === '/api/auth/logout' || r.url === '/api/account' ? 1 : 0);
    api.sort((a, b) => last(a) - last(b));
    let walked = 0;
    for (const who of [undefined, bearer(u.token)]) {
      for (const r of api) {
        for (const method of [r.method].flat()) {
          const url = r.url.replace(/:([A-Za-z]+)/g, (_m, name: string) => values[name] ?? NO_SUCH);
          const body = method === 'GET' || method === 'HEAD' ? undefined : {};
          const res = await app.inject({ method: method as 'GET', url, headers: who, payload: body as never });
          check(res.headers['cache-control'], `${method} ${r.url} (${who ? 'signed in' : 'anon'}, ${res.statusCode}) says how it may be cached`);
          walked++;
        }
      }
    }
    for (const url of ['/nope', '/api/nope', '/assets/nope.js', '/news/nope.webp', `/og/t/${NO_SUCH}.png`, '/admin.js', '/d/not-a-uuid/x', '/.env', '/wp-login.php']) {
      for (const method of ['GET', 'HEAD', 'POST'] as const) {
        const res = await app.inject({ method, url });
        if (res.statusCode !== 404) continue;
        check(/no-store|no-cache/.test(String(res.headers['cache-control'] ?? '')), `${method} ${url} 404 says how it may be cached (${res.headers['cache-control']})`);
        walked++;
      }
    }
    await app.close();
    console.log(`  P0.2 walk: ${walked} answers from ${api.length} API routes and the 404s all carry Cache-Control`);
  }

  // ---- P1.27: the hashed build files have a capped bucket of their own ----
  //
  // They were in the general 300, and six ordinary page views in 50 seconds
  // used it up: the seventh page's own scripts got 429. They now count in a
  // bucket of 600 a minute. Still a limit, still per client (an IPv6 /64 is
  // one client here too), one bucket for every file, decided by the static
  // route that answered and never by how the URL was written. The 300 and
  // every per-route limit are unchanged.
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { staticDir: dist, rateLimit: true });
    const ASSETS = ['/assets/index-Ab12Cd34.js', '/assets/index-Ab12Cd34.css', WORKER, '/assets/inter-latin-400-Ab12Cd34.woff2'];
    const login = (ip: string) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { username: 'nobody_s1', password: 'wrong password here' } });
    const count = async (n: number, f: (i: number) => Promise<{ statusCode: number }>): Promise<Record<number, number>> => {
      const by: Record<number, number> = {};
      for (let i = 0; i < n; i++) { const st = (await f(i)).statusCode; by[st] = (by[st] ?? 0) + 1; }
      return by;
    };
    // 400 asset requests, then sign-ins: still exactly 10 a minute.
    const ip = '198.19.0.1';
    assert.deepEqual(await count(400, (i) => app.inject({ method: 'GET', url: ASSETS[i % ASSETS.length], remoteAddress: ip })), { 200: 400 }, 'a page’s worth of assets, many times over, is served');
    assert.deepEqual(await count(12, () => login(ip)), { 401: 10, 429: 2 }, 'sign-in is still 10 a minute after 400 asset requests');
    // The general 300 is untouched by them, and still 300.
    assert.deepEqual(await count(301, () => app.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip })), { 200: 300, 429: 1 }, 'the general bucket is 300, whatever the assets used');
    // And the assets are capped: 600 in all.
    assert.deepEqual(await count(201, (i) => app.inject({ method: i % 2 ? 'HEAD' : 'GET', url: ASSETS[i % ASSETS.length], remoteAddress: ip })), { 200: 200, 429: 1 }, 'the 601st asset request in a minute is refused');
    // A miss under /assets/ is a 404 like any other: in the 300, not the 600.
    const ip2 = '198.19.0.2';
    assert.deepEqual(await count(300, () => app.inject({ method: 'GET', url: '/assets/nope.js', remoteAddress: ip2 })), { 404: 300 });
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip2 })).statusCode, 429, '/assets/nope.js counted in the 300');
    assert.equal((await app.inject({ method: 'GET', url: ASSETS[0], remoteAddress: ip2 })).statusCode, 200, 'while the real files are still served');
    // Paths that only look like assets are whatever the router makes of them.
    for (const url of ['/assets/../api/templates', '/assets%2F..%2Fapi/templates', '/assets/./index-Ab12Cd34.js/../../api/templates', '/assets//index-Ab12Cd34.js']) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: ip2 });
      assert.equal(r.statusCode, 429, `${url} is not an asset request (${r.statusCode})`);
    }
    // A POST to a file's path is not a file request either.
    const ip3 = '198.19.0.3';
    assert.deepEqual(await count(300, () => app.inject({ method: 'POST', url: ASSETS[0], remoteAddress: ip3, payload: {} })), { 404: 300 });
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip3 })).statusCode, 429, 'a POST to an asset path counted in the 300');
    // IPv6: the whole /64 is one client for the asset bucket too.
    const in64 = (i: number) => `2001:db8:5:6:${(i >> 16 & 0xffff).toString(16)}:${(i & 0xffff).toString(16)}::${(i % 7) + 1}`;
    assert.deepEqual(await count(600, (i) => app.inject({ method: 'GET', url: ASSETS[i % ASSETS.length], remoteAddress: in64(i) })), { 200: 600 });
    assert.equal((await app.inject({ method: 'GET', url: ASSETS[0], remoteAddress: '2001:db8:5:6:ffff:ffff:ffff:fffe' })).statusCode, 429, 'a new address in the same /64 is the same client');
    assert.equal((await app.inject({ method: 'GET', url: ASSETS[0], remoteAddress: '2001:DB8:5:6::abcd' })).statusCode, 429, 'however it is written');
    assert.equal((await app.inject({ method: 'GET', url: ASSETS[0], remoteAddress: '2001:db8:5:7::1' })).statusCode, 200, 'the next /64 is another client');
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: '2001:db8:5:6::99' })).statusCode, 200, 'and the /64’s general bucket is its own');
    // The key never comes from what the caller sends: a new bearer per request is still one client.
    const ip4 = '198.19.0.4';
    assert.deepEqual(await count(301, (i) => app.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip4, headers: bearer(`forged-${i}`) })), { 200: 300, 429: 1 }, 'a forged bearer per request shares one bucket');
    assert.deepEqual(await count(601, (i) => app.inject({ method: 'GET', url: ASSETS[i % ASSETS.length], remoteAddress: ip4, headers: bearer(`forged-${i}`) })), { 200: 600, 429: 1 }, 'for the assets too');
    const head = await app.inject({ method: 'GET', url: ASSETS[0], remoteAddress: '198.19.0.5' });
    assert.equal(head.headers['x-ratelimit-limit'], '600', 'an asset answer reports its own bucket');
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: '198.19.0.5' })).headers['x-ratelimit-limit'], '300', 'and the API its own');
    await app.close();
    console.log('  P1.27 asset bucket: 600 a minute for hashed files, per client and /64; sign-in, the 300 and 404s unchanged');
  }

  // ---- P1.9: a bare /app is sent to Projects by the server ----
  //
  // Only when the query is empty or campaign tags alone; every other query is
  // the editor's, as before. The target is a fixed path here, so nothing a
  // visitor puts in the link can choose where the redirect goes.
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { staticDir: dist });
    const bare: [string, string][] = [
      ['/app', '/projects?start=1'],
      ['/app?', '/projects?start=1'],
      ['/app?&&', '/projects?start=1'],
      ['/app?utm_source=whatsapp&utm_medium=share&utm_campaign=tifo', '/projects?start=1&utm_source=whatsapp&utm_medium=share&utm_campaign=tifo'],
      ['/app?utm_source=chatgpt.com', '/projects?start=1&utm_source=chatgpt.com'],
      ['/app?utm_term=%0d%0aSet-Cookie:%20x=1', '/projects?start=1&utm_term=%0D%0ASet-Cookie%3A+x%3D1'],
      ['/app?utm_content=https://evil.example/', '/projects?start=1&utm_content=https%3A%2F%2Fevil.example%2F'],
    ];
    for (const [url, to] of bare) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await app.inject({ method, url });
        assert.equal(r.statusCode, 302, `${method} ${url} is bare`);
        assert.equal(r.headers.location, to, `${method} ${url} goes to Projects`);
        assert.equal(r.headers['cache-control'], 'no-cache', `${url}: the redirect is revalidated like the page it replaces`);
        check(!/[\r\n]/.test(String(r.headers.location)) && !String(r.headers['set-cookie'] ?? '').includes('x=1'), `${url}: nothing from the link becomes a header`);
      }
    }
    // Everything else is the editor's to read, exactly as before.
    for (const url of [
      `/app?design=${NO_SUCH}`, `/app?project=${NO_SUCH}`, '/app?local=abc123', '/app?new=1', '/app?new=1&from=x&import=1',
      '/app?admin=1', '/app?signedin=google', '/app?verified=1', '/app?sim=1', '/app?e2e', '/app?start=1',
      `/app?utm_source=x&design=${NO_SUCH}`, '/app?utm_source=x&local=abc', '/app?x=1', '/app?=1', '/app?UTM_SOURCE=x', '/app?utm_=x', '/app?utm_source[]=x',
    ]) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, `${url} opens the editor`);
      check(String(r.headers['content-type']).startsWith('text/html'), `${url} is the editor page`);
    }
    await app.close();
    console.log('  P1.9 bare /app: 302 to /projects?start=1 for an empty or utm-only query, the editor for anything else');
  }

  // ---- P1.11 / P1.12: comment counts, facets, profiles and the sitemap ----
  //
  // The feed's cards carry their comment count (the 60 thread fetches per
  // /community view go), counted exactly as the thread route returns it. The
  // facets are counted in SQL and remembered per scope for a minute, and
  // forgotten at once on every change to the public set. A profile lists the
  // person's public designs from a query that is "owner AND public", never
  // their own list. The sitemap reads two columns.
  {
    const { designFacets, COLOUR_FAMILIES: FAMILIES } = await import('../../src/core/facets');
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const app = await buildApp(designs, auth, templates, { staticDir: dist, social, featured: new MemoryDailyFeatureRepository(), adminUsernames: ['mod_f'], aiAdminPassword: 'facets admin password' });
    const owner = await s1reg(app, 'owner_f');
    const fan = await s1reg(app, 'fan_f');
    const leaver = await s1reg(app, 'leaver_f');
    const mod = await s1reg(app, 'mod_f', freshIp(), 'facets admin password');
    await auth.markEmailVerified(fan.id);
    const ownH = bearer(owner.token);
    const create = async (title: string, palette: string[], pub: boolean, who = owner): Promise<string> => {
      const r = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(who.token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette, cellsGzB64 } });
      assert.equal(r.statusCode, 201, r.body);
      const id = (r.json() as { id: string }).id;
      if (pub) assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(who.token), payload: { isPublic: true } })).statusCode, 200);
      return id;
    };
    const comment = async (who: { token: string }, id: string, body: string, parentId?: string): Promise<string> => {
      const r = await app.inject({ method: 'POST', url: `/api/designs/${id}/comments`, headers: bearer(who.token), payload: { body, parentId } });
      assert.equal(r.statusCode, 201, r.body);
      return (r.json() as { id: string }).id;
    };
    const RED = ['#262a33', '#d01020', '#ffffff'];
    const BLUE = ['#262a33', '#1040d0', '#ffffff'];
    const a = await create('Al Hilal in blue', BLUE, true);
    const b = await create('Red wall', RED, true);
    const c = await create('Quiet one', BLUE, true);
    const priv = await create('Al Nassr private plan', RED, false);
    const top = await comment(fan, a, 'first');
    await comment(owner, a, 'a reply', top);
    await comment(leaver, a, 'from someone who leaves');
    const gone = await comment(fan, b, 'to be deleted');
    await comment(fan, b, 'stays');
    await comment(owner, priv, 'a note on a private design');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${gone}`, headers: bearer(fan.token) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(leaver.token), payload: { password: S1PW } })).statusCode, 204);
    // A design liked by the fan, so the profile's other list has a card too.
    assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${a}/vote`, headers: bearer(fan.token), payload: { value: 1 } })).statusCode, 200);

    /** Every card the API hands out, from every list that carries them. */
    const cards = async (headers?: Record<string, string>): Promise<{ from: string; id: string; commentCount: unknown }[]> => {
      const out: { from: string; id: string; commentCount: unknown }[] = [];
      for (const it of (await app.inject({ method: 'GET', url: '/api/gallery', headers })).json() as { id: string; commentCount: unknown }[]) out.push({ from: 'gallery', ...it });
      for (const it of (await app.inject({ method: 'GET', url: '/api/gallery?sort=likes', headers })).json() as { id: string; commentCount: unknown }[]) out.push({ from: 'gallery by likes', ...it });
      for (const id of [a, b, c]) out.push({ from: 'gallery item', ...((await app.inject({ method: 'GET', url: `/api/gallery/${id}`, headers })).json() as { id: string; commentCount: unknown }) });
      const prof = (await app.inject({ method: 'GET', url: `/api/users/${owner.id}/profile`, headers })).json() as { created: { id: string; commentCount: unknown }[] };
      for (const it of prof.created) out.push({ from: 'profile created', ...it });
      const fanProf = (await app.inject({ method: 'GET', url: `/api/users/${fan.id}/profile`, headers })).json() as { liked: { id: string; commentCount: unknown }[] };
      for (const it of fanProf.liked) out.push({ from: 'profile liked', ...it });
      return out;
    };
    for (const [who, headers] of [['anon', undefined], ['fan', bearer(fan.token)], ['owner', ownH]] as const) {
      const all = await cards(headers);
      check(all.length >= 10, `${who}: cards from every list (${all.length})`);
      for (const card of all) {
        const thread = (await app.inject({ method: 'GET', url: `/api/designs/${card.id}/comments`, headers })).json() as unknown[];
        assert.equal(card.commentCount, thread.length, `${who}, ${card.from}: commentCount is the thread's length (${card.id})`);
        check(card.id !== priv, `${who}, ${card.from}: never a private design`);
      }
    }
    // A thread that changes is counted as it is now.
    await comment(fan, c, 'new');
    const cNow = ((await app.inject({ method: 'GET', url: `/api/gallery/${c}` })).json() as { commentCount: number }).commentCount;
    assert.equal(cNow, 1, 'a new comment is counted at once');

    // ---- facets: what the JavaScript used to compute, now from the counts ----
    /** The old answer, computed the old way: every public card, classified here. */
    const oldWay = async (query: string): Promise<{ total: number; colors: { id: string; count: number }[]; clubs: { id: string; count: number }[] }> => {
      const qs = new URLSearchParams(query);
      const rows = (await designs.listPublic({ sort: 'recent', excludeTemplates: qs.get('made') === 'people', templatesOnly: qs.get('templates') === '1' }));
      const cc = new Map<string, number>(); const kc = new Map<string, number>();
      for (const r of rows) {
        const f = designFacets({ title: r.title, titleAr: r.titleAr, palette: r.palette });
        for (const x of f.colors) cc.set(x, (cc.get(x) ?? 0) + 1);
        if (f.clubId) kc.set(f.clubId, (kc.get(f.clubId) ?? 0) + 1);
      }
      return {
        total: rows.length,
        colors: FAMILIES.filter((x) => cc.has(x)).map((x) => ({ id: x, count: cc.get(x)! })),
        clubs: [...kc.entries()].sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0])).map(([id, count]) => ({ id, count })),
      };
    };
    const facets = async (query = ''): Promise<{ total: number; matching: number; colors: { id: string; count: number }[]; clubs: { id: string; count: number; name: string }[] }> => {
      const r = await app.inject({ method: 'GET', url: `/api/gallery/facets${query ? `?${query}` : ''}` });
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    };
    const sameAsOld = async (why: string): Promise<void> => {
      for (const query of ['', 'made=people', 'templates=1', 'made=people&templates=1']) {
        const now = await facets(query);
        const was = await oldWay(query);
        assert.equal(now.total, was.total, `${why} [${query}]: total`);
        assert.equal(now.matching, was.total, `${why} [${query}]: matching with nothing picked`);
        assert.deepEqual(now.colors, was.colors, `${why} [${query}]: colours`);
        assert.deepEqual(now.clubs.map(({ id, count }) => ({ id, count })), was.clubs, `${why} [${query}]: clubs`);
      }
    };
    await sameAsOld('to begin with');
    const hilal = designFacets({ title: 'Al Hilal in blue', palette: BLUE }).clubId!;
    check(hilal, 'the test title names a club');
    assert.equal((await facets('colors=red')).matching, (await designs.listPublic({ sort: 'recent', colors: ['red'] })).length, 'matching counts a selection like the feed returns it');
    assert.equal((await facets(`club=${hilal}&colors=blue`)).matching, 1);
    // Every change to the public set is seen at once, not after the minute.
    const changes: [string, () => Promise<unknown>][] = [
      ['publish', () => app.inject({ method: 'PATCH', url: `/api/designs/${priv}`, headers: ownH, payload: { isPublic: true } })],
      ['unpublish', () => app.inject({ method: 'PATCH', url: `/api/designs/${priv}`, headers: ownH, payload: { isPublic: false } })],
      ['rename to another club', () => app.inject({ method: 'PATCH', url: `/api/designs/${c}`, headers: ownH, payload: { title: 'Al Ittihad night' } })],
      ['repaint', () => app.inject({ method: 'PUT', url: `/api/designs/${b}`, headers: ownH, payload: { palette: BLUE, cellsGzB64 } })],
      ['template flag', () => app.inject({ method: 'PUT', url: `/api/designs/${b}/template`, headers: ownH, payload: { isTemplate: true } })],
      ['takedown', () => app.inject({ method: 'POST', url: `/api/admin/designs/${b}/takedown`, headers: bearer(mod.token) })],
      ['trash', () => app.inject({ method: 'DELETE', url: `/api/designs/${c}`, headers: ownH })],
      ['restore', () => app.inject({ method: 'POST', url: `/api/designs/${c}/restore`, headers: ownH })],
      ['trash again', () => app.inject({ method: 'DELETE', url: `/api/designs/${c}`, headers: ownH })],
      ['delete for good', () => app.inject({ method: 'DELETE', url: `/api/designs/${c}?permanent=1`, headers: ownH })],
    ];
    for (const [why, change] of changes) {
      await facets(); await facets('made=people'); await facets('templates=1'); // remembered now
      const r = (await change()) as { statusCode: number; body: string };
      check(r.statusCode < 300, `${why}: ${r.statusCode} ${r.body.slice(0, 80)}`);
      await sameAsOld(`after ${why}`);
    }
    // Account deletion takes its designs out of the counts at once.
    const goner = await s1reg(app, 'goner_f');
    await create('Al Nassr farewell', RED, true, goner);
    await facets();
    await sameAsOld('with the leaving account');
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(goner.token), payload: { password: S1PW } })).statusCode, 204);
    await sameAsOld('after an account deletion');
    // Memoised: a change made behind the routes' back (another process) shows after the minute, not before.
    await facets();
    const before = (await facets()).total;
    const sneaky = await designs.create({ title: 'Behind the routes', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: RED, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: owner.id, thumbnailPng: null });
    await designs.patchMeta(sneaky.id, { isPublic: true });
    assert.equal((await facets()).total, before, 'the base counts are remembered between changes');
    app.forgetPublicCounts(); // what server.ts does after seeding the library at boot
    assert.equal((await facets()).total, before + 1, 'and forgotten when the server says the public set changed');
    assert.equal((await facets('colors=red')).matching, (await designs.listPublic({ sort: 'recent', colors: ['red'] })).length, 'a selection is never remembered');

    // ---- profiles: the person's public designs, nothing else ----
    const pubMine = await create('Profile public', RED, true);
    const privMine = await create('Profile private', RED, false);
    const downMine = await create('Profile taken down', RED, true);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${downMine}/takedown`, headers: bearer(mod.token) })).statusCode, 200);
    const trashMine = await create('Profile trashed', RED, true);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/designs/${trashMine}`, headers: ownH })).statusCode, 200);
    const orphanPub = await designs.create({ title: 'Profile orphan public', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: RED, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: null as unknown as string, thumbnailPng: null });
    await designs.patchMeta(orphanPub.id, { isPublic: true });
    const orphanPriv = await designs.create({ title: 'Profile orphan private', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: RED, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: null as unknown as string, thumbnailPng: null });
    const neverListed = [privMine, downMine, trashMine, orphanPub.id, orphanPriv.id, priv];
    const expected = (await designs.listPublic({ sort: 'recent' })).filter((d) => d.ownerId === owner.id).map((d) => d.id);
    check(expected.includes(pubMine) && expected.length >= 3, 'the owner has public designs to list');
    for (const [who, headers] of [['anon', undefined], ['fan', bearer(fan.token)], ['owner', ownH], ['moderator', bearer(mod.token)]] as const) {
      const prof = (await app.inject({ method: 'GET', url: `/api/users/${owner.id}/profile`, headers })).json() as { created: { id: string; ownerId: string; isPublic: boolean }[]; designCount: number };
      assert.deepEqual(prof.created.map((d) => d.id), expected, `${who}: exactly the owner's public designs, newest first`);
      for (const id of neverListed) check(!prof.created.some((d) => d.id === id), `${who}: never a private, taken-down, trashed or ownerless design (${id})`);
      check(prof.created.every((d) => d.isPublic && d.ownerId === owner.id), `${who}: every card is public and theirs`);
      for (const k of ['pinned', 'deletedAt', 'takenDown', 'origin']) check(prof.created.every((d) => !(k in d)), `${who}: no owner-only "${k}"`);
    }
    // Asking for fewer, or for nonsense.
    const sized = async (q: string) => ((await app.inject({ method: 'GET', url: `/api/users/${owner.id}/profile${q}` })).json() as { created: { id: string }[] }).created.map((d) => d.id);
    assert.deepEqual(await sized('?limit=2'), expected.slice(0, 2), 'limit=2 is the newest two');
    assert.deepEqual(await sized('?limit=1'), expected.slice(0, 1));
    for (const q of ['?limit=0', '?limit=-5', '?limit=abc', '?limit=1e9', '?limit=1000', '?limit=2&limit=3']) {
      const got = await sized(q);
      check(got.length >= 1 && got.length <= 200 && got.every((id, i) => id === expected[i]), `${q}: a prefix of the list, 1 to 200 long (${got.length})`);
    }
    // An ownerless design is nobody's profile; a profile of nobody is a 404.
    assert.equal((await app.inject({ method: 'GET', url: `/api/users/${NO_SUCH}/profile` })).statusCode, 404);
    for (const id of [orphanPub.id, orphanPriv.id]) check(!(await designs.listPublicByOwner(null as unknown as string, { limit: 200 })).some((d) => d.id === id), 'no owner matches an ownerless design');

    // ---- the sitemap: public designs only, ids and dates ----
    const xml = (await app.inject({ method: 'GET', url: '/sitemap.xml' })).body;
    const listed = [...xml.matchAll(/\/t\/([0-9a-f-]{36})<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(listed, (await designs.listPublic({ sort: 'recent' })).map((d) => d.id), 'the sitemap lists every public design, newest first, and nothing else');
    for (const id of neverListed.filter((x) => x !== orphanPub.id)) check(!xml.includes(id), `the sitemap never lists a design that is not public (${id})`);
    check(xml.includes(orphanPub.id), 'an ownerless design that is public is listed like any public one');
    await app.close();
    console.log('  P1.11/P1.12: comment counts match every thread, facets match the old computation through every change, profiles and the sitemap are public-only');
  }

  // ---- Postgres: the same counts, privacy and parity on a real database ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { readFileSync: readSql } = await import('node:fs');
    const { schemaStatements } = await import('../src/schema');
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const { PgSocialRepository } = await import('../src/pgSocial');
    const { designFacets, COLOUR_FAMILIES: FAMILIES } = await import('../../src/core/facets');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      for (const stmt of schemaStatements(readSql(new URL('../schema.sql', import.meta.url), 'utf8'))) await pool.query(stmt).catch(() => {});
      const pAuth = new PgAuthRepository(pool);
      const pDesigns = new PgDesignRepository(pool);
      const pSocial = new PgSocialRepository(pool);
      const sfx = Math.random().toString(36).slice(2, 7);
      const papp = await buildApp(pDesigns, pAuth, templates, { social: pSocial, adminUsernames: [`pgmod${sfx}`], aiAdminPassword: 'pg stage one admin' });
      const owner = await s1reg(papp, `pgown${sfx}`);
      const fan = await s1reg(papp, `pgfan${sfx}`);
      const leaver = await s1reg(papp, `pglve${sfx}`);
      const mod = await s1reg(papp, `pgmod${sfx}`, freshIp(), 'pg stage one admin');
      await pAuth.markEmailVerified(fan.id);
      const ownH = bearer(owner.token);
      const create = async (title: string, palette: string[], pub: boolean): Promise<string> => {
        const r = await papp.inject({ method: 'POST', url: '/api/designs', headers: ownH, payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette, cellsGzB64 } });
        assert.equal(r.statusCode, 201, r.body);
        const id = (r.json() as { id: string }).id;
        if (pub) assert.equal((await papp.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: ownH, payload: { isPublic: true } })).statusCode, 200);
        return id;
      };
      const comment = async (who: { token: string }, id: string, body: string, parentId?: string): Promise<string> => {
        const r = await papp.inject({ method: 'POST', url: `/api/designs/${id}/comments`, headers: bearer(who.token), payload: { body, parentId } });
        assert.equal(r.statusCode, 201, r.body);
        return (r.json() as { id: string }).id;
      };
      const a = await create(`Al Hilal pg ${sfx}`, ['#262a33', '#1040d0', '#ffffff'], true);
      const b = await create(`Red pg ${sfx}`, ['#262a33', '#d01020', '#ffffff'], true);
      const priv = await create(`Private pg ${sfx}`, ['#262a33', '#d01020'], false);
      const down = await create(`Down pg ${sfx}`, ['#262a33', '#d01020'], true);
      const trashed = await create(`Trashed pg ${sfx}`, ['#262a33', '#d01020'], true);
      const leaverTop = await comment(leaver, a, 'from someone who leaves');
      await comment(fan, a, 'a reply to the leaver', leaverTop);
      await comment(fan, a, 'top level');
      const gone = await comment(fan, b, 'deleted');
      await comment(owner, b, 'kept');
      await comment(owner, priv, 'private note');
      await comment(fan, down, 'on a design about to go');
      assert.equal((await papp.inject({ method: 'DELETE', url: `/api/comments/${gone}`, headers: bearer(fan.token) })).statusCode, 200);
      assert.equal((await papp.inject({ method: 'DELETE', url: '/api/account', headers: bearer(leaver.token), payload: { password: S1PW } })).statusCode, 204);
      assert.equal((await papp.inject({ method: 'POST', url: `/api/admin/designs/${down}/takedown`, headers: bearer(mod.token) })).statusCode, 200);
      assert.equal((await papp.inject({ method: 'DELETE', url: `/api/designs/${trashed}`, headers: ownH })).statusCode, 200);
      const orphans = await pool.query(
        `INSERT INTO designs (title, template_id, template_version, palette, cells, is_public)
         VALUES ($1, $3, 1, '["#262a33","#d01020"]'::jsonb, $4, true), ($2, $3, 1, '["#262a33","#d01020"]'::jsonb, $4, false) RETURNING id`,
        [`Orphan pub pg ${sfx}`, `Orphan priv pg ${sfx}`, DEFAULT_TEMPLATE.id, gzipSync(new Uint8Array(map.count))],
      );
      const [orphanPub, orphanPriv] = orphans.rows.map((r) => String(r.id));
      // Comment counts: what each thread returns, from every list.
      const ids = [a, b];
      for (const headers of [undefined, bearer(fan.token)]) {
        const lists = [
          ...((await papp.inject({ method: 'GET', url: '/api/gallery?limit=120', headers })).json() as { id: string; commentCount: number }[]),
          ...(await Promise.all(ids.map(async (id) => (await papp.inject({ method: 'GET', url: `/api/gallery/${id}`, headers })).json() as { id: string; commentCount: number }))),
          ...((await papp.inject({ method: 'GET', url: `/api/users/${owner.id}/profile`, headers })).json() as { created: { id: string; commentCount: number }[] }).created,
        ];
        for (const id of ids) check(lists.some((c) => c.id === id), `Postgres: ${id} is on the lists`);
        for (const card of lists) {
          const thread = (await papp.inject({ method: 'GET', url: `/api/designs/${card.id}/comments`, headers })).json() as unknown[];
          assert.equal(card.commentCount, thread.length, `Postgres: commentCount is the thread's length (${card.id})`);
        }
      }
      assert.equal(((await papp.inject({ method: 'GET', url: `/api/gallery/${a}` })).json() as { commentCount: number }).commentCount, 2, 'Postgres: a departed account’s comment is gone from the count as from the thread, its reply kept');
      // Profiles: owner AND public, whatever else the owner has.
      const created = ((await papp.inject({ method: 'GET', url: `/api/users/${owner.id}/profile`, headers: ownH })).json() as { created: { id: string }[] }).created.map((d) => d.id);
      assert.deepEqual(created, [b, a], 'Postgres: the profile lists the public designs, newest first');
      for (const id of [priv, down, trashed, orphanPub, orphanPriv]) check(!created.includes(id), `Postgres: never ${id} in a profile`);
      assert.deepEqual((await pDesigns.listPublicByOwner(owner.id, { limit: 1 })).map((d) => d.id), [b], 'Postgres: the limit holds');
      // Facets: the SQL counts are the old JavaScript classification of every public design.
      // A row whose stored facets went stale (a failed sync, or rules that
      // changed since) is put right by the boot resync.
      await pool.query(`UPDATE designs SET colors = '{grey}', club_id = 'not-a-club' WHERE id = $1`, [b]);
      check((await pDesigns.resyncFacets()) >= 1, 'Postgres: the resync finds the stale row');
      assert.equal(await pDesigns.resyncFacets(), 0, 'Postgres: and a second one has nothing left to do');
      for (const scope of [{}, { excludeTemplates: true }, { templatesOnly: true }, { excludeTemplates: true, templatesOnly: true }]) {
        const rows = await pDesigns.listPublic({ sort: 'recent', ...scope });
        const want = { total: rows.length, colors: {} as Record<string, number>, clubs: {} as Record<string, number> };
        for (const r of rows) {
          const f = designFacets({ title: r.title, titleAr: r.titleAr, palette: r.palette });
          for (const x of f.colors) want.colors[x] = (want.colors[x] ?? 0) + 1;
          if (f.clubId) want.clubs[f.clubId] = (want.clubs[f.clubId] ?? 0) + 1;
        }
        const got = await pDesigns.facetBase(scope);
        assert.equal(got.total, want.total, `Postgres facets ${JSON.stringify(scope)}: total`);
        assert.deepEqual(Object.fromEntries(FAMILIES.filter((x) => got.colors[x]).map((x) => [x, got.colors[x]])), Object.fromEntries(FAMILIES.filter((x) => want.colors[x]).map((x) => [x, want.colors[x]])), `Postgres facets ${JSON.stringify(scope)}: colours`);
        assert.deepEqual(got.clubs, want.clubs, `Postgres facets ${JSON.stringify(scope)}: clubs`);
        assert.equal(await pDesigns.countPublic({ ...scope, colors: ['red'] }), (await pDesigns.listPublic({ sort: 'recent', ...scope, colors: ['red'] })).length, `Postgres count ${JSON.stringify(scope)}: as the feed`);
      }
      // The sitemap's ids are exactly the public ones.
      assert.deepEqual((await pDesigns.listPublicIds(5000)).map((d) => d.id), (await pDesigns.listPublic({ sort: 'recent' })).map((d) => d.id), 'Postgres: sitemap ids are the public designs');
      await papp.close();
    } finally {
      await pool.end();
    }
    console.log('  Postgres: comment counts, profiles, facets and sitemap ids agree with the threads and the old computation');
  }

  // ---- P1.26: bounded pools, a maintenance pool, and fail-closed under timeouts ----
  //
  // A statement now stops at 10 s and a request waits at most 5 s for a
  // connection, so database errors stop being rare. Every check that reads
  // the database must refuse when the read fails, and a timeout answers 503
  // "try again" through the error handler, never a driver message.
  {
    const { POOL_SETTINGS, createPool, isDatabaseUnavailable } = await import('../src/db');
    assert.equal(POOL_SETTINGS.app.max, 20);
    assert.equal(POOL_SETTINGS.app.connectionTimeoutMillis, 5_000, 'a request waits at most 5 s for a connection');
    assert.equal(POOL_SETTINGS.app.statement_timeout, 10_000, 'and a statement runs at most 10 s');
    assert.equal(POOL_SETTINGS.app.idle_in_transaction_session_timeout, 10_000);
    assert.equal(POOL_SETTINGS.maintenance.max, 3, 'the maintenance pool is small');
    check((POOL_SETTINGS.maintenance.statement_timeout as number) >= 60_000, 'and patient');
    for (const role of ['app', 'maintenance'] as const) {
      const p = createPool('postgres://nobody:nothing@127.0.0.1:1/none', role);
      check(p.listenerCount('error') > 0 && p.listenerCount('connect') > 0, `the ${role} pool keeps its error listeners (pool and client)`);
      await p.end();
    }
    for (const e of [{ code: '57014' }, { code: '25P03' }, { code: '53300' }, { code: '57P01' }, { code: '08006' }, new Error('timeout exceeded when trying to connect'), new Error('Connection terminated unexpectedly'), new Error('Connection terminated due to connection timeout')]) {
      check(isDatabaseUnavailable(e), `${JSON.stringify(e)} / ${(e as Error).message ?? ''} is the database being unavailable`);
    }
    for (const e of [{ code: '23505' }, { code: '22P02' }, new Error('boom'), null, undefined]) check(!isDatabaseUnavailable(e), `${JSON.stringify(e)} is not`);
    const src = readFileSync('server/src/server.ts', 'utf8');
    assert.match(src, /createPool\(process\.env\.DATABASE_URL, 'app'\)/, 'server.ts builds the request pool');
    assert.match(src, /createPool\(process\.env\.DATABASE_URL, 'maintenance'\)/, 'and the maintenance pool');
    assert.match(src, /await applySchema\(maint\)/, 'the schema is applied on the maintenance pool');
    assert.match(src, /new PgAdminStatsRepository\(maint\)/, 'the admin aggregates run there');
    assert.match(src, /new PgDesignRepository\(pool, maint\)/);
    assert.match(src, /new PgAuthRepository\(pool, maint\)/, 'and account erasure');

    class Flaky extends MemoryDesignRepository {
      fail = new Set<string>();
      private boom(what: string): void { if (this.fail.has(what)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); }
      override async listTitlesByOwner(id: string) { this.boom('titles'); return super.listTitlesByOwner(id); }
      override async listPhotos(id: string) { this.boom('photos'); return super.listPhotos(id); }
      override async listByOwner(id: string) { this.boom('list'); return super.listByOwner(id); }
      override async deleteByOwner(id: string) { this.boom('erase'); return super.deleteByOwner(id); }
      override async listPublic(q: Parameters<MemoryDesignRepository['listPublic']>[0]) { this.boom('gallery'); return super.listPublic(q); }
    }
    const auth = new MemoryAuthRepository();
    const designs = new Flaky((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, {});
    const u = await s1reg(app, 'flaky_s1');
    await auth.markEmailVerified(u.id);
    const h = bearer(u.token);
    const made = await app.inject({ method: 'POST', url: '/api/designs', headers: h, payload: { title: 'F', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    const id = (made.json() as { id: string }).id;
    // A timeout anywhere: 503 and a retry code, no driver text.
    designs.fail.add('gallery');
    const t = await app.inject({ method: 'GET', url: '/api/gallery' });
    designs.fail.delete('gallery');
    assert.equal(t.statusCode, 503, 'a statement timeout answers 503');
    assert.deepEqual(t.json(), { error: 'the server is busy, please try again', code: 'retry' }, 'with nothing from the driver');
    // The design cap: an unreadable count refuses, it does not let the design in.
    designs.fail.add('titles');
    const capped = await app.inject({ method: 'POST', url: '/api/designs', headers: h, payload: { title: 'G', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    assert.equal(capped.statusCode, 503, `a design is not created when the account's count cannot be read (${capped.statusCode})`);
    assert.equal((await app.inject({ method: 'POST', url: `/api/designs/${id}/fork`, headers: h, payload: {} })).statusCode, 503, 'nor a copy');
    designs.fail.delete('titles');
    assert.equal((await designs.listByOwner(u.id)).length, 1, 'and nothing was added');
    // The photo cap, likewise.
    designs.fail.add('photos');
    const ph = await app.inject({ method: 'POST', url: `/api/designs/${id}/photos`, headers: h, payload: { imageB64: PNG.toString('base64'), width: 1, height: 1 } });
    designs.fail.delete('photos');
    assert.equal(ph.statusCode, 503, `a photo is not stored when the design's photos cannot be counted (${ph.statusCode})`);
    assert.equal((await designs.listPhotos(id)).length, 0);
    // The export: all of it or a refusal, never part of it given as the whole.
    designs.fail.add('list');
    const ex = await app.inject({ method: 'GET', url: '/api/account/export', headers: h });
    designs.fail.delete('list');
    assert.equal(ex.statusCode, 503, 'an export that cannot read the designs is refused');
    // Erasure: the designs first; if they cannot go, nothing goes and it says so.
    designs.fail.add('erase');
    const del = await app.inject({ method: 'DELETE', url: '/api/account', headers: h, payload: { password: S1PW } });
    designs.fail.delete('erase');
    assert.equal(del.statusCode, 503, 'an erasure that cannot delete the designs fails');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: h })).statusCode, 200, 'and the account is still there');
    assert.equal((await designs.listByOwner(u.id)).length, 1, 'with its designs: nothing was left ownerless');
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/account', headers: h, payload: { password: S1PW } })).statusCode, 204, 'a retry finishes it');
    assert.equal((await designs.listByOwner(u.id)).length, 0);
    await app.close();

    // The slow work goes to the maintenance pool and nothing else does.
    const { PgAuthRepository, PgDesignRepository, PgEventsRepository, PgAiEventsRepository } = await import('../src/pgRepo');
    const { PgTrafficRepository } = await import('../src/trafficRepo');
    const { PgFeedbackRepository } = await import('../src/feedbackRepo');
    const { PgSocRepository } = await import('../src/socRepo');
    const seen: string[] = [];
    const fakePool = (name: string) => {
      const answer = { rows: [], rowCount: 0 };
      const client = { query: async (sql: string) => { seen.push(`${name}: ${String(sql).trim().split(/\s+/).slice(0, 2).join(' ')}`); return answer; }, release: () => {} };
      return { query: client.query, connect: async () => client } as unknown as import('pg').Pool;
    };
    const app_ = fakePool('app');
    const maint = fakePool('maintenance');
    const pd = new PgDesignRepository(app_, maint);
    const pa = new PgAuthRepository(app_, maint);
    await pd.deleteByOwner(NO_SUCH); await pd.purgeTrashed(new Date()); await pd.backfillFacets(); await pd.resyncFacets();
    await pa.deleteUser(NO_SUCH);
    await new PgEventsRepository(app_, maint).purge(new Date());
    await new PgEventsRepository(app_, maint).funnel(['a'], 1).catch(() => {});
    await new PgAiEventsRepository(app_, maint).stats(1).catch(() => {});
    await new PgTrafficRepository(app_, maint).purge().catch(() => {});
    await new PgTrafficRepository(app_, maint).summary(1).catch(() => {});
    await new PgFeedbackRepository(app_, maint).list(1).catch(() => {});
    await new PgSocRepository(app_, maint).purge().catch(() => {});
    check(seen.length > 8 && seen.every((q) => q.startsWith('maintenance:')), `slow work runs on the maintenance pool (${seen.filter((q) => !q.startsWith('maintenance:')).join('; ')})`);
    seen.length = 0;
    await pd.listPublic({ sort: 'recent', limit: 1 }); await pd.get(NO_SUCH); await pd.facetBase({}); await pa.getUserIdByToken('x');
    await new PgEventsRepository(app_, maint).record('s', 'landed', false);
    check(seen.length >= 5 && seen.every((q) => q.startsWith('app:')), `requests run on the request pool (${seen.join('; ')})`);

    // On a real database: the limits are what the session runs with, and a
    // timeout is recognised for what it is.
    if (process.env.DATABASE_URL) {
      const appPool = createPool(process.env.DATABASE_URL, 'app');
      const mPool = createPool(process.env.DATABASE_URL, 'maintenance');
      try {
        assert.equal((await appPool.query('SHOW statement_timeout')).rows[0].statement_timeout, '10s', 'Postgres: requests run with a 10 s statement limit');
        assert.equal((await appPool.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout, '10s');
        assert.equal((await mPool.query('SHOW statement_timeout')).rows[0].statement_timeout, '1min', 'Postgres: maintenance a minute');
        const pg = (await import('pg')).default;
        const quick = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 200, max: 1, connectionTimeoutMillis: 300 });
        const slow = await quick.query('SELECT pg_sleep(2)').then(() => null, (e: unknown) => e);
        check(slow && isDatabaseUnavailable(slow), `Postgres: a statement past its limit is "unavailable" (${(slow as { code?: string })?.code})`);
        const held = await quick.connect();
        const waited = await quick.query('SELECT 1').then(() => null, (e: unknown) => e);
        held.release();
        check(waited && isDatabaseUnavailable(waited), `Postgres: no connection within the wait is "unavailable" (${(waited as Error)?.message})`);
        await quick.end();
      } finally {
        await appPool.end();
        await mPool.end();
      }
    }
    console.log('  P1.26 pools: 20 + 2 connections, 5 s wait, 10 s statements; timeouts answer 503; the design and photo caps, the export and erasure fail closed');
  }

  // ---- P1.25: the foreign-key indexes ----
  {
    const { FOREIGN_KEY_INDEXES, applyForeignKeyIndexes } = await import('../src/schema');
    assert.equal(FOREIGN_KEY_INDEXES.length, 8, 'eight indexes');
    const schemaSql = readFileSync('server/schema.sql', 'utf8');
    check(/CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens \(user_id\)/.test(schemaSql), 'auth_tokens (user_id) is in the schema already (round six)');
    check(!/CONCURRENTLY/.test(schemaSql.replace(/^\s*--.*$/gm, '')), 'schema.sql stays runnable as one query: no CONCURRENTLY in it');
    // A build that fails is logged and the next one tried; nothing throws.
    const ran: string[] = [];
    const logged: string[] = [];
    const fake = { connect: async () => ({
      query: async (sql: string) => {
        ran.push(sql);
        if (sql.startsWith('SELECT i.indisvalid')) return { rows: [] };
        if (sql.includes('ON notifications (design_id)')) throw new Error('canceling statement due to lock timeout');
        return { rows: [] };
      },
      release: () => {},
    }) };
    const r = await applyForeignKeyIndexes(fake as never, (m) => logged.push(m));
    assert.deepEqual(r.failed, ['notifications_design_idx'], 'the failure is reported');
    assert.equal(r.built.length, 7, 'and the other seven built');
    check(logged.length === 1 && logged[0].includes('notifications_design_idx'), 'and logged');
    check(ran.filter((q) => q.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).length === 8, 'every build is CONCURRENTLY, one statement each');
    check(ran.some((q) => /^SET statement_timeout/.test(q)) && ran.some((q) => /RESET statement_timeout/.test(q)), 'the build session’s limits are set and put back');

    if (process.env.DATABASE_URL) {
      const pg = (await import('pg')).default;
      const { schemaStatements } = await import('../src/schema');
      const { PgFeedbackRepository } = await import('../src/feedbackRepo');
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        for (const stmt of schemaStatements(schemaSql)) await pool.query(stmt).catch(() => {});
        await new PgFeedbackRepository(pool).init();
        for (const ix of FOREIGN_KEY_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${ix.name}`);
        const first = await applyForeignKeyIndexes(pool);
        assert.deepEqual(first.failed, [], 'Postgres: every index builds');
        assert.equal(first.built.length, 8);
        const state = async () => (await pool.query(
          `SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
             FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = ANY($1)`,
          [FOREIGN_KEY_INDEXES.map((x) => x.name)],
        )).rows as { name: string; valid: boolean; def: string }[];
        for (const ix of FOREIGN_KEY_INDEXES) {
          const row = (await state()).find((x) => x.name === ix.name);
          check(row?.valid && row.def.includes(`ON public.${ix.table} USING btree (${ix.column})`), `Postgres: ${ix.name} is valid, on ${ix.table} (${ix.column}): ${row?.def}`);
        }
        assert.deepEqual((await applyForeignKeyIndexes(pool)).built, [], 'Postgres: a second run builds nothing');
        // A half-built index (what an interrupted CONCURRENTLY build leaves) is rebuilt.
        await pool.query('DROP INDEX IF EXISTS design_votes_user_idx');
        await pool.query("INSERT INTO users (username, password_hash) VALUES ('ixa_' || md5(random()::text), 'x'), ('ixb_' || md5(random()::text), 'x')");
        const two = (await pool.query("SELECT id FROM users ORDER BY created_at DESC LIMIT 2")).rows.map((x) => x.id);
        const someDesign = (await pool.query(`INSERT INTO designs (title, template_id, template_version, palette, cells) VALUES ('ix', 'x', 1, '[]'::jsonb, '\\x00') RETURNING id`)).rows[0].id;
        await pool.query('INSERT INTO design_votes (design_id, user_id, value) VALUES ($1, $2, 1), ($1, $3, 1)', [someDesign, two[0], two[1]]);
        await pool.query('CREATE UNIQUE INDEX CONCURRENTLY design_votes_user_idx ON design_votes (design_id, value)').catch(() => {});
        check((await state()).find((x) => x.name === 'design_votes_user_idx')?.valid === false, 'Postgres: (the test made an invalid index)');
        const repaired = await applyForeignKeyIndexes(pool);
        assert.deepEqual(repaired.built, ['design_votes_user_idx'], 'Postgres: the invalid index is rebuilt');
        const fixed = (await state()).find((x) => x.name === 'design_votes_user_idx');
        check(fixed?.valid && fixed.def.includes('(user_id)') && !fixed.def.includes('UNIQUE'), `Postgres: and is the right one now (${fixed?.def})`);
        await pool.query('DELETE FROM designs WHERE id = $1', [someDesign]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [two]);
        // The session limits went back to what the connection had.
        assert.equal((await pool.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
      } finally {
        await pool.end();
      }
    }
    console.log('  P1.25 foreign-key indexes: eight, CONCURRENTLY, after listen; a failure is logged and skipped, an invalid one rebuilt');
  }

  // ---- P1.29: public pictures, icons and robots.txt cached for an hour ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { staticDir: dist });
    const HOUR = 'public, max-age=3600, stale-while-revalidate=86400';
    const expect: [string, string][] = [
      ['/favicon.svg', HOUR], ['/favicon.ico', HOUR], ['/apple-touch-icon.png', HOUR], ['/icon-512.png', HOUR],
      ['/og-card.png', HOUR], ['/og-default.png', HOUR], ['/hero-stadium.webp', HOUR], ['/hero-stadium-640.webp', HOUR], ['/news/leagues-saudi.webp', HOUR], ['/robots.txt', HOUR],
      ['/assets/index-Ab12Cd34.js', 'public, max-age=31536000, immutable'], [WORKER, 'public, max-age=31536000, immutable'],
      // A page and an unhashed script are never kept.
      ['/boot-script.js', 'public, max-age=0'], ['/verify-site.html', 'public, max-age=0'], ['/landing.html', 'public, max-age=0'], ['/index.html', 'public, max-age=0'],
    ];
    for (const [url, cc] of expect) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.headers['cache-control'], cc, `${url}: ${cc}`);
      const again = await app.inject({ method: 'GET', url, headers: { 'if-none-match': String(r.headers.etag) } });
      assert.equal(again.statusCode, 304, `${url} revalidates`);
      check(again.headers['cache-control'] === undefined || again.headers['cache-control'] === cc, `${url}: a 304 never says something different from its 200 (${again.headers['cache-control']})`);
    }
    for (const url of ['/', '/community', '/projects', '/clubs', '/legal', '/tifo-spec', '/account', '/reset']) {
      assert.equal((await app.inject({ method: 'GET', url })).headers['cache-control'], 'no-cache', `${url}: pages are revalidated every time`);
    }
    // The server never names the boot script: the build may give it a hashed name.
    for (const f of listDir('server/src')) check(!readFileSync(`server/src/${f}`, 'utf8').includes('theme-boot'), `server/src/${f} does not hard-code theme-boot.js`);
    await app.close();
    console.log('  P1.29 static: pictures, icons and robots.txt an hour (+ a day stale-while-revalidate); pages and unhashed scripts max-age=0');
  }

  // ---- P1.28 / P1.31: seat counts and royal boxes from the generated table ----
  //
  // Boot no longer generates 104 seat maps to count seats, and the first save
  // on a ground no longer generates its map to find the royal box. Both come
  // from server/data/seat-table.json, written by the same generator. A row is
  // used only when it was generated from the ground's current definition;
  // otherwise, or when the file is missing or malformed, the ground is
  // generated as before. (test:deploy regenerates the whole table and compares.)
  {
    const { SeatTable, SEAT_TABLE_PATH, readSeatTable, formatSeatTable, generateSeatEntry, templateFingerprint, maskRuns } = await import('../src/seatTable');
    const { shippedTemplates } = await import('../../src/core/stadiumCatalog');
    const { noTifoMask } = await import('../../src/core/venueDetails');
    const { gunzipSync } = await import('node:zlib');
    const file = readSeatTable(SEAT_TABLE_PATH);
    check(file && file.size === shippedTemplates().length, `the table has every shipped ground (${file?.size})`);
    // The one the save test uses: a ground with a royal box, and its row checked against the generator.
    const boxed = shippedTemplates().find((t) => (file!.get(`${t.id}@${t.version}`)?.locked.length ?? 0) > 0)!;
    check(boxed, 'some ground has locked seats');
    const fresh = generateSeatEntry(boxed);
    assert.deepEqual(file!.get(fresh.key), fresh, `${boxed.id}: the table's row is exactly what the generator makes`);
    assert.deepEqual(fresh.locked, maskRuns(noTifoMask(generateSeatMap(boxed), boxed)!), 'and its locked runs are the royal box');
    assert.deepEqual(maskRuns(Uint8Array.from([0, 1, 1, 0, 1, 0, 0, 1])), [[1, 3], [4, 5], [7, 8]], 'runs are [start, end)');
    // A good table is read, not regenerated.
    const logs: string[] = [];
    const good = new SeatTable(SEAT_TABLE_PATH, (m) => logs.push(m));
    const t0 = Date.now();
    const rows = good.shipped();
    const readMs = Date.now() - t0;
    check(readMs < 2000 && good.generatedIds().length === 0 && logs.length === 0, `a current table is used as it is (${readMs} ms, ${good.generatedIds().length} generated)`);
    assert.equal(rows.length, shippedTemplates().length);
    // A stale, missing or malformed row is generated, and said.
    const dir = mkdtempSync(`${tmpdir()}/tifo-seat-table-`);
    const stalePath = `${dir}/stale.json`;
    const all = [...file!.values()];
    writeFileSync(stalePath, formatSeatTable(all.map((e) => (e.key === fresh.key ? { ...e, fp: 'old-definition', seats: e.seats + 1 } : e))));
    const stale = new SeatTable(stalePath, (m) => logs.push(m));
    assert.equal(stale.entry(boxed).seats, fresh.seats, 'a row from an older definition is not used: the ground is generated');
    assert.deepEqual(stale.generatedIds(), [boxed.id]);
    stale.shipped();
    check(logs.some((m) => m.includes(boxed.id) && m.includes('seats:table')), 'and the boot line says which, and what to run');
    for (const [label, text] of [
      ['missing', null],
      ['not JSON', '{"format":1,"grounds":['],
      ['another format', JSON.stringify({ format: 2, grounds: all })],
      ['a negative count', formatSeatTable(all.map((e) => (e.key === fresh.key ? { ...e, seats: -5 } : e)))],
      ['locked seats past the end', formatSeatTable(all.map((e) => (e.key === fresh.key ? { ...e, locked: [[0, e.seats + 10]] } : e)))],
      ['runs out of order', formatSeatTable(all.map((e) => (e.key === fresh.key ? { ...e, locked: [[50, 60], [10, 20]] } : e)))],
      ['a key that is not its ground', formatSeatTable(all.map((e) => (e.key === fresh.key ? { ...e, key: 'generic-bowl-60k@1' } : e)))],
    ] as [string, string | null][]) {
      const path = `${dir}/${label.replace(/\W+/g, '-')}.json`;
      if (text !== null) writeFileSync(path, text);
      const t = new SeatTable(path, () => {});
      assert.deepEqual(t.entry(boxed), fresh, `${label}: the ground is generated, never read from a bad row`);
    }
    assert.equal(templateFingerprint(boxed), fresh.fp);
    // Through the routes: a save on that ground clears exactly its royal box, from the table.
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, [{ id: boxed.id, version: boxed.version, name: boxed.name, seatCount: fresh.seats }], {});
    const u = await s1reg(app, 'boxed_s1');
    const full = gzipSync(new Uint8Array(fresh.seats).fill(1)).toString('base64');
    const made = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(u.token), payload: { title: 'Royal box', templateId: boxed.id, templateVersion: boxed.version, palette: PALETTE, cellsGzB64: full } });
    assert.equal(made.statusCode, 201, made.body);
    const id = (made.json() as { id: string }).id;
    const cells = gunzipSync(Buffer.from(((await app.inject({ method: 'GET', url: `/api/designs/${id}`, headers: bearer(u.token) })).json() as { cellsGzB64: string }).cellsGzB64, 'base64'));
    const lockedSet = new Uint8Array(fresh.seats);
    for (const [a, b] of fresh.locked) lockedSet.fill(1, a, b);
    let wrong = 0;
    for (let i = 0; i < cells.length; i++) if ((cells[i] === 0) !== (lockedSet[i] === 1)) wrong++;
    assert.equal(wrong, 0, 'every royal-box seat cleared, every other seat kept');
    const saved = await app.inject({ method: 'PUT', url: `/api/designs/${id}`, headers: bearer(u.token), payload: { palette: PALETTE, cellsGzB64: full } });
    assert.equal(saved.statusCode, 200, 'a full save on it works too');
    check(seatTable.lockedRuns('not-a-ground', 1) === null, 'a ground that is not shipped has no runs and clears nothing');
    await app.close();
    console.log(`  P1.28/P1.31 seat table: ${rows.length} grounds read in ${readMs} ms; stale, missing and malformed rows regenerated; the royal box cleared from it`);
  }

  console.log('performance plan stage 1 (server): all assertions passed');
}

// ---------- 2026-10: performance plan, the editor's one fetch of a design (P1.8) ----------
// GET /api/designs/:id says whether the caller owns the design, so a page no
// longer fetches /api/me to compare ids; and the browser client keeps the
// design's answer (and /api/me) in page memory for the load that follows. The
// guardrails: isOwner is true only for the bearer token's own account, the
// answer stays no-store, and the page memos are keyed by the token
// generation, so switching accounts without signing out never hands one
// account's answer to the other.
{
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const social = new MemorySocialRepository(designs, auth);
  const app = await buildApp(designs, auth, templates, { social, leads: new MemoryLeadsRepository() });
  const alice = await reg(app, 'alice_p18');
  const bob = await reg(app, 'bob_p18');
  const priv = await makeDesign(app, alice.token, false);
  const pub = await makeDesign(app, alice.token, true);
  const orphan = await designs.create({ title: 'no owner', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: null as unknown as string, thumbnailPng: null });
  await designs.patchMeta(orphan.id, { isPublic: true });
  const get = (id: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/api/designs/${id}`, headers });

  // ---- isOwner: true for the owner's own session, false for everyone else ----
  for (const [what, id, headers, want] of [
    ['the owner, private', priv, bearer(alice.token), true],
    ['the owner, public', pub, bearer(alice.token), true],
    ['another account, public', pub, bearer(bob.token), false],
    ['anonymous, public', pub, {}, false],
    ['a made-up token, public', pub, bearer('f'.repeat(64)), false],
    ['a token for the owner’s id spelled as a header', pub, { authorization: `Bearer ${alice.id}` }, false],
    ['the owner, an ownerless design', orphan.id, bearer(alice.token), false],
    ['anonymous, an ownerless design', orphan.id, {}, false],
  ] as [string, string, Record<string, string>, boolean][]) {
    const r = await get(id, headers);
    assert.equal(r.statusCode, 200, `${what}: ${r.body.slice(0, 120)}`);
    const body = r.json() as { isOwner?: unknown };
    assert.equal(typeof body.isOwner, 'boolean', `${what}: isOwner is a boolean`);
    assert.equal(body.isOwner, want, `${what}: isOwner is ${want}`);
    assert.equal(r.headers['cache-control'], 'no-store', `${what}: the answer is still no-store`);
  }
  // A private design is still not there for anyone but its owner, isOwner or not.
  for (const headers of [{}, bearer(bob.token)]) {
    const r = await get(priv, headers);
    assert.equal(r.statusCode, 404, 'a private design is 404 to others');
    check(!/isOwner/.test(r.body), 'and a refusal says nothing about ownership');
  }
  // A session that has been signed out owns nothing any more.
  const gone = await reg(app, 'gone_p18');
  const gonePub = await makeDesign(app, gone.token, true);
  assert.equal((await get(gonePub, bearer(gone.token))).json().isOwner, true);
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(gone.token) });
  assert.equal((await get(gonePub, bearer(gone.token))).json().isOwner, false, 'a revoked token is not the owner');

  // ---- the browser client's page memos, against this server ----
  // src/net/api.ts, run as it runs in a page, with fetch answered by the app.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const r = await app.inject({ method: method as 'GET', url, headers: (init?.headers ?? {}) as Record<string, string>, payload: init?.body as string | undefined });
    const empty = r.statusCode === 204 || r.statusCode === 304;
    return new Response(empty ? null : new Uint8Array(r.rawPayload), { status: r.statusCode, headers: r.headers as Record<string, string> });
  }) as typeof fetch;
  try {
    const api = await import('../../src/net/api');
    const { DesignStore } = await import('../../src/core/design');
    const count = (s: string) => calls.filter((c) => c === s).length;
    const designGets = (id: string) => count(`GET /api/designs/${id}`);

    await api.login('alice_p18', 'quartz-lantern-echo7');
    // One request answers the stadium lookup and the load after it.
    api.fetchDesignEarly(priv);
    const ref = await api.fetchDesignTemplate(priv);
    assert.equal(ref.templateId, DEFAULT_TEMPLATE.id);
    const loaded = await api.loadDesign(new DesignStore(map, PALETTE.slice()), priv);
    assert.equal(loaded.ownerIsMe, true, 'the owner is told it is theirs, from isOwner');
    assert.equal(designGets(priv), 1, `one GET for the template and the seats (${designGets(priv)})`);
    assert.equal(count('GET /api/me'), 0, 'and no /api/me to find out whose it is');
    // Loaded is forgotten: a later look asks again.
    await api.fetchDesignTemplate(priv);
    assert.equal(designGets(priv), 2, 'a design already loaded is fetched afresh');
    // The page's /api/me, once.
    const me1 = await api.fetchMeOnce();
    const me2 = await api.fetchMeOnce();
    assert.equal(me1?.id, alice.id);
    assert.equal(me2?.id, alice.id);
    assert.equal(count('GET /api/me'), 1, 'fetchMeOnce asks once per session');

    // Switching accounts without signing out: nothing of alice's is handed to bob.
    api.fetchDesignEarly(priv); // in memory (or still in flight) for alice
    await api.login('bob_p18', 'quartz-lantern-echo7');
    const before = designGets(priv);
    let refused: unknown = null;
    await api.fetchDesignTemplate(priv).catch((e) => { refused = e; });
    check(refused instanceof Error, 'after the switch, alice’s private design is refused to bob, not served from memory');
    assert.equal(designGets(priv), before + 1, 'the switch made the page ask the server again');
    const meBob = await api.fetchMeOnce();
    assert.equal(meBob?.id, bob.id, 'the /api/me memo is bob’s after the switch');
    assert.equal(count('GET /api/me'), 2, '…fetched again, not alice’s kept answer');
    // Bob opening alice's public design is not its owner.
    const asBob = await api.loadDesign(new DesignStore(map, PALETTE.slice()), pub);
    assert.equal(asBob.ownerIsMe, false, 'another account is never told it owns the design');
    // A change of password hands back a new token: a new generation too.
    api.fetchDesignEarly(pub);
    const g = designGets(pub);
    await api.changePassword('quartz-lantern-echo7', 'harbour-violet-signal4');
    await api.fetchDesignTemplate(pub);
    assert.equal(designGets(pub), g + 1, 'a password change drops the memo');
    // Signed out: no account, and no request to learn that.
    api.signOut();
    const meOut = await api.fetchMeOnce();
    assert.equal(meOut, null, 'signed out, there is no /api/me');
    assert.equal(count('GET /api/me'), 2, 'and none was asked for');
    const asAnon = await api.loadDesign(new DesignStore(map, PALETTE.slice()), pub);
    assert.equal(asAnon.ownerIsMe, false, 'nobody signed in owns anything');
  } finally {
    globalThis.fetch = realFetch;
  }
  await app.close();
  console.log('performance plan P1.8: all assertions passed (isOwner only for the owner’s own session, still no-store, page memos dropped on every token change)');
}

// ---------- 2026-10: performance plan stage 1, the independent review ----------
// A URL the router cannot read was answered by Fastify itself, before any
// hook: none of the security headers, no Cache-Control, the path echoed in the
// body, and never rate limited. It is answered by our own handler now.
{
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const a = new MemoryAuthRepository();
  const d = new MemoryDesignRepository((id) => a.usernameOf(id));
  const dist = existsSync('dist/index.html') ? resolve('dist') : undefined;
  const app = await buildApp(d, a, templates, { rateLimit: true, ...(dist ? { staticDir: dist } : {}) });
  const ref = await app.inject({ method: 'GET', url: '/no-such-page' });
  const pinned = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'strict-transport-security', 'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'origin-agent-cluster', 'x-dns-prefetch-control', 'x-download-options', 'x-permitted-cross-domain-policies', 'x-xss-protection'];
  for (const url of ['/%E0%A4%A', '/api/%', '/assets/%E0']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 400, `${url} is a bad request`);
    for (const h of pinned) assert.equal(r.headers[h], ref.headers[h], `${url} carries ${h} like any other answer`);
    assert.equal(r.headers['cache-control'], 'no-store', `${url} says no-store`);
    assert.ok(!r.body.includes('%E0') && !r.body.includes('valid url'), `${url}: the body repeats nothing (${r.body})`);
  }
  let refused = 0;
  for (let i = 0; i < 305; i++) {
    const r = await app.inject({ method: 'GET', url: `/%E0%A4%A${i}` });
    if (r.statusCode === 429) refused++;
  }
  assert.ok(refused > 0, `unreadable URLs count against the limit like any probe (${refused} of 305 refused)`);
  await app.close();
  console.log('performance plan stage 1 review: all assertions passed (unreadable URLs get the headers, no-store and the limit)');
}

// ---------- 2026-10: performance plan, stage 2 (server), part one ----------
// One log line per request (P2.20), one auth query per request (P2.17), the
// unread count (P2.16) and batched page views (P2.18). Each sits next to a
// control: the request log is where real addresses live, the session read
// decides who a request is, and the page views must never carry an address.
{
  const { connect } = await import('node:net');
  const { readFileSync } = await import('node:fs');
  const { MemoryTrafficRepository, BatchedTrafficRepository } = await import('../src/trafficRepo');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const S2PW = 'lantern-orchid-quarry8';
  const s2reg = async (app: FastifyInstance, u: string, adminPassword?: string): Promise<{ token: string; id: string }> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: S2PW, email: `${u}@example.test`, acceptedVersion: 'test', adminPassword } });
    assert.equal(r.statusCode, 201, r.body);
    const token = (r.json() as { token: string }).token;
    return { token, id: ((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json() as { id: string }).id };
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  // ---- P2.20: one line per request; redacted; errors kept; aborts written ----
  {
    const lines: string[] = [];
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const { MemorySocRepository } = await import('../src/socRepo');
    const { SocMonitor } = await import('../src/soc');
    const soc = new SocMonitor({ repo: new MemorySocRepository() });
    const app = await buildApp(designs, auth, templates, { logger: true, logStream: { write: (l: string) => { lines.push(l); } }, soc });
    app.get('/__s2_slow', async () => { await new Promise((r) => setTimeout(r, 400)); return { ok: true }; });
    const parsed = () => lines.map((l) => JSON.parse(l) as { level: number; reqId?: string; msg: string; req?: { url: string; remoteAddress?: string; method: string }; res?: { statusCode: number | null }; responseTime?: number; aborted?: boolean });
    const u = await s2reg(app, 'logline_s2');
    await settle();
    lines.length = 0;
    const urls: [string, string, Record<string, string>?][] = [
      ['GET', '/health'],
      ['GET', '/api/me', bearer(u.token)],
      ['GET', '/reset?token=RESETSECRET2222'],
      ['GET', '/api/auth/verify?token=VERIFYSECRET2222&code=123456'],
      ['GET', '/api/nope'],
      ['GET', '/%E0%A4%A'],
      ['POST', '/api/auth/login'],
    ];
    for (const [method, url, headers] of urls) await app.inject({ method: method as 'GET', url, headers: { ...headers, 'x-origin-secret': 'NOT-A-REAL-SECRET-0000', 'user-agent': 'S2-UA-marker' } });
    // A failure: the error line and the request's own line.
    const leaky = designs as unknown as { popularTags: () => Promise<never> };
    const realTags = leaky.popularTags;
    leaky.popularTags = async () => { throw new Error('S2 boom'); };
    await app.inject({ method: 'GET', url: '/api/tags' });
    leaky.popularTags = realTags;
    await settle();
    const all = parsed();
    const done = all.filter((l) => l.msg === 'request completed');
    assert.equal(done.length, urls.length + 1, `one "request completed" line per request (${done.length} for ${urls.length + 1})`);
    assert.equal(all.filter((l) => l.msg === 'incoming request').length, 0, 'and no "incoming request" line');
    assert.equal(new Set(done.map((l) => l.reqId)).size, done.length, 'one line per request id');
    for (const l of done) {
      check(l.req && l.req.method && l.req.url && l.req.remoteAddress === '127.0.0.1', `the line keeps method, URL and address (${JSON.stringify(l.req)})`);
      check(typeof l.res?.statusCode === 'number' && typeof l.responseTime === 'number', 'and the status and response time');
    }
    const joined = lines.join('');
    check(!/RESETSECRET2222|VERIFYSECRET2222|123456/.test(joined), 'one-time secrets in a URL are redacted');
    check(joined.includes('/reset?token=[redacted]') && joined.includes('code=[redacted]'), 'and the URL is still there, minus the secret');
    check(!joined.includes(u.token) && !joined.includes('NOT-A-REAL-SECRET-0000') && !joined.includes('S2-UA-marker'), 'no header is ever written: not the bearer, not x-origin-secret, not the user-agent');
    const failed = all.find((l) => l.level === 50 && /request failed/.test(l.msg));
    check(failed, 'the error line is still written');
    const failedLine = done.find((l) => l.req?.url === '/api/tags');
    check(failed && failedLine && failed.reqId === failedLine.reqId && failedLine.res?.statusCode === 500, 'with the same reqId as its request line');
    check(done.some((l) => l.req?.url === '/%E0%A4%A' && l.res?.statusCode === 400), 'an unreadable URL (no hook runs for it) still gets its line');
    // The Security tab names events by reqId, and the log line carries the same one.
    await soc.flush();
    const ev = soc.recent(20).find((e: { kind: string }) => e.kind === 'server_error') as { reqId?: string } | undefined;
    check(ev && ev.reqId === failedLine?.reqId, `a Security tab event can still be found in the log by its reqId (${ev?.reqId} / ${failedLine?.reqId})`);
    // A client that leaves before the answer: a line of its own, with the address.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    lines.length = 0;
    await new Promise<void>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write('GET /__s2_slow?token=ABORTSECRET HTTP/1.1\r\nHost: localhost\r\n\r\n');
        setTimeout(() => { sock.destroy(); resolve(); }, 60);
      });
    });
    await new Promise((r) => setTimeout(r, 600));
    const aborted = parsed().filter((l) => l.msg === 'request aborted');
    assert.equal(aborted.length, 1, 'an aborted request is written once');
    check(aborted[0].req?.url === '/__s2_slow?token=[redacted]' && aborted[0].req?.remoteAddress === '127.0.0.1' && aborted[0].aborted === true, `with its redacted URL and its address (${JSON.stringify(aborted[0])})`);
    assert.equal(parsed().filter((l) => l.msg === 'request completed').length, 0, 'and not also as completed');
    await app.close();
    // The SOC monitor does not read the log; its hook is untouched.
    check(/attachSecurityMonitor\(app, options\.soc\)/.test(readFileSync('server/src/routes.ts', 'utf8')), 'the security monitor is still attached to every route');
    console.log('  P2.20 request log: one line per request, secrets and headers out, error lines kept, aborted requests written');
  }

  // ---- P2.17: one read of the session per request, never kept past it ----
  {
    /** Counts the account reads a route makes (the store's own lookup inside getSessionUser is not one). */
    class CountingAuth extends MemoryAuthRepository {
      reads: string[] = [];
      failSession = false;
      private inSession = false;
      override async getSessionUser(h: string): ReturnType<MemoryAuthRepository['getSessionUser']> {
        this.reads.push('session');
        if (this.failSession) throw new Error('connection terminated');
        this.inSession = true;
        try {
          return await super.getSessionUser(h);
        } finally {
          this.inSession = false;
        }
      }
      override async getUserIdByToken(h: string): Promise<string | null> { this.reads.push('token'); return super.getUserIdByToken(h); }
      override async hasChosenUsername(id: string): Promise<boolean> { this.reads.push('chosen'); return super.hasChosenUsername(id); }
      override async getUserById(id: string): ReturnType<MemoryAuthRepository['getUserById']> {
        if (!this.inSession) this.reads.push('user');
        return super.getUserById(id);
      }
    }
    const auth = new CountingAuth();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const app = await buildApp(designs, auth, templates, { social, adminUsernames: ['chief_s2'], aiAdminPassword: 'stage two admin password' });
    const fan = await s2reg(app, 'fan_s2');
    const chief = await s2reg(app, 'chief_s2', 'stage two admin password');
    await auth.markEmailVerified(fan.id);
    const pub = await makeDesign(app, chief.token, true);
    const authReads = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) => {
      auth.reads.length = 0;
      const r = await app.inject({ method, url, headers: bearer(token), payload: payload as never });
      return { status: r.statusCode, reads: [...auth.reads] };
    };
    for (const [method, url, who, payload] of [
      ['GET', '/api/me', fan, undefined],
      ['GET', '/api/me', chief, undefined],
      ['GET', '/api/notifications', fan, undefined],
      ['GET', '/api/notifications/unread', fan, undefined],
      ['POST', `/api/designs/${pub}/vote`, fan, { value: 1 }],
      ['GET', '/api/admin/reports', chief, undefined],
      ['GET', `/api/designs/${pub}`, chief, undefined],
      ['GET', '/api/projects', fan, undefined],
      ['GET', '/api/account/export', fan, undefined],
    ] as const) {
      const { status, reads } = await authReads(method, url, who.token, payload);
      check(status < 400, `${method} ${url} answers (${status})`);
      assert.deepEqual(reads, ['session'], `${method} ${url}: one read of the session and the account, nothing else (${reads.join(', ')})`);
    }
    // Every way a session ends is seen by the very next request.
    const fresh = async (u: string) => s2reg(app, u);
    const a = await fresh('revoke_s2');
    await auth.deleteToken(hashToken(a.token));
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(a.token) })).statusCode, 401, 'a revoked token is refused on the next request');
    const b = await fresh('logout_s2');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(b.token) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(b.token) })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(b.token) })).statusCode, 401, 'a signed-out token is refused on the next request');
    const c = await fresh('pwchange_s2');
    const other = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pwchange_s2', password: S2PW } })).json().token as string;
    const changed = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(c.token), payload: { currentPassword: S2PW, newPassword: 'basalt-ember-violin4' } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(c.token) })).statusCode, 401, 'after a password change the old session is refused on the next request');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(other) })).statusCode, 401, 'and so is every other one');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(changed.json().token) })).statusCode, 200, 'the session it handed back works');
    const d = await fresh('deleted_s2');
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(d.token), payload: { password: S2PW } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(d.token) })).statusCode, 401, 'a deleted account is refused on the next request');
    const e = await fresh('expired_s2');
    const expiredTok = 'e'.repeat(64);
    await auth.createToken(e.id, hashToken(expiredTok), new Date(Date.now() - 1000));
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(expiredTok) })).statusCode, 401, 'an expired token opens nothing');
    // Two sessions at once never see each other's account.
    const x = await fresh('twin_x_s2');
    const y = await fresh('twin_y_s2');
    for (let round = 0; round < 25; round++) {
      const [rx, ry] = await Promise.all([
        app.inject({ method: 'GET', url: '/api/me', headers: bearer(x.token) }),
        app.inject({ method: 'GET', url: '/api/me', headers: bearer(y.token) }),
      ]);
      assert.equal(rx.json().id, x.id, 'each request is its own token’s account');
      assert.equal(ry.json().id, y.id, 'each request is its own token’s account');
    }
    // The wall and the admin checks read the same row, and still hold.
    const unnamed = await auth.createUser('gfan_s2_unnamed', null, { email: 'unnamed_s2@example.test', emailVerified: true, usernameChosen: false });
    const unnamedTok = 'u'.repeat(64);
    await auth.createToken(unnamed!.id, hashToken(unnamedTok), new Date(Date.now() + 3600_000));
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(unnamedTok) })).statusCode, 200, 'an unnamed account may ask who it is');
    assert.equal((await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(unnamedTok), payload: { title: 'x', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } })).statusCode, 428, 'and nothing else: the wall still holds');
    assert.equal((await app.inject({ method: 'GET', url: '/api/notifications/unread', headers: bearer(unnamedTok) })).statusCode, 428, 'the unread count included');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/reports', headers: bearer(fan.token) })).statusCode, 403, 'an ordinary account is no moderator');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/reports', headers: bearer(chief.token) })).statusCode, 200, 'the allow-listed one is');
    // A session that cannot be read refuses: 503, never a guess.
    auth.failSession = true;
    const refused = await Promise.all([
      app.inject({ method: 'POST', url: '/api/designs', headers: bearer(fan.token), payload: { title: 'x', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } }),
      app.inject({ method: 'PUT', url: `/api/designs/${pub}/scene`, headers: bearer(chief.token), payload: { sceneGzB64: gzipSync(Buffer.from('{"v":1}')).toString('base64') } }),
      app.inject({ method: 'GET', url: '/api/me', headers: bearer(fan.token) }),
    ]);
    auth.failSession = false;
    for (const r of refused) assert.equal(r.statusCode, 503, `a session that cannot be read is refused with 503 (${r.statusCode})`);
    // Kept on the request object only: no cache of tokens anywhere in the routes.
    const src = readFileSync('server/src/routes.ts', 'utf8');
    check(/new WeakMap<FastifyRequest, Promise<UserRow \| null>>\(\)/.test(src), 'the session read is kept in a WeakMap keyed by the request');
    check(!/new Map<string, Promise<UserRow/.test(src) && !/tokenCache|sessionCache/.test(src), 'and in nothing keyed by a token');
    await app.close();
    console.log('  P2.17 one session read per request: revoked, signed out, password-changed, deleted and expired sessions refused at once; no crossing; wall and admin checks hold; fails closed');
  }

  // ---- P2.16: the unread count ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const social = new MemorySocialRepository(designs, auth);
    const app = await buildApp(designs, auth, templates, { social });
    const maker = await s2reg(app, 'unread_maker_s2');
    const fanA = await s2reg(app, 'unread_a_s2');
    const fanB = await s2reg(app, 'unread_b_s2');
    for (const f of [fanA, fanB]) await app.inject({ method: 'POST', url: `/api/users/${maker.id}/follow`, headers: bearer(f.token) });
    await app.inject({ method: 'POST', url: `/api/users/${fanA.id}/follow`, headers: bearer(maker.token) });
    const unread = (t?: string) => app.inject({ method: 'GET', url: '/api/notifications/unread', headers: t ? bearer(t) : undefined });
    const anon = await unread();
    assert.equal(anon.statusCode, 401, 'signed out: 401');
    const mine = await unread(maker.token);
    assert.equal(mine.statusCode, 200);
    assert.deepEqual(mine.json(), { unread: 2 }, 'exactly { unread }: the caller’s own count');
    assert.equal(mine.headers['cache-control'], 'no-store', 'never kept by any cache');
    assert.deepEqual((await unread(fanA.token)).json(), { unread: 1 }, 'another account sees its own count');
    assert.deepEqual((await unread(fanB.token)).json(), { unread: 0 });
    const feed = (await app.inject({ method: 'GET', url: '/api/notifications', headers: bearer(maker.token) })).json() as { unread: number; items: unknown[] };
    assert.equal(feed.unread, 2, 'and the same number as the feed, which keeps { unread, items }');
    check(Array.isArray(feed.items), 'the feed is unchanged');
    await app.inject({ method: 'POST', url: '/api/notifications/read', headers: bearer(maker.token), payload: {} });
    assert.deepEqual((await unread(maker.token)).json(), { unread: 0 }, 'read is read');
    await app.close();
    const noSocial = await buildApp(new MemoryDesignRepository(), new MemoryAuthRepository(), templates, {});
    assert.equal((await noSocial.inject({ method: 'GET', url: '/api/notifications/unread' })).statusCode, 503, 'without the social layer it is off, like the feed');
    await noSocial.close();
    // The same limit as the feed: the general 300, per client.
    const limited = await buildApp(new MemoryDesignRepository(), new MemoryAuthRepository(), templates, { social: new MemorySocialRepository(new MemoryDesignRepository(), new MemoryAuthRepository()), rateLimit: true });
    const h1 = await limited.inject({ method: 'GET', url: '/api/notifications/unread', remoteAddress: '198.18.200.1' });
    const h2 = await limited.inject({ method: 'GET', url: '/api/notifications', remoteAddress: '198.18.200.2' });
    assert.equal(h1.headers['x-ratelimit-limit'], h2.headers['x-ratelimit-limit'], 'the unread count is limited like the feed');
    await limited.close();
    console.log('  P2.16 unread count: signed in, own count only, no-store, same limits as the feed');
  }

  // ---- P2.18: page views batched, never an address ----
  {
    const inner = new MemoryTrafficRepository();
    const logged: string[] = [];
    const buffer = new BatchedTrafficRepository(inner, { maxBuffered: 3, log: (m) => logged.push(m) });
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const { existsSync } = await import('node:fs');
    // Absolute: @fastify/static refuses a relative root (the built dist/ when there is one).
    const staticDir = existsSync('dist/index.html') ? `${process.cwd()}/dist` : process.cwd();
    const app = await buildApp(designs, auth, templates, { traffic: buffer, staticDir, adminUsernames: ['trafficadmin_s2'], aiAdminPassword: 'stage two traffic admin' });
    const admin = await s2reg(app, 'trafficadmin_s2', 'stage two traffic admin');
    const UA = 'Mozilla/5.0 (S2 visit marker; Android 14) Mobile Safari/537.36';
    await app.inject({ method: 'GET', url: '/?utm_source=whatsapp', remoteAddress: '203.0.113.77', headers: { 'user-agent': UA, referer: 'https://t.co/abc?secret=1' } });
    await settle();
    assert.equal(buffer.pending, 1, 'a page view waits in memory');
    assert.equal((await inner.summary(1)).totals.visits, 0, 'and is not written yet');
    const waiting = (buffer as unknown as { buffer: { visit: Record<string, unknown>; at: Date }[] }).buffer;
    assert.deepEqual(Object.keys(waiting[0]).sort(), ['at', 'visit'], 'what waits is a visit and its time');
    assert.deepEqual(Object.keys(waiting[0].visit).sort(), ['browser', 'country', 'device', 'isBot', 'lang', 'os', 'path', 'referrerHost', 'source', 'utmCampaign', 'utmMedium', 'utmSource', 'visitorKey'], 'exactly buildVisit’s output');
    const text = JSON.stringify(waiting);
    check(!text.includes('203.0.113.77') && !text.includes('S2 visit marker') && !text.includes('secret=1'), 'never the address, the user-agent or the referrer’s path');
    // The admin view flushes before it reads, so it is right at once.
    const t = await app.inject({ method: 'GET', url: '/api/admin/traffic?days=1', headers: bearer(admin.token) });
    assert.equal(t.statusCode, 200, t.body);
    assert.equal((t.json() as { totals: { visits: number } }).totals.visits, 1, 'the admin traffic view includes the page view just made');
    assert.equal(buffer.pending, 0);
    assert.equal((await inner.summary(1)).totals.visits, 1, 'one row written');
    // Capped: beyond the cap, dropped and counted, said once at the next flush.
    for (let i = 0; i < 5; i++) await buffer.record(waiting[0]?.visit as never ?? (await import('../src/trafficRepo')).buildVisit({ ip: '1.1.1.1', ua: UA, path: '/', query: {} }));
    assert.equal(buffer.pending, 3, 'at most maxBuffered wait');
    await buffer.flush();
    assert.equal(logged.filter((m) => /2 page view\(s\) not recorded, the buffer was full/.test(m)).length, 1, 'the drop is said once, with the count');
    await buffer.flush();
    assert.equal(logged.length, 1, 'and not again');
    // A write that fails is logged and dropped, not retried.
    const store = (recordMany: (rows: unknown[]) => Promise<void>) => ({ recordMany, record: (v: never) => inner.record(v), summary: (d: number) => inner.summary(d), purge: () => inner.purge() });
    const failing = new BatchedTrafficRepository(store(async () => { throw new Error('connection terminated'); }), { log: (m) => logged.push(m) });
    await failing.record(waiting[0]?.visit as never);
    await failing.flush();
    check(logged.some((m) => /could not be written and were dropped: connection terminated/.test(m)), 'a failed write is logged');
    assert.equal(failing.pending, 0, 'and its views are gone, not queued again');
    // Stopping waits for the last write, but not for ever.
    const stuck = new BatchedTrafficRepository(store(() => new Promise<void>(() => {})), { log: (m) => logged.push(m) });
    await stuck.record(waiting[0]?.visit as never);
    const t0 = Date.now();
    await stuck.close(300);
    check(Date.now() - t0 < 2000, 'a stuck last write does not hold the shutdown');
    const ok = new BatchedTrafficRepository(inner, { log: (m) => logged.push(m) });
    const before = (await inner.summary(1)).totals.visits;
    await ok.record(waiting[0]?.visit as never);
    await ok.close(1000);
    assert.equal((await inner.summary(1)).totals.visits, before + 1, 'closing writes what was waiting');
    const server = readFileSync('server/src/server.ts', 'utf8');
    check(/visitBuffer\?\.close\(2_000\)/.test(server) && /app\.close\(\)\.then\(lastVisits, lastVisits\)/.test(server), 'SIGTERM closes the app, then awaits one last write of the page views, for at most 2 s');
    await app.close();
    console.log('  P2.18 page views: buffered as buildVisit output only, flushed in one write, capped and said, failed writes dropped, drained at shutdown');
  }

  // ---- Postgres: the session read, the unread count and the batch on a real database ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const { PgSocialRepository } = await import('../src/pgSocial');
    const { PgTrafficRepository } = await import('../src/trafficRepo');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
      const pAuth = new PgAuthRepository(pool);
      const pDesigns = new PgDesignRepository(pool);
      const pTraffic = new PgTrafficRepository(pool);
      await pTraffic.init();
      const sfx = Math.random().toString(36).slice(2, 7);
      const papp = await buildApp(pDesigns, pAuth, templates, { social: new PgSocialRepository(pool), adminUsernames: [`pgchief${sfx}`], aiAdminPassword: 'pg stage two admin' });
      const fan = await s2reg(papp, `pgfan2${sfx}`);
      const chief = await s2reg(papp, `pgchief${sfx}`, 'pg stage two admin');
      // Count what each request asks the database about its session.
      const seen: string[] = [];
      const realQuery = pg.Client.prototype.query;
      pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
        seen.push(text.replace(/\s+/g, ' '));
        return (realQuery as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof realQuery;
      try {
        for (const [url, who] of [['/api/me', fan], ['/api/me', chief], ['/api/notifications/unread', fan], ['/api/admin/reports', chief]] as const) {
          seen.length = 0;
          const r = await papp.inject({ method: 'GET', url, headers: bearer(who.token) });
          assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
          const authQ = seen.filter((q) => /auth_tokens|FROM users WHERE id|username_chosen FROM users/.test(q));
          assert.equal(authQ.length, 1, `Postgres ${url}: one session query (${authQ.join(' | ')})`);
          check(/FROM auth_tokens t JOIN users u ON u\.id = t\.user_id WHERE t\.token_hash = \$1 AND t\.expires_at > now\(\)/.test(authQ[0]), 'Postgres: the token joined to its account, still unexpired');
        }
      } finally {
        pg.Client.prototype.query = realQuery;
      }
      const gone = await s2reg(papp, `pggone${sfx}`);
      await pool.query('DELETE FROM auth_tokens WHERE token_hash = $1', [hashToken(gone.token)]);
      assert.equal((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(gone.token) })).statusCode, 401, 'Postgres: a revoked token is refused on the next request');
      const old = await s2reg(papp, `pgold${sfx}`);
      await pool.query('UPDATE auth_tokens SET expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [hashToken(old.token)]);
      assert.equal((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(old.token) })).statusCode, 401, 'Postgres: an expired token is refused');
      const del = await s2reg(papp, `pgdel${sfx}`);
      assert.equal((await papp.inject({ method: 'DELETE', url: '/api/account', headers: bearer(del.token), payload: { password: S2PW } })).statusCode, 204);
      assert.equal((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(del.token) })).statusCode, 401, 'Postgres: a deleted account is refused on the next request');
      const lo = await s2reg(papp, `pglo${sfx}`);
      await papp.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(lo.token) });
      assert.equal((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(lo.token) })).statusCode, 401, 'Postgres: a signed-out token is refused on the next request');
      const pw = await s2reg(papp, `pgpw${sfx}`);
      const ch = await papp.inject({ method: 'POST', url: '/api/account/password', headers: bearer(pw.token), payload: { currentPassword: S2PW, newPassword: 'quarry-velvet-anchor5' } });
      assert.equal(ch.statusCode, 200, ch.body);
      assert.equal((await papp.inject({ method: 'GET', url: '/api/me', headers: bearer(pw.token) })).statusCode, 401, 'Postgres: the old session is refused after a password change');
      const tx = await s2reg(papp, `pgtx${sfx}`);
      for (let i = 0; i < 10; i++) {
        const [r1, r2] = await Promise.all([papp.inject({ method: 'GET', url: '/api/me', headers: bearer(fan.token) }), papp.inject({ method: 'GET', url: '/api/me', headers: bearer(tx.token) })]);
        assert.equal(r1.json().id, fan.id);
        assert.equal(r2.json().id, tx.id, 'Postgres: two sessions at once never see each other’s account');
      }
      assert.deepEqual((await papp.inject({ method: 'GET', url: '/api/notifications/unread', headers: bearer(fan.token) })).json(), { unread: 0 }, 'Postgres: the unread count');
      // The batch: one statement for many views, each with its own time.
      const at = new Date(Date.now() - 4000);
      const { buildVisit } = await import('../src/trafficRepo');
      const mark = `/s2-batch-${sfx}`;
      const v = buildVisit({ ip: '203.0.113.9', ua: 'Mozilla/5.0 (S2 batch) Chrome/120 Safari/537.36', path: mark, query: {} });
      const writes: string[] = [];
      const realQ = pool.query.bind(pool);
      (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => { writes.push(String(a[0])); return (realQ as (...x: unknown[]) => unknown)(...a); };
      await pTraffic.recordMany(Array.from({ length: 50 }, (_, i) => ({ visit: { ...v, path: `${mark}-${i % 2}` }, at })));
      (pool as unknown as { query: typeof realQ }).query = realQ;
      assert.equal(writes.length, 1, 'Postgres: fifty page views are one statement');
      const rows = await pool.query('SELECT count(*)::int AS n, min(created_at) AS t FROM visits WHERE path LIKE $1', [`${mark}%`]);
      assert.equal(rows.rows[0].n, 50, 'Postgres: all of them written');
      check(Math.abs(new Date(rows.rows[0].t).getTime() - at.getTime()) < 1000, 'Postgres: with the time of the view, not of the write');
      const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'visits'");
      check(!cols.rows.some((c: { column_name: string }) => /ip|agent/.test(c.column_name)), 'Postgres: the visits table has no address or user-agent column');
      await papp.close();
    } finally {
      await pool.end();
    }
    console.log('  Postgres: one session query per request, revocations at once, no crossing; unread count; page views in one statement');
  }
  console.log('performance plan stage 2 (server), part one: all assertions passed');
}

// ---------- 2026-10: performance plan, stage 2 (server), part two ----------
// Pre-compressed files (P2.3), thumbnail ETags (P2.4), the anonymous scene's
// stripped copy (P2.5) and the static HTML shells (P2.9). Every one of them
// keeps something for later, so every one is checked against the rules for
// what may be kept: nothing private, nothing before the visibility check, no
// layer, nothing a caller can choose.
{
  const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readdirSync: listDir, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { brotliCompressSync, constants: zc, gunzipSync } = await import('node:zlib');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository } = await import('../src/memoryRepo');
  const { StrippedSceneCache } = await import('../src/sceneCache');
  const { WorkerPool } = await import('../src/workerPool');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const S2PW = 'lantern-orchid-quarry8';
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const png = (n: number): Buffer => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200 + n, n & 0xff)]);
  const s2reg = async (app: FastifyInstance, u: string, adminPassword?: string): Promise<{ token: string; id: string }> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: S2PW, email: `${u}@example.test`, acceptedVersion: 'test', adminPassword } });
    assert.equal(r.statusCode, 201, r.body);
    const token = (r.json() as { token: string }).token;
    return { token, id: ((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json() as { id: string }).id };
  };
  const makeWith = async (app: FastifyInstance, token: string, thumb: Buffer | null, isPublic: boolean, title = 'S2 design'): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, ...(thumb ? { thumbnailPngB64: thumb.toString('base64') } : {}) } });
    assert.equal(r.statusCode, 201, r.body);
    const id = (r.json() as { id: string }).id;
    if (isPublic) assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } })).statusCode, 200);
    return id;
  };

  // A build output with compressed copies beside some files, as the build writes them.
  const dist = mkdtempSync(`${tmpdir()}/tifo-perf-s2-`);
  for (const f of listDir('.').filter((n) => n.endsWith('.html'))) copyFileSync(f, `${dist}/${f}`);
  mkdirSync(`${dist}/assets`);
  const JS = `export const s2 = ${JSON.stringify('tifo '.repeat(2000))};\n`;
  const JS_BR = brotliCompressSync(Buffer.from(JS), { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } });
  const JS_GZ = (await import('node:zlib')).gzipSync(Buffer.from(JS), { level: 9 });
  writeFileSync(`${dist}/assets/app-S2hash01.js`, JS);
  writeFileSync(`${dist}/assets/app-S2hash01.js.br`, JS_BR);
  writeFileSync(`${dist}/assets/app-S2hash01.js.gz`, JS_GZ);
  writeFileSync(`${dist}/assets/only-S2hash02.js.br`, JS_BR); // a copy with no original
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(500)}</svg>\n`;
  writeFileSync(`${dist}/favicon.svg`, SVG);
  writeFileSync(`${dist}/favicon.svg.br`, brotliCompressSync(Buffer.from(SVG)));
  writeFileSync(`${dist}/og-card.png`, png(1));

  // ---- P2.3: the build's compressed copies, and nothing compressed on the fly ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { staticDir: dist, rateLimit: true });
    let ip = 0;
    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers, remoteAddress: `198.18.210.${ip++ % 250}` });
    const br = await get('/assets/app-S2hash01.js', { 'accept-encoding': 'br, gzip' });
    assert.equal(br.statusCode, 200);
    assert.equal(br.headers['content-encoding'], 'br', 'brotli when the browser takes it');
    assert.deepEqual(br.rawPayload, JS_BR, 'the build’s own bytes');
    assert.equal(Number(br.headers['content-length']), JS_BR.byteLength, 'and their length');
    check(String(br.headers['content-type']).includes('javascript'), `the original’s type (${br.headers['content-type']})`);
    check(/accept-encoding/i.test(String(br.headers.vary)), 'Vary: Accept-Encoding');
    assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable', 'the original’s cache rule');
    assert.equal(br.headers['x-ratelimit-limit'], '600', 'still counted in the assets bucket, decided by the registered route');
    const gz = await get('/assets/app-S2hash01.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip', 'gzip when that is all it takes');
    assert.deepEqual(gz.rawPayload, JS_GZ);
    assert.equal(Number(gz.headers['content-length']), JS_GZ.byteLength);
    for (const ae of [undefined, 'identity', 'br;q=0, gzip;q=0', 'deflate']) {
      const plain = await get('/assets/app-S2hash01.js', ae ? { 'accept-encoding': ae } : {});
      assert.equal(plain.headers['content-encoding'], undefined, `the original when neither is taken (${ae})`);
      assert.equal(plain.body, JS);
      check(/accept-encoding/i.test(String(plain.headers.vary)), 'and Vary on that answer too, so no cache hands it to a browser that takes brotli');
    }
    assert.equal((await get('/assets/app-S2hash01.js', { 'accept-encoding': 'br;q=0, gzip' })).headers['content-encoding'], 'gzip', 'q-values are honoured');
    // 304s, per copy.
    const etag = String(br.headers.etag);
    const again = await get('/assets/app-S2hash01.js', { 'accept-encoding': 'br', 'if-none-match': etag });
    assert.equal(again.statusCode, 304, 'a copy revalidates');
    assert.equal(again.rawPayload.byteLength, 0);
    assert.equal((await get('/assets/app-S2hash01.js', { 'accept-encoding': 'gzip', 'if-none-match': etag })).statusCode, 200, 'the brotli copy’s ETag is not the gzip copy’s');
    // The copies are never files of their own, and never stand in for a missing original.
    for (const url of ['/assets/app-S2hash01.js.br', '/assets/app-S2hash01.js.gz', '/assets/only-S2hash02.js', '/assets/only-S2hash02.js.br', '/favicon.svg.br']) {
      const r = await get(url, { 'accept-encoding': 'br, gzip' });
      assert.equal(r.statusCode, 404, `${url} is a 404`);
      check(!r.headers['content-encoding'], `${url} sends no compressed bytes`);
    }
    // Nothing outside the build is reachable with a copy asked for, however the path is spelled.
    writeFileSync(`${dist}/../tifo-s2-outside.txt`, 'S2-OUTSIDE-MARKER');
    writeFileSync(`${dist}/../tifo-s2-outside.txt.br`, brotliCompressSync(Buffer.from('S2-OUTSIDE-MARKER')));
    for (const url of ['/assets/../../tifo-s2-outside.txt', '/assets/..%2f..%2ftifo-s2-outside.txt', '/assets/%2e%2e/%2e%2e/tifo-s2-outside.txt', '/..%2ftifo-s2-outside.txt', '/assets/..%5c..%5ctifo-s2-outside.txt', '/%2e%2e/tifo-s2-outside.txt.br']) {
      const r = await get(url, { 'accept-encoding': 'br, gzip' });
      check(r.statusCode >= 300 && r.statusCode !== 304, `${url}: not served (${r.statusCode})`);
      check(!r.rawPayload.includes(Buffer.from('S2-OUTSIDE')) && r.rawPayload.indexOf(brotliCompressSync(Buffer.from('S2-OUTSIDE-MARKER'))) < 0, `${url}: nothing from outside the build`);
    }
    // A spelling that resolves to the file inside the build is the file, with its rule.
    const dotted = await get('/assets/./app-S2hash01.js', { 'accept-encoding': 'br' });
    check(dotted.statusCode !== 200 || (dotted.headers['cache-control'] === 'public, max-age=31536000, immutable' && Buffer.compare(dotted.rawPayload, JS_BR) === 0), 'a dotted path is the same file under the same rule');
    // A public file outside /assets keeps its own rule when its copy is sent.
    const fav = await get('/favicon.svg', { 'accept-encoding': 'br' });
    assert.equal(fav.headers['content-encoding'], 'br');
    assert.equal(fav.headers['cache-control'], 'public, max-age=3600, stale-while-revalidate=86400', 'the copy has its original’s cache rule');
    // Pages and API answers are not compressed by the server at all.
    for (const url of ['/clubs', '/api/templates', '/']) {
      const r = await get(url, { 'accept-encoding': 'br, gzip' });
      assert.equal(r.headers['content-encoding'], undefined, `${url} is not compressed on the fly`);
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    check(!pkg.dependencies['@fastify/compress'], 'no on-the-fly compression plugin');
    const routesSrc = readFileSync('server/src/routes.ts', 'utf8');
    check(/preCompressed: true/.test(routesSrc) && /globIgnore: \['\*\*\/\*\.br', '\*\*\/\*\.gz'\]/.test(routesSrc) && !/@fastify\/compress/.test(routesSrc), 'preCompressed, copies never routes, nothing compressed per request');
    await app.close();
  }

  // ---- P2.3: an answer that carries a secret says no-store, no-transform ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, {
      staticDir: dist, aiUsage: new MemoryAiUsageRepository(), aiEvents: new MemoryAiEventsRepository(), aiAdminPassword: 'stage two transform admin',
      oauth: { google: { id: 'client-id', secret: 'client-secret' } }, emailSender: { send: async () => {} } as never,
    });
    const secret = (r: { headers: Record<string, unknown>; statusCode: number }, label: string): void => {
      const cc = String(r.headers['cache-control'] ?? '');
      check(/\bno-store\b/.test(cc) && /\bno-transform\b/.test(cc), `${label} (${r.statusCode}): no-store, no-transform (${cc})`);
    };
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'transform_s2', password: S2PW, email: 'transform_s2@example.test', acceptedVersion: 'test' } });
    assert.equal(reg.statusCode, 201);
    secret(reg, 'sign-up, with its session token');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'transform_s2', password: S2PW } });
    assert.equal(login.statusCode, 200);
    secret(login, 'sign-in');
    const tok = (login.json() as { token: string }).token;
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json() as { id: string };
    await auth.markEmailVerified(me.id);
    secret(await app.inject({ method: 'GET', url: '/api/account/export', headers: bearer(tok) }), 'the account export');
    const link = await app.inject({ method: 'POST', url: '/api/account/link/google', headers: bearer(tok), payload: { password: S2PW } });
    assert.equal(link.statusCode, 200, link.body);
    secret(link, 'a link start, with its sealed state cookie');
    const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
    assert.equal(start.statusCode, 302);
    secret(start, 'a sign-in start, with its sealed state cookie');
    secret(await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=x&state=y' }), 'a sign-in return');
    secret(await app.inject({ method: 'GET', url: '/api/auth/verify?token=abc' }), 'the verification link');
    await auth.linkIdentity('google', 'sub-s2-transform', me.id);
    const ticket = 'f'.repeat(64);
    assert.ok(await auth.createHandoffIfLinked(me.id, 'google', 'sub-s2-transform', hashToken(ticket), new Date(Date.now() + 60_000)));
    const hand = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { cookie: `tm_handoff=${ticket}` } });
    assert.equal(hand.statusCode, 200, hand.body);
    secret(hand, 'the Google handoff, which hands out a session');
    const pw = await app.inject({ method: 'POST', url: '/api/account/password', headers: bearer(tok), payload: { currentPassword: S2PW, newPassword: 'ember-violet-harbour6' } });
    assert.equal(pw.statusCode, 200, pw.body);
    secret(pw, 'a password change, with the session it keeps');
    const unlock = await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'stage two transform admin' } });
    assert.equal(unlock.statusCode, 200);
    secret(unlock, 'the admin unlock, with its token and cookie');
    // The guard is written down, response by response.
    const checks = readFileSync('SECURITY-CHECKS.md', 'utf8');
    check(/no-transform/.test(checks) && /BREACH/.test(checks), 'SECURITY-CHECKS.md says which answers carry a secret and why BREACH has nothing to work with');
    await app.close();
    console.log('  P2.3 pre-compressed files: br, gzip or the original by Accept-Encoding, right length, Vary, 304s; copies never routes; secrets no-transform');
  }

  // ---- P2.4: a thumbnail's ETag is its content hash, compared after the visibility check ----
  const thumbFlow = async (label: string, designs: InstanceType<typeof MemoryDesignRepository> | import('../src/repo').DesignRepository, auth: import('../src/repo').AuthRepository, suffix: string): Promise<void> => {
    const app = await buildApp(designs, auth, templates, { adminUsernames: [`thmod${suffix}`], aiAdminPassword: 'stage two thumb admin' });
    const owner = await s2reg(app, `thown${suffix}`);
    const other = await s2reg(app, `thoth${suffix}`);
    const mod = await s2reg(app, `thmod${suffix}`, 'stage two thumb admin');
    const P1 = png(7);
    const pub = await makeWith(app, owner.token, P1, true);
    const url = `/api/designs/${pub}/thumbnail.png`;
    const first = await app.inject({ method: 'GET', url });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'public, no-cache', `${label}: a public picture: public, revalidated`);
    assert.equal(first.headers.etag, `"${sha(P1)}"`, `${label}: its ETag is the sha-256 of the stored bytes`);
    assert.deepEqual(first.rawPayload, P1);
    for (const inm of [`"${sha(P1)}"`, `W/"${sha(P1)}"`, `"nope", "${sha(P1)}"`]) {
      const again = await app.inject({ method: 'GET', url, headers: { 'if-none-match': inm } });
      assert.equal(again.statusCode, 304, `${label}: a repeat view is a 304 (${inm})`);
      assert.equal(again.rawPayload.byteLength, 0, 'with no body');
      assert.equal(again.headers['cache-control'], 'public, no-cache', 'and the same Cache-Control as its 200');
      assert.equal(again.headers.etag, `"${sha(P1)}"`);
    }
    for (const who of [undefined, bearer(other.token), bearer(owner.token)]) {
      assert.equal((await app.inject({ method: 'GET', url, headers: { ...who, 'if-none-match': `"${sha(P1)}"` } })).statusCode, 304, `${label}: the same answer for everyone`);
    }
    assert.equal((await app.inject({ method: 'GET', url, headers: { 'if-none-match': '"0000"' } })).statusCode, 200, `${label}: another ETag gets the picture`);
    // A new picture is a new hash.
    const P2 = png(9);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${pub}`, headers: bearer(owner.token), payload: { palette: PALETTE, cellsGzB64, thumbnailPngB64: P2.toString('base64') } })).statusCode, 200);
    const changed = await app.inject({ method: 'GET', url, headers: { 'if-none-match': `"${sha(P1)}"` } });
    assert.equal(changed.statusCode, 200, `${label}: a changed picture is sent again`);
    assert.equal(changed.headers.etag, `"${sha(P2)}"`, `${label}: with the new hash`);
    // A private design's picture: the owner's only, never an ETag, never a 304.
    const P3 = png(11);
    const priv = await makeWith(app, owner.token, P3, false);
    const purl = `/api/designs/${priv}/thumbnail.png`;
    const own = await app.inject({ method: 'GET', url: purl, headers: bearer(owner.token) });
    assert.equal(own.statusCode, 200);
    assert.equal(own.headers['cache-control'], 'private, no-store', `${label}: private, no-store`);
    assert.equal(own.headers.etag, undefined, `${label}: no ETag on a private picture`);
    assert.equal((await app.inject({ method: 'GET', url: purl, headers: { ...bearer(owner.token), 'if-none-match': `"${sha(P3)}"` } })).statusCode, 200, `${label}: never a 304, even for its owner with the right hash`);
    for (const who of [undefined, bearer(other.token)]) {
      assert.equal((await app.inject({ method: 'GET', url: purl, headers: { ...who, 'if-none-match': `"${sha(P3)}"` } })).statusCode, 404, `${label}: anyone else, the right hash in hand, gets the 404 of an id that does not exist`);
    }
    // A public design that stops being public: an old ETag gets exactly what it would without one.
    const lose = async (kind: string, act: (id: string) => Promise<unknown>): Promise<void> => {
      const P = png(13 + kind.length);
      const id = await makeWith(app, owner.token, P, true, `S2 ${kind}`);
      const u = `/api/designs/${id}/thumbnail.png`;
      assert.equal((await app.inject({ method: 'GET', url: u, headers: { 'if-none-match': `"${sha(P)}"` } })).statusCode, 304);
      await act(id);
      for (const who of [undefined, bearer(other.token)]) {
        const r = await app.inject({ method: 'GET', url: u, headers: { ...who, 'if-none-match': `"${sha(P)}"` } });
        assert.equal(r.statusCode, 404, `${label}: ${kind}: a stale ETag is a 404 for everyone else (${r.statusCode})`);
        check(/no-store|no-cache/.test(String(r.headers['cache-control'])), 'and the 404 is not cached');
      }
      const mine = await app.inject({ method: 'GET', url: u, headers: { ...bearer(owner.token), 'if-none-match': `"${sha(P)}"` } });
      check(mine.statusCode === 404 || (mine.statusCode === 200 && mine.headers['cache-control'] === 'private, no-store' && !mine.headers.etag), `${label}: ${kind}: and for the owner a private answer or nothing (${mine.statusCode})`);
    };
    await lose('unpublished', (id) => app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(owner.token), payload: { isPublic: false } }));
    await lose('taken down', (id) => app.inject({ method: 'POST', url: `/api/admin/designs/${id}/takedown`, headers: bearer(mod.token) }));
    await lose('trashed', (id) => app.inject({ method: 'DELETE', url: `/api/designs/${id}`, headers: bearer(owner.token) }));
    await lose('deleted', async (id) => {
      await app.inject({ method: 'DELETE', url: `/api/designs/${id}`, headers: bearer(owner.token) });
      await app.inject({ method: 'DELETE', url: `/api/designs/${id}?permanent=1`, headers: bearer(owner.token) });
    });
    // A copy carries its picture's hash.
    const copy = await app.inject({ method: 'POST', url: `/api/designs/${pub}/fork`, headers: bearer(other.token), payload: {} });
    assert.equal(copy.statusCode, 201);
    const copyId = (copy.json() as { id: string }).id;
    await app.inject({ method: 'PATCH', url: `/api/designs/${copyId}`, headers: bearer(other.token), payload: { isPublic: true } });
    assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${copyId}/thumbnail.png` })).headers.etag, `"${sha(P2)}"`, `${label}: a fork’s picture has the hash of its bytes`);
    await app.close();
  };
  {
    const auth = new MemoryAuthRepository();
    await thumbFlow('memory', new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, '_m2');
    console.log('  P2.4 thumbnails: ETag = sha-256 of the bytes, 304 only after the visibility check and only public; private no-store, never 304; stale ETags 404');
  }

  // ---- P2.5: anonymous views of a scene reuse its stripped copy, by the stored hash ----
  const SECRET = 'data:image/webp;base64,UzItT1dORVItTEFZRVI=';
  const scene = (banner: string, layers = true) => gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: banner, text: banner }], ...(layers ? { layers: [{ id: 'l1', src: SECRET }] } : {}) }))).toString('base64');
  const sceneOf = (r: { json(): unknown }): string | null => {
    const b64 = (r.json() as { sceneGzB64: string | null }).sceneGzB64;
    return b64 ? gunzipSync(Buffer.from(b64, 'base64')).toString('utf8') : null;
  };
  const sceneFlow = async (label: string, designs: import('../src/repo').DesignRepository, auth: import('../src/repo').AuthRepository, suffix: string, reads: { scene: number }): Promise<void> => {
    const cache = new StrippedSceneCache();
    const app = await buildApp(designs, auth, templates, { sceneCache: cache, adminUsernames: [`scmod${suffix}`], aiAdminPassword: 'stage two scene admin' });
    const owner = await s2reg(app, `scown${suffix}`);
    const other = await s2reg(app, `scoth${suffix}`);
    const mod = await s2reg(app, `scmod${suffix}`, 'stage two scene admin');
    const pub = await makeWith(app, owner.token, null, true);
    const put = (id: string, b64: string) => app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: b64 } });
    const v1 = scene('derby-v1');
    assert.equal((await put(pub, v1)).statusCode, 200);
    const a1 = await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene` });
    assert.match(sceneOf(a1) ?? '', /derby-v1/, `${label}: the banners are there`);
    check(!(sceneOf(a1) ?? '').includes(SECRET) && !(sceneOf(a1) ?? '').includes('"layers"'), `${label}: the owner’s layers are not`);
    const before = reads.scene;
    for (const who of [undefined, bearer(other.token)]) {
      const again = await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene`, headers: who });
      assert.match(sceneOf(again) ?? '', /derby-v1/);
    }
    assert.equal(reads.scene, before, `${label}: repeat views do not read the stored scene`);
    // Right after the owner saves, the next anonymous view has the new banners.
    assert.equal((await put(pub, scene('derby-v2'))).statusCode, 200);
    const a2 = await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene` });
    assert.match(sceneOf(a2) ?? '', /derby-v2/, `${label}: an anonymous view right after a save shows the new banners`);
    check(!(sceneOf(a2) ?? '').includes('derby-v1'), `${label}: and not the old ones`);
    // The owner's own view is the scene as stored, layers and all.
    const mine = await app.inject({ method: 'GET', url: `/api/designs/${pub}/scene`, headers: bearer(owner.token) });
    assert.match(sceneOf(mine) ?? '', /derby-v2/);
    check((sceneOf(mine) ?? '').includes(SECRET), `${label}: the owner gets their layers back`);
    // A private design is never served from the cache, and never cached.
    const priv = await makeWith(app, owner.token, null, false);
    assert.equal((await put(priv, scene('private-v1'))).statusCode, 200);
    const sizeBefore = cache.size;
    for (const who of [undefined, bearer(other.token)]) assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${priv}/scene`, headers: who })).statusCode, 404, `${label}: a private scene is a 404 to others`);
    check((sceneOf(await app.inject({ method: 'GET', url: `/api/designs/${priv}/scene`, headers: bearer(owner.token) })) ?? '').includes(SECRET), 'its owner has it, layers and all');
    assert.equal(cache.size, sizeBefore, `${label}: nothing about a private design is kept`);
    // Kept while public, then taken down: the copy is never served again.
    const down = await makeWith(app, owner.token, null, true);
    assert.equal((await put(down, scene('down-v1'))).statusCode, 200);
    assert.match(sceneOf(await app.inject({ method: 'GET', url: `/api/designs/${down}/scene` })) ?? '', /down-v1/);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/designs/${down}/takedown`, headers: bearer(mod.token) })).statusCode, 200);
    for (const who of [undefined, bearer(other.token)]) assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${down}/scene`, headers: who })).statusCode, 404, `${label}: a taken-down design’s scene is not served from the cache`);
    const trashedId = await makeWith(app, owner.token, null, true);
    assert.equal((await put(trashedId, scene('trash-v1'))).statusCode, 200);
    await app.inject({ method: 'GET', url: `/api/designs/${trashedId}/scene` });
    await app.inject({ method: 'DELETE', url: `/api/designs/${trashedId}`, headers: bearer(owner.token) });
    assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${trashedId}/scene` })).statusCode, 404, `${label}: nor a trashed one’s`);
    // The cache holds stripped scenes and nothing else.
    check(cache.size > 0, 'something was kept');
    for (const v of cache.values()) {
      if (!v) continue;
      const text = gunzipSync(Buffer.from(v)).toString('utf8');
      check(!text.includes(SECRET) && !/"layers"/.test(text), `${label}: the cache never holds a layer`);
    }
    // A strip the worker cannot do now is a 503, never the scene as stored.
    const broken = new WorkerPool({ name: 'scene-test', file: { url: new URL(`data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.postMessage({ready:true});parentPort.on('message',()=>process.exit(3))`) }, size: 1, maxQueue: 1, timeoutMs: 2000, idleMs: 1000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
    const app2 = await buildApp(designs, auth, templates, { workers: { scene: broken as never }, sceneCache: new StrippedSceneCache() });
    const r503 = await app2.inject({ method: 'GET', url: `/api/designs/${pub}/scene` });
    assert.equal(r503.statusCode, 503, `${label}: a worker that dies answers 503`);
    check(!r503.body.includes(SECRET) && !r503.body.includes('sceneGzB64'), 'with no scene in it');
    const own503 = await app2.inject({ method: 'GET', url: `/api/designs/${pub}/scene`, headers: bearer(owner.token) });
    assert.equal(own503.statusCode, 200, `${label}: the owner path needs no worker and is unchanged`);
    await broken.close();
    await app2.close();
    await app.close();
  };
  {
    const auth = new MemoryAuthRepository();
    const reads = { scene: 0 };
    class CountingDesigns extends MemoryDesignRepository {
      override async getSceneRow(id: string) { reads.scene++; return super.getSceneRow(id); }
      override async getScene(id: string) { reads.scene++; return super.getScene(id); }
    }
    await sceneFlow('memory', new CountingDesigns((id) => auth.usernameOf(id)), auth, '_m2', reads);
    // Bounded in bytes, one version per design.
    const small = new StrippedSceneCache(1000);
    small.set('d1', 'h1', new Uint8Array(600));
    small.set('d1', 'h2', new Uint8Array(600));
    assert.equal(small.size, 1, 'a newer version replaces the older');
    small.set('d2', 'h1', new Uint8Array(600));
    check(small.usedBytes <= 1000 && small.size === 1, `bounded in bytes, least recently used out first (${small.usedBytes} bytes, ${small.size} kept)`);
    assert.equal(small.get('d1', 'h2'), undefined);
    console.log('  P2.5 scenes: anonymous views from the stripped copy keyed by the stored hash; new banners right after a save; private, taken-down and trashed never served from it; no layer ever kept; worker failure 503');
  }

  // ---- P2.9: the static HTML shells ----
  {
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i;
    const SHELLS = ['/app?design=7f000000-0000-4000-8000-0000000000aa', '/clubs', '/legal', '/tifo-spec'];
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { staticDir: dist, publicUrl: 'https://tifomaker.org' });
    const u = await s2reg(app, 'shell_s2');
    for (const url of SHELLS) {
      const ref = await app.inject({ method: 'GET', url });
      assert.equal(ref.statusCode, 200, url);
      assert.equal(ref.headers['cache-control'], 'no-cache', `${url}: still revalidated every time`);
      assert.equal(ref.headers['content-type'], 'text/html; charset=utf-8', `${url}: utf-8`);
      const etag = String(ref.headers.etag ?? '');
      check(/^"[0-9a-f]{32}"$/.test(etag), `${url}: an ETag (${etag})`);
      check(!inlineScript.test(ref.body), `${url}: the served page has no inline script`);
      check(ref.body.includes('https://tifomaker.org'), `${url}: it names the fixed address`);
      for (const headers of [bearer(u.token), { cookie: 'tm_admin=x' }, { host: 'evil.example' }, { host: 'tifomaker.org:1234' }, { 'accept-language': 'ar' }, { 'x-forwarded-host': 'evil.example' }]) {
        const r = await app.inject({ method: 'GET', url, headers });
        assert.equal(r.body, ref.body, `${url}: the same bytes whoever asks (${JSON.stringify(headers)})`);
        assert.equal(r.headers.etag, etag);
        check(!r.body.includes('evil.example') && !r.body.includes(':1234'), `${url}: a forged Host never appears`);
      }
      for (const inm of [etag, `W/${etag}`]) {
        const r = await app.inject({ method: 'GET', url, headers: { 'if-none-match': inm } });
        assert.equal(r.statusCode, 304, `${url}: a 304 for its ETag`);
        assert.equal(r.rawPayload.byteLength, 0);
        assert.equal(r.headers.etag, etag);
        assert.equal(r.headers['cache-control'], 'no-cache', 'with the 200’s Cache-Control');
      }
      assert.equal((await app.inject({ method: 'GET', url, headers: { 'if-none-match': '"0123456789abcdef0123456789abcdef"' } })).statusCode, 200, `${url}: only for its own ETag`);
    }
    assert.equal(app.htmlShellStats!().rendered, SHELLS.length, 'each built once');
    // Never the pages that name designs: those are read per request.
    const pub = await makeWith(app, u.token, png(3), true, 'Shell check public');
    for (const url of ['/', '/community', `/t/${pub}`, `/d/${pub}`]) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.headers.etag, undefined, `${url} is not a kept shell`);
    }
    check((await app.inject({ method: 'GET', url: `/t/${pub}` })).body.includes('Shell check public'), 'the share page names the public design');
    await app.inject({ method: 'PATCH', url: `/api/designs/${pub}`, headers: bearer(u.token), payload: { isPublic: false } });
    check(!(await app.inject({ method: 'GET', url: `/t/${pub}` })).body.includes('Shell check public'), 'and stops the moment it is private');
    await app.close();
    // Without PUBLIC_URL: kept per address, at most eight of them.
    const app2 = await buildApp(designs, auth, templates, { staticDir: dist });
    for (let i = 1; i <= 9; i++) {
      const r = await app2.inject({ method: 'GET', url: '/legal', headers: { host: `localhost:${9100 + i}` } });
      check(r.body.includes(`http://localhost:${9100 + i}/legal`), `host ${i}: its own address in its page`);
    }
    const stats = app2.htmlShellStats!();
    assert.equal(stats.rendered, 9);
    assert.equal(stats.cached, 8, 'eight addresses kept');
    for (let i = 1; i <= 8; i++) await app2.inject({ method: 'GET', url: '/legal', headers: { host: `localhost:${9100 + i}` } });
    assert.equal(app2.htmlShellStats!().rendered, 9, 'the eight kept ones are not built again');
    const ninth = await app2.inject({ method: 'GET', url: '/legal', headers: { host: 'localhost:9109' } });
    check(ninth.body.includes('http://localhost:9109/legal'), 'the ninth is right');
    assert.equal(app2.htmlShellStats!().rendered, 10, 'and built fresh each time, never kept');
    const forged = await app2.inject({ method: 'GET', url: '/legal', headers: { host: 'evil.example' } });
    check(!forged.body.includes('evil.example') && forged.body.includes('https://tifomaker.org/legal'), 'a Host not on the list is the canonical address');
    await app2.close();
    console.log('  P2.9 shells: built once with an ETag and utf-8, no-cache; identical for every caller and Host; 304 only for its ETag; 8 addresses at most without PUBLIC_URL; never the design pages');
  }

  // ---- Postgres: hashes stored with the bytes, one query per repeat view, lazy backfill ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
      const sfx = Math.random().toString(36).slice(2, 7);
      const pAuth = new PgAuthRepository(pool);
      const pDesigns = new PgDesignRepository(pool);
      await thumbFlow('Postgres', pDesigns, pAuth, `_p${sfx}`);
      const reads = { scene: 0 };
      class CountingPg extends PgDesignRepository {
        override async getSceneRow(id: string) { reads.scene++; return super.getSceneRow(id); }
        override async getScene(id: string) { reads.scene++; return super.getScene(id); }
      }
      await sceneFlow('Postgres', new CountingPg(pool), pAuth, `_p${sfx}`, reads);
      // Rows written before the hashes existed may be NULL until the backfill; none may be wrong.
      const wrong = await pool.query("SELECT count(*)::int AS n FROM designs WHERE thumbnail_hash IS NOT NULL AND thumbnail_hash <> encode(sha256(thumbnail), 'hex')");
      assert.equal(wrong.rows[0].n, 0, 'Postgres: no stored picture hash describes other bytes');
      const swrong = await pool.query("SELECT count(*)::int AS n FROM design_scenes WHERE scene_hash IS NOT NULL AND scene_hash <> encode(sha256(scene), 'hex')");
      assert.equal(swrong.rows[0].n, 0, 'Postgres: nor any stored scene hash');
      // Counted: a repeat view of a public picture is one query and no body.
      const app = await buildApp(pDesigns, pAuth, templates, {});
      const o = await s2reg(app, `pgth${sfx}`);
      const P = png(21);
      const id = await makeWith(app, o.token, P, true);
      const seen: string[] = [];
      const realQuery = pg.Client.prototype.query;
      pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
        seen.push(typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '');
        return (realQuery as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof realQuery;
      let r304;
      let sceneQueries: string[] = [];
      try {
        r304 = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': `"${sha(P)}"` } });
        const repeat = [...seen];
        assert.equal(r304.statusCode, 304);
        assert.equal(repeat.length, 1, `Postgres: a repeat view is one query (${repeat.map((q) => q.replace(/\s+/g, ' ').slice(0, 60)).join(' | ')})`);
        check(!/SELECT[^]*\bthumbnail\b[^]*FROM/.test(repeat[0].replace(/thumbnail_hash|thumbnail IS NOT NULL/g, '')), 'Postgres: and it does not read the picture');
        seen.length = 0;
        const firstView = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png` });
        assert.equal(firstView.statusCode, 200);
        assert.equal(seen.length, 1, 'Postgres: a first view is one query too');
        // A scene view, anonymous, kept: visibility and hash only.
        await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(o.token), payload: { sceneGzB64: scene('pg-count') } });
        await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` });
        seen.length = 0;
        await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` });
        sceneQueries = [...seen];
      } finally {
        pg.Client.prototype.query = realQuery;
      }
      assert.equal(sceneQueries.length, 1, `Postgres: a repeat anonymous scene view is one query (${sceneQueries.length})`);
      check(!/SELECT scene\b/.test(sceneQueries[0]) && /scene_hash/.test(sceneQueries[0]), 'Postgres: visibility and the hash, never the scene');
      // Rows stored before the hashes: served right, and filled in. (The
      // triggers that keep the hashes are switched off for this, as they
      // were before they existed; the stage 2 review block tests them.)
      await pool.query('ALTER TABLE designs DISABLE TRIGGER designs_thumbnail_hash; ALTER TABLE design_scenes DISABLE TRIGGER design_scenes_scene_hash');
      await pool.query('UPDATE designs SET thumbnail_hash = NULL WHERE id = $1', [id]);
      await pool.query('UPDATE design_scenes SET scene_hash = NULL WHERE design_id = $1', [id]);
      const lazy = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png` });
      assert.equal(lazy.headers.etag, `"${sha(P)}"`, 'Postgres: a picture with no stored hash gets the right ETag');
      assert.match(sceneOf(await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` })) ?? '', /pg-count/, 'Postgres: and a scene with none is still served stripped');
      await new Promise((r) => setTimeout(r, 300));
      const filled = await pool.query("SELECT (d.thumbnail_hash = encode(sha256(d.thumbnail), 'hex')) AS t, (s.scene_hash = encode(sha256(s.scene), 'hex')) AS s FROM designs d JOIN design_scenes s ON s.design_id = d.id WHERE d.id = $1", [id]);
      check(filled.rows[0].t === true && filled.rows[0].s === true, 'Postgres: and both are filled in from the stored bytes');
      await pool.query('UPDATE designs SET thumbnail_hash = NULL WHERE id = $1', [id]);
      await pool.query('ALTER TABLE designs ENABLE TRIGGER designs_thumbnail_hash; ALTER TABLE design_scenes ENABLE TRIGGER design_scenes_scene_hash');
      check((await pDesigns.backfillHashes()) >= 1, 'Postgres: the boot backfill fills what is missing');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM designs WHERE thumbnail IS NOT NULL AND thumbnail_hash IS NULL")).rows[0].n, 0, 'Postgres: all of it');
      await app.close();
    } finally {
      await pool.end();
    }
    console.log('  Postgres: thumbnails and scenes as on memory; hashes stored with the bytes; repeat views one query, no picture or scene read; lazy and boot backfill');
  }
  console.log('performance plan stage 2 (server), part two: all assertions passed');
}

// ---------- 2026-10: performance plan, stage 2 (server), part three ----------
// Work in worker threads (P2.14), the schema at boot (P2.15) and the
// Cloudflare code side (P2.2). The workers hold scene and PDF work that used to
// hold the event loop, so they must fail closed; the schema ledger skips work,
// so it must never skip a control; the origin lock refuses traffic, so it must
// refuse the right traffic and leak nothing.
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const { WorkerPool, PoolBusyError, PoolFailedError, workerFile, SCENE_POOL, PDF_POOL } = await import('../src/workerPool');
  const { StrippedSceneCache } = await import('../src/sceneCache');
  const { securityPosture } = await import('../src/posture');
  const { configWarnings } = await import('../src/preflight');
  const { MemorySocRepository } = await import('../src/socRepo');
  const { SocMonitor } = await import('../src/soc');
  const { MemoryAiUsageRepository, MemoryAiEventsRepository } = await import('../src/memoryRepo');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const S2PW = 'lantern-orchid-quarry8';
  const s2reg = async (app: FastifyInstance, u: string, ip = '198.18.230.1'): Promise<{ token: string; id: string }> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { username: u, password: S2PW, email: `${u}@example.test`, acceptedVersion: 'test' } });
    assert.equal(r.statusCode, 201, r.body);
    const token = (r.json() as { token: string }).token;
    return { token, id: ((await app.inject({ method: 'GET', url: '/api/me', remoteAddress: ip, headers: bearer(token) })).json() as { id: string }).id };
  };
  /** A worker written inline, started by the pool exactly as the real ones are. */
  const inline = (body: string) => ({ url: new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads';\n${body}\nparentPort.postMessage({ ready: true });`)}`) });
  const pool = (body: string, o: Partial<{ size: number; maxQueue: number; timeoutMs: number; idleMs: number; memMb: number }> = {}) =>
    new WorkerPool<unknown, unknown>({
      name: 'test', file: inline(body), size: o.size ?? 1, maxQueue: o.maxQueue ?? 4, timeoutMs: o.timeoutMs ?? 2_000, idleMs: o.idleMs ?? 5_000,
      resourceLimits: { maxOldGenerationSizeMb: o.memMb ?? 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, log: () => {},
    });
  const reply = `parentPort.on('message', async (m) => {
    if (m === 'die') process.exit(3);
    if (m === 'throw') return void setTimeout(() => { throw new Error('S2 thrown'); });
    if (m === 'spin') for (;;) {}
    if (m === 'eat') { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); }
    if (m === 'slow') await new Promise((r) => setTimeout(r, 300));
    if (m === 'env') return parentPort.postMessage({ ok: true, result: { keys: Object.keys(process.env), secret: process.env.S2_WORKER_SECRET ?? null, db: process.env.DATABASE_URL ?? null } });
    if (m === 'fail') return parentPort.postMessage({ ok: false, error: 'S2 refused' });
    parentPort.postMessage({ ok: true, result: m });
  });`;

  // ---- P2.14: the pool's guardrails, one by one ----
  {
    process.env.S2_WORKER_SECRET = 'S2-SECRET-NOT-FOR-WORKERS';
    const p = pool(reply, { timeoutMs: 400, idleMs: 300, memMb: 24 });
    assert.equal(await p.run('hello'), 'hello', 'a task runs');
    const env = (await p.run('env')) as { keys: string[]; secret: string | null; db: string | null };
    assert.deepEqual(env.keys, [], 'a worker starts with an empty environment');
    assert.equal(env.secret, null, 'so no secret of the server is within its reach');
    assert.equal(env.db, null);
    delete process.env.S2_WORKER_SECRET;
    await assert.rejects(p.run('fail'), PoolFailedError, 'a task the worker refuses fails');
    assert.equal(await p.run('after a refusal'), 'after a refusal', 'and the worker carries on');
    for (const [m, stat] of [['die', 'crashed'], ['throw', 'crashed'], ['spin', 'timedOut']] as const) {
      const before = p.stats[stat];
      const t0 = Date.now();
      await assert.rejects(p.run(m), PoolFailedError, `${m}: the task fails`);
      check(p.stats[stat] === before + 1, `${m}: counted as ${stat}`);
      if (m === 'spin') check(Date.now() - t0 < 2_000, `the time limit ends a task that never answers (${Date.now() - t0} ms)`);
      assert.equal(await p.run(`after ${m}`), `after ${m}`, `${m}: a new worker takes the next task`);
    }
    check(p.stats.started >= 4, 'each lost worker was replaced');
    // Out of memory: the worker's own limit, never the server's. Run in a
    // process of its own without NODE_OPTIONS (a V8 heap flag there overrides
    // every worker's limit, which is what the next check is about), and with
    // a guard that ends it long before it could hurt the machine.
    {
      const script = `
        import { WorkerPool, PoolFailedError } from './server/src/workerPool.ts';
        setInterval(() => { if (process.memoryUsage().rss > 700e6) { console.log('GUARD'); process.exit(9); } }, 10).unref();
        const p = new WorkerPool({ name: 'oom', file: { url: new URL('data:text/javascript,' + encodeURIComponent(${JSON.stringify(`import { parentPort } from 'node:worker_threads'; import { getHeapStatistics } from 'node:v8'; parentPort.on('message', (m) => { if (m === 'eat') { const keep = []; for (;;) keep.push({ a: Math.random(), b: [1, 2, 3] }); } parentPort.postMessage({ ok: true, result: m }); }); parentPort.postMessage({ ready: true, heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1048576) });`)})) }, size: 1, maxQueue: 1, timeoutMs: 20000, idleMs: 1000, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 }, log: () => {} });
        const t0 = Date.now();
        const err = await p.run('eat').then(() => null, (e) => e);
        const after = await p.run('after');
        console.log(JSON.stringify({ failed: err instanceof PoolFailedError, crashed: p.stats.crashed, ms: Date.now() - t0, rssMb: Math.round(process.memoryUsage().rss / 1e6), after, overridden: p.limitOverridden }));
        await p.close();`;
      const env = { ...process.env } as Record<string, string | undefined>;
      delete env.NODE_OPTIONS;
      const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
      const out = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as { failed: boolean; crashed: number; ms: number; rssMb: number; after: string; overridden: boolean };
      check(run.status === 0 && out.failed && out.crashed === 1, `a task past its memory limit fails as a lost worker (${run.status} ${run.stdout.slice(-200)} ${run.stderr.slice(-300)})`);
      check(out.rssMb < 600 && !out.overridden, `the process stays small: the worker’s limit held (${out.rssMb} MB)`);
      assert.equal(out.after, 'after', 'and a new worker takes the next task');
    }
    // A process-wide heap flag is noticed: by the pool, by preflight and so on the posture panel.
    {
      const said: string[] = [];
      const w = new WorkerPool<unknown, unknown>({ name: 'limit-check', file: workerFile('sceneWorker'), size: 1, maxQueue: 1, timeoutMs: 5_000, idleMs: 1_000, resourceLimits: SCENE_POOL.resourceLimits, log: (m) => said.push(m) });
      await w.run({ kind: 'check', gz: gzipSync(Buffer.from('{}')) });
      const flagged = /--max-old-space-size/.test(process.env.NODE_OPTIONS ?? '') || process.execArgv.some((a) => a.startsWith('--max-old-space-size'));
      assert.equal(w.limitOverridden, flagged, `the pool knows whether its limit is in force (NODE_OPTIONS ${process.env.NODE_OPTIONS ?? 'unset'})`);
      assert.equal(said.some((m) => /memory limit not in force/.test(m)), flagged, 'and says so in the log when it is not');
      await w.close();
      assert.equal(configWarnings({ NODE_OPTIONS: '--max-old-space-size=8192' }).find((x) => x.key === 'NODE_OPTIONS')?.state, 'wrong');
      assert.equal(configWarnings({ NODE_OPTIONS: '--enable-source-maps' }).find((x) => x.key === 'NODE_OPTIONS'), undefined);
      const post = securityPosture({ env: { NODE_OPTIONS: '--max-old-space-size=4096' }, nodeVersion: process.version, uid: 1000, rateLimit: true, database: 'postgres', email: null, soc: null });
      assert.equal(post.find((c) => c.id === 'config-NODE_OPTIONS')?.state, 'bad', 'the posture panel says fix');
    }
    // The queue: one running, two waiting, the fourth refused at once.
    const q = pool(reply, { maxQueue: 2 });
    const running = [q.run('slow'), q.run('slow'), q.run('slow')];
    await assert.rejects(q.run('slow'), PoolBusyError, 'a full queue refuses at once');
    assert.equal(q.stats.refused, 1);
    assert.deepEqual(await Promise.all(running), ['slow', 'slow', 'slow'], 'and the waiting tasks still run');
    // A slow start is not a slow task: the clock starts once the worker has loaded.
    const late = new WorkerPool<unknown, unknown>({ name: 'late', file: { url: new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'; await new Promise((r) => setTimeout(r, 600)); parentPort.on('message', (m) => parentPort.postMessage({ ok: true, result: m })); parentPort.postMessage({ ready: true });`)}`) }, size: 1, maxQueue: 1, timeoutMs: 200, idleMs: 1_000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
    assert.equal(await late.run('started late'), 'started late', 'a worker that loads slowly still gets its full time limit');
    // Idle workers end, and the next task starts one.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(p.alive, 0, 'an idle worker is ended');
    assert.equal(await p.run('again'), 'again');
    // Closing refuses what waits.
    const c = pool(reply, { maxQueue: 2 });
    const pending = [c.run('slow'), c.run('slow')].map((x) => x.then(() => null, (e: unknown) => e));
    await c.close();
    for (const x of pending) check((await x) instanceof PoolBusyError, 'a pool that closes refuses its running and waiting tasks');
    await assert.rejects(c.run('x'), PoolBusyError, 'a closed pool takes nothing');
    await Promise.all([p.close(), q.close(), late.close()]);
    // The real pools: separate, bounded, time-limited, memory-limited, no environment.
    const src = readFileSync('server/src/workerPool.ts', 'utf8');
    check(/new Worker\(this\.opts\.file\.url, \{\s*env: \{\},\s*resourceLimits: this\.opts\.resourceLimits,/.test(src), 'every worker: env {} and resourceLimits');
    check(/worker\.on\('error'/.test(src) && /worker\.on\('exit'/.test(src), 'an error and an exit handler on every worker');
    check(SCENE_POOL.maxQueue > 0 && SCENE_POOL.maxQueue <= 32 && PDF_POOL.maxQueue > 0 && PDF_POOL.maxQueue <= 8, 'both queues are bounded');
    check(SCENE_POOL.timeoutMs <= 10_000 && PDF_POOL.timeoutMs <= 60_000, 'both have a time limit');
    check(!!SCENE_POOL.resourceLimits.maxOldGenerationSizeMb && !!PDF_POOL.resourceLimits.maxOldGenerationSizeMb, 'both have a memory limit');
    for (const name of ['sceneWorker', 'pdfWorker'] as const) {
      const f = workerFile(name);
      check(existsSync(new URL(f.workerData!.entry)), `${name}: its source exists`);
      const w = readFileSync(new URL(f.workerData!.entry), 'utf8');
      check(!/process\.env/.test(w.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, '')), `${name}: reads no environment`);
    }
    console.log('  P2.14 pools: empty environment; refusals, crashes, throws, time-outs and out-of-memory fail the task and replace the worker; bounded queue; slow start not counted; idle end; close');
  }

  // ---- P2.14: the routes fail closed when the work cannot be done ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, {});
    const owner = await s2reg(app, 'wkown_s2');
    const SECRET = 'data:image/webp;base64,UzItV09SS0VSLUxBWUVS';
    const scene = (b: string) => gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: b }], layers: [{ id: 'l', src: SECRET }] }))).toString('base64');
    const made = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(owner.token), payload: { title: 'Workers', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
    const id = (made.json() as { id: string }).id;
    await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(owner.token), payload: { isPublic: true } });
    assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: scene('kept-v1') } })).statusCode, 200, 'a save through the real scene worker');
    const { gunzipSync } = await import('node:zlib');
    const ownScene = async (): Promise<string> => gunzipSync(Buffer.from((await app.inject({ method: 'GET', url: `/api/designs/${id}/scene`, headers: bearer(owner.token) })).json().sceneGzB64, 'base64')).toString();
    for (const [label, body, o] of [
      ['a worker that dies', `parentPort.on('message', () => process.exit(4));`, {}],
      ['a worker that never answers', `parentPort.on('message', () => { for (;;) {} });`, { timeoutMs: 300 }],
      ['a worker that throws', `parentPort.on('message', () => { throw new Error('x'); });`, {}],
      ['a worker that refuses', `parentPort.on('message', () => parentPort.postMessage({ ok: false, error: 'no' }));`, {}],
    ] as const) {
      const bad = pool(body, o);
      const broken = await buildApp(designs, auth, templates, { workers: { scene: bad as never, pdf: bad as never }, sceneCache: new StrippedSceneCache() });
      const put = await broken.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: scene(`unchecked-${label}`) } });
      assert.equal(put.statusCode, 503, `${label}: a save that could not be checked is a 503 (${put.body})`);
      assert.equal((put.json() as { code: string }).code, 'retry');
      check(!(await ownScene()).includes('unchecked'), `${label}: and the unchecked scene was not stored`);
      const anon = await broken.inject({ method: 'GET', url: `/api/designs/${id}/scene` });
      assert.equal(anon.statusCode, 503, `${label}: a strip that could not be done is a 503`);
      check(!anon.body.includes('sceneGzB64') && !anon.body.includes(SECRET), `${label}: never the scene as stored`);
      const pdf = await broken.inject({ method: 'POST', url: '/api/export/pdf', payload: { title: 'x', templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 } });
      assert.equal(pdf.statusCode, 503, `${label}: a PDF that could not be drawn is a 503`);
      check(!String(pdf.headers['content-type']).includes('pdf'), 'with no PDF');
      await broken.close();
      await bad.close();
    }
    // A full queue: one save checking, the next refused, never stored unchecked.
    {
      const slow = pool(`parentPort.on('message', () => setTimeout(() => parentPort.postMessage({ ok: true, result: 'ok' }), 400));`, { maxQueue: 0 });
      const busyApp = await buildApp(designs, auth, templates, { workers: { scene: slow as never, pdf: slow as never } });
      const [a, b] = await Promise.all([
        busyApp.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: scene('first-in') } }),
        new Promise((r) => setTimeout(r, 50)).then(() => busyApp.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: scene('queue-full') } })),
      ]);
      assert.equal(a.statusCode, 200, 'the first is checked and saved');
      assert.equal(b.statusCode, 503, 'the one the queue could not take is a 503');
      check(!(await ownScene()).includes('queue-full'), 'and was not stored');
      await busyApp.close();
      await slow.close();
    }
    // The PDF's temporary file is gone after every outcome, a stopped worker included.
    {
      const real = workerFile('pdfWorker');
      const paths: string[] = [];
      const spy = (p: InstanceType<typeof WorkerPool>) => ({ run: (msg: { outPath: string }, t?: never) => { paths.push(msg.outPath); return p.run(msg, t); }, close: () => p.close() });
      const ok = new WorkerPool({ ...PDF_POOL, file: real, log: () => {} });
      const okApp = await buildApp(designs, auth, templates, { workers: { pdf: spy(ok) as never } });
      const body = { title: 'Temp file', templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 };
      const pdf = await okApp.inject({ method: 'POST', url: '/api/export/pdf', payload: body });
      assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));
      assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-', 'a PDF, drawn in the worker');
      check(/^tifo-[0-9a-f]{24}\.pdf$/.test(paths[0].split('/').pop()!), 'a random name');
      check(!existsSync(paths[0]), 'its temporary file is gone once it is sent');
      const stopped = new WorkerPool({ ...PDF_POOL, timeoutMs: 120, file: real, log: () => {} });
      const stoppedApp = await buildApp(designs, auth, templates, { workers: { pdf: spy(stopped) as never } });
      // Warm the worker up first, so the time limit lands while it is drawing.
      await stopped.run({ outPath: `/nonexistent/tifo-${'0'.repeat(24)}.pdf`, templateId: 'no-such', templateVersion: 1, cells: new Uint8Array(1), palette: PALETTE, meta: {} as never }).catch(() => {});
      const cut = await stoppedApp.inject({ method: 'POST', url: '/api/export/pdf', payload: body });
      assert.equal(cut.statusCode, 503, 'a PDF past its time limit is a 503');
      await new Promise((r) => setTimeout(r, 2_500));
      check(!existsSync(paths[paths.length - 1]), 'and the stopped worker’s temporary file is removed too');
      // The worker writes only where the route says, and only that kind of name.
      await assert.rejects(ok.run({ ...body, outPath: '/tmp/../etc/passwd', templateVersion: DEFAULT_TEMPLATE.version, cells: new Uint8Array(map.count), palette: PALETTE, meta: { designTitle: 'x', stadiumName: 'x', cardsPerBag: 1, watermark: true } } as never), PoolFailedError);
      await Promise.all([okApp.close(), stoppedApp.close(), ok.close(), stopped.close()]);
    }
    // Every cap and limit stays in front of the queue.
    {
      const limited = await buildApp(designs, auth, templates, { rateLimit: true });
      const ip = '198.18.231.7';
      const lim = await s2reg(limited, 'wklim_s2', ip);
      const m2 = await limited.inject({ method: 'POST', url: '/api/designs', remoteAddress: ip, headers: bearer(lim.token), payload: { title: 'Limited', templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64 } });
      const lid = (m2.json() as { id: string }).id;
      let last;
      for (let i = 0; i < 31; i++) last = await limited.inject({ method: 'PUT', url: `/api/designs/${lid}/scene`, remoteAddress: ip, headers: bearer(lim.token), payload: {} });
      assert.equal(last!.statusCode, 429, 'scene saves: 30 a minute');
      for (let i = 0; i < 7; i++) last = await limited.inject({ method: 'POST', url: '/api/export/pdf', remoteAddress: '198.18.231.8', payload: {} });
      assert.equal(last!.statusCode, 429, 'PDFs: 6 a minute');
      const huge = await limited.inject({ method: 'PUT', url: `/api/designs/${lid}/scene`, remoteAddress: '198.18.231.9', headers: bearer(lim.token), payload: { sceneGzB64: Buffer.alloc(3_000_000, 1).toString('base64') } });
      check(huge.statusCode === 413, `an oversized scene is refused before any worker sees it (${huge.statusCode})`);
      await limited.close();
    }
    await app.close();
    console.log('  P2.14 routes: a scene save, a strip or a PDF the worker cannot do is a 503 (never stored unchecked, never the layers); temp files removed after every outcome; limits kept');
  }

  // ---- P2.15: the statements a control rests on are known, one each ----
  const { SchemaLedger, schemaStatements, statementBody, withoutDollarQuotes, SECURITY_STATEMENTS, SCHEMA_LOCK_TIMEOUT_MS } = await import('../src/schema');
  const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const statements = schemaStatements(schemaSql);
  for (const rule of SECURITY_STATEMENTS) {
    assert.equal(statements.filter((s) => rule.match.test(statementBody(s))).length, 1, `${rule.id}: matches exactly one statement of schema.sql`);
  }
  // Recognised without their comments, which most of them open with; never two statements in one.
  assert.equal(statementBody("-- why\nALTER TABLE t ADD COLUMN IF NOT EXISTS k TEXT DEFAULT 'a--b' -- trailing\n  -- more"), "ALTER TABLE t ADD COLUMN IF NOT EXISTS k TEXT DEFAULT 'a--b'");
  assert.deepEqual(schemaStatements('A BYTEA;  -- note\nB;\nC'), ['A BYTEA', 'B', 'C'], 'a comment after the semicolon still ends the statement');
  assert.deepEqual(statements.filter((s) => withoutDollarQuotes(statementBody(s)).replace(/;\s*$/, '').includes(';')).map((s) => s.slice(0, 60)), [], 'no text of schema.sql holds two statements (a $$ body has semicolons of its own)');
  check(SECURITY_STATEMENTS.length >= 10, 'the controls the database holds are all listed');
  assert.equal(SCHEMA_LOCK_TIMEOUT_MS, 3_000);
  {
    const src = readFileSync('server/src/server.ts', 'utf8');
    const listen = src.indexOf('await app.listen(');
    const loop = src.indexOf('for (const task of afterListen)');
    check(listen > 0 && loop > listen, 'the boot purges run after the port is open');
    for (const purge of ['t.purge()', 'socRepo.purge()', 'pruneEvents', 'backfillHashes()']) {
      const at = src.indexOf(purge);
      check(at > 0 && !new RegExp(`await ${purge.replace(/[().]/g, '\\$&')}`).test(src.slice(0, listen).replace(/afterListen\.push\([^]*?\);/g, '')), `${purge}: not awaited before listen`);
    }
    check(/afterListen\.push\(\(\) => t\.purge\(\)\)/.test(src) && /afterListen\.push\(\(\) => socRepo\.purge\(\)\)/.test(src) && /afterListen\.push\(pruneEvents\)/.test(src), 'each purge is queued for after listen');
    check(/createPool\(process\.env\.DATABASE_URL, 'maintenance'\)/.test(src) && /applySchema\(maint\)/.test(src), 'on the maintenance pool');
  }
  // The posture panel's schema check.
  {
    const base = { env: { NODE_ENV: 'production' }, nodeVersion: process.version, uid: 1000, rateLimit: true, database: 'postgres' as const, email: null, soc: null };
    const schemaState = (schema: { pendingSecurity: { id: string; why: string }[]; failed: number } | null) => securityPosture({ ...base, schema }).find((c) => c.id === 'schema');
    assert.equal(schemaState({ pendingSecurity: [{ id: 'username-unique-ci', why: 'x' }], failed: 1 })?.state, 'bad', 'a security statement not in force: fix');
    check(/username-unique-ci|x/.test(schemaState({ pendingSecurity: [{ id: 'username-unique-ci', why: 'x' }], failed: 1 })!.detail), 'naming it');
    assert.equal(schemaState({ pendingSecurity: [], failed: 2 })?.state, 'warn', 'others not applied: check');
    assert.equal(schemaState({ pendingSecurity: [], failed: 0 })?.state, 'good');
    assert.equal(schemaState(null), undefined, 'no schema check on the memory store');
  }
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const name = `s2_ledger_${randomBytes(4).toString('hex')}`;
    const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await adminPool.query(`CREATE SCHEMA ${name}`);
    const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, options: `-c search_path=${name}` });
    try {
      // schema.sql is still runnable as one query.
      await p.query(schemaSql);
      await p.query(`DROP SCHEMA ${name} CASCADE; CREATE SCHEMA ${name}`);
      // First boot on an empty database: everything applied.
      const first = new SchemaLedger(p, { log: () => {} });
      await first.load();
      const r1 = await first.applyAll(statements);
      assert.deepEqual(r1.failed, [], 'a first boot applies the whole file');
      assert.equal(r1.applied + r1.present, statements.length);
      assert.deepEqual(r1.pendingSecurity, []);
      // Second boot: nothing to run.
      const second = new SchemaLedger(p, { log: () => {} });
      await second.load();
      const t2 = Date.now();
      const r2 = await second.applyAll(statements);
      assert.equal(r2.skipped, statements.length, `a second boot skips every statement (${JSON.stringify({ ...r2, failed: r2.failed.length })})`);
      assert.equal(r2.applied, 0);
      console.log(`  P2.15 boot: first ${r1.applied} applied + ${r1.present} present; second ${r2.skipped} skipped in ${Date.now() - t2} ms`);
      // ...even while a long write holds the busiest table: no lock is asked for.
      const holder = await adminPool.connect();
      await holder.query(`BEGIN; LOCK TABLE ${name}.designs IN ACCESS EXCLUSIVE MODE; LOCK TABLE ${name}.users IN ACCESS EXCLUSIVE MODE`);
      try {
        const third = new SchemaLedger(p, { log: () => {} });
        await third.load();
        const t3 = Date.now();
        const r3 = await third.applyAll(statements);
        check(Date.now() - t3 < 2_000, `a boot with nothing to do waits for no lock, security re-checks included (${Date.now() - t3} ms)`);
        assert.equal(r3.skipped, statements.length);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // A database that already has the objects (one made before the ledger): recorded, not run.
      await p.query('DROP TABLE schema_ledger');
      const legacy = new SchemaLedger(p, { log: () => {} });
      await legacy.load();
      const holder2 = await adminPool.connect();
      await holder2.query(`BEGIN; LOCK TABLE ${name}.users IN ROW EXCLUSIVE MODE`);
      let r4;
      try {
        const t4 = Date.now();
        r4 = await legacy.applyAll(statements.filter((s) => /^(CREATE (UNIQUE )?INDEX|ALTER TABLE \w+ ADD COLUMN|CREATE TABLE) IF NOT EXISTS/i.test(statementBody(s))));
        check(Date.now() - t4 < 2_000, `objects already there are recorded without waiting on a lock (${Date.now() - t4} ms)`);
      } finally {
        await holder2.query('ROLLBACK');
        holder2.release();
      }
      assert.deepEqual(r4.failed, []);
      check(r4.present > 0 && r4.applied === 0, `recorded as present (${r4.present}), none run`);
      // The rest of the file (the statements of no IF NOT EXISTS shape) runs once and is recorded.
      const rest = await legacy.applyAll(statements);
      assert.deepEqual(rest.failed, []);
      assert.equal(rest.skipped + rest.applied, statements.length);
      // A security statement whose object is missing is run again, however it is recorded...
      await p.query('DROP INDEX users_username_lower_idx');
      const again = new SchemaLedger(p, { log: () => {} });
      await again.load();
      // ...and while a write holds its table, it gives up after 3 s, says so, and the panel says fix.
      const holder3 = await adminPool.connect();
      await holder3.query(`BEGIN; LOCK TABLE ${name}.users IN ROW EXCLUSIVE MODE`);
      let r5;
      const t5 = Date.now();
      try {
        r5 = await again.applyAll(statements);
      } finally {
        await holder3.query('ROLLBACK');
        holder3.release();
      }
      const waited = Date.now() - t5;
      check(waited >= 2_900 && waited < 8_000, `a statement waits at most 3 s for its lock (${waited} ms)`);
      assert.equal(r5.failed.length, 1, 'that statement failed');
      check(/lock timeout|canceling statement due to lock timeout/i.test(r5.failed[0].error), r5.failed[0].error);
      assert.deepEqual(r5.pendingSecurity.map((x) => x.id), ['username-unique-ci'], 'and it is reported as a security statement not in force');
      assert.equal(r5.skipped, statements.length - 1, 'the rest of the boot went on');
      // Wired to the panel.
      const auth = new MemoryAuthRepository();
      const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
      const panel = await buildApp(designs, auth, templates, { soc: new SocMonitor({ repo: new MemorySocRepository() }), aiAdminPassword: 'stage two schema admin', schemaStatus: () => ({ pendingSecurity: r5.pendingSecurity, failed: r5.failed.length }) });
      const soc = await panel.inject({ method: 'GET', url: '/api/admin/soc', headers: { 'x-ai-unlock': mintUnlock('stage two schema admin') } });
      assert.equal(soc.statusCode, 200, soc.body);
      const posture = (soc.json() as { posture: { id: string; state: string }[] }).posture;
      assert.equal(posture.find((c) => c.id === 'schema')?.state, 'bad', 'the posture panel says fix');
      await panel.close();
      // The next boot, without the lock, puts it back.
      const healed = new SchemaLedger(p, { log: () => {} });
      await healed.load();
      const r6 = await healed.applyAll(statements);
      assert.equal(r6.applied, 1, 'applied at the next boot');
      assert.deepEqual(r6.pendingSecurity, []);
      assert.equal((await p.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_username_lower_idx'")).rows[0].n, 1);
      // A statement that changes is a new hash, and runs; then it is recorded.
      const changed = new SchemaLedger(p, { log: () => {} });
      await changed.load();
      assert.equal(await changed.run('ALTER TABLE designs ADD COLUMN IF NOT EXISTS s2_ledger_probe TEXT'), 'applied');
      assert.equal(await changed.run('ALTER TABLE designs ADD COLUMN IF NOT EXISTS s2_ledger_probe TEXT'), 'skipped');
      assert.equal(await changed.run("UPDATE designs SET s2_ledger_probe = 'x' WHERE false"), 'applied', 'any other statement runs once');
      const later = new SchemaLedger(p, { log: () => {} });
      await later.load();
      assert.equal(await later.run("UPDATE designs SET s2_ledger_probe = 'x' WHERE false"), 'skipped', 'and is skipped after that');
      // The repositories' own tables go through the same ledger.
      const srv = readFileSync('server/src/server.ts', 'utf8');
      check(/const ddl = \(sql: string\): Promise<unknown> => ledger\.run\(sql\)/.test(srv) && (srv.match(/\.init\(ddl\)/g) ?? []).length >= 4, 'repository tables are made through the ledger');
      console.log(`  P2.15 Postgres: ledger skips what ran; present objects recorded without a lock; a held lock fails one statement after ${waited} ms and the panel says fix; the next boot heals it`);
    } finally {
      await p.end();
      await adminPool.query(`DROP SCHEMA ${name} CASCADE`).catch(() => {});
      await adminPool.end();
    }
  }

  // ---- P2.2: Cloudflare in front, and the origin lock ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const SECRET = randomBytes(32).toString('hex');
    assert.equal(process.env.ORIGIN_SECRET, undefined, 'tests run without ORIGIN_SECRET');
    for (const short of ['x', 'a'.repeat(31), ` ${'b'.repeat(31)} `]) {
      await assert.rejects(buildApp(designs, auth, templates, { originSecret: short }), /at least 32/, `a ${short.trim().length}-character secret is refused`);
    }
    const lines: string[] = [];
    const soc = new SocMonitor({ repo: new MemorySocRepository() });
    const app = await buildApp(designs, auth, templates, { originSecret: SECRET, rateLimit: true, logger: true, logStream: { write: (l: string) => { lines.push(l); } }, soc, staticDir: undefined });
    app.get('/__s2_headers', async (req) => ({ names: Object.keys(req.headers) }));
    const ok = { 'x-origin-secret': SECRET };
    let n = 0;
    const ip = () => `198.18.232.${n++ % 250}`;
    const normal = await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: ip(), headers: ok });
    assert.equal(normal.statusCode, 200, 'through Cloudflare: answered');
    const refusals: [string, string, Record<string, string>?][] = [
      ['GET', '/api/templates'],
      ['GET', '/api/templates', { 'x-origin-secret': SECRET.slice(0, -1) + (SECRET.endsWith('0') ? '1' : '0') }],
      ['GET', '/api/templates', { 'x-origin-secret': `${SECRET}x` }],
      ['GET', '/api/templates', { 'x-origin-secret': SECRET.toUpperCase() }],
      ['GET', '/api/templates', { 'x-origin-secret': '' }],
      ['GET', '/api/me', { authorization: 'Bearer x' }],
      ['GET', '/api/admin/soc'],
      ['POST', '/api/auth/login'],
      ['GET', '/nope'],
      ['HEAD', '/health'],
      ['POST', '/health'],
      ['GET', '/health/'],
      ['GET', '/%E0%A4%A'],
    ];
    for (const [method, url, headers] of refusals) {
      const r = await app.inject({ method: method as 'GET', url, remoteAddress: ip(), headers });
      assert.equal(r.statusCode, 403, `around Cloudflare: ${method} ${url} ${JSON.stringify(headers ?? {})} is refused (${r.statusCode})`);
      assert.equal(r.headers['cache-control'], 'no-store', 'not cached');
      for (const h of ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-resource-policy']) {
        assert.equal(r.headers[h], normal.headers[h], `${method} ${url}: ${h} as on any answer`);
      }
      if (method !== 'HEAD') assert.deepEqual(r.json(), { error: 'forbidden' }, 'saying nothing else');
    }
    assert.equal((await app.inject({ method: 'GET', url: '/health', remoteAddress: ip() })).statusCode, 200, 'GET /health is exempt, for the platform’s healthcheck');
    assert.equal((await app.inject({ method: 'GET', url: '/health?probe=1', remoteAddress: ip() })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/%E0%A4%A', remoteAddress: ip(), headers: ok })).statusCode, 400, 'with the secret, an unreadable URL is its usual 400');
    // Gone from the request once checked, and never in a log line.
    const seen = await app.inject({ method: 'GET', url: '/__s2_headers', remoteAddress: ip(), headers: ok });
    assert.equal(seen.statusCode, 200);
    check(!(seen.json() as { names: string[] }).names.includes('x-origin-secret'), 'no route ever sees the secret');
    await new Promise((r) => setTimeout(r, 30));
    check(lines.length > 0 && !lines.some((l) => l.includes(SECRET) || l.includes(SECRET.slice(0, 16)) || l.includes(SECRET.toUpperCase())), 'the secret, right or wrong, is in no log line');
    check(lines.some((l) => /"statusCode":403/.test(l)), 'the refusals are logged like any request');
    // Counted in the rate limit, in the same bucket as everything else.
    const lip = '198.18.233.1';
    for (let i = 0; i < 299; i++) await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: lip });
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: lip, headers: ok })).statusCode, 200, 'the 300th in a minute, with the secret');
    const over = await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: lip });
    assert.equal(over.statusCode, 429, 'refusals count: the 301st is a 429');
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: lip, headers: ok })).statusCode, 429, 'for that client’s real requests too');
    const events = soc.recent(400);
    check(!events.some((e) => e.kind === 'admin_denied' || e.kind === 'admin_unlock_failed' || e.kind === 'login_failed'), 'a request refused by the lock is not an admin or sign-in event');
    check(events.some((e) => e.kind === 'rate_limited'), 'but a flood at the origin itself is on the Security tab');
    await app.close();
    // Unset: exactly as before, and the header means nothing.
    const open = await buildApp(designs, auth, templates, {});
    assert.equal((await open.inject({ method: 'GET', url: '/api/templates' })).statusCode, 200, 'no secret, no lock');
    assert.equal((await open.inject({ method: 'GET', url: '/api/templates', headers: { 'x-origin-secret': 'anything' } })).statusCode, 200);
    await open.close();
    // server.ts refuses to start with a short secret, before it listens.
    const env = { ...process.env, ORIGIN_SECRET: 'too-short-a-secret', PORT: '8961' } as Record<string, string | undefined>;
    delete env.DATABASE_URL;
    const boot = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 90_000 });
    assert.equal(boot.status, 1, `the server exits (${boot.status}, ${boot.stderr.slice(-300)})`);
    check(/FATAL: ORIGIN_SECRET is 18 characters/.test(boot.stderr) && !/tifo-maker on :/.test(boot.stdout), 'saying why, without having listened');
    check(!boot.stderr.includes('too-short-a-secret') && !boot.stdout.includes('too-short-a-secret'), 'and without printing it');
    // The config warnings and the posture panel.
    assert.equal(configWarnings({ ORIGIN_SECRET: 'short' }).find((w) => w.key === 'ORIGIN_SECRET')?.state, 'wrong');
    check(configWarnings({ TRUST_PROXY: 'cloudflare' }).some((w) => w.key === 'ORIGIN_SECRET'), 'cloudflare without a secret is a warning');
    check(!configWarnings({ TRUST_PROXY: 'cloudflare', ORIGIN_SECRET: SECRET }).some((w) => w.key === 'ORIGIN_SECRET'), 'and not with one');
    const base = { nodeVersion: process.version, uid: 1000, rateLimit: true, database: 'postgres' as const, email: null, soc: null };
    const proxy = (env: Record<string, string>, cloudflareSeen: string | null = null) => securityPosture({ ...base, env, cloudflareSeen });
    assert.equal(proxy({ NODE_ENV: 'production', TRUST_PROXY: 'cloudflare' }).find((c) => c.id === 'proxy')?.state, 'warn', 'Cloudflare mode, origin not locked: check');
    assert.equal(proxy({ NODE_ENV: 'production', TRUST_PROXY: 'cloudflare', ORIGIN_SECRET: SECRET }).find((c) => c.id === 'proxy')?.state, 'good');
    assert.equal(proxy({ NODE_ENV: 'production', TRUST_PROXY: 'cloudflare', ORIGIN_SECRET: 'short' }).find((c) => c.id === 'origin-secret')?.state, 'bad');
    // Anyone can send Cloudflare's headers, so seeing them is a check with advice for both cases, never a fix (stage 2 review).
    const seenProd = proxy({ NODE_ENV: 'production' }, new Date().toISOString()).find((c) => c.id === 'proxy')!;
    assert.equal(seenProd.state, 'warn', 'Cloudflare headers seen, not told, in production: a check');
    check(/TRUST_PROXY=cloudflare/.test(seenProd.detail) && /someone wrote themselves/.test(seenProd.detail) && /nothing to do/.test(seenProd.detail), 'with the advice for Cloudflare in front, and for headers someone sent');
    assert.equal(proxy({ NODE_ENV: 'production', TRUST_PROXY: '1' }, new Date().toISOString()).find((c) => c.id === 'proxy')?.state, 'warn');
    assert.equal(proxy({}, new Date().toISOString()).find((c) => c.id === 'proxy')?.state, 'warn');
    assert.equal(proxy({ NODE_ENV: 'production', TRUST_PROXY: 'cloudflare' }, new Date().toISOString()).find((c) => c.id === 'proxy')?.state, 'warn', 'seen while told: only the lock is missing');
    check(!proxy({ NODE_ENV: 'production', TRUST_PROXY: 'cloudflare' }).some((c) => c.id === 'config-ORIGIN_SECRET'), 'the panel says it once, in its own check, not again as a config line');
    console.log('  P2.2 origin lock: short secrets refused (buildApp and boot); everything but GET /health needs the secret; 403 pinned, no-store, counted, unlogged, gone from the request; unset is unchanged');
  }

  // ---- P2.2: Cloudflare's headers noticed, never believed ----
  {
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
    try {
      const soc = new SocMonitor({ repo: new MemorySocRepository() });
      const app = await buildApp(designs, auth, templates, { rateLimit: true, soc, aiAdminPassword: 'stage two proxy admin', aiUsage: new MemoryAiUsageRepository(), aiEvents: new MemoryAiEventsRepository() });
      app.get('/__s2_ip', async (req) => ({ ip: req.ip }));
      const unlock = { 'x-ai-unlock': mintUnlock('stage two proxy admin') };
      const postureOf = async () => ((await app.inject({ method: 'GET', url: '/api/admin/soc', remoteAddress: '198.18.234.250', headers: unlock })).json() as { posture: { id: string; state: string; detail: string }[] }).posture.find((c) => c.id === 'proxy')!;
      assert.equal((await postureOf()).state, 'good', 'development, nothing in front: fine');
      const r = await app.inject({ method: 'GET', url: '/__s2_ip', remoteAddress: '198.18.234.1', headers: { 'cf-ray': '8f00000000000000-LHR', 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '203.0.113.78' } });
      assert.equal((r.json() as { ip: string }).ip, '198.18.234.1', 'the address is the connection’s, never CF-Connecting-IP or X-Forwarded-For');
      const p = await postureOf();
      assert.equal(p.state, 'warn', 'the posture panel notices Cloudflare');
      check(/TRUST_PROXY=cloudflare/.test(p.detail), 'and says what to set');
      for (let i = 0; i < 5; i++) await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: '198.18.234.2', headers: { 'cf-ray': `x${i}` } });
      assert.equal(warned.filter((w) => /TRUST_PROXY/.test(w)).length, 1, 'said in the log once a minute, not per request');
      // Rate limits are keyed on the connection, whatever CF-Connecting-IP says.
      const one = '198.18.234.3';
      for (let i = 0; i < 300; i++) await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: one, headers: { 'cf-connecting-ip': `203.0.113.${i % 250}` } });
      assert.equal((await app.inject({ method: 'GET', url: '/api/templates', remoteAddress: one, headers: { 'cf-connecting-ip': '192.0.2.1' } })).statusCode, 429, 'a new CF-Connecting-IP is not a new client');
      await app.close();
      // In Cloudflare mode: the hop is believed from Cloudflare's addresses only, and CF-Connecting-IP never.
      const saved = process.env.TRUST_PROXY;
      process.env.TRUST_PROXY = 'cloudflare';
      try {
        const cf = await buildApp(designs, auth, templates, {});
        cf.get('/__s2_ip', async (req) => ({ ip: req.ip }));
        const via = await cf.inject({ method: 'GET', url: '/__s2_ip', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.9, 173.245.48.1', 'cf-connecting-ip': '198.51.100.7', 'cf-ray': 'y' } });
        assert.equal((via.json() as { ip: string }).ip, '203.0.113.9', 'through a Cloudflare edge: the visitor, from X-Forwarded-For');
        const around = await cf.inject({ method: 'GET', url: '/__s2_ip', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.9, 198.18.234.9', 'cf-connecting-ip': '198.51.100.7' } });
        assert.equal((around.json() as { ip: string }).ip, '198.18.234.9', 'around Cloudflare: the address that reached Railway, whatever was written before it');
        await cf.close();
        check(warned.filter((w) => /TRUST_PROXY/.test(w)).length === 1, 'no warning once told');
      } finally {
        if (saved === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = saved;
      }
    } finally {
      console.warn = realWarn;
    }
    // CLOUDFLARE.md: the whole rule set, in an order that never locks the site out.
    const doc = readFileSync('CLOUDFLARE.md', 'utf8');
    for (const must of ['x-origin-secret', 'ORIGIN_SECRET', 'Transform Rule', 'Cache Rule', 'TRUST_PROXY=cloudflare', '/health', 'Bypass']) check(doc.includes(must), `CLOUDFLARE.md covers ${must}`);
    check(doc.indexOf('TRUST_PROXY=cloudflare') < doc.indexOf('ORIGIN_SECRET'), 'TRUST_PROXY first');
    const transform = doc.indexOf('Transform Rule');
    check(transform > 0 && transform < doc.lastIndexOf('ORIGIN_SECRET'), 'the Transform Rule before the secret is set on the server');
    check(!/^TRUST_PROXY=2\s*$/m.test(doc) && !/Cache Everything[^\n]*\b(on|yes)\b/i.test(doc), 'never TRUST_PROXY=2, never Cache Everything');
    console.log('  P2.2 Cloudflare: its headers noticed (log once a minute, posture panel) and never believed; CLOUDFLARE.md complete and in order');
  }
  console.log('performance plan stage 2 (server), part three: all assertions passed');
}

// ---------- 2026-10: performance plan, stage 2 (server), the security review's fixes ----------
// Two should-fix findings and seven nits from the independent review of the
// merged stage 2. Each is checked the way the review found it: a stored hash
// left stale by a writer that did not know it, a cache charged less than it
// holds, a flood of views refusing saves, a security statement recorded once
// and never looked at again.
{
  const { readFileSync } = await import('node:fs');
  const { createHash, randomBytes } = await import('node:crypto');
  const { gunzipSync } = await import('node:zlib');
  const { WorkerPool, PoolBusyError, workerFile, SCENE_POOL, PDF_POOL, SCENE_VIEW_ROOM } = await import('../src/workerPool');
  const { StrippedSceneCache } = await import('../src/sceneCache');
  const { SchemaLedger, schemaStatements, statementBody, SECURITY_STATEMENTS, HASH_STATEMENT_IDS, inForce } = await import('../src/schema');
  const { securityPosture } = await import('../src/posture');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const R4PW = 'harbour-quill-meadow5';
  const r4reg = async (app: FastifyInstance, u: string): Promise<{ token: string; id: string }> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: R4PW, email: `${u}@example.test`, acceptedVersion: 'test' } });
    assert.equal(r.statusCode, 201, r.body);
    const token = (r.json() as { token: string }).token;
    return { token, id: ((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json() as { id: string }).id };
  };
  const png = (n: number): Buffer => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300 + n, n & 0xff)]);
  const LAYER = 'data:image/webp;base64,UjQtT1dORVItTEFZRVI=';
  const sceneGz = (banner: string): Buffer => gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: 'b', text: banner }], layers: [{ id: 'l', src: LAYER }] })));
  const sceneText = (r: { json(): unknown }): string => {
    const b64 = (r.json() as { sceneGzB64: string | null }).sceneGzB64;
    return b64 ? gunzipSync(Buffer.from(b64, 'base64')).toString('utf8') : '(none)';
  };
  const publicDesign = async (app: FastifyInstance, token: string, thumb: Buffer, title = 'R4'): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/api/designs', headers: bearer(token), payload: { title, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGzB64, thumbnailPngB64: thumb.toString('base64') } });
    assert.equal(r.statusCode, 201, r.body);
    const id = (r.json() as { id: string }).id;
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/designs/${id}`, headers: bearer(token), payload: { isPublic: true } })).statusCode, 200);
    return id;
  };
  const inline = (body: string) => ({ url: new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads';\n${body}\nparentPort.postMessage({ ready: true });`)}`) });

  // ---- nit d: every security statement names a catalogue check for what it makes ----
  {
    const statements = schemaStatements(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const squash = (x: string): string => x.replace(/\s+/g, ' ');
    for (const rule of SECURITY_STATEMENTS) {
      const found = statements.filter((s) => rule.match.test(statementBody(s)));
      assert.equal(found.length, 1, `${rule.id}: one statement`);
      const body = statementBody(found[0]);
      const c = rule.check;
      let m: RegExpExecArray | null;
      if ((m = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+)/i.exec(body))) {
        check(c.kind === 'index' && c.name === m[2] && c.unique === !!m[1], `${rule.id}: checked as the ${m[1] ? 'unique ' : ''}index it makes (${JSON.stringify(c)})`);
      } else if ((m = /^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/i.exec(body))) {
        check(c.kind === 'column' && c.table === m[1] && c.column === m[2], `${rule.id}: checked as the column it adds`);
      } else if ((m = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(body))) {
        check(c.kind === 'table' && c.name === m[1], `${rule.id}: checked as the table it makes`);
      } else if ((m = /^CREATE OR REPLACE FUNCTION (\w+)\(/i.exec(body))) {
        check(c.kind === 'function' && c.name === m[1] && squash(body).includes(squash(c.body)), `${rule.id}: checked as the function it makes, by its body`);
      } else if ((m = /CREATE TRIGGER (\w+)\s+BEFORE INSERT OR UPDATE OF ([\w, ]+) ON (\w+) FOR EACH ROW EXECUTE FUNCTION (\w+)\(/i.exec(squash(body)))) {
        const cols = m[2].split(',').map((x) => x.trim());
        check(c.kind === 'trigger' && c.name === m[1] && c.table === m[3] && c.fn === m[4] && cols.includes(c.column), `${rule.id}: checked as the trigger it makes`);
      } else {
        assert.fail(`${rule.id}: a security statement of a shape no catalogue check knows: add one to CatalogueCheck and inForce() (${body.slice(0, 80)})`);
      }
    }
    for (const id of HASH_STATEMENT_IDS) check(SECURITY_STATEMENTS.some((r) => r.id === id), `${id} is a security statement`);
    const src = readFileSync('server/src/schema.ts', 'utf8');
    check(/report\.pendingSecurity = await this\.pendingSecurity\(statements\)/.test(src), 'pendingSecurity is read from the catalogue after the run, not from what threw');
    console.log('  review d: every security statement names its catalogue check (index unique and valid, column, table, function body, enabled trigger)');
  }

  // ---- nit c: views cannot take the places saves need ----
  {
    const p = new WorkerPool<unknown, unknown>({ name: 'room', file: inline(`parentPort.on('message', (m) => setTimeout(() => parentPort.postMessage({ ok: true, result: m }), 40));`), size: 1, maxQueue: SCENE_POOL.maxQueue, timeoutMs: 5_000, idleMs: 1_000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
    const done: string[] = [];
    const track = (tag: string, opts: { room?: number; urgent?: boolean }) =>
      p.run(tag, [], opts).then((v) => { done.push(String(v)); return 'ok'; }, (e: unknown) => (e instanceof PoolBusyError ? 'busy' : 'failed'));
    const views = Array.from({ length: SCENE_VIEW_ROOM + 2 }, (_, i) => track(`view-${i}`, { room: SCENE_VIEW_ROOM }));
    const saves = Array.from({ length: SCENE_POOL.maxQueue - SCENE_VIEW_ROOM + 1 }, (_, i) => track(`save-${i}`, { urgent: true }));
    const vr = await Promise.all(views);
    const sr = await Promise.all(saves);
    assert.equal(vr.filter((x) => x === 'busy').length, 1, `one running and ${SCENE_VIEW_ROOM} waiting views; the next is refused (${vr.join(',')})`);
    assert.deepEqual(sr.slice(0, -1).every((x) => x === 'ok'), true, 'the saves still find room');
    assert.equal(sr[sr.length - 1], 'busy', 'until the whole queue is full');
    assert.deepEqual(done.slice(1, 1 + sr.length - 1), sr.slice(0, -1).map((_, i) => `save-${i}`), `saves run ahead of every waiting view (${done.slice(0, 8).join(',')})`);
    await p.close();
    // Through the routes: a flood of cache-missing anonymous views, and an owner saving.
    const slow = new WorkerPool<unknown, unknown>({ name: 'scene-flood', file: inline(`parentPort.on('message', (m) => setTimeout(() => parentPort.postMessage({ ok: true, result: m.kind === 'check' ? 'ok' : null }), 60));`), size: 1, maxQueue: SCENE_POOL.maxQueue, timeoutMs: 5_000, idleMs: 1_000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { workers: { scene: slow as never }, sceneCache: new StrippedSceneCache() });
    const owner = await r4reg(app, 'flood_r4');
    const ids: string[] = [];
    for (let i = 0; i < SCENE_VIEW_ROOM + 4; i++) {
      const id = await publicDesign(app, owner.token, png(i), `Flood ${i}`);
      await designs.putScene(id, sceneGz(`flood-${i}`));
      ids.push(id);
    }
    const order: string[] = [];
    const viewsDone = ids.map((id) => app.inject({ method: 'GET', url: `/api/designs/${id}/scene` }).then((r) => { order.push('view'); return r.statusCode; }));
    await new Promise((r) => setTimeout(r, 20));
    const save = await app.inject({ method: 'PUT', url: `/api/designs/${ids[0]}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: sceneGz('saved during the flood').toString('base64') } });
    order.push('save');
    const codes = await Promise.all(viewsDone);
    check(codes.filter((c) => c === 503).length >= 1, `the flood is refused past its room (${codes.join(',')})`);
    assert.equal(save.statusCode, 200, `and the owner's save is not (${save.body})`);
    check(order.indexOf('save') < order.lastIndexOf('view'), `the save went ahead of the waiting views (${order.join(',')})`);
    await app.close();
    await slow.close();
    console.log(`  review c: anonymous views take at most ${SCENE_VIEW_ROOM} of the ${SCENE_POOL.maxQueue} places; a save waits ahead of them and is not refused by a flood`);
  }

  // ---- should-fix 2, nit a: exact-size buffers cross, and the cache is charged what it holds ----
  {
    // The cache on its own: a view into a larger buffer is copied out of it.
    const cache = new StrippedSceneCache(1024 * 1024);
    let held = 0;
    for (let i = 0; i < 200; i++) {
      const slab = new Uint8Array(16 * 1024);
      const view = slab.subarray(100, 140);
      cache.set(`d${i}`, `h${i}`, view);
    }
    for (const v of cache.values()) {
      if (!v) continue;
      assert.equal(v.buffer.byteLength, v.byteLength, 'every entry is exact-size');
      held += v.buffer.byteLength;
    }
    check(held <= cache.usedBytes, `the cache counts at least what its entries hold (${cache.usedBytes} counted, ${held} held)`);
    check(cache.usedBytes < 200 * 1024, `and 200 small entries no longer pin 200 slabs (${cache.usedBytes} bytes)`);
    // Through the routes and the real worker: what crosses, both ways.
    const real = new WorkerPool<unknown, unknown>({ ...SCENE_POOL, file: workerFile('sceneWorker'), log: () => {} });
    const realPdf = new WorkerPool<unknown, unknown>({ ...PDF_POOL, file: workerFile('pdfWorker'), log: () => {} });
    const MARK = Buffer.from('R4-OTHER-REQUEST-SECRET');
    const crossed: { kind: string; exact: boolean; handedOver: boolean; foreign: boolean }[] = [];
    const spy = (pool: typeof real, field: 'gz' | 'cells') => ({
      run: (msg: Record<string, Uint8Array>, transfer: import('node:worker_threads').Transferable[] = [], opts?: { room?: number; urgent?: boolean }) => {
        const b = msg[field];
        crossed.push({ kind: String((msg as { kind?: string }).kind ?? field), exact: b.byteOffset === 0 && b.buffer.byteLength === b.byteLength, handedOver: (transfer as unknown[]).includes(b.buffer), foreign: Buffer.from(b.buffer).includes(MARK) });
        return pool.run(msg, transfer, opts);
      },
      close: () => pool.close(),
    });
    const kept = new StrippedSceneCache();
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { workers: { scene: spy(real, 'gz') as never, pdf: spy(realPdf, 'cells') as never }, sceneCache: kept });
    const owner = await r4reg(app, 'exact_r4');
    const id = await publicDesign(app, owner.token, png(3));
    // Another request's bytes, decoded into Node's shared pool just before the save's own.
    const other = Buffer.from(Buffer.concat([MARK, MARK]).toString('base64'), 'base64');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: sceneGz('exact').toString('base64') } })).statusCode, 200);
    check(other.length > 0, 'the other bytes are in use');
    assert.match(sceneText(await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` })), /exact/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/export/pdf', payload: { title: 'x', templateId: DEFAULT_TEMPLATE.id, templateVersion: DEFAULT_TEMPLATE.version, palette: PALETTE, cellsGzB64 } })).statusCode, 200);
    check(crossed.length >= 3, `the save's check, the view's strip and the PDF crossed (${crossed.map((c) => c.kind).join(',')})`);
    for (const c of crossed) {
      check(c.exact, `${c.kind}: an exact-size copy crosses, not a view into a larger buffer`);
      check(c.handedOver, `${c.kind}: handed over, not cloned`);
      check(!c.foreign, `${c.kind}: no other request's bytes cross with it`);
    }
    // What comes back, with layers and without, is exact-size too.
    for (const gz of [sceneGz('back'), gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: 'b' }] })))]) {
      const input = new Uint8Array(gz);
      const out = (await real.run({ kind: 'strip', gz: input }, [input.buffer])) as Uint8Array;
      check(out && out.byteOffset === 0 && out.buffer.byteLength === out.byteLength, `the strip comes back exact-size (${out?.byteLength} of ${out?.buffer.byteLength})`);
    }
    // The reviewer's case: 200 small public scenes viewed once each.
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const d = await designs.create({ title: `Small ${i}`, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: owner.id, thumbnailPng: png(i % 50) });
      await designs.patchMeta(d.id, { isPublic: true });
      await designs.putScene(d.id, sceneGz(`small-${i}`));
      ids.push(d.id);
    }
    for (const sid of ids) assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${sid}/scene` })).statusCode, 200);
    let pinned = 0;
    for (const v of kept.values()) if (v) pinned += v.buffer.byteLength;
    check(kept.size >= 200 && pinned <= kept.usedBytes, `200 kept strips hold ${pinned} bytes and are charged ${kept.usedBytes}`);
    await app.close();
    await real.close();
    await realPdf.close();
    console.log(`  review 2/a: exact-size copies cross both ways, handed over, nothing of another request; 200 small strips held ${pinned} bytes, charged ${kept.usedBytes}`);
  }

  // ---- should-fix 1 (routes): stored hashes are believed only when trusted ----
  {
    const auth = new MemoryAuthRepository();
    /** A store whose hashes can be made stale, as a writer that does not know them would leave them. */
    class StaleDesigns extends MemoryDesignRepository {
      staleThumb = new Map<string, string>();
      staleScene = new Map<string, string>();
      override async getThumbnailMeta(id: string) { const m = await super.getThumbnailMeta(id); return m && this.staleThumb.has(id) ? { ...m, hash: this.staleThumb.get(id)! } : m; }
      override async getThumbnailRow(id: string) { const m = await super.getThumbnailRow(id); return m && this.staleThumb.has(id) ? { ...m, hash: this.staleThumb.get(id)! } : m; }
      override async getSceneMeta(id: string) { const m = await super.getSceneMeta(id); return m && this.staleScene.has(id) ? { ...m, hash: this.staleScene.get(id)! } : m; }
      override async getSceneRow(id: string) { const m = await super.getSceneRow(id); return m && this.staleScene.has(id) ? { ...m, hash: this.staleScene.get(id)! } : m; }
    }
    const designs = new StaleDesigns((id) => auth.usernameOf(id));
    let trusted = true;
    const app = await buildApp(designs, auth, templates, { storedHashesTrusted: () => trusted, sceneCache: new StrippedSceneCache() });
    const owner = await r4reg(app, 'trust_r4');
    const P1 = png(5);
    const id = await publicDesign(app, owner.token, P1);
    await designs.putScene(id, sceneGz('FIRST-BANNER'));
    assert.match(sceneText(await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` })), /FIRST-BANNER/);
    const oldTag = `"${sha(P1)}"`;
    const oldSceneHash = sha(sceneGz('FIRST-BANNER'));
    // New bytes, the old hashes left beside them.
    const P2 = png(6);
    await app.inject({ method: 'PUT', url: `/api/designs/${id}`, headers: bearer(owner.token), payload: { palette: PALETTE, cellsGzB64, thumbnailPngB64: P2.toString('base64') } });
    await designs.putScene(id, sceneGz('SECOND-ONLY'));
    designs.staleThumb.set(id, sha(P1));
    designs.staleScene.set(id, oldSceneHash);
    // What the review found, while the stored hashes are believed:
    assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': oldTag } })).statusCode, 304, '(the stale hash is believed: the bug the triggers close)');
    // Not trusted (the triggers not yet in force, or the recompute not done): the bytes decide.
    trusted = false;
    const t = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': oldTag } });
    assert.equal(t.statusCode, 200, 'untrusted: a replaced picture is sent, not a 304');
    assert.equal(t.headers.etag, `"${sha(P2)}"`, 'with the ETag of its bytes');
    assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': `"${sha(P2)}"` } })).statusCode, 304, 'and a 304 for that one');
    const view = sceneText(await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` }));
    check(/SECOND-ONLY/.test(view) && !/FIRST-BANNER/.test(view) && !view.includes(LAYER), `untrusted: the strip follows the bytes (${view})`);
    await app.close();
    const srv = readFileSync('server/src/server.ts', 'utf8');
    check(/const hashTrust = await hashTrustAfterBoot\(ledger, schemaReport\);\s*let hashesTrusted = hashTrust\.trusted;/.test(srv) && /storedHashesTrusted: \(\) => hashesTrusted/.test(srv), 'server.ts trusts stored hashes only as hashTrustAfterBoot says (triggers in force, recompute done)');
    check(/await pgDesigns\.backfillHashes\(\);\s*await ledger\.mark\(HASH_RECOMPUTE_TASK\);\s*hashesTrusted = true;/.test(srv), 'and marks the recompute done only after it ran');
    console.log('  review 1 (routes): stored hashes believed only when trusted; otherwise the 304 and the kept strip follow the bytes read');
  }

  // ---- nits b, f, g: what the documents and the panel say ----
  {
    const checks = readFileSync('SECURITY-CHECKS.md', 'utf8');
    check(/not a sandbox/.test(checks) && /\/proc\/self\/environ/.test(checks) && /defence in depth/.test(checks), 'SECURITY-CHECKS: env {} is defence in depth; a worker thread is not a sandbox');
    const pool = readFileSync('server/src/workerPool.ts', 'utf8');
    check(/NOT a sandbox/.test(pool) && /\/proc\/self\/environ/.test(pool) && !/so no secret\s+\* \(DATABASE_URL/.test(pool), 'workerPool.ts says the same');
    const seen = securityPosture({ env: { NODE_ENV: 'production' }, nodeVersion: process.version, uid: 1000, rateLimit: true, database: 'postgres', email: null, soc: null, cloudflareSeen: new Date().toISOString() }).find((c) => c.id === 'proxy')!;
    assert.equal(seen.state, 'warn', 'a header anyone can send never turns the row red');
    check(/If Cloudflare is not in front/.test(seen.detail) && /nothing to do/.test(seen.detail), 'and the advice covers spoofed headers');
    const cf = readFileSync('CLOUDFLARE.md', 'utf8');
    const order = cf.slice(cf.indexOf('## The order to do things in'), cf.indexOf('## 1.'));
    check(/legal|privacy policy/i.test(order) && order.search(/privacy policy/i) < order.search(/orange cloud on/i), 'CLOUDFLARE.md: naming Cloudflare in the privacy policy is a step, before the orange cloud');
    check(cf.includes('Cloudflare sits in front of the site as a content delivery and security network') && cf.includes('تمرّ كل الطلبات إلى الموقع عبر Cloudflare'), 'with the exact sentences, in English and Arabic');
    check(!readFileSync('legal.html', 'utf8').includes('Cloudflare sits in front'), 'and legal.html is not changed while Cloudflare is not in front');
    console.log('  review b/f/g: worker threads described as no sandbox; spoofable Cloudflare headers a check with both answers; the privacy-policy step with its sentences');
  }

  // ---- should-fix 1 (Postgres): the database keeps the hashes for every writer ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { PgAuthRepository, PgDesignRepository } = await import('../src/pgRepo');
    const name = `s2_review_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA ${name}`);
    const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, options: `-c search_path=${name}` });
    const statements = schemaStatements(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    try {
      const ledger = new SchemaLedger(p, { log: () => {} });
      await ledger.load();
      const first = await ledger.applyAll(statements);
      assert.deepEqual(first.failed, []);
      assert.deepEqual(first.pendingSecurity, [], 'the hash triggers are in force after a first boot');
      const pDesigns = new PgDesignRepository(p, p);
      const pAuth = new PgAuthRepository(p, p);
      const app = await buildApp(pDesigns, pAuth, templates, { sceneCache: new StrippedSceneCache() });
      const owner = await r4reg(app, 'pgrev_r4');
      const P1 = png(11);
      const id = await publicDesign(app, owner.token, P1);
      assert.equal((await app.inject({ method: 'PUT', url: `/api/designs/${id}/scene`, headers: bearer(owner.token), payload: { sceneGzB64: sceneGz('FIRST-BANNER').toString('base64') } })).statusCode, 200);
      const t1 = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png` });
      assert.equal(t1.headers.etag, `"${sha(P1)}"`);
      assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': `"${sha(P1)}"` } })).statusCode, 304);
      assert.match(sceneText(await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` })), /FIRST-BANNER/, 'the first scene is kept stripped');
      // The previous release's writes, as it ran them: bytes, and no hash.
      const P2 = png(12);
      const S2 = sceneGz('SECOND-ONLY');
      await p.query('UPDATE designs SET thumbnail = coalesce($2, thumbnail), updated_at = now() WHERE id = $1', [id, P2]);
      await p.query(`INSERT INTO design_scenes (design_id, scene, updated_at) VALUES ($1, $2, now())
                     ON CONFLICT (design_id) DO UPDATE SET scene = EXCLUDED.scene, updated_at = now()`, [id, S2]);
      const row = await p.query('SELECT d.thumbnail_hash AS t, s.scene_hash AS s FROM designs d JOIN design_scenes s ON s.design_id = d.id WHERE d.id = $1', [id]);
      assert.equal(row.rows[0].t, sha(P2), 'Postgres: the picture written the old way has the hash of its bytes');
      assert.equal(row.rows[0].s, sha(S2), 'Postgres: and so has the scene');
      const stale = await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': `"${sha(P1)}"` } });
      assert.equal(stale.statusCode, 200, 'Postgres: the old ETag gets the new picture, not a 304');
      assert.equal(stale.headers.etag, `"${sha(P2)}"`);
      assert.deepEqual(stale.rawPayload, P2);
      assert.equal((await app.inject({ method: 'GET', url: `/api/designs/${id}/thumbnail.png`, headers: { 'if-none-match': `"${sha(P2)}"` } })).statusCode, 304, 'Postgres: and the new ETag its 304');
      const view = sceneText(await app.inject({ method: 'GET', url: `/api/designs/${id}/scene` }));
      check(/SECOND-ONLY/.test(view) && !/FIRST-BANNER/.test(view) && !view.includes(LAYER), `Postgres: anonymous viewers see the scene as now stored, not the kept strip of the old one (${view})`);
      // An old-style insert, and a write of a wrong hash: both put right.
      const ins = await p.query(`INSERT INTO designs (title, template_id, template_version, palette, cells, owner_id, thumbnail)
                                 SELECT 'old insert', template_id, template_version, palette, cells, owner_id, $2 FROM designs WHERE id = $1 RETURNING thumbnail_hash`, [id, P1]);
      assert.equal(ins.rows[0].thumbnail_hash, sha(P1), 'Postgres: an insert that names no hash gets one');
      await p.query("UPDATE designs SET thumbnail_hash = 'deadbeef' WHERE id = $1", [id]);
      assert.equal((await p.query('SELECT thumbnail_hash FROM designs WHERE id = $1', [id])).rows[0].thumbnail_hash, sha(P2), 'Postgres: a hash written by hand is replaced by the real one');
      await app.close();

      // The triggers are security statements: a disabled or dropped one is pending, and put back.
      await p.query('ALTER TABLE designs DISABLE TRIGGER designs_thumbnail_hash');
      const l2 = new SchemaLedger(p, { log: () => {} });
      await l2.load();
      assert.deepEqual((await l2.pendingSecurity(statements)).map((x) => x.id), ['thumbnail-hash'], 'Postgres: a disabled hash trigger is not in force');
      const posture = securityPosture({ env: {}, nodeVersion: process.version, uid: 1000, rateLimit: true, database: 'postgres', email: null, soc: null, schema: { pendingSecurity: await l2.pendingSecurity(statements), failed: 0 } });
      assert.equal(posture.find((c) => c.id === 'schema')?.state, 'bad', 'Postgres: and the panel says fix');
      const r2 = await l2.applyAll(statements);
      assert.equal(r2.applied, 1, 'Postgres: the next boot runs the recorded trigger statement again');
      assert.deepEqual(r2.pendingSecurity, []);
      assert.equal((await p.query("SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE t.tgname = 'designs_thumbnail_hash' AND n.nspname = current_schema()")).rows[0].tgenabled, 'O', 'Postgres: enabled again');
      await p.query('DROP FUNCTION tifo_scene_hash() CASCADE');
      const l3 = new SchemaLedger(p, { log: () => {} });
      await l3.load();
      const r3 = await l3.applyAll(statements);
      assert.equal(r3.applied, 2, 'Postgres: a dropped function and the trigger it took with it are both made again');
      assert.deepEqual(r3.pendingSecurity, []);
      check(await inForce(p, { kind: 'trigger', table: 'design_scenes', name: 'design_scenes_scene_hash', fn: 'tifo_scene_hash', column: 'scene' }), 'Postgres: the scene trigger is in force');

      // An index that ran cleanly but is not in force: invalid, or not unique, under the right name.
      await p.query('DROP INDEX users_username_lower_idx');
      const dupe = await p.query("INSERT INTO users (username, password_hash) VALUES ('Dupe_R4', 'x'), ('dupe_r4', 'x') RETURNING id");
      await p.query('CREATE UNIQUE INDEX CONCURRENTLY users_username_lower_idx ON users (lower(username))').catch(() => {});
      assert.equal((await p.query("SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'users_username_lower_idx' AND n.nspname = current_schema()")).rows[0]?.indisvalid, false, '(an invalid index under the right name)');
      const l4 = new SchemaLedger(p, { log: () => {} });
      await l4.load();
      const r4 = await l4.applyAll(statements);
      assert.deepEqual(r4.failed, [], 'Postgres: CREATE UNIQUE INDEX IF NOT EXISTS runs without an error');
      assert.deepEqual(r4.pendingSecurity.map((x) => x.id), ['username-unique-ci'], 'Postgres: but it is reported as not in force');
      await p.query('DROP INDEX users_username_lower_idx');
      await p.query('CREATE INDEX users_username_lower_idx ON users (lower(username))');
      assert.deepEqual((await l4.pendingSecurity(statements)).map((x) => x.id), ['username-unique-ci'], 'Postgres: nor is one that is not unique');
      await p.query('DROP INDEX users_username_lower_idx');
      await p.query('DELETE FROM users WHERE id = ANY ($1::uuid[])', [dupe.rows.map((r) => r.id)]);
      assert.deepEqual((await l4.applyAll(statements)).pendingSecurity, [], 'Postgres: put right at the next boot');

      // Hashes left stale before the triggers existed are recomputed once, and that is recorded.
      await p.query('ALTER TABLE designs DISABLE TRIGGER designs_thumbnail_hash; ALTER TABLE design_scenes DISABLE TRIGGER design_scenes_scene_hash');
      await p.query("UPDATE designs SET thumbnail_hash = 'stale' WHERE thumbnail IS NOT NULL");
      await p.query("UPDATE design_scenes SET scene_hash = NULL");
      await p.query('ALTER TABLE designs ENABLE TRIGGER designs_thumbnail_hash; ALTER TABLE design_scenes ENABLE TRIGGER design_scenes_scene_hash');
      const staleRows = (await p.query("SELECT count(*)::int AS n FROM designs WHERE thumbnail_hash = 'stale'")).rows[0].n + (await p.query('SELECT count(*)::int AS n FROM design_scenes WHERE scene_hash IS NULL')).rows[0].n;
      check(staleRows >= 2, `(${staleRows} rows left stale)`);
      const l5 = new SchemaLedger(p, { log: () => {} });
      await l5.load();
      check(!l5.has('content-hashes-recomputed-v1'), 'Postgres: not recorded as done yet');
      assert.equal(await pDesigns.backfillHashes(), staleRows, 'Postgres: the recompute corrects every stale or missing hash, and nothing else');
      const wrong = (await p.query("SELECT count(*)::int AS n FROM designs WHERE thumbnail_hash IS DISTINCT FROM CASE WHEN thumbnail IS NULL THEN NULL ELSE encode(sha256(thumbnail), 'hex') END")).rows[0].n
        + (await p.query("SELECT count(*)::int AS n FROM design_scenes WHERE scene_hash IS DISTINCT FROM encode(sha256(scene), 'hex')")).rows[0].n;
      assert.equal(wrong, 0, 'Postgres: every hash matches its bytes');
      await l5.mark('content-hashes-recomputed-v1');
      const l6 = new SchemaLedger(p, { log: () => {} });
      await l6.load();
      check(l6.has('content-hashes-recomputed-v1'), 'Postgres: recorded in the ledger for the next boot');
      assert.equal(await pDesigns.backfillHashes(), 0, 'Postgres: a second recompute finds nothing to do');
      console.log('  review 1 (Postgres): triggers keep both hashes for old-style writes (hash, 304 and strip follow); disabled or dropped ones pending and put back; an invalid or non-unique security index pending; one recompute, recorded');
    } finally {
      await p.end();
      await admin.query(`DROP SCHEMA ${name} CASCADE`).catch(() => {});
      await admin.end();
    }
  }
  console.log('performance plan stage 2 (server), the security review: all assertions passed');
}

// ---------- 2026-10: performance plan, stage 2 (server), the review's second pass ----------
// A forged header must never make the posture panel kinder; a waiting task
// must never wait for ever; a trigger that does not fire is not in force, and
// a boot that had to put one back recomputes the hashes before trusting them.
{
  const { readFileSync } = await import('node:fs');
  const { randomBytes, createHash } = await import('node:crypto');
  const { securityPosture } = await import('../src/posture');
  const { WorkerPool, PoolBusyError, SCENE_POOL, PDF_POOL, SCENE_VIEW_ROOM, DEFAULT_MAX_WAIT_MS } = await import('../src/workerPool');
  const { StrippedSceneCache } = await import('../src/sceneCache');
  const { SchemaLedger, schemaStatements, SECURITY_STATEMENTS, inForce, hashTrustAfterBoot, HASH_RECOMPUTE_TASK } = await import('../src/schema');
  const check = (cond: unknown, msg: string): void => assert.ok(cond, msg);
  const inline = (body: string) => ({ url: new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads';\n${body}\nparentPort.postMessage({ ready: true });`)}`) });

  // ---- the posture panel: Cloudflare's headers can only make the verdict worse ----
  {
    const SECRET = 'o'.repeat(40);
    const rank = { good: 0, info: 1, warn: 2, bad: 3 } as const;
    const proxyRow = (env: Record<string, string>, seen: boolean) =>
      securityPosture({ env, nodeVersion: process.version, uid: 1000, rateLimit: true, database: 'postgres', email: null, soc: null, schema: null, cloudflareSeen: seen ? '2026-10-24T10:00:00.000Z' : null }).find((c) => c.id === 'proxy')!;
    const table: [string, Record<string, string>, string, string][] = [
      ['unset', { NODE_ENV: 'production' }, 'good', 'warn'],
      ['1', { NODE_ENV: 'production', TRUST_PROXY: '1' }, 'good', 'warn'],
      ['2', { NODE_ENV: 'production', TRUST_PROXY: '2' }, 'bad', 'bad'],
      ['5', { NODE_ENV: 'production', TRUST_PROXY: '5' }, 'bad', 'bad'],
      ['0', { NODE_ENV: 'production', TRUST_PROXY: '0' }, 'warn', 'warn'],
      ['cloudflare, no secret', { NODE_ENV: 'production', TRUST_PROXY: 'cloudflare' }, 'warn', 'warn'],
      ['cloudflare, locked', { NODE_ENV: 'production', TRUST_PROXY: 'cloudflare', ORIGIN_SECRET: SECRET }, 'good', 'good'],
      ['unset, development', {}, 'good', 'warn'],
    ];
    for (const [label, env, without, withCf] of table) {
      const a = proxyRow(env, false);
      const b = proxyRow(env, true);
      assert.equal(a.state, without, `TRUST_PROXY ${label}, no Cloudflare headers: ${a.state}`);
      assert.equal(b.state, withCf, `TRUST_PROXY ${label}, Cloudflare headers seen: ${b.state}`);
      check(rank[b.state as keyof typeof rank] >= rank[a.state as keyof typeof rank], `${label}: a request's headers never make the verdict kinder`);
      if (env.TRUST_PROXY === 'cloudflare') {
        assert.equal(b.detail, a.detail, `${label}: in Cloudflare mode the headers are expected and change nothing`);
      } else {
        check(/someone wrote themselves/.test(b.detail) && /TRUST_PROXY=cloudflare/.test(b.detail), `${label}: the Cloudflare advice is added`);
        if (a.state !== 'good') check(b.detail.startsWith(a.detail), `${label}: after the verdict's own explanation, which is kept (${b.detail.slice(0, 60)})`);
      }
    }
    check(/^Trusting 2 hops whoever wrote them/.test(proxyRow({ NODE_ENV: 'production', TRUST_PROXY: '2' }, true).detail), 'TRUST_PROXY=2 with Cloudflare headers still says why it is a fix, first');
    console.log('  review 2nd pass, posture: the TRUST_PROXY verdict is the worse of its own and the Cloudflare check; a fix keeps its explanation');
  }

  // ---- no task waits in a queue for ever ----
  {
    check(SCENE_POOL.maxWaitMs! > 0 && SCENE_POOL.maxWaitMs! <= 10_000 && PDF_POOL.maxWaitMs! > 0 && PDF_POOL.maxWaitMs! <= 20_000 && DEFAULT_MAX_WAIT_MS <= 10_000, 'both pools, and any pool naming none, have a limit on waiting');
    const body = `parentPort.on('message', (m) => setTimeout(() => parentPort.postMessage({ ok: true, result: m.tag }), m.ms));`;
    const p = new WorkerPool<{ tag: string; ms: number }, string>({ name: 'wait', file: inline(body), size: 1, maxQueue: 16, timeoutMs: 5_000, maxWaitMs: 300, idleMs: 1_000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
    const outcome = (x: Promise<string>, t0: number) => x.then((v) => `ran ${v}`, (e: unknown) => (e instanceof PoolBusyError ? `refused after ${Date.now() - t0} ms` : 'failed'));
    let t0 = Date.now();
    const long = outcome(p.run({ tag: 'long', ms: 1_000 }), t0);
    const queued = [outcome(p.run({ tag: 'q1', ms: 10 }), t0), outcome(p.run({ tag: 'q2', ms: 10 }, [], { urgent: true }), t0), outcome(p.run({ tag: 'q3', ms: 10 }, [], { room: SCENE_VIEW_ROOM }), t0)];
    const q = await Promise.all(queued);
    for (const r of q) check(/^refused after (\d+) ms$/.test(r) && Number(/\d+/.exec(r)![0]) < 900, `a task not started in time is refused, view, save or other (${r})`);
    assert.equal(await long, 'ran long', 'the running task is not touched');
    assert.equal(p.stats.expired, 3);
    // The review's case: a view queued behind a steady stream of saves.
    let stop = false;
    t0 = Date.now();
    void outcome(p.run({ tag: 'busy', ms: 50 }), t0);
    const view = outcome(p.run({ tag: 'V', ms: 5 }, [], { room: SCENE_VIEW_ROOM }), t0);
    const feeder = (async () => { while (!stop) { void p.run({ tag: 's', ms: 50 }, [], { urgent: true }).catch(() => {}); await new Promise((r) => setTimeout(r, 40)); } })();
    const waited = await Promise.race([view, new Promise<string>((r) => setTimeout(() => r('still waiting after 3000 ms'), 3_000))]);
    stop = true;
    await feeder;
    check(/^refused after/.test(waited), `a view behind a steady stream of saves gets an answer, not a hang (${waited})`);
    await p.close();
    // Through the routes: the request is answered 503 retry.
    const slow = new WorkerPool<unknown, unknown>({ name: 'scene-wait', file: inline(`parentPort.on('message', () => setTimeout(() => parentPort.postMessage({ ok: true, result: null }), 1_500));`), size: 1, maxQueue: 16, timeoutMs: 5_000, maxWaitMs: 200, idleMs: 1_000, resourceLimits: { maxOldGenerationSizeMb: 32 }, log: () => {} });
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    const app = await buildApp(designs, auth, templates, { workers: { scene: slow as never }, sceneCache: new StrippedSceneCache() });
    const mk = async (n: number) => {
      const d = await designs.create({ title: `Wait ${n}`, templateId: DEFAULT_TEMPLATE.id, templateVersion: 1, palette: PALETTE, cellsGz: gzipSync(new Uint8Array(map.count)), ownerId: null as unknown as string, thumbnailPng: null as never });
      await designs.patchMeta(d.id, { isPublic: true });
      await designs.putScene(d.id, gzipSync(Buffer.from(JSON.stringify({ v: 1, banners: [{ id: `w${n}` }] }))));
      return d.id;
    };
    const [a, b] = [await mk(1), await mk(2)];
    const first = app.inject({ method: 'GET', url: `/api/designs/${a}/scene` });
    await new Promise((r) => setTimeout(r, 30));
    const t1 = Date.now();
    const second = await app.inject({ method: 'GET', url: `/api/designs/${b}/scene` });
    assert.equal(second.statusCode, 503, `a view that could not start in time is answered (${second.statusCode})`);
    assert.equal((second.json() as { code: string }).code, 'retry');
    check(Date.now() - t1 < 1_200, `within the wait limit, not after the task ahead (${Date.now() - t1} ms)`);
    assert.equal((await first).statusCode, 200);
    await app.close();
    await slow.close();
    console.log('  review 2nd pass, queue: a task not started within its pool\'s wait limit is refused (503 retry), views and saves alike');
  }

  // ---- a trigger that does not fire is not in force; putting one back means recomputing ----
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const name = `s2_review2_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA ${name}`);
    const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, options: `-c search_path=${name}` });
    const statements = schemaStatements(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const rule = SECURITY_STATEMENTS.find((r) => r.id === 'thumbnail-hash')!;
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
    try {
      const boot = async () => {
        const l = new SchemaLedger(p, { log: () => {} });
        await l.load();
        return { l, rep: await l.applyAll(statements) };
      };
      const b0 = await boot();
      check(b0.rep.ran.includes('thumbnail-hash') && b0.rep.ran.includes('scene-hash'), 'Postgres: a first boot reports the hash statements it ran');
      const t0 = await hashTrustAfterBoot(b0.l, b0.rep);
      assert.deepEqual(t0, { inForce: true, trusted: false, recompute: true }, 'Postgres: the first boot with the triggers recomputes before trusting');
      await b0.l.mark(HASH_RECOMPUTE_TASK);
      const b1 = await boot();
      assert.deepEqual(b1.rep.ran, [], 'Postgres: a boot with nothing to do runs no security statement');
      assert.deepEqual(await hashTrustAfterBoot(b1.l, b1.rep), { inForce: true, trusted: true, recompute: false }, 'Postgres: and trusts the hashes at once');
      // A replica-only trigger does not fire for the server's writes.
      await p.query("INSERT INTO users (username, password_hash) VALUES ('rep_owner', 'x')");
      const row = await p.query("INSERT INTO designs (title, template_id, template_version, palette, cells, thumbnail) VALUES ('R', 'x', 1, '[]'::jsonb, '\\x00', '\\x0102') RETURNING id");
      const id = row.rows[0].id as string;
      await p.query('ALTER TABLE designs ENABLE REPLICA TRIGGER designs_thumbnail_hash');
      await p.query("UPDATE designs SET thumbnail = '\\x0304' WHERE id = $1", [id]);
      const after = (await p.query('SELECT thumbnail_hash FROM designs WHERE id = $1', [id])).rows[0].thumbnail_hash;
      check(after !== sha(Buffer.from([3, 4])), '(a replica-only trigger did not fire: the hash went stale)');
      check(!(await inForce(p, rule.check)), 'Postgres: so it is not in force');
      assert.deepEqual((await new SchemaLedger(p, { log: () => {} }).pendingSecurity(statements)).map((x) => x.id), ['thumbnail-hash'], 'Postgres: and reads as pending');
      await p.query('ALTER TABLE designs ENABLE ALWAYS TRIGGER designs_thumbnail_hash');
      check(await inForce(p, rule.check), "Postgres: an ENABLE ALWAYS trigger fires everywhere, and counts");
      await p.query('ALTER TABLE designs ENABLE REPLICA TRIGGER designs_thumbnail_hash');
      // The next boot puts it back, and does not trust the hashes until they are recomputed.
      const b2 = await boot();
      check(b2.rep.ran.includes('thumbnail-hash') && b2.rep.pendingSecurity.length === 0, `Postgres: the boot makes it again (${b2.rep.ran.join(',')})`);
      const t2 = await hashTrustAfterBoot(b2.l, b2.rep);
      assert.deepEqual(t2, { inForce: true, trusted: false, recompute: true }, 'Postgres: rows written meanwhile may be stale, so the recompute runs again first');
      check(!b2.l.has(HASH_RECOMPUTE_TASK), 'Postgres: the record of the old recompute is gone');
      const fresh = new SchemaLedger(p, { log: () => {} });
      await fresh.load();
      check(!fresh.has(HASH_RECOMPUTE_TASK), 'Postgres: for the next boot too, until the recompute has run');
      const { PgDesignRepository } = await import('../src/pgRepo');
      check((await new PgDesignRepository(p, p).backfillHashes()) >= 1, 'Postgres: the recompute finds the stale hash');
      assert.equal((await p.query('SELECT thumbnail_hash FROM designs WHERE id = $1', [id])).rows[0].thumbnail_hash, sha(Buffer.from([3, 4])), 'Postgres: and corrects it');
      await b2.l.mark(HASH_RECOMPUTE_TASK);
      const b3 = await boot();
      assert.deepEqual(await hashTrustAfterBoot(b3.l, b3.rep), { inForce: true, trusted: true, recompute: false }, 'Postgres: then the hashes are trusted again');
      // A dropped function counts the same way.
      await p.query('DROP FUNCTION tifo_scene_hash() CASCADE');
      const b4 = await boot();
      check(b4.rep.ran.includes('scene-hash-fn') && b4.rep.ran.includes('scene-hash'), 'Postgres: function and trigger made again');
      assert.equal((await hashTrustAfterBoot(b4.l, b4.rep)).recompute, true, 'Postgres: and the recompute runs again');
      console.log('  review 2nd pass, Postgres: a replica-only or disabled trigger is not in force; a boot that puts one back recomputes before trusting stored hashes');
    } finally {
      await p.end();
      await admin.query(`DROP SCHEMA ${name} CASCADE`).catch(() => {});
      await admin.end();
    }
  }
  console.log('performance plan stage 2 (server), the review\'s second pass: all assertions passed');
}
