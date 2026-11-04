/**
 * Club kits and the credit line on the account (server/src/kitRoutes.ts,
 * kitRepo.ts): the routes, and what an attacker tries against them.
 *
 * Adversarial, like security.test.mts: it reads and writes without a session,
 * as an account Pro is not on for, and with PRO_MODE off; it sends logos that
 * are not PNGs, PNGs that are too large in bytes and in pixels, PNGs carrying
 * metadata, five logos, a body over the limit, names with direction overrides
 * and controls, colours that are not colours, and kit ids that are paths; it
 * reads another account's logo by its hash and names it in its own kit; it
 * races six new kits at an account that may hold three. Runs on the memory
 * stores, and the store promises again on Postgres when DATABASE_URL is set
 * (schema.sql applied).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { CREDIT_MAX, KIT_LOGO_MAX_BYTES, KIT_NAME_MAX, MAX_KITS, cleanColours, cleanCredit, cleanName } from '../../src/core/kitRules';
import { MemoryAuthRepository, MemoryDesignRepository } from '../src/memoryRepo';
import { buildApp, type TemplateInfo } from '../src/routes';
import { MemoryProRepository } from '../src/proRepo';
import { MemoryKitRepository, PgKitRepository, type KitRepository, type NewLogo } from '../src/kitRepo';
import { KIT_BODY_LIMIT } from '../src/kitRoutes';

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
/** A real PNG (w x h, RGBA). `noise` makes it incompressible; `text` adds a tEXt chunk. */
function png(w = 4, h = 4, opts: { noise?: boolean; text?: string; seed?: number } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4), (opts.seed ?? 0x7f) & 0xff);
  let x = opts.seed ?? 1;
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    if (opts.noise) for (let i = 1; i <= w * 4; i++) raw[y * (1 + w * 4) + i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(opts.text ? [chunk('tEXt', Buffer.from(`Comment\0${opts.text}`, 'latin1'))] : []),
    chunk('IDAT', deflateSync(raw, { level: opts.noise ? 0 : 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const b64 = (b: Buffer) => b.toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

async function reg(app: FastifyInstance, u: string): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'quartz-lantern-echo7', email: `${u}@example.test`, acceptedVersion: 'test' } });
  assert.equal(r.statusCode < 300, true, `register ${u}: ${r.body}`);
  const token = (r.json() as { token: string }).token;
  const id = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(token) })).json().id as string;
  return { token, id };
}

async function appWith(env: Record<string, string | undefined>, kits: KitRepository = new MemoryKitRepository()): Promise<{ app: FastifyInstance; restore: () => void; kits: KitRepository }> {
  const restore = setEnv(env);
  const auth = new MemoryAuthRepository();
  const app = await buildApp(new MemoryDesignRepository((id) => auth.usernameOf(id)), auth, templates, { pro: new MemoryProRepository(), kits });
  return { app, restore, kits };
}

const KIT = (over: Record<string, unknown> = {}) => ({ name: 'Blue Wave', colours: ['#1c5fd9', '#f2f1ec'], font: 'condensed', at: 1000, logos: [], ...over });

// ------------------------------------------------------------ the rules ---
{
  assert.equal(cleanName('  Blue‮ Wave \u0000\n FC  '), 'Blue Wave FC', 'controls and a direction override go; spaces fold');
  assert.equal(Array.from(cleanName('ن'.repeat(80))).length, KIT_NAME_MAX, 'a name is at most 40 characters, Arabic counted by letter');
  assert.deepEqual(cleanColours(['#1C5FD9', '#1c5fd9', 'red', '#12345', '#abcdef', 7, null]), ['#1c5fd9', '#abcdef'], 'colours: #rrggbb, lower-cased, once each');
  assert.equal(cleanCredit('  @os99 ‮<b>  '), '@os99 b', 'a credit line: one line, no override, no angle brackets');
  assert.equal(Array.from(cleanCredit('ألتراس '.repeat(10))).length <= CREDIT_MAX, true, 'at most 32 characters');
  assert.equal(cleanCredit(42), '', 'only text');
  console.log('kits.test: the shared rules hold');
}

