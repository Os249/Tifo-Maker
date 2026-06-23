/**
 * Stadium panel (Mode: 'stadium') — the central place to choose and configure the
 * bowl, with NO tifo-editing tools. Mirrors the AI panel: a rail button toggles
 * panelMode='stadium' and this fills the #ctx-stadium-config section.
 *
 * Sections:
 *   1 Selection : Built-in / Community / Custom / ★ Favourites tabs, a search box
 *                 + Type/Tiers/Country/Capacity filters, an entry list with a
 *                 per-row favourite star, and a confirmation modal before any
 *                 switch (reuses the proven stash→reload→remap).
 *   2 Info      : metadata for the selected stadium (exact seat count for the one
 *                 that's loaded; approximate capacity for others).
 *   8 Disclaimer: the non-affiliation notice for community templates.
 *
 * Active-area (Section 3) and orientation (Section 4) arrive in Wave C; the
 * catalog + query helpers already make those additive.
 */

import type { DesignStore } from '../core/design';
import type { SeatMap, StadiumTemplate } from '../core/types';
import {
  entryById,
  queryCatalog,
  catalogCountries,
  tierCount,
  sectionCount,
  type StadiumEntry,
  type StadiumSource,
  type StadiumType,
  type CatalogQuery,
} from '../core/stadiumCatalog';
import { requestStadiumSwitch } from './stadiumSwitch';
import { loadFavorites, toggleFavorite } from './stadiumFavorites';
import { ACTIVE_AREAS, getActiveArea, setActiveArea } from '../core/activeArea';
import { orientCells, type OrientOp } from '../core/orientation';
import { createCustomTemplate, addCustomTemplate, removeCustomTemplate, parseImportedTemplate, exportTemplate, type CustomSize } from '../core/customStadiums';

export interface StadiumPanelDeps {
  root: HTMLElement;
  map: SeatMap;
  store: DesignStore;
  /** Repaint 2D + 3D after the cells change (orientation). */
  refresh: () => void;
}

const DISCLAIMER =
  'Community-created template inspired by a real-world venue. This template is not affiliated with, endorsed by, or officially connected to any club, stadium owner, or venue operator.';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
const fmt = (n?: number): string => (typeof n === 'number' ? n.toLocaleString() : '—');
const INPUT_CSS =
  'width:100%;box-sizing:border-box;padding:6px;border:1px solid var(--line-1);border-radius:var(--r-md);background:var(--bg-1);color:var(--text-1);font:inherit;font-size:11px;';

type Tab = StadiumSource | 'favorites';

