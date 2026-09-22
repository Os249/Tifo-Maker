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
import { submitStadium, fetchPendingStadiums, reviewStadium, type PendingStadium } from '../net/api';
import { buildStadiumImport } from './stadiumImport';

import { t, t as tr, tl, onLangChange } from './i18n';
import { escapeHtml } from '../core/escape';
export interface StadiumPanelDeps {
  root: HTMLElement;
  map: SeatMap;
  store: DesignStore;
  /** Repaint 2D + 3D after the cells change (orientation). */
  refresh: () => void;
}

const DISCLAIMER =
  'Community-created template inspired by a real-world venue. This template is not affiliated with, endorsed by, or officially connected to any club, stadium owner, or venue operator.';

const fmt = (n?: number): string => (typeof n === 'number' ? n.toLocaleString() : '-');
// `--bg-1` does not exist. It is defined nowhere in the stylesheet, so
// `background:var(--ink-2)` was an invalid value: the whole shorthand fell back
// to its initial value, leaving these controls transparent AND wiping the
// chevron that `select` sets via background-image. That is why the filter
// dropdowns in the screenshot had no arrow and no fill. `--ink-3` is the token
// the stylesheet uses for selects and inputs, and the longhand leaves the
// chevron alone.
const INPUT_CSS =
  'width:100%;box-sizing:border-box;padding:6px;border:1px solid var(--line-1);border-radius:var(--r-md);background-color:var(--ink-3);color:var(--text-1);font:inherit;font-size:11px;';

/**
 * Custom and community stadiums are built, tested and switched off.
 *
 * Both features work — the OSM importer behind the Custom tab resolves a real
 * ground and fits a bowl to within 2.5% of its stated capacity — but the panel
 * is showing only the stadiums we built ourselves for now. Typed `boolean`
 * rather than left as a literal `false` on purpose: TypeScript would otherwise
 * narrow these to `false`, mark every guarded branch unreachable, and stop
 * typechecking the code inside it. This way the hidden features keep compiling
 * and keep failing the build if something else breaks them, and turning either
 * back on is one word.
 *
 * What stays live while they are off:
 *  - `registerCustom()` in main.ts, so a design already saved on a custom
 *    stadium still resolves its template and still opens.
 *  - every custom template in localStorage, untouched.
 */
const CUSTOM_STADIUMS: boolean = false;
const COMMUNITY_STADIUMS: boolean = false;

