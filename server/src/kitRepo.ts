/**
 * Where a fan's club kits and credit line are kept on their account, so they
 * are on every device they sign in on (Pro, server/src/kitRoutes.ts). In
 * memory for development and tests, in Postgres in production (schema.sql,
 * "Club kits on the account").
 *
 * A kit is its name, colours, font and up to four logos. The logos are kept
 * apart, by their SHA-256, once per account: a kit names its logos by hash,
 * so saving a kit again does not send its pictures again, and two kits with
 * the same crest keep one copy.
 *
 * Three promises every implementation keeps:
 *  - an account never holds more than MAX_KITS kits, however many requests
 *    race to add one (put() decides under a per-account lock);
 *  - a kit only names logos its own account holds (put() refuses others);
 *  - a logo no kit names any more is gone after the write that dropped it,
 *    so deleting a kit deletes its pictures.
 */
import type pg from 'pg';
import { MAX_KITS } from '../../src/core/kitRules';

export interface KitLogoRef {
  hash: string;
  w: number;
  h: number;
}

export interface StoredKit {
  id: string;
  name: string;
  colours: string[];
  font: string;
  /** When the fan made it (their clock, ms): kits are listed oldest first. */
  at: number;
  logos: KitLogoRef[];
  updatedAt: string;
}

/** A logo to keep with a kit: its bytes (checked and cleaned by the route). */
export interface NewLogo {
  hash: string;
  w: number;
  h: number;
  png: Buffer;
}

export type PutKit = Omit<StoredKit, 'updatedAt' | 'logos'> & {
  /** In order: a hash the account already holds, or a new logo. */
  logos: (string | NewLogo)[];
};

export type PutResult = { ok: true; kit: StoredKit } | { ok: false; reason: 'full' | 'logo' };

export interface KitRepository {
  list(userId: string): Promise<StoredKit[]>;
  put(userId: string, kit: PutKit): Promise<PutResult>;
  /** True when there was such a kit. */
  remove(userId: string, kitId: string): Promise<boolean>;
  logo(userId: string, hash: string): Promise<Buffer | null>;
  /** The credit line, '' when there is none. */
  credit(userId: string): Promise<string>;
  /** Keep the credit line; '' removes it. */
  setCredit(userId: string, text: string): Promise<void>;
}

const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------- memory ---

export class MemoryKitRepository implements KitRepository {
  private kits = new Map<string, Map<string, StoredKit>>();
  private logos = new Map<string, Map<string, { png: Buffer; w: number; h: number }>>();
  private credits = new Map<string, string>();

  private mine(userId: string): Map<string, StoredKit> {
    let m = this.kits.get(userId);
    if (!m) this.kits.set(userId, (m = new Map()));
    return m;
  }

  private pictures(userId: string): Map<string, { png: Buffer; w: number; h: number }> {
    let m = this.logos.get(userId);
    if (!m) this.logos.set(userId, (m = new Map()));
    return m;
  }

  /** Drop the logos no kit of this account names. */
  private tidy(userId: string): void {
    const named = new Set([...this.mine(userId).values()].flatMap((k) => k.logos.map((l) => l.hash)));
    for (const h of [...this.pictures(userId).keys()]) if (!named.has(h)) this.pictures(userId).delete(h);
  }

  async list(userId: string): Promise<StoredKit[]> {
    return [...this.mine(userId).values()]
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .map((k) => ({ ...k, colours: k.colours.slice(), logos: k.logos.map((l) => ({ ...l })) }));
  }

  async put(userId: string, kit: PutKit): Promise<PutResult> {
    // Synchronous from here on: nothing interleaves inside one call.
    const mine = this.mine(userId);
    if (!mine.has(kit.id) && mine.size >= MAX_KITS) return { ok: false, reason: 'full' };
    const pics = this.pictures(userId);
    const refs: KitLogoRef[] = [];
    for (const l of kit.logos) {
      if (typeof l === 'string') {
        const have = pics.get(l);
        if (!have) return { ok: false, reason: 'logo' };
        refs.push({ hash: l, w: have.w, h: have.h });
      } else {
        refs.push({ hash: l.hash, w: l.w, h: l.h });
      }
    }
    for (const l of kit.logos) if (typeof l !== 'string') pics.set(l.hash, { png: Buffer.from(l.png), w: l.w, h: l.h });
    const stored: StoredKit = { id: kit.id, name: kit.name, colours: kit.colours.slice(), font: kit.font, at: kit.at, logos: refs, updatedAt: nowIso() };
    mine.set(kit.id, stored);
    this.tidy(userId);
    return { ok: true, kit: { ...stored, colours: stored.colours.slice(), logos: refs.map((r) => ({ ...r })) } };
  }

  async remove(userId: string, kitId: string): Promise<boolean> {
    const had = this.mine(userId).delete(kitId);
    this.tidy(userId);
    return had;
  }

  async logo(userId: string, hash: string): Promise<Buffer | null> {
    const l = this.logos.get(userId)?.get(hash);
    return l ? Buffer.from(l.png) : null;
  }

  async credit(userId: string): Promise<string> {
    return this.credits.get(userId) ?? '';
  }

  async setCredit(userId: string, text: string): Promise<void> {
    if (text) this.credits.set(userId, text);
    else this.credits.delete(userId);
  }
}

