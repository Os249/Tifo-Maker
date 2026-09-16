import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/** Password + token primitives. No dependencies: node:crypto scrypt and sha256. */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Current scrypt parameters.
 *
 * OWASP's floor is N=2^17, r=8, p=1 — but that is 128 MB of RAM *per hash in
 * flight*, and node runs scrypt on the libuv thread pool, four wide by default.
 * Four people signing in at once would ask a small container for half a gigabyte
 * and get killed, which is a worse outage than the finding this fixes.
 *
 * So this is OWASP's second listed configuration, N=2^16 r=8 p=2: the same work
 * factor for half the memory, because (N, r, p) trades memory against passes.
 * Measured on the deploy container: 348 ms and a 64 MB peak, against 394 ms and
 * 128 MB for the first option, and against 46 ms for the N=2^14 default this
 * replaces — roughly 8x the cost of an offline guess.
 */
export const SCRYPT_PARAMS = { N: 65536, r: 8, p: 2, keylen: 32 } as const;

/** Node refuses any N above the default 32 MB ceiling unless maxmem is raised. */
const maxmemFor = (N: number, r: number): number => 256 * N * r;

/** What a hash written before the parameters were versioned used. */
const LEGACY_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/**
 * Stored form: `s2:N:r:p:salt:hash`, or the unprefixed `salt:hash` written
 * before this existed. The prefix is what lets the cost rise again later without
 * locking everyone out — a stored hash now says how it was made.
 */
function parse(stored: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split(':');
  if (parts.length === 2) {
    const [saltHex, hashHex] = parts;
    if (!saltHex || !hashHex) return null;
    return { ...LEGACY_PARAMS, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
  }
  if (parts.length === 6 && parts[0] === 's2') {
    const [, n, r, p, saltHex, hashHex] = parts;
    const N = Number(n);
    const rr = Number(r);
    const pp = Number(p);
    // Bounded, because these numbers come back out of the database and go
    // straight into an allocation: a row saying N=2^30 is an out-of-memory kill
    // triggered by a login.
    if (!Number.isInteger(N) || N < 1024 || N > 1_048_576) return null;
    if (!Number.isInteger(rr) || rr < 1 || rr > 32) return null;
    if (!Number.isInteger(pp) || pp < 1 || pp > 16) return null;
    if (!saltHex || !hashHex) return null;
    return { N, r: rr, p: pp, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const hash = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return `s2:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * A hash of a password nobody has, at the current cost.
 *
 * Sign-in used to short-circuit when no account matched, so a missing account
 * answered in about 0.3 ms and a real one in 35. The bodies were identical; the
 * clock was the oracle. Verifying against this instead spends the same time on
 * an address that has never registered.
 *
 * Built once, lazily, and awaited — it costs one scrypt at startup, and doing it
 * on the first failed login instead would make that one login slow enough to be
 * its own signal.
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('hex'));
  return dummy;
}

export interface VerifyResult {
  ok: boolean;
  /** The stored hash was made with weaker parameters than we now use. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parsed = parse(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const { N, r, p, salt, hash } = parsed;
  if (!hash.length) return { ok: false, needsRehash: false };
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, hash.length, { N, r, p, maxmem: maxmemFor(N, r) });
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = timingSafeEqual(actual, hash);
  const current = N === SCRYPT_PARAMS.N && r === SCRYPT_PARAMS.r && p === SCRYPT_PARAMS.p;
  // Only worth rehashing a password we have just seen in the clear and got right.
  return { ok, needsRehash: ok && !current };
}

/** Opaque token returned to the client; only its sha256 is stored. */
export function issueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
