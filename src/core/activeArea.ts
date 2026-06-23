/**
 * Active Tifo Area — which part of the bowl the design targets.
 *
 * A single, shared selection that the Stadium panel sets and other features read
 * — today the AI uses it to focus a generation; future features (export scoping,
 * production manifests) can read the same value. Maps onto the existing Region
 * system (stand / tier), so it integrates with the seat + section logic for free.
 *
 * Persisted in localStorage so it survives the reload that a stadium switch does.
 * Pure aside from storage; the Region/describe logic is unit-testable.
 */

import { normalizeRegion, type Region } from './tifoSpec';

export type ActiveAreaId = 'all' | 'north' | 'south' | 'east' | 'west' | 'upper' | 'lower';

export const ACTIVE_AREAS: { id: ActiveAreaId; label: string }[] = [
  { id: 'all', label: 'Entire stadium' },
  { id: 'north', label: 'North stand' },
  { id: 'south', label: 'South stand' },
  { id: 'east', label: 'East stand' },
  { id: 'west', label: 'West stand' },
  { id: 'upper', label: 'Upper tier' },
  { id: 'lower', label: 'Lower tier' },
];

const KEY = 'tifo_active_area';
const isId = (v: unknown): v is ActiveAreaId => ACTIVE_AREAS.some((a) => a.id === v);

let active: ActiveAreaId = ((): ActiveAreaId => {
  try {
    const v = localStorage.getItem(KEY);
    return isId(v) ? v : 'all';
  } catch {
    return 'all';
  }
})();

export function getActiveArea(): ActiveAreaId {
  return active;
}

export function setActiveArea(a: ActiveAreaId): void {
  active = a;
  try {
    localStorage.setItem(KEY, a);
  } catch {
    /* storage unavailable — keep it in memory for this session */
  }
}

/** The active area as a compiler/AI Region. */
export function activeAreaRegion(id: ActiveAreaId = active): Region {
  return normalizeRegion(id) ?? { stand: 'all', tier: 'all' };
}

/** Human phrase for prompts/UI, e.g. "the north stand". Empty for the whole bowl. */
export function describeActiveArea(id: ActiveAreaId = active): string {
  if (id === 'all') return '';
  if (id === 'upper') return 'the upper tier';
  if (id === 'lower') return 'the lower tier';
  return `the ${id} stand`;
}