// ------------------------------------------------- who may use the routes ---
{
  const { app, restore } = await appWith({ PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'kit_fan' });
  try {
    const fan = await reg(app, 'kit_fan');
    const other = await reg(app, 'kit_other');
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/pro/kits'],
      ['PUT', '/api/pro/kits/kabcdefgh1', KIT()],
      ['DELETE', '/api/pro/kits/kabcdefgh1'],
      ['GET', `/api/pro/kits/logos/${'a'.repeat(64)}`],
      ['GET', '/api/pro/credit'],
      ['PUT', '/api/pro/credit', { credit: '@me' }],
    ];
    for (const [method, url, payload] of routes) {
      const anon = await app.inject({ method: method as 'GET', url, ...(payload ? { payload: payload as object } : {}) });
      assert.equal(anon.statusCode, 401, `${method} ${url} signed out: 401 (${anon.body})`);
      const off = await app.inject({ method: method as 'GET', url, headers: bearer(other.token), ...(payload ? { payload: payload as object } : {}) });
      assert.equal(off.statusCode, 404, `${method} ${url} for an account Pro is not on for: 404, as if there were nothing here`);
      assert.deepEqual(off.json(), { error: 'not found' }, 'and nothing else said');
    }
    const list = await app.inject({ method: 'GET', url: '/api/pro/kits', headers: bearer(fan.token) });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { kits: [] }, 'an account on the list starts with none');
    assert.equal(list.headers['cache-control'], 'no-store', 'one person’s kits are never kept by a shared cache');
    console.log('kits.test: signed out 401, not on the list 404, on the list an empty list');
  } finally {
    restore();
  }
  // PRO_MODE off: nothing, even for a name on the list.
  const off = await appWith({ PRO_MODE: 'off', PRO_PREVIEW_USERS: 'kit_fan' });
  try {
    const fan = await reg(off.app, 'kit_fan');
    for (const url of ['/api/pro/kits', '/api/pro/credit']) {
      assert.equal((await off.app.inject({ method: 'GET', url, headers: bearer(fan.token) })).statusCode, 404, `${url} with Pro off: 404`);
    }
    console.log('kits.test: PRO_MODE off answers 404 to everyone');
  } finally {
    off.restore();
  }
}