/** The sources a user can actually reach right now. */
const VISIBLE_SOURCES: StadiumSource[] = [
  'builtin',
  ...(COMMUNITY_STADIUMS ? (['community'] as StadiumSource[]) : []),
  ...(CUSTOM_STADIUMS ? (['custom'] as StadiumSource[]) : []),
];
const isVisible = (e: StadiumEntry): boolean => VISIBLE_SOURCES.includes(e.meta.source);

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
  const reviewEl = $('#stadium-review');
  const reviewListEl = $('#stadium-review-list');
  if (!listEl || !infoEl) return; // panel not present (e.g. phone build)

  const currentId = map.templateRef.id;
  let favorites = loadFavorites();
  // Landing on a hidden tab is a real path, not a hypothetical: a design saved
  // while the Custom tab existed still reports source 'custom' when reopened,
  // and without this the panel would show a tab bar with nothing selected and a
  // list of stadiums the user has no tab for.
  const openingSource = entryById(currentId)?.meta.source;
  let activeTab: Tab = openingSource && VISIBLE_SOURCES.includes(openingSource) ? openingSource : 'builtin';
  let selectedId = currentId;
  let customTools: HTMLElement | null = null;

  let searchEl: HTMLInputElement | null = null;
  let typeEl: HTMLSelectElement | null = null;
  let tiersEl: HTMLSelectElement | null = null;
  let countryEl: HTMLSelectElement | null = null;
  let capEl: HTMLSelectElement | null = null;

  const docTitle = (): string => (document.getElementById('doc-title') as HTMLInputElement | null)?.value ?? '';

  const TABS: { id: Tab; label: string }[] = [
    { id: 'builtin', label: t('sp.builtin') },
    ...(COMMUNITY_STADIUMS ? [{ id: 'community' as Tab, label: t('sp.community') }] : []),
    ...(CUSTOM_STADIUMS ? [{ id: 'custom' as Tab, label: t('sp.custom') }] : []),
    { id: 'favorites', label: `★ ${t('sp.favorites')}` },
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
    searchEl.placeholder = t('sp.search');
    searchEl.style.cssText = INPUT_CSS;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;';
    typeEl = mkSelect([['', t('sp.anyType')], ...(['Bowl', 'Single-tier', 'Two-tier', 'Oval', 'Arena'] as const).map((v) => [v, tl(v)] as [string, string])]);
    tiersEl = mkSelect([['', t('sp.anyTiers')], ['1', `1 ${t('sp.tier')}`], ['2', `2 ${t('sp.tiers')}`], ['3', `3 ${t('sp.tiers')}`]]);
    // "Any region", not "Any country": the catalogue's values are Europe,
    // International, Middle East and South America. Labelling regions as
    // countries is why the filter read as broken even when it worked.
    // Scoped to what is reachable: offering "South America" when the only South
    // American ground is on a hidden tab gives a filter that always finds
    // nothing.
    const regions = catalogCountries(queryCatalog({}).filter(isVisible));
    countryEl = mkSelect([['', t('sp.anyRegion')], ...regions.map((c) => [c, tl(c)] as [string, string])]);
    capEl = mkSelect([['', t('sp.anySize')], ['20000', '20k+'], ['40000', '40k+'], ['60000', '60k+'], ['80000', '80k+']]);
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

  /**
   * Favourites are stored as bare ids, so the tab ignores source and would keep
   * listing a starred custom or community ground after its tab was hidden.
   */
  function visibleEntries(): StadiumEntry[] {
    const found = queryCatalog(buildQuery());
    return activeTab === 'favorites' ? found.filter(isVisible) : found;
  }

  function renderTabs(): void {
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const tab of TABS) {
      const b = document.createElement('button');
      b.className = 'chip';
      // Count what the tab will actually show. The raw set can hold ids of
      // stadiums that no longer exist or are no longer reachable, and a tab
      // reading "(3)" that opens onto one row is its own small bug.
      const favCount = queryCatalog({ ids: favorites }).filter(isVisible).length;
      b.textContent = tab.id === 'favorites' ? `★ ${t('sp.favorites')} (${favCount})` : tab.label;
      if (tab.id === activeTab) b.style.cssText = 'font-weight:600;border-color:var(--text-2);color:var(--text-1);';
      b.addEventListener('click', () => {
        activeTab = tab.id;
        const first = visibleEntries()[0];
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
    star.title = on ? t('sp.unfav') : t('sp.fav');
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
    const entries = visibleEntries();
    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.cssText = 'font-size:11px;color:var(--text-3);margin:4px 0;';
      p.textContent =
        activeTab === 'favorites' ? t('sp.noFav') : activeTab === 'custom' ? t('sp.noCustom') : t('sp.noMatch');
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
        `background:${isSel ? 'rgba(255,255,255,0.05)' : 'var(--ink-2)'};${isCurrent ? 'border-color:var(--text-2);' : ''}`;
      sel.innerHTML =
        `<span><b style="font-size:12px;">${escapeHtml(tl(e.id) === e.id ? e.meta.name : tl(e.id))}</b><br>` +
        `<span style="font-size:10px;color:var(--text-3);">${escapeHtml(e.meta.type ? tl(e.meta.type) : '')}${e.meta.capacity ? ' · ~' + fmt(e.meta.capacity) : ''}</span></span>` +
        `<span style="font-size:10px;color:var(--text-3);white-space:nowrap;">${isCurrent ? `● ${t('sp.current')}` : `${t('sp.load')} →`}</span>`;
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
      [t('sp.region'), e.meta.country ? tl(e.meta.country) : '-'],
      [t('sp.capacity'), e.meta.capacity ? '~' + fmt(e.meta.capacity) : '-'],
      [t('sp.seats'), e.id === currentId ? fmt(map.count) : e.meta.capacity ? '~' + fmt(e.meta.capacity) : '-'],
      [t('sp.sections'), String(sectionCount(e.template))],
      [t('sp.tiersLabel'), String(tierCount(e.template))],
      [t('sp.type'), e.meta.type ? tl(e.meta.type) : '-'],
    ];
    infoEl.innerHTML =
      `<h4 style="margin:0 0 6px;">${escapeHtml(tl(e.id) === e.id ? e.meta.name : tl(e.id))}</h4>` +
      rows
        .map(
          ([k, v]) =>
            `<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--line-1);">` +
            `<span style="color:var(--text-3);">${k}</span><span style="color:var(--text-1);">${escapeHtml(v)}</span></div>`,
        )
        .join('');
    if (discEl) {
      // Driven by `inspiredBy`, not by source. A template resembles a real venue
      // or it does not; who wrote it is a different question, and tying the
      // notice to `source` meant retagging a template silently dropped its
      // disclaimer.
      if (e.meta.inspiredBy) {
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
      'max-width:380px;width:100%;background:var(--ink-1);border:1px solid var(--line-1);border-radius:var(--r-md);padding:18px;color:var(--text-1);box-shadow:0 12px 40px rgba(0,0,0,0.5);';
    box.innerHTML =
      `<h3 style="margin:0 0 8px;font-size:15px;">${t('sp.changeQ')} “${escapeHtml(tl(e.id) === e.id ? e.meta.name : tl(e.id))}”?</h3>` +
      `<p style="font-size:12px;color:var(--text-2);line-height:1.5;margin:0 0 14px;">${t('sp.changeMsg')}</p>` +
      (e.meta.inspiredBy
        ? `<p class="hint" style="font-size:10px;color:var(--text-3);line-height:1.4;margin:0 0 14px;border-left:2px solid var(--line-1);padding-left:8px;">${DISCLAIMER}</p>`
        : '') +
      `<div style="display:flex;gap:8px;justify-content:flex-end;"><button id="sw-cancel">${t('common.cancel')}</button><button id="sw-continue" class="primary">${t('sp.continue')}</button></div>`;
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
      b.textContent = tl(a.label);
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
      { op: 'rotate', label: t('sp.rotate'), icon: 'ti-rotate-clockwise' },
      { op: 'flip-ns', label: t('sp.flipNS'), icon: 'ti-flip-vertical' },
      { op: 'flip-ew', label: t('sp.flipEW'), icon: 'ti-flip-horizontal' },
    ];
    for (const o of ops) {
      const b = document.createElement('button');
      b.style.cssText = 'flex:1;';
      b.innerHTML = `<i class="ti ${o.icon}"></i> ${o.label}`;
      b.addEventListener('click', () => applyOrient(o.op));
      orientEl.appendChild(b);
    }
  }

  // ---- Admin: community review queue (visible only to moderators) ----
  // The /pending endpoint is admin-gated server-side; non-admins get [] (403),
  // so the section stays hidden for them. Fetched once on mount, not per render.
  function reviewRow(s: PendingStadium): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px;border:1px solid var(--line-1);border-radius:var(--r-md);background:var(--ink-2);';
    const tiers = Array.isArray(s.template?.tiers) ? s.template.tiers.length : 0;
    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0;';
    meta.innerHTML =
      `<div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.name)}</div>` +
      `<div style="font-size:10px;color:var(--text-3);">${escapeHtml(s.country ?? '-')} · ${tiers} tier${tiers === 1 ? '' : 's'}</div>`;
    const approve = document.createElement('button');
    approve.textContent = t('sp.approve');
    approve.style.cssText = 'font-size:10px;padding:4px 8px;';
    const reject = document.createElement('button');
    reject.textContent = t('sp.reject');
    reject.style.cssText = 'font-size:10px;padding:4px 8px;';
    const act = async (approveIt: boolean): Promise<void> => {
      approve.disabled = reject.disabled = true;
      const ok = await reviewStadium(s.id, approveIt);
      if (ok) {
        row.remove();
        if (reviewListEl && !reviewListEl.children.length && reviewEl) reviewEl.style.display = 'none';
      } else {
        approve.disabled = reject.disabled = false;
        approve.textContent = approveIt ? t('sp.retry') : t('sp.approve');
      }
    };
    approve.addEventListener('click', () => void act(true));
    reject.addEventListener('click', () => void act(false));
    row.append(meta, approve, reject);
    return row;
  }
  async function renderReviewQueue(): Promise<void> {
    // The queue moderates community submissions. With that switched off there is
    // nothing to moderate, and this is a network request on every panel mount
    // for every user to populate a section nobody can see.
    if (!COMMUNITY_STADIUMS) return;
    if (!reviewEl || !reviewListEl) return;
    const pending = await fetchPendingStadiums();
    if (pending.length === 0) {
      reviewEl.style.display = 'none';
      return;
    }
    reviewListEl.replaceChildren(...pending.map(reviewRow));
    reviewEl.style.display = '';
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
    const submitBtn = document.createElement('button');
    submitBtn.textContent = '▲';
    submitBtn.title = t('sp.submitT');
    submitBtn.setAttribute('aria-label', submitBtn.title);
    submitBtn.style.cssText = 'background:none;border:1px solid var(--line-1);border-radius:var(--r-md);color:var(--text-2);font-size:12px;cursor:pointer;padding:4px 7px;line-height:1;';
    submitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      submitBtn.disabled = true;
      submitBtn.textContent = '…';
      void submitStadium(e.template, e.meta.name, e.meta.country ?? undefined)
        .then((r) => {
          submitBtn.textContent = r ? '✓' : '✗';
          submitBtn.title = r ? t('sp.submitted') : t('sp.submitFail');
        })
        .catch(() => {
          submitBtn.textContent = '✗';
        });
    });
    return [
      submitBtn,
      mk('⤓', t('sp.exportT'), () => downloadJson(e.template)),
      mk('🗑', t('sp.deleteT'), () => {
        removeCustomTemplate(e.id);
        if (selectedId === e.id) selectedId = currentId;
        render();
      }),
    ];
  }

  function buildCustomTools(): void {
    if (!CUSTOM_STADIUMS) return;
    if (customTools || !listEl) return;
    customTools = document.createElement('div');
    customTools.style.cssText = 'margin-bottom:8px;border:1px solid var(--line-1);border-radius:var(--r-md);padding:8px;display:none;';
    const nameI = document.createElement('input');
    nameI.placeholder = t('sp.namePh');
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
    for (const [v, l] of [['standard', t('sp.standard')], ['compact', t('sp.compact')], ['large', t('sp.large')]] as [CustomSize, string][]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      sizeSel.appendChild(o);
    }
    grid.append(baseSel, sizeSel);
    const createBtn = document.createElement('button');
    createBtn.className = 'primary';
    createBtn.textContent = t('sp.create');
    createBtn.style.cssText = 'width:100%;margin-top:6px;';
    createBtn.addEventListener('click', () => {
      const t = createCustomTemplate({ name: nameI.value.trim() || 'Custom stadium', baseId: baseSel.value, size: sizeSel.value as CustomSize });
      if (!t) return;
      if (!addCustomTemplate(t)) { importMsg.textContent = tr('sp.saveFailed'); return; }
      nameI.value = '';
      selectedId = t.id;
      render();
    });
    const importI = document.createElement('textarea');
    importI.placeholder = t('sp.importPh');
    importI.rows = 2;
    importI.style.cssText = INPUT_CSS + 'margin-top:8px;resize:vertical;';
    const importBtn = document.createElement('button');
    importBtn.textContent = t('sp.import');
    importBtn.style.cssText = 'width:100%;margin-top:6px;';
    const importMsg = document.createElement('p');
    importMsg.className = 'hint';
    importMsg.style.cssText = 'font-size:10px;color:var(--text-3);margin:4px 0 0;';
    importBtn.addEventListener('click', () => {
      const parsed = parseImportedTemplate(importI.value);
      if (!parsed) {
        importMsg.textContent = t('sp.importBad');
        return;
      }
      if (!addCustomTemplate(parsed)) { importMsg.textContent = t('sp.saveFailed'); return; }
      importI.value = '';
      importMsg.textContent = `${t('sp.imported')} “${parsed.name}”.`;
      selectedId = parsed.id;
      render();
    });
    // Building from a real ground sits under hand-authoring, not instead of it:
    // the two answer different questions, and someone who wants an exact bowl
    // they invented should not have to scroll past a search box to get it.
    const fromReal = buildStadiumImport({
      onAdded: (id) => {
        selectedId = id;
        render();
      },
    });
    customTools.append(nameI, grid, createBtn, importI, importBtn, importMsg, fromReal);
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
  void renderReviewQueue(); // one admin-gated probe; hides itself for non-admins

  // Switching language left this panel in English.
  //
  // setLang re-applies every [data-i18n] element in the document, which covers
  // the headings in index.html but not a single control in here: the filters and
  // the orientation buttons are built in JS with t(), and both are guarded by a
  // `dataset.built` flag so they are built exactly once and never again. The
  // tabs, list and info re-read their strings on every render(), but nothing
  // called render() on a language change either — i18n has always exposed
  // onLangChange and, before this, nothing in the app had ever subscribed to it.
  //
  // Clearing the two guards and re-rendering rebuilds the panel in the new
  // language, keeping the selected stadium, tab and filters as they were.
  onLangChange(() => {
    const keptTab = activeTab;
    const keptSearch = searchEl?.value ?? '';
    const keptType = typeEl?.value ?? '';
    const keptTiers = tiersEl?.value ?? '';
    const keptCountry = countryEl?.value ?? '';
    const keptCap = capEl?.value ?? '';
    if (filtersEl) { delete filtersEl.dataset.built; filtersEl.innerHTML = ''; }
    if (orientEl) { delete orientEl.dataset.built; orientEl.innerHTML = ''; }
    activeTab = keptTab;
    render();
    if (searchEl) searchEl.value = keptSearch;
    if (typeEl) typeEl.value = keptType;
    if (tiersEl) tiersEl.value = keptTiers;
    if (countryEl) countryEl.value = keptCountry;
    if (capEl) capEl.value = keptCap;
    renderList();
  });
}
