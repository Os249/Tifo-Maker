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

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
const cellsGzB64 = gzipSync(new Uint8Array(map.count)).toString('base64');
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function reg(app: FastifyInstance, u: string): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'password1234', email: `${u}@example.test`, acceptedVersion: 'test' } });
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
  const app = await buildApp(designs, auth, templates, { staticDir: process.cwd(), adminUsernames: ['admin'] });

  // 1. CRITICAL was: usernames are unique case-SENSITIVELY, but the admin
  //    allow-list matched case-INSENSITIVELY, so "Admin" registered beside the
  //    real "admin" and inherited moderator in one unauthenticated request.
  await reg(app, 'admin');
  const lookalike = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'Admin', password: 'password1234', email: 'evil@example.test', acceptedVersion: 'test' } });
  assert.equal(lookalike.statusCode, 409, 'a username that case-folds onto an admin name is refused');
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
  const known = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'titler', password: 'password1234', email: 'titler@example.test', acceptedVersion: 'test' } });
  const unknown = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'titler', password: 'password1234', email: 'nobody@example.test', acceptedVersion: 'test' } });
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
  await mailApp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'mailer', password: 'password1234', email: 'mailer@example.test', acceptedVersion: 'test' } });
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
  const fresh = await hashPassword('password1234');
  assert.match(fresh, /^s2:\d+:\d+:\d+:[0-9a-f]{32}:[0-9a-f]{64}$/, 'a new hash records the parameters it was made with');
  assert.ok(SCRYPT_PARAMS.N >= 65536, 'scrypt N is at or above the raised floor');
  assert.equal((await verifyPassword('password1234', fresh)).ok, true);
  assert.equal((await verifyPassword('wrong', fresh)).ok, false);
  assert.equal((await verifyPassword('password1234', fresh)).needsRehash, false, 'a current hash does not need rehashing');

  // A hash in the old unprefixed form still verifies — nobody is locked out —
  // and is flagged for upgrade.
  const legacySalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const legacy = `${legacySalt.toString('hex')}:${scryptSync('password1234', legacySalt, 32).toString('hex')}`;
  const legacyCheck = await verifyPassword('password1234', legacy);
  assert.equal(legacyCheck.ok, true, 'an old hash still verifies');
  assert.equal(legacyCheck.needsRehash, true, 'and is marked for upgrade');
  assert.equal((await verifyPassword('wrong', legacy)).needsRehash, false, 'a wrong password never triggers a rehash');

  // And the upgrade actually happens, on the one occasion the password is in
  // the clear: a successful sign-in.
  const bob = await reg(app, 'rehash_bob');
  await auth.setPasswordHash(bob.id, legacy);
  assert.equal((await auth.getUserById(bob.id))!.passwordHash, legacy);
  const relog = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'rehash_bob', password: 'password1234' } });
  assert.equal(relog.statusCode, 200, 'the old password still signs in');
  const after = (await auth.getUserById(bob.id))!.passwordHash;
  assert.ok(after.startsWith('s2:'), 'and the stored hash was upgraded in place');
  assert.equal((await verifyPassword('password1234', after)).ok, true, 'the upgraded hash still matches the same password');

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
    ['AI_ADMIN_PASSWORD', 'PUBLIC_URL', 'RESEND_API_KEY', 'SECURITY_ALERT_TO', 'TRUST_PROXY'],
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
      statuses.push((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(attacker.token), payload: { email: target } })).statusCode);
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
      probes.push((await app.inject({ method: 'POST', url: '/api/account/email', headers: bearer(prober.token), payload: { email: 'listed@example.test' } })).statusCode);
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

  await app.close();
  console.log('audit round three: all assertions passed (PDF title DoS, 500 bodies, tokens in logs + console mail, reset timing + mail bomb, change-email mail bomb + lookup cost, code-guess cap, photo metadata, $& injection, feedback mailto, local escapers, AI budget, Cloudflare hop trust, asset caching, inline scripts)');
}
