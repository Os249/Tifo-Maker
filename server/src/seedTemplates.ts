import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { randomBytes, scryptSync } from 'node:crypto';
import type { DesignRepository, SeedDesign } from './repo';
import type { AuthRepository } from './repo';

/**
 * Load the starter-template library into the design repo at boot.
 *
 * The library is generated offline (scripts/generate-templates.mts) and checked
 * in as one JSONL file — a template per line — so a fresh deploy has a full
 * gallery on its first request without a migration, a fixture dump, or anyone
 * clicking anything. It is idempotent: templates are owned by one official
 * account and the seeder asks that account what it has already published, so a
 * restart is a no-op and a grown library tops up.
 *
 * These are deliberately NOT community posts. They are published by an account
 * the site owns, flagged isTemplate, and surfaced under Templates. Seeding the
 * community feed with machine-made designs would be dishonest, and it would
 * bury the real ones the feed exists to show.
 */

/** The account the library is published under. */
export const TEMPLATE_OWNER = 'tifomaker';

interface TemplateFile {
  id: string;
  titleEn: string;
  titleAr: string;
  stadiumId: string;
  templateVersion: number;
  palette: string[];
  /** Gzipped cell buffer, base64. This is exactly what the repo stores, so the
   *  seeder does no work to load it — and it is 8x smaller on disk than the
   *  same data written out as JSON run-length pairs. */
  cellsGzB64?: string;
  /** Format the first generation run wrote; still accepted so an older library
   *  directory seeds without being repacked first. */
  cellsRle?: [number, number][];
  tags: string[];
  archetype: string;
  family: string;
  club: string | null;
  thumbnailPng: string | null;
}

function expand(rle: [number, number][]): Uint8Array {
  let total = 0;
  for (const [, n] of rle) total += n;
  const out = new Uint8Array(total);
  let at = 0;
  for (const [v, n] of rle) {
    out.fill(v, at, at + n);
    at += n;
  }
  return out;
}

/** Cells as the repo wants them: gzipped. The packed format is already gzipped,
 *  so that path is a base64 decode and nothing else. */
function cellsGzOf(t: Pick<TemplateFile, 'cellsGzB64' | 'cellsRle'>): Buffer {
  if (t.cellsGzB64) return Buffer.from(t.cellsGzB64, 'base64');
  if (t.cellsRle) return gzipSync(Buffer.from(expand(t.cellsRle)));
  throw new Error('template has no cell data');
}

