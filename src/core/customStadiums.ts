/**
 * Custom stadiums — user-authored bowls, persisted in localStorage and registered
 * into the catalog so they appear under the Custom tab and load like any other.
 *
 * Authoring is deliberately safe + simple: derive a new template from a chosen
 * base archetype scaled by size, rather than a freehand geometry editor. Custom
 * templates also import/export as JSON, which doubles as a backend-free way to
 * SHARE community stadiums (a real submission backend can layer on later).
 *
 * isValidTemplate() hard-validates shape AND ranges so a pasted/imported template
 * can never feed the seat-map generator pathological numbers. Pure aside from
 * localStorage; the create/validate/parse logic is unit-testable.
 */

import type { StadiumTemplate } from './types';
import { LIMITS, inRange } from './templateLimits';
import { registerCustomStadiums, type StadiumEntry, type StadiumType } from './stadiumCatalog';
import { templateById } from './stadiumCatalog';

const KEY = 'tifo_custom_stadiums';

export type CustomSize = 'compact' | 'standard' | 'large';
const SIZE_SCALE: Record<CustomSize, number> = { compact: 0.82, standard: 1, large: 1.2 };

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Strict structural + range validation — protects the generator from bad input.
 *
 * The ranges come from `templateLimits` rather than being written out here. They
 * used to be literals, and `stadiumFit` had its own, different literals: the two
 * disagreed about the minimum bowl width and the maximum row count, so the
 * estimator could build a stadium this function would then quietly reject.
 */
export function isValidTemplate(t: unknown): t is StadiumTemplate {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false;
  const plan = o.plan as Record<string, unknown> | undefined;
  if (!plan || !num(plan.a) || !num(plan.b) || !num(plan.exponent)) return false;
  if (!inRange(plan.a, LIMITS.planA) || !inRange(plan.b, LIMITS.planB) || !inRange(plan.exponent, LIMITS.exponent)) return false;
  if (!Array.isArray(o.tiers) || !inRange(o.tiers.length, LIMITS.tierCount)) return false;
  for (const tier of o.tiers as Record<string, unknown>[]) {
    if (!tier || !num(tier.rows) || !inRange(tier.rows, LIMITS.rows)) return false;
    if (!num(tier.rowDepth) || !inRange(tier.rowDepth, LIMITS.rowDepth)) return false;
    if (!num(tier.rakeDeg) || !inRange(tier.rakeDeg, LIMITS.rakeDeg)) return false;
    if (!num(tier.baseElevation) || !num(tier.baseOffset)) return false;
    if (!num(tier.seatPitch) || !inRange(tier.seatPitch, LIMITS.seatPitch)) return false;
  }
  const aisles = o.aisles as Record<string, unknown> | undefined;
  if (!aisles || !num(aisles.count) || !inRange(aisles.count, LIMITS.aisleCount) || !num(aisles.widthMeters) || !inRange(aisles.widthMeters, LIMITS.aisleWidth)) return false;
  if (!num(o.sectionsPerTier) || !inRange(o.sectionsPerTier, LIMITS.sectionsPerTier)) return false;
  return true;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'stadium';
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** Derive a new custom template from a base archetype scaled by size. */
export function createCustomTemplate(opts: { name: string; baseId: string; size: CustomSize }): StadiumTemplate | null {
  const base = templateById(opts.baseId);
  if (!base) return null;
  const s = SIZE_SCALE[opts.size] ?? 1;
  return {
    id: `custom-${slug(opts.name)}-${Date.now().toString(36)}`,
    name: opts.name.trim().slice(0, 60) || 'Custom stadium',
    version: 1,
    plan: { a: clamp(Math.round(base.plan.a * s), 20, 200), b: clamp(Math.round(base.plan.b * s), 20, 200), exponent: base.plan.exponent },
    tiers: base.tiers.map((t) => ({ ...t, rows: clamp(Math.round(t.rows * s), 8, 80) })),
    aisles: { ...base.aisles },
    sectionsPerTier: base.sectionsPerTier,
  };
}

/** Wrap a template as a catalog entry under the 'custom' source. */
export function customEntry(t: StadiumTemplate, country?: string): StadiumEntry {
  const type: StadiumType = t.tiers.length === 1 ? 'Single-tier' : 'Two-tier';
  return { id: t.id, template: t, meta: { name: t.name, source: 'custom', type, country, tags: ['custom'] } };
}

export function loadCustomTemplates(): StadiumTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter(isValidTemplate) : [];
  } catch {
    return [];
  }
}

function saveCustomTemplates(list: StadiumTemplate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — custom stays in memory for this session */
  }
}

/** Load custom templates from storage and register them into the catalog. */
export function registerCustom(): StadiumTemplate[] {
  const list = loadCustomTemplates();
  registerCustomStadiums(list.map((t) => customEntry(t)));
  return list;
}

/**
 * Save a template and register it, or refuse it.
 *
 * Returns false when the template would not survive a round trip through
 * storage. It used to return the (re-read, silently filtered) list, so a caller
 * that saved an invalid template got a list without it back and no indication
 * that anything had gone wrong — the stadium simply was not there any more, and
 * the user had been told it was added.
 */
export function addCustomTemplate(t: StadiumTemplate): boolean {
  if (!isValidTemplate(t)) return false;
  const list = loadCustomTemplates().filter((x) => x.id !== t.id);
  list.push(t);
  saveCustomTemplates(list);
  // Confirm it actually came back: a full localStorage quota fails silently.
  registerCustom();
  return loadCustomTemplates().some((x) => x.id === t.id);
}

export function removeCustomTemplate(id: string): StadiumTemplate[] {
  const list = loadCustomTemplates().filter((x) => x.id !== id);
  saveCustomTemplates(list);
  return registerCustom();
}

/** Parse imported JSON into a template (re-id'd so it doesn't clash), or null. */
export function parseImportedTemplate(json: string): StadiumTemplate | null {
  try {
    const t = JSON.parse(json) as unknown;
    if (!isValidTemplate(t)) return null;
    const src = t as StadiumTemplate;
    // Defense-in-depth: cap + strip the user-controlled name so it's safe even if a
    // caller ever renders it as HTML (the rest of the template is range-validated).
    const name = src.name.replace(/[<>]/g, '').trim().slice(0, 60) || 'Imported stadium';
    return { ...src, name, id: `custom-${slug(name)}-${Date.now().toString(36)}` };
  } catch {
    return null;
  }
}

export function exportTemplate(t: StadiumTemplate): string {
  return JSON.stringify(t, null, 2);
}
