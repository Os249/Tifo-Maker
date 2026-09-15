/**
 * "Build one from a real ground" — the import block in the Stadium panel's
 * Custom tab.
 *
 * Type a name, it finds the footprint in OpenStreetMap, and src/core/stadiumFit
 * turns that plus the stated capacity into a template. The user sets the two or
 * three things no public source knows — how many tiers, which stands are roofed —
 * and gets the bowl added to their Custom list.
 *
 * The part that is not decoration: it shows WHERE EVERY NUMBER CAME FROM. Some
 * are measured off geometry, some are solved against a capacity, and some are a
 * rule of thumb that is right about ten times in thirteen. Presenting those as
 * one confident blob of numbers is how someone ends up believing a guess, so the
 * panel prints the provenance and names the fields worth checking.
 */
import { buildStadium, type FitResult } from '../core/stadiumFit';
import { addCustomTemplate } from '../core/customStadiums';
import { findStadiums, OSM_ATTRIBUTION, type OsmStadium } from '../net/osm';
import { t, tv } from './i18n';
import type { RoofCoverage } from '../core/types';

const INPUT =
  'width:100%;box-sizing:border-box;padding:6px;border:1px solid var(--line-1);border-radius:var(--r-md);background:var(--bg-1);color:var(--text-1);font:inherit;font-size:11px;';

const CONF_COLOUR: Record<string, string> = {
  measured: 'var(--ok, #2fb37a)',
  derived: 'var(--ok, #2fb37a)',
  given: 'var(--text-2)',
  suggested: 'var(--warn, #f0b429)',
};

export interface StadiumImportDeps {
  /** Re-render the panel after a stadium is added. */
  onAdded: (id: string) => void;
}

/**
 * A human name for a template field, falling back to the raw name so a field
 * nobody has translated yet still appears rather than vanishing.
 */
function fieldLabel(field: string): string {
  const label = t('si.f.' + field);
  return label === 'si.f.' + field ? field : label;
}