/** FNV-1a over the id: a fixed, uniform order that is not the file's. */
function shuffleKey(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A password nobody holds: the account exists to own templates, not to sign in. */
function unusablePassword(): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(randomBytes(32), salt, 64).toString('hex')}`;
}

export interface SeedResult {
  added: number;
  existing: number;
  skipped: string[];
}

export async function seedTemplates(
  designs: DesignRepository,
  auth: AuthRepository,
  file: string,
): Promise<SeedResult> {
  const result: SeedResult = { added: 0, existing: 0, skipped: [] };
  if (!existsSync(file)) return result;

  const entries: TemplateFile[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      entries.push(JSON.parse(text) as TemplateFile);
    } catch {
      result.skipped.push(`line ${entries.length + result.skipped.length + 1}`);
    }
  }
  if (entries.length === 0) return result;
  // Insertion order IS gallery order, and the generator writes the library
  // grouped by composition, so seeding it in file order puts sixty consecutive
  // hoops on the first page and every stripe design three hundred cards later.
  // A stable hash shuffle interleaves them, so any page shows the range of the
  // library — and being a hash, not a random, the order is the same on every
  // deploy.
  entries.sort((a, b) => shuffleKey(a.id) - shuffleKey(b.id) || a.id.localeCompare(b.id));

  let owner = await auth.getUserByName(TEMPLATE_OWNER);
  if (!owner) {
    owner = await auth.createUser(TEMPLATE_OWNER, unusablePassword(), { email: null });
    if (!owner) {
      result.skipped.push('could not create the template account');
      return result;
    }
  }

  // Idempotence by title: re-running must not double the library. This asks for
  // titles rather than reusing listByOwner, which is the profile query and caps
  // at 200 — against Postgres that made the seeder believe it had published 200
  // of the 591 and re-add the other 391 on every single restart.
  const have = new Set(await designs.listTitlesByOwner(owner.id));
  result.existing = have.size;

  const pending: SeedDesign[] = [];
  for (const t of entries) {
    if (have.has(t.titleEn)) continue;
    have.add(t.titleEn); // a duplicate title inside one run must not double either
    try {
      pending.push({
        title: t.titleEn,
        titleAr: t.titleAr,
        templateId: t.stadiumId,
        templateVersion: t.templateVersion,
        palette: t.palette,
        cellsGz: cellsGzOf(t),
        thumbnailPng: t.thumbnailPng ? Buffer.from(t.thumbnailPng, 'base64') : null,
        tags: [...new Set([...t.tags, ...(t.club ? ['club'] : ['palette'])])].slice(0, 8),
      });
    } catch {
      result.skipped.push(t.id); // unreadable cells; the rest of the library is fine
    }
  }

  // One call, not four per design. Writing them one at a time cost about
  // seventeen round trips each, so the first deploy spent forty seconds seeding
  // before it opened its port and Railway killed it on a thirty-second
  // healthcheck. Seeding now runs after listen, and takes about a second.
  result.added = await designs.seedDesigns(owner.id, pending);
  return result;
}

/** One showcase design: a library entry plus the banners it carries. */
interface ShowcaseFile extends Pick<TemplateFile, 'id' | 'titleEn' | 'titleAr' | 'stadiumId' | 'templateVersion' | 'palette' | 'cellsGzB64' | 'tags' | 'thumbnailPng'> {
  /** The design's scene, gzipped JSON, base64 — exactly what PUT /scene stores. */
  sceneGzB64: string;
}

/**
 * Publish the banner showcase (server/data/showcase.jsonl, written by
 * scripts/generate-showcase.mts): a few designs that show what a banner looks
 * like in a stadium.
 *
 * The same account and the same rules as the library above — owned by
 * @tifomaker, public, flagged as templates, idempotent by title — so they are
 * never passed off as somebody's post. Run AFTER the library: the feed's
 * default order is newest first, and these are what it should open on.
 *
 * One design at a time rather than the bulk path, because each has a scene
 * to store and there are only a handful. It is published only once its scene
 * is stored: a design is created private, and one whose banners failed to
 * store stays that way rather than going out as a showcase with none.
 */
export async function seedShowcase(
  designs: DesignRepository,
  auth: AuthRepository,
  file: string,
): Promise<SeedResult> {
  const result: SeedResult = { added: 0, existing: 0, skipped: [] };
  if (!existsSync(file)) return result;
  const entries: ShowcaseFile[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      entries.push(JSON.parse(text) as ShowcaseFile);
    } catch {
      result.skipped.push(`line ${entries.length + result.skipped.length + 1}`);
    }
  }
  if (entries.length === 0) return result;

  let owner = await auth.getUserByName(TEMPLATE_OWNER);
  if (!owner) {
    owner = await auth.createUser(TEMPLATE_OWNER, unusablePassword(), { email: null });
    if (!owner) {
      result.skipped.push('could not create the template account');
      return result;
    }
  }
  const have = new Set(await designs.listTitlesByOwner(owner.id));
  // The feed's "recent" is by last update, to the millisecond, and the
  // library was written a moment ago in one go. A tie is broken by id — at
  // random — so without a clear millisecond between them the showcase could
  // land anywhere on the first page instead of at the top of it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const s of entries) {
    if (have.has(s.titleEn)) {
      result.existing++;
      continue;
    }
    have.add(s.titleEn);
    try {
      const meta = await designs.create({
        title: s.titleEn,
        titleAr: s.titleAr,
        templateId: s.stadiumId,
        templateVersion: s.templateVersion,
        palette: s.palette,
        cellsGz: cellsGzOf(s),
        ownerId: owner.id,
        thumbnailPng: s.thumbnailPng ? Buffer.from(s.thumbnailPng, 'base64') : null,
      });
      const scened = await designs.putScene(meta.id, Buffer.from(s.sceneGzB64, 'base64'));
      if (!scened) {
        // Left private: a showcase of banners with no banner on it is worse
        // than one fewer showcase.
        result.skipped.push(s.id);
        continue;
      }
      await designs.patchMeta(meta.id, { isPublic: true });
      await designs.setTemplate(meta.id, owner.id, true);
      await designs.setTags(meta.id, owner.id, s.tags);
      result.added++;
    } catch {
      result.skipped.push(s.id);
    }
  }
  return result;
}
