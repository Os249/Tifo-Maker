import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAuthRepository, MemoryDesignRepository } from '../src/memoryRepo';
import { PgAuthRepository, PgDesignRepository } from '../src/pgRepo';
import { buildApp, SNAPSHOT_EVERY, type TemplateInfo } from '../src/routes';
import { toB64 } from '../src/codec';
import type { AuthRepository, DesignRepository } from '../src/repo';

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
    payload: { username, password: 'hunter22pass' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token as string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function runSuite(name: string, repo: DesignRepository, auth: AuthRepository): Promise<void> {
  const app = await buildApp(repo, auth, templates);
  const cells = sampleCells();
  const gz = gzipSync(cells);
  const cellsGzB64 = gz.toString('base64');

  // ---- auth ----
  const aliceTok = await registerUser(app, 'alice');
  const bobTok = await registerUser(app, 'bob');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'hunter22pass' } })).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrongpass99' } })).statusCode,
    401,
  );
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'hunter22pass' } });
  assert.equal(login.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(aliceTok) })).statusCode, 200);

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
}

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  await pool.query('TRUNCATE design_revisions, designs, auth_tokens, users CASCADE');
  await runSuite('postgres repos', new PgDesignRepository(pool), new PgAuthRepository(pool));
  await pool.end();
} else {
  console.log('postgres repos: skipped (set DATABASE_URL to run)');
}