export function buildStadiumImport(deps: StadiumImportDeps): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:10px;border:1px solid var(--line-1);border-radius:var(--r-md);padding:8px;';

  const title = document.createElement('div');
  title.textContent = t('si.title');
  title.style.cssText = 'font-weight:600;font-size:11px;margin-bottom:2px;';
  const blurb = document.createElement('p');
  blurb.className = 'hint';
  blurb.textContent = t('si.blurb');
  blurb.style.cssText = 'font-size:10px;color:var(--text-3);margin:0 0 6px;';

  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;gap:6px;';
  const nameI = document.createElement('input');
  nameI.placeholder = t('si.searchPh');
  // A hook, because the Custom tab has a second "stadium name" box right above
  // this one for hand-authoring. Matching on placeholder text picks the wrong
  // field, which is how the first screenshot run reported success while typing
  // into the other form.
  nameI.dataset.tm = 'osm-search';
  nameI.setAttribute('aria-label', t('si.searchPh'));
  nameI.style.cssText = INPUT;
  const findBtn = document.createElement('button');
  findBtn.dataset.tm = 'osm-find';
  findBtn.textContent = t('si.find');
  findBtn.style.cssText = 'white-space:nowrap;';
  searchRow.append(nameI, findBtn);

  const status = document.createElement('p');
  status.className = 'hint';
  status.style.cssText = 'font-size:10px;color:var(--text-3);margin:6px 0 0;';

  const resultSel = document.createElement('select');
  resultSel.style.cssText = INPUT + 'margin-top:6px;display:none;';

  const knobs = document.createElement('div');
  knobs.style.cssText = 'display:none;margin-top:6px;';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';
  const capI = document.createElement('input');
  capI.type = 'number';
  capI.min = '500';
  capI.placeholder = t('si.capacityPh');
  capI.style.cssText = INPUT;
  const tierSel = document.createElement('select');
  tierSel.style.cssText = INPUT;
  for (const [v, k] of [['', 'si.tiersAuto'], ['1', 'si.tiers1'], ['2', 'si.tiers2'], ['3', 'si.tiers3']] as [string, string][]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t(k);
    tierSel.appendChild(o);
  }
  const roofSel = document.createElement('select');
  roofSel.style.cssText = INPUT;
  for (const [v, k] of [['', 'si.roofAuto'], ['ring', 'si.roofRing'], ['sides', 'si.roofSides'], ['west', 'si.roofOne'], ['none', 'si.roofNone']] as [string, string][]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t(k);
    roofSel.appendChild(o);
  }
  const aislesI = document.createElement('input');
  aislesI.type = 'number';
  aislesI.min = '4';
  aislesI.max = '80';
  aislesI.placeholder = t('si.aislesPh');
  aislesI.style.cssText = INPUT;
  grid.append(capI, tierSel, roofSel, aislesI);

  const buildBtn = document.createElement('button');
  buildBtn.className = 'primary';
  buildBtn.dataset.tm = 'osm-build';
  buildBtn.textContent = t('si.build');
  buildBtn.style.cssText = 'width:100%;margin-top:6px;';
  knobs.append(grid, buildBtn);

  const report = document.createElement('div');
  report.dataset.tm = 'osm-report';
  report.style.cssText = 'display:none;margin-top:8px;border-top:1px solid var(--line-1);padding-top:8px;';

  const credit = document.createElement('p');
  credit.className = 'hint';
  credit.textContent = OSM_ATTRIBUTION;
  credit.style.cssText = 'font-size:9px;color:var(--text-3);margin:8px 0 0;';

  box.append(title, blurb, searchRow, status, resultSel, knobs, report, credit);

  // ---- state
  let found: OsmStadium[] = [];
  let inflight: AbortController | null = null;

  const current = (): OsmStadium | undefined => found[Number(resultSel.value) || 0];

  async function search(): Promise<void> {
    const q = nameI.value.trim();
    if (q.length < 3) { status.textContent = t('si.tooShort'); return; }
    inflight?.abort();
    inflight = new AbortController();
    findBtn.disabled = true;
    status.textContent = t('si.searching');
    resultSel.style.display = 'none';
    knobs.style.display = 'none';
    report.style.display = 'none';
    try {
      found = await findStadiums(q, inflight.signal);
      if (found.length === 0) { status.textContent = t('si.none'); return; }
      resultSel.replaceChildren();
      found.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = s.capacity ? `${s.name} — ${s.capacity.toLocaleString()}` : s.name;
        resultSel.appendChild(o);
      });
      resultSel.style.display = '';
      knobs.style.display = '';
      onPick();
      status.textContent = found.length === 1 ? t('si.found1') : `${found.length} ${t('si.foundN')}`;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      status.textContent = t('si.osmDown');
    } finally {
      findBtn.disabled = false;
    }
  }

  function onPick(): void {
    const s = current();
    if (!s) return;
    // Prefill from OSM but leave it editable: many grounds carry no capacity
    // tag at all, and a wrong one is worse than an empty box.
    capI.value = s.capacity ? String(s.capacity) : '';
    report.style.display = 'none';
  }

  function renderReport(fit: FitResult, s: OsmStadium): void {
    report.replaceChildren();
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;font-size:11px;margin-bottom:4px;';
    head.textContent = t('si.whereFrom');
    report.appendChild(head);

    // One row per MEASUREMENT, not per field. The bowl's length, width and corner
    // shape all come out of a single fit, and printing its note three times says
    // there were three findings when there was one.
    const rows = new Map<string, { fields: string[]; p: typeof fit.provenance[string]; note: string }>();
    for (const [field, p] of Object.entries(fit.provenance)) {
      const note = p.noteKey ? tv(p.noteKey, p.noteVars ?? {}) : (p.note ?? p.source);
      const key = `${p.confidence}|${p.source}|${note}`;
      const row = rows.get(key);
      if (row) row.fields.push(field);
      else rows.set(key, { fields: [field], p, note });
    }

    const table = document.createElement('div');
    table.style.cssText = 'display:grid;grid-template-columns:minmax(0,1.1fr) auto minmax(0,1.6fr);gap:5px 8px;font-size:10px;align-items:baseline;';
    for (const { fields, p, note } of rows.values()) {
      const f = document.createElement('span');
      f.textContent = fields.map(fieldLabel).join(', ');
      f.style.cssText = 'color:var(--text-2);';
      const c = document.createElement('span');
      c.textContent = t('si.conf.' + p.confidence);
      c.style.cssText = `color:${CONF_COLOUR[p.confidence] ?? 'var(--text-2)'};font-weight:600;white-space:nowrap;`;
      const n = document.createElement('span');
      n.textContent = note;
      n.style.cssText = 'color:var(--text-3);';
      table.append(f, c, n);
    }
    report.appendChild(table);

    for (const w of fit.warnings) {
      const p = document.createElement('p');
      p.textContent = tv(w.key, w.vars ?? {});
      p.style.cssText = 'font-size:10px;color:var(--warn, #f0b429);margin:6px 0 0;';
      report.appendChild(p);
    }
    if (fit.confirm.length) {
      const p = document.createElement('p');
      p.textContent = `${t('si.confirm')} ${fit.confirm.map(fieldLabel).join(', ')}`;
      p.style.cssText = 'font-size:10px;color:var(--text-3);margin:6px 0 0;';
      report.appendChild(p);
    }

    const add = document.createElement('button');
    add.className = 'primary';
    add.style.cssText = 'width:100%;margin-top:8px;';
    add.textContent = t('si.add');
    add.addEventListener('click', () => {
      addCustomTemplate(fit.template);
      status.textContent = `${t('si.added')} “${fit.template.name}”.`;
      report.style.display = 'none';
      deps.onAdded(fit.template.id);
    });
    report.appendChild(add);

    const cite = document.createElement('p');
    cite.className = 'hint';
    cite.textContent = `OSM way ${s.id} · ${fit.built.toLocaleString()} ${t('si.seats')}`;
    cite.style.cssText = 'font-size:9px;color:var(--text-3);margin:6px 0 0;';
    report.appendChild(cite);

    report.style.display = '';
  }

  function build(): void {
    const s = current();
    if (!s) return;
    const capacity = Number(capI.value) || undefined;
    const tiers = tierSel.value ? Number(tierSel.value) : undefined;
    const roof = roofSel.value ? (roofSel.value as RoofCoverage) : undefined;
    const aisles = Number(aislesI.value) || undefined;
    try {
      const fit = buildStadium({
        id: `osm-${s.id}`,
        name: s.name,
        footprint: s.ring,
        capacity,
        known: { ...(tiers ? { tiers } : {}), ...(roof ? { roof } : {}), ...(aisles ? { aisles } : {}) },
      });
      renderReport(fit, s);
    } catch {
      status.textContent = t('si.buildFailed');
    }
  }

  findBtn.addEventListener('click', () => { void search(); });
  nameI.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void search(); });
  resultSel.addEventListener('change', onPick);
  buildBtn.addEventListener('click', build);

  return box;
}