// -------------------------------------------------------------- postgres ---

function rowToKit(r: Record<string, unknown>, sizes: Map<string, { w: number; h: number }>): StoredKit {
  const hashes = Array.isArray(r.logos) ? (r.logos as unknown[]).map(String) : [];
  return {
    id: String(r.kit_id),
    name: String(r.name),
    colours: Array.isArray(r.colours) ? (r.colours as unknown[]).map(String) : [],
    font: String(r.font ?? ''),
    at: Number(r.made_at),
    logos: hashes.filter((h) => sizes.has(h)).map((h) => ({ hash: h, ...sizes.get(h)! })),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export class PgKitRepository implements KitRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(userId: string): Promise<StoredKit[]> {
    const [k, l] = await Promise.all([
      this.pool.query(
        `SELECT kit_id, name, colours, font, made_at, logos, updated_at FROM pro_club_kits
         WHERE user_id = $1 ORDER BY made_at, kit_id LIMIT ${MAX_KITS}`,
        [userId],
      ),
      this.pool.query('SELECT hash, width, height FROM pro_kit_logos WHERE user_id = $1', [userId]),
    ]);
    const sizes = new Map<string, { w: number; h: number }>(l.rows.map((x) => [String(x.hash), { w: Number(x.width), h: Number(x.height) }]));
    return k.rows.map((r) => rowToKit(r, sizes));
  }

  async put(userId: string, kit: PutKit): Promise<PutResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One writer per account at a time: two requests racing to add the
      // fourth kit see each other's count, and a logo checked here is still
      // there when the kit naming it is written.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pro_club_kits:' || $1::text))", [userId]);
      const n = await client.query(
        'SELECT count(*)::int AS n, bool_or(kit_id = $2) AS mine FROM pro_club_kits WHERE user_id = $1',
        [userId, kit.id],
      );
      if (!n.rows[0]?.mine && Number(n.rows[0]?.n ?? 0) >= MAX_KITS) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'full' };
      }
      const named = kit.logos.filter((l): l is string => typeof l === 'string');
      const have = named.length
        ? await client.query('SELECT hash, width, height FROM pro_kit_logos WHERE user_id = $1 AND hash = ANY($2::text[])', [userId, named])
        : { rows: [] as Record<string, unknown>[] };
      const sizes = new Map<string, { w: number; h: number }>(have.rows.map((x) => [String(x.hash), { w: Number(x.width), h: Number(x.height) }]));
      if (named.some((h) => !sizes.has(h))) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'logo' };
      }
      for (const l of kit.logos) {
        if (typeof l === 'string') continue;
        await client.query(
          `INSERT INTO pro_kit_logos (user_id, hash, png, width, height) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, hash) DO NOTHING`,
          [userId, l.hash, l.png, l.w, l.h],
        );
        sizes.set(l.hash, { w: l.w, h: l.h });
      }
      const hashes = kit.logos.map((l) => (typeof l === 'string' ? l : l.hash));
      const r = await client.query(
        `INSERT INTO pro_club_kits (user_id, kit_id, name, colours, font, made_at, logos)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7::text[])
         ON CONFLICT (user_id, kit_id) DO UPDATE
           SET name = EXCLUDED.name, colours = EXCLUDED.colours, font = EXCLUDED.font,
               made_at = EXCLUDED.made_at, logos = EXCLUDED.logos, updated_at = now()
         RETURNING kit_id, name, colours, font, made_at, logos, updated_at`,
        [userId, kit.id, kit.name, kit.colours, kit.font, kit.at, hashes],
      );
      await this.tidy(client, userId);
      await client.query('COMMIT');
      return { ok: true, kit: rowToKit(r.rows[0], sizes) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Drop the logos no kit of this account names (inside the writer's transaction). */
  private async tidy(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `DELETE FROM pro_kit_logos l WHERE l.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM pro_club_kits k WHERE k.user_id = $1 AND l.hash = ANY(k.logos))`,
      [userId],
    );
  }

  async remove(userId: string, kitId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pro_club_kits:' || $1::text))", [userId]);
      const r = await client.query('DELETE FROM pro_club_kits WHERE user_id = $1 AND kit_id = $2', [userId, kitId]);
      await this.tidy(client, userId);
      await client.query('COMMIT');
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async logo(userId: string, hash: string): Promise<Buffer | null> {
    const r = await this.pool.query('SELECT png FROM pro_kit_logos WHERE user_id = $1 AND hash = $2', [userId, hash]);
    return r.rows[0] ? Buffer.from(r.rows[0].png as Buffer) : null;
  }

  async credit(userId: string): Promise<string> {
    const r = await this.pool.query('SELECT text FROM pro_credit_lines WHERE user_id = $1', [userId]);
    return r.rows[0] ? String(r.rows[0].text) : '';
  }

  async setCredit(userId: string, text: string): Promise<void> {
    if (!text) {
      await this.pool.query('DELETE FROM pro_credit_lines WHERE user_id = $1', [userId]);
      return;
    }
    await this.pool.query(
      `INSERT INTO pro_credit_lines (user_id, text) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET text = EXCLUDED.text, updated_at = now()`,
      [userId, text],
    );
  }
}