// --------------------------------------------- saving, reading, deleting ---
{
  const { app, restore } = await appWith({ PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'kit_a,kit_b' });
  try {
    const a = await reg(app, 'kit_a');
    const b = await reg(app, 'kit_b');
    const put = (tok: string, id: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/pro/kits/${id}`, headers: bearer(tok), payload: body as object });

    // A kit with a crest that carries metadata: kept without it, under the hash of what is kept.
    const crest = png(64, 48, { text: 'GPS 24.7136 46.6753, Riyadh' });
    const r1 = await put(a.token, 'kblue00001', KIT({
      name: ' Blue‮ Wave\u0007 ', colours: ['#1C5FD9', 'not-a-colour', '#1c5fd9', '#F2F1EC'], font: 'no-such-font', at: 1234.9, logos: [{ png: b64(crest) }],
    }));
    assert.equal(r1.statusCode, 200, r1.body);
    const k1 = r1.json().kit as { id: string; name: string; colours: string[]; font: string; at: number; logos: { hash: string; w: number; h: number }[] };
    assert.equal(k1.name, 'Blue Wave', 'the name is cleaned as the browser cleans it');
    assert.deepEqual(k1.colours, ['#1c5fd9', '#f2f1ec'], 'and the colours');
    assert.equal(k1.font, '', 'an unknown font is left out, not stored');
    assert.equal(k1.at, 1234, 'when it was made, whole milliseconds');
    assert.equal(k1.logos.length, 1);
    assert.deepEqual([k1.logos[0].w, k1.logos[0].h], [64, 48], 'the logo’s size, read from its header');
    const got = await app.inject({ method: 'GET', url: `/api/pro/kits/logos/${k1.logos[0].hash}`, headers: bearer(a.token) });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['content-type'], 'image/png');
    assert.equal(got.headers['x-content-type-options'], 'nosniff');
    assert.match(String(got.headers['cache-control']), /^private,/, 'a person’s logo is never kept by a shared cache');
    assert.equal(got.headers['content-security-policy'], "default-src 'none'");
    assert.ok(!got.rawPayload.includes(Buffer.from('Riyadh')), 'the metadata is not kept');
    assert.equal(createHash('sha256').update(got.rawPayload).digest('hex'), k1.logos[0].hash, 'kept under the hash of its own bytes');

    // Saved again naming the logo by its hash: no pictures sent twice.
    const r2 = await put(a.token, 'kblue00001', KIT({ name: 'Blue Wave FC', font: 'block', logos: [{ hash: k1.logos[0].hash }] }));
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(r2.json().kit.name, 'Blue Wave FC');
    assert.equal(r2.json().kit.font, 'block', 'a Pro voice is a font a kit can keep');
    assert.deepEqual(r2.json().kit.logos, k1.logos, 'the same logo, by its hash');

    // Another account: cannot read it, cannot name it.
    assert.equal((await app.inject({ method: 'GET', url: `/api/pro/kits/logos/${k1.logos[0].hash}`, headers: bearer(b.token) })).statusCode, 404, 'another account’s logo is not found, even by its hash');
    const steal = await put(b.token, 'ksteal0001', KIT({ logos: [{ hash: k1.logos[0].hash }] }));
    assert.equal(steal.statusCode, 409, 'naming another account’s logo is refused');
    assert.equal(steal.json().code, 'kit_logo');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/pro/kits', headers: bearer(b.token) })).json(), { kits: [] }, 'and nothing was saved');
    assert.equal((await app.inject({ method: 'GET', url: '/api/pro/kits', headers: bearer(a.token) })).json().kits.length, 1, 'kits are per account');

    // What a logo may be.
    const refused: [string, unknown, RegExp, number?][] = [
      ['a JPEG', [{ png: b64(JPEG) }], /must be a PNG/],
      ['a GIF', [{ png: b64(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')) }], /must be a PNG/],
      ['HTML that says it is a PNG', [{ png: b64(Buffer.from('<script>alert(1)</script>')) }], /must be a PNG/],
      ['a PNG signature and nothing else', [{ png: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }], /must be a PNG/],
      ['a PNG wider than 512 px', [{ png: b64(png(513, 4)) }], /512 pixels/],
      ['a PNG taller than 512 px', [{ png: b64(png(4, 600)) }], /512 pixels/],
      ['a 0 x 0 PNG', [{ png: b64(png(0, 0)) }], /512 pixels|must be a PNG/],
      ['five logos', Array.from({ length: 5 }, (_, i) => ({ png: b64(png(4, 4, { seed: i })) })), /at most 4 logos/],
      ['logos that are not a list', { png: b64(crest) }, /at most 4 logos/],
      ['a logo that is a string', ['iVBORw0KGgo='], /\{ hash \} or \{ png \}/],
      ['both a hash and a PNG', [{ hash: 'a'.repeat(64), png: b64(crest) }], /\{ hash \} or \{ png \}/],
      ['a hash that is not one', [{ hash: '../../etc/passwd' }], /64 hex/],
      ['base64 that is not', [{ png: 'not base64!!' }], /base64/],
    ];
    for (const [what, logos, msg] of refused) {
      const r = await put(a.token, 'kbad000001', KIT({ logos }));
      assert.equal(r.statusCode, 400, `${what}: 400 (${r.body})`);
      assert.match(r.json().error, msg, `${what}: says why`);
    }
    // Over 400 KB: an incompressible 320 x 320 PNG is about 410 KB.
    const heavy = png(320, 320, { noise: true });
    assert.ok(heavy.byteLength > KIT_LOGO_MAX_BYTES, `the heavy logo is ${heavy.byteLength} bytes`);
    const r3 = await put(a.token, 'kbad000001', KIT({ logos: [{ png: b64(heavy) }] }));
    assert.equal(r3.statusCode, 400, 'a logo over 400 KB is refused');
    // A body past the route's limit never reaches the route.
    const huge = await app.inject({ method: 'PUT', url: '/api/pro/kits/kbad000001', headers: { ...bearer(a.token), 'content-type': 'application/json' }, payload: JSON.stringify(KIT({ name: 'x'.repeat(KIT_BODY_LIMIT + 10) })) });
    assert.equal(huge.statusCode, 413, 'a body over the limit: 413');
    // What a kit must be.
    for (const [what, body] of [['no colours', KIT({ colours: [] })], ['colours that are not', KIT({ colours: ['red', 'blue'] })], ['an array', [1, 2]], ['a string', 'kit']] as [string, unknown][]) {
      const r = await app.inject({ method: 'PUT', url: '/api/pro/kits/kbad000001', headers: { ...bearer(a.token), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      assert.equal(r.statusCode, 400, `${what}: 400 (${r.body})`);
    }
    for (const id of ['..%2F..%2Fadmin', 'k', 'K12345678', 'kabc-defgh', `k${'a'.repeat(40)}`, 'kabcdefgh%00']) {
      const r = await put(a.token, id, KIT());
      assert.ok(r.statusCode === 400 || r.statusCode === 404, `kit id ${id}: refused (${r.statusCode})`);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/pro/kits/logos/ABC', headers: bearer(a.token) })).statusCode, 400, 'a logo is asked for by its hash only');
    assert.equal((await app.inject({ method: 'GET', url: '/api/pro/kits', headers: bearer(a.token) })).json().kits.length, 1, 'nothing refused was saved');

    // At most three, whichever order; changing one when full is fine.
    for (const id of ['kblue00002', 'kblue00003']) assert.equal((await put(a.token, id, KIT({ at: 2000 }))).statusCode, 200);
    const fourth = await put(a.token, 'kblue00004', KIT({ at: 3000 }));
    assert.equal(fourth.statusCode, 409, 'a fourth kit is refused');
    assert.equal(fourth.json().code, 'kit_full');
    assert.equal((await put(a.token, 'kblue00003', KIT({ name: 'Away', at: 2000 }))).statusCode, 200, 'changing one of the three is not adding one');
    const names = (await app.inject({ method: 'GET', url: '/api/pro/kits', headers: bearer(a.token) })).json().kits.map((k: { name: string }) => k.name);
    assert.deepEqual(names, ['Blue Wave FC', 'Blue Wave', 'Away'], 'listed oldest first');

    // Deleting: idempotent, and the pictures go with the last kit naming them.
    const del = await app.inject({ method: 'DELETE', url: '/api/pro/kits/kblue00001', headers: bearer(a.token) });
    assert.deepEqual(del.json(), { ok: true, removed: true });
    assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/pro/kits/kblue00001', headers: bearer(a.token) })).json(), { ok: true, removed: false }, 'a delete sent twice is not an error');
    assert.equal((await app.inject({ method: 'GET', url: `/api/pro/kits/logos/${k1.logos[0].hash}`, headers: bearer(a.token) })).statusCode, 404, 'its logo is gone with it');
    assert.equal((await put(a.token, 'kblue00004', KIT())).statusCode, 200, 'and there is room for another');

    // The credit line.
    const credit = (tok: string, body?: unknown) => app.inject({ method: body === undefined ? 'GET' : 'PUT', url: '/api/pro/credit', headers: bearer(tok), ...(body === undefined ? {} : { payload: body as object }) });
    assert.deepEqual((await credit(a.token)).json(), { credit: '' }, 'none to start');
    assert.deepEqual((await credit(a.token, { credit: '  @os99‮ \n' })).json(), { credit: '@os99' }, 'kept cleaned');
    assert.deepEqual((await credit(a.token)).json(), { credit: '@os99' });
    assert.deepEqual((await credit(b.token)).json(), { credit: '' }, 'one account’s credit is not another’s');
    assert.equal(Array.from((await credit(a.token, { credit: 'ا'.repeat(60) })).json().credit as string).length, CREDIT_MAX, 'at most 32 characters');
    assert.equal((await credit(a.token, { credit: '<img src=x onerror=alert(1)>' })).json().credit, 'img src=x onerror=alert(1)', 'never markup');
    for (const bad of [{ credit: 42 }, { credit: null }, {}, ['@me']]) assert.equal((await credit(a.token, bad)).statusCode, 400, `credit ${JSON.stringify(bad)}: 400`);
    assert.deepEqual((await credit(a.token, { credit: '   ' })).json(), { credit: '' }, 'blank removes it');
    assert.deepEqual((await credit(a.token)).json(), { credit: '' });

    // The account export carries them (the person's own uploads).
    await credit(a.token, { credit: 'Ultras Blue' });
    const ex = (await app.inject({ method: 'GET', url: '/api/account/export', headers: bearer(a.token) })).json() as { pro: { kits: { name: string; logos: string[] }[]; credit: string } };
    assert.equal(ex.pro.credit, 'Ultras Blue', 'the export has the credit line');
    assert.equal(ex.pro.kits.length, 3, 'and every kit');
    console.log('kits.test: kits saved cleaned, logos PNG-only, stripped, per account and capped at 3, deletes idempotent, credit cleaned, export complete');
  } finally {
    restore();
  }
}

// ------------------------------------------------- the store's promises ---
async function storePromises(label: string, repo: KitRepository, a: string, b: string): Promise<void> {
  const logo = (seed: number): NewLogo => {
    const bytes = png(8, 8, { seed });
    return { hash: createHash('sha256').update(bytes).digest('hex'), w: 8, h: 8, png: bytes };
  };
  const base = { name: 'K', colours: ['#000000'], font: '', at: 0 };
  // Six racing to be new: three win, the rest are told it is full.
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => repo.put(a, { ...base, id: `krace0000${i}`, at: i, logos: [logo(i)] })));
  assert.equal(race.filter((r) => r.ok).length, MAX_KITS, `${label}: six racing kits, exactly ${MAX_KITS} kept`);
  assert.ok(race.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'full'), `${label}: the others are told it is full`);
  assert.equal((await repo.list(a)).length, MAX_KITS);
  const kept = await repo.list(a);
  // The logos of the losers are not kept.
  for (let i = 0; i < 6; i++) {
    const won = kept.some((k) => k.id === `krace0000${i}`);
    assert.equal(!!(await repo.logo(a, logo(i).hash)), won, `${label}: a logo is kept only with a kit that names it (${i})`);
  }
  // A kit cannot name a logo of another account's.
  const theirs = await repo.put(b, { ...base, id: 'ktheirs001', logos: [kept[0].logos[0].hash] });
  assert.equal(theirs.ok, false, `${label}: no naming another account's logo`);
  assert.equal(await repo.logo(b, kept[0].logos[0].hash), null, `${label}: nor reading it`);
  // Shared crest, one copy: deleting one kit keeps it for the other.
  const shared = logo(99);
  await repo.remove(a, kept[2].id);
  assert.ok((await repo.put(a, { ...base, id: 'kshare0001', logos: [shared] })).ok);
  await repo.remove(a, kept[1].id);
  assert.ok((await repo.put(a, { ...base, id: 'kshare0002', logos: [shared.hash] })).ok, `${label}: a kit names a logo the account holds`);
  await repo.remove(a, 'kshare0001');
  assert.ok(await repo.logo(a, shared.hash), `${label}: still named by the other kit, still there`);
  await repo.remove(a, 'kshare0002');
  assert.equal(await repo.logo(a, shared.hash), null, `${label}: named by none, gone`);
  // Credit lines.
  await repo.setCredit(a, '@os99');
  assert.equal(await repo.credit(a), '@os99');
  assert.equal(await repo.credit(b), '');
  await repo.setCredit(a, '');
  assert.equal(await repo.credit(a), '', `${label}: an empty credit removes it`);
  console.log(`kits.test: ${label} store promises hold (3 of 6 racing kits, logos per account and tidied, credit lines)`);
}

await storePromises('memory', new MemoryKitRepository(), 'user-a', 'user-b');

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const mk = async (name: string) =>
      String((await pool.query(
        `INSERT INTO users (username, password_hash, email) VALUES ($1, 'x', $2)
         ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [name, `${name}@example.test`],
      )).rows[0].id);
    const a = await mk(`kit_pg_a_${Date.now()}`);
    const b = await mk(`kit_pg_b_${Date.now()}`);
    await storePromises('postgres', new PgKitRepository(pool), a, b);
    // The routes on Postgres too, end to end through the app.
    await new PgKitRepository(pool).put(a, { id: 'kerase0001', name: 'E', colours: ['#ffffff'], font: '', at: 0, logos: [{ hash: createHash('sha256').update(png(2, 2)).digest('hex'), w: 2, h: 2, png: png(2, 2) }] });
    await new PgKitRepository(pool).setCredit(a, 'gone soon');
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b]]);
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM pro_club_kits WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_kit_logos WHERE user_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM pro_credit_lines WHERE user_id = ANY($1::uuid[])) AS n`,
      [[a, b]],
    );
    assert.equal(Number(left.rows[0].n), 0, 'an erased account leaves no kits, logos or credit line');
    // The table's own checks hold even against a writer that skips the routes.
    const c = await mk(`kit_pg_c_${Date.now()}`);
    await assert.rejects(pool.query(`INSERT INTO pro_club_kits (user_id, kit_id, name, colours) VALUES ($1, '../x', 'n', ARRAY['#000000'])`, [c]), 'a kit id the routes would refuse is refused by the table');
    await assert.rejects(pool.query(`INSERT INTO pro_kit_logos (user_id, hash, png, width, height) VALUES ($1, $2, $3, 600, 4)`, [c, 'a'.repeat(64), png(2, 2)]), 'and a logo past 512 px');
    await assert.rejects(pool.query(`INSERT INTO pro_credit_lines (user_id, text) VALUES ($1, $2)`, [c, 'x'.repeat(33)]), 'and a credit line past 32 characters');
    await pool.query('DELETE FROM users WHERE id = $1', [c]);
    console.log('kits.test: postgres store checks passed');
  } finally {
    await pool.end();
  }
} else {
  console.log('kits.test: DATABASE_URL not set; Postgres store checks skipped');
}

// Routes run on Postgres: one app over PgKitRepository, the race through HTTP.
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { app, restore } = await appWith({ PRO_MODE: 'on' }, new PgKitRepository(pool));
  try {
    // The memory auth store hands out ids Postgres has no user row for: make one with that id.
    const u = `kit_pgr_${Date.now()}`;
    const a = await reg(app, u);
    await pool.query(`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [a.id, u]);
    const race = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      app.inject({ method: 'PUT', url: `/api/pro/kits/kroute000${i}`, headers: bearer(a.token), payload: KIT({ at: i, logos: [{ png: b64(png(6, 6, { seed: i })) }] }) })));
    assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 200, 200, 409, 409, 409], 'six racing PUTs on Postgres: three saved, three told it is full');
    await pool.query('DELETE FROM users WHERE id = $1', [a.id]);
    console.log('kits.test: postgres routes hold the cap under a race');
  } finally {
    restore();
    await pool.end();
  }
}

console.log('kits.test: all assertions passed');