export function mountStadiumPanel(deps: StadiumPanelDeps): void {
  const { root, map, store, refresh } = deps;
  const $ = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  const tabsEl = $('#stadium-tabs');
  const filtersEl = $('#stadium-filters');
  const listEl = $('#stadium-list');
  const infoEl = $('#stadium-info');
  const discEl = $('#stadium-disclaimer');
  const areaEl = $('#stadium-area');
  const orientEl = $('#stadium-orient');
  if (!listEl || !infoEl) return; // panel not present (e.g. phone build)

  const currentId = map.templateRef.id;
  let favorites = loadFavorites();
  let activeTab: Tab = entryById(currentId)?.meta.source ?? 'builtin';
  let selectedId = currentId;
  let customTools: HTMLElement | null = null;

  let searchEl: HTMLInputElement | null = null;
  let typeEl: HTMLSelectElement | null = null;
  let tiersEl: HTMLSelectElement | null = null;
  let countryEl: HTMLSelectElement | null = null;
  let capEl: HTMLSelectElement | null = null;

  const docTitle = (): string => (document.getElementById('doc-title') as HTMLInputElement | null)?.value ?? '';

  const TABS: { id: Tab; label: string }[] = [
    { id: 'builtin', label: 'Built-in' },
    { id: 'community', label: 'Community' },
    { id: 'custom', label: 'Custom' },
    { id: 'favorites', label: '★ Favourites' },
  ];

  function mkSelect(opts: [string, string][]): HTMLSelectElement {
    const s = document.createElement('select');
    s.style.cssText = INPUT_CSS;
    for (const [v, l] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      s.appendChild(o);
    }
    return s;
  }

  function buildFilters(): void {
    if (!filtersEl || filtersEl.dataset.built) return;
    filtersEl.dataset.built = '1';
    searchEl = document.createElement('input');
    searchEl.type = 'search';
    searchEl.placeholder = 'Search stadiums…';
    searchEl.style.cssText = INPUT_CSS;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;';
    typeEl = mkSelect([['', 'Any type'], ['Bowl', 'Bowl'], ['Single-tier', 'Single-tier'], ['Two-tier', 'Two-tier'], ['Oval', 'Oval'], ['Arena', 'Arena']]);
    tiersEl = mkSelect([['', 'Any tiers'], ['1', '1 tier'], ['2', '2 tiers'], ['3', '3 tiers']]);
    countryEl = mkSelect([['', 'Any country'], ...catalogCountries().map((c) => [c, c] as [string, string])]);
    capEl = mkSelect([['', 'Any size'], ['20000', '20k+'], ['40000', '40k+'], ['60000', '60k+'], ['80000', '80k+']]);
    grid.append(typeEl, tiersEl, countryEl, capEl);
    filtersEl.append(searchEl, grid);
    for (const el of [searchEl, typeEl, tiersEl, countryEl, capEl]) el.addEventListener('input', () => renderList());
  }

  function buildQuery(): CatalogQuery {
    const q: CatalogQuery = {};
    if (searchEl?.value.trim()) q.search = searchEl.value.trim();
    if (typeEl?.value) q.type = typeEl.value as StadiumType;
    if (tiersEl?.value) q.tiers = Number(tiersEl.value);
    if (countryEl?.value) q.country = countryEl.value;
    if (capEl?.value) q.minCapacity = Number(capEl.value);
    if (activeTab === 'favorites') q.ids = favorites;
    else q.source = activeTab;
    return q;
  }

  function renderTabs(): void {
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const t of TABS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t.id === 'favorites' ? `★ Favourites (${favorites.size})` : t.label;
      if (t.id === activeTab) b.style.cssText = 'font-weight:600;border-color:var(--text-2);color:var(--text-1);';
      b.addEventListener('click', () => {
        activeTab = t.id;
        const first = queryCatalog(buildQuery())[0];
        selectedId = first ? first.id : selectedId;
        render();
      });
      tabsEl.appendChild(b);
    }
  }

  function favStar(e: StadiumEntry): HTMLButtonElement {
    const star = document.createElement('button');
    const on = favorites.has(e.id);
    star.textContent = on ? '★' : '☆';
    star.title = on ? 'Remove from favourites' : 'Add to favourites';
    star.setAttribute('aria-label', star.title);
    star.style.cssText = 'background:none;border:1px solid var(--line-1);border-radius:var(--r-md);color:var(--text-2);font-size:13px;cursor:pointer;padding:4px 7px;line-height:1;';
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      favorites = toggleFavorite(favorites, e.id);
      render();
    });
    return star;
  }

  function renderList(): void {
    if (!listEl) return;
    listEl.innerHTML = '';
    const entries = queryCatalog(buildQuery());
    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.cssText = 'font-size:11px;color:var(--text-3);margin:4px 0;';
      p.textContent =
        activeTab === 'favorites' ? 'No favourites yet — tap ☆ on a stadium to add it.' : activeTab === 'custom' ? 'No custom stadiums yet — create one above.' : 'No stadiums match your filters.';
      listEl.appendChild(p);
      return;
    }
    for (const e of entries) {
      const isCurrent = e.id === currentId;
      const isSel = e.id === selectedId;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const sel = document.createElement('button');
      sel.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;gap:8px;flex:1;text-align:left;' +
        'padding:8px;border:1px solid var(--line-1);border-radius:var(--r-md);color:var(--text-1);cursor:pointer;' +
        `background:${isSel ? 'rgba(255,255,255,0.05)' : 'var(--bg-1)'};${isCurrent ? 'border-color:var(--text-2);' : ''}`;
      sel.innerHTML =
        `<span><b style="font-size:12px;">${esc(e.meta.name)}</b><br>` +
        `<span style="font-size:10px;color:var(--text-3);">${esc(e.meta.type ?? '')}${e.meta.capacity ? ' · ~' + fmt(e.meta.capacity) : ''}</span></span>` +
        `<span style="font-size:10px;color:var(--text-3);white-space:nowrap;">${isCurrent ? '● Current' : 'Load →'}</span>`;
      sel.addEventListener('click', () => {
        selectedId = e.id;
        renderList();
        renderInfo();
        if (!isCurrent) confirmSwitch(e);
      });
      row.append(sel, favStar(e));
      if (e.meta.source === 'custom') for (const b of customRowButtons(e)) row.append(b);
      listEl.appendChild(row);
    }
  }

  function renderInfo(): void {
    if (!infoEl) return;
    const e = entryById(selectedId) ?? entryById(currentId);
    if (!e) {
      infoEl.innerHTML = '';
      if (discEl) discEl.style.display = 'none';
      return;
    }
    const rows: [string, string][] = [
      ['Country', e.meta.country ?? '—'],
      ['Capacity', e.meta.capacity ? '~' + fmt(e.meta.capacity) : '—'],
      ['Seats', e.id === currentId ? fmt(map.count) : e.meta.capacity ? '~' + fmt(e.meta.capacity) : '—'],
      ['Sections', String(sectionCount(e.template))],
      ['Tiers', String(tierCount(e.template))],
      ['Type', e.meta.type ?? '—'],
    ];
    infoEl.innerHTML =
      `<h4 style="margin:0 0 6px;">${esc(e.meta.name)}</h4>` +
      rows
        .map(
          ([k, v]) =>
            `<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--line-1);">` +
            `<span style="color:var(--text-3);">${k}</span><span style="color:var(--text-1);">${esc(v)}</span></div>`,
        )
        .join('');
    if (discEl) {
      if (e.meta.source === 'community') {
        discEl.style.display = '';
        discEl.innerHTML = `<p class="hint" style="font-size:10px;color:var(--text-3);line-height:1.4;border-left:2px solid var(--line-1);padding-left:8px;margin:0;">${DISCLAIMER}</p>`;
      } else {
        discEl.style.display = 'none';
        discEl.innerHTML = '';
      }
    }
  }

  function confirmSwitch(e: StadiumEntry): void {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText =
      'max-width:380px;width:100%;background:var(--bg-1);border:1px solid var(--line-1);border-radius:var(--r-md);padding:18px;color:var(--text-1);box-shadow:0 12px 40px rgba(0,0,0,0.5);';
    box.innerHTML =
      `<h3 style="margin:0 0 8px;font-size:15px;">Change stadium to “${esc(e.meta.name)}”?</h3>` +
      `<p style="font-size:12px;color:var(--text-2);line-height:1.5;margin:0 0 14px;">Changing stadiums may reposition, resize, crop, or remove parts of your current design because stadium layouts differ. Are you sure you want to continue?</p>` +
      (e.meta.source === 'community'
        ? `<p class="hint" style="font-size:10px;color:var(--text-3);line-height:1.4;margin:0 0 14px;border-left:2px solid var(--line-1);padding-left:8px;">${DISCLAIMER}</p>`
        : '') +
      `<div style="display:flex;gap:8px;justify-content:flex-end;"><button id="sw-cancel">Cancel</button><button id="sw-continue" class="primary">Continue</button></div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = (): void => overlay.remove();
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    document.addEventListener('keydown', function onEsc(ev) {
      if (ev.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onEsc);
      }
    });
    (box.querySelector('#sw-cancel') as HTMLButtonElement).addEventListener('click', close);
    (box.querySelector('#sw-continue') as HTMLButtonElement).addEventListener('click', () => {
      close();
      requestStadiumSwitch(e.id, { fromId: currentId, palette: store.palette, cells: store.cells, title: docTitle() });
    });
    (box.querySelector('#sw-continue') as HTMLButtonElement).focus();
  }

  // ---- Section 3: Active Tifo Area ----
  function renderArea(): void {
    if (!areaEl) return;
    areaEl.innerHTML = '';
    const cur = getActiveArea();
    for (const a of ACTIVE_AREAS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = a.label;
      if (a.id === cur) b.style.cssText = 'font-weight:600;border-color:var(--text-2);color:var(--text-1);';
      b.addEventListener('click', () => {
        setActiveArea(a.id);
        renderArea();
      });
      areaEl.appendChild(b);
    }
  }

  // ---- Section 4: Stadium Orientation (re-orient the design; undoable) ----
  function applyOrient(op: OrientOp): void {
    store.beginStroke();
    const next = orientCells(store.cells, map, op);
    for (let i = 0; i < map.count; i++) store.paint(i, next[i]);
    store.commitStroke();
    refresh();
  }
  function renderOrient(): void {
    if (!orientEl || orientEl.dataset.built) return;
    orientEl.dataset.built = '1';
    const ops: { op: OrientOp; label: string; icon: string }[] = [
      { op: 'rotate', label: 'Rotate', icon: 'ti-rotate-clockwise' },
      { op: 'flip-ns', label: 'Flip N/S', icon: 'ti-flip-vertical' },
      { op: 'flip-ew', label: 'Flip E/W', icon: 'ti-flip-horizontal' },
    ];
    for (const o of ops) {
      const b = document.createElement('button');
      b.style.cssText = 'flex:1;';
      b.innerHTML = `<i class="ti ${o.icon}"></i> ${o.label}`;
      b.addEventListener('click', () => applyOrient(o.op));
      orientEl.appendChild(b);
    }
  }

  // ---- Section 7: custom-stadium authoring (Custom tab) ----
  function downloadJson(t: StadiumTemplate): void {
    try {
      const blob = new Blob([exportTemplate(t)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${t.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* download unavailable */
    }
  }

  function customRowButtons(e: StadiumEntry): HTMLButtonElement[] {
    const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'background:none;border:1px solid var(--line-1);border-radius:var(--r-md);color:var(--text-2);font-size:12px;cursor:pointer;padding:4px 7px;line-height:1;';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
      return b;
    };
    return [
      mk('⤓', 'Export this stadium as JSON (share it)', () => downloadJson(e.template)),
      mk('🗑', 'Delete this custom stadium', () => {
        removeCustomTemplate(e.id);
        if (selectedId === e.id) selectedId = currentId;
        render();
      }),
    ];
  }

  function buildCustomTools(): void {
    if (customTools || !listEl) return;
    customTools = document.createElement('div');
    customTools.style.cssText = 'margin-bottom:8px;border:1px solid var(--line-1);border-radius:var(--r-md);padding:8px;display:none;';
    const nameI = document.createElement('input');
    nameI.placeholder = 'Custom stadium name';
    nameI.style.cssText = INPUT_CSS;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;';
    const baseSel = document.createElement('select');
    baseSel.style.cssText = INPUT_CSS;
    for (const e of [...queryCatalog({ source: 'builtin' }), ...queryCatalog({ source: 'community' })]) {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = `Base: ${e.meta.name}`;
      baseSel.appendChild(o);
    }
    const sizeSel = document.createElement('select');
    sizeSel.style.cssText = INPUT_CSS;
    for (const [v, l] of [['standard', 'Standard'], ['compact', 'Compact'], ['large', 'Large']] as [CustomSize, string][]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      sizeSel.appendChild(o);
    }
    grid.append(baseSel, sizeSel);
    const createBtn = document.createElement('button');
    createBtn.className = 'primary';
    createBtn.textContent = 'Create custom stadium';
    createBtn.style.cssText = 'width:100%;margin-top:6px;';
    createBtn.addEventListener('click', () => {
      const t = createCustomTemplate({ name: nameI.value.trim() || 'Custom stadium', baseId: baseSel.value, size: sizeSel.value as CustomSize });
      if (!t) return;
      addCustomTemplate(t);
      nameI.value = '';
      selectedId = t.id;
      render();
    });
    const importI = document.createElement('textarea');
    importI.placeholder = 'Paste a stadium JSON to import…';
    importI.rows = 2;
    importI.style.cssText = INPUT_CSS + 'margin-top:8px;resize:vertical;';
    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import from JSON';
    importBtn.style.cssText = 'width:100%;margin-top:6px;';
    const importMsg = document.createElement('p');
    importMsg.className = 'hint';
    importMsg.style.cssText = 'font-size:10px;color:var(--text-3);margin:4px 0 0;';
    importBtn.addEventListener('click', () => {
      const t = parseImportedTemplate(importI.value);
      if (!t) {
        importMsg.textContent = 'That JSON is not a valid stadium template.';
        return;
      }
      addCustomTemplate(t);
      importI.value = '';
      importMsg.textContent = `Imported “${t.name}”.`;
      selectedId = t.id;
      render();
    });
    customTools.append(nameI, grid, createBtn, importI, importBtn, importMsg);
    listEl.parentElement?.insertBefore(customTools, listEl);
  }

  function render(): void {
    buildFilters();
    buildCustomTools();
    if (customTools) customTools.style.display = activeTab === 'custom' ? '' : 'none';
    renderTabs();
    renderList();
    renderInfo();
    renderArea();
    renderOrient();
  }
  render();
}
