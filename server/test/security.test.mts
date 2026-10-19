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

      // ...until a password is set. No current password is asked for, because
      // there is none — the bearer token has already proved who is asking.
      const setFirst = await gApp.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: bearer(newcomerToken),
        payload: { newPassword: 'quartz-lantern-echo7' },
      });
      assert.equal(setFirst.statusCode, 200, 'a Google account can set its first password without confirming one');
      const afterSet = (setFirst.json() as { token: string }).token;
      const nowUnlink = await gApp.inject({ method: 'DELETE', url: '/api/account/link/google', headers: bearer(afterSet) });
      assert.equal(nowUnlink.statusCode, 200, 'with a password in place, the link can go');
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
      assert.ok(!/gemini|HTTP|503|high demand|AIza/i.test(r.body), `nothing of the provider's reply reaches the editor: ${r.body}`);
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
      assert.equal((await papp.inject({ method: 'DELETE', url: '/api/account', headers: bearer(x.token) })).statusCode, 204);
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
