import './seat.css';
import { initLang, t } from './ui/i18n';
import { generateSeatMapAsync } from './workers/client';
import { TEMPLATES } from './core/template';
import { DesignStore } from './core/design';
import { loadDesign, fetchDesignTemplate } from './net/api';
import {
  listSections,
  listRows,
  seatCountInRow,
  resolveSeat,
  sectionLabel,
  type SeatChoice,
} from './core/seatLocator';
import type { SeatMap } from './core/types';

const app = document.getElementById('seat-app')!;
// Apply the saved language (also sets dir=rtl on <html> for Arabic) before render.
initLang();

/** Parse /s/:id (the QR target). */
function designIdFromPath(): string | null {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9-]+)\/?$/);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get('d');
  return q && /^[A-Za-z0-9-]+$/.test(q) ? q : null;
}

const EMPTY_HEX = '#3a3f4b'; // an unlit seat (index 0)

function contrastInk(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // relative luminance
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0E0A1A' : '#ffffff';
}

function colorName(hex: string): string {
  // Friendly, approximate name so the instruction reads naturally.
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 28) return r > 200 ? 'white' : r < 60 ? 'black' : 'grey';
  if (r >= g && r >= b) return g > 150 ? 'orange/yellow' : b > 120 ? 'pink/red' : 'red';
  if (g >= r && g >= b) return b > 150 ? 'teal' : 'green';
  return r > 120 ? 'purple' : 'blue';
}

async function main(): Promise<void> {
  const id = designIdFromPath();
  if (!id) {
    app.innerHTML = errorScreen(t('seat.errNoCodeTitle'), t('seat.errNoCodeBody'));
    return;
  }

  let map: SeatMap;
  let store: DesignStore;
  let title = 'the display';
  try {
    const info = await fetchDesignTemplate(id);
    const tpl = TEMPLATES.find((t) => t.id === info.templateId) ?? TEMPLATES[0];
    map = await generateSeatMapAsync(tpl.id);
    store = new DesignStore(map, ['#262a33', '#1c5fd9']);
    const loaded = await loadDesign(store, id);
    title = loaded?.title || 'the display';
  } catch {
    app.innerHTML = errorScreen(t('seat.errLoadTitle'), t('seat.errLoadBody'));
    return;
  }

  const sections = listSections(map);
  const choice: Partial<SeatChoice> = {};

  renderPicker();

  function renderPicker(): void {
    app.innerHTML = `
      <div class="seat-head">
        <div class="seat-brand">TIFO<b>MAKER</b></div>
        <div class="seat-title">${escapeHtml(title)}</div>
        <p class="seat-intro">${t('seat.intro')}</p>
      </div>
      <div class="seat-form">
        <label class="seat-field">
          <span>${t('seat.section')}</span>
          <select id="sel-section">
            <option value="">${t('seat.sectionPick')}</option>
            ${sections.map((s) => `<option value="${s}">${sectionLabel(s, sections.length)}</option>`).join('')}
          </select>
        </label>
        <label class="seat-field" id="row-field" hidden>
          <span>${t('seat.row')}</span>
          <select id="sel-row"><option value="">${t('seat.rowPick')}</option></select>
        </label>
        <label class="seat-field" id="seat-field" hidden>
          <span>${t('seat.seat')}</span>
          <select id="sel-seat"><option value="">${t('seat.seatPick')}</option></select>
        </label>
        <button class="seat-go" id="seat-go" disabled>${t('seat.showCard')}</button>
      </div>
      <div class="seat-foot">${t('seat.madeWith')} · <a href="/">tifomaker.org</a></div>`;

    const selSection = document.getElementById('sel-section') as HTMLSelectElement;
    const rowField = document.getElementById('row-field')!;
    const selRow = document.getElementById('sel-row') as HTMLSelectElement;
    const seatField = document.getElementById('seat-field')!;
    const selSeat = document.getElementById('sel-seat') as HTMLSelectElement;
    const go = document.getElementById('seat-go') as HTMLButtonElement;

    const refreshGo = (): void => {
      go.disabled = !(choice.section !== undefined && choice.tier !== undefined && choice.row !== undefined && choice.seatInRow);
    };

    selSection.addEventListener('change', () => {
      choice.section = selSection.value === '' ? undefined : Number(selSection.value);
      choice.tier = undefined;
      choice.row = undefined;
      choice.seatInRow = undefined;
      seatField.hidden = true;
      if (choice.section === undefined) {
        rowField.hidden = true;
        refreshGo();
        return;
      }
      const rows = listRows(map, choice.section);
      selRow.innerHTML =
        `<option value="">${t('seat.rowPick')}</option>` +
        rows.map((r, i) => `<option value="${i}">${r.label}</option>`).join('');
      rowField.hidden = false;
      refreshGo();
    });

    selRow.addEventListener('change', () => {
      if (choice.section === undefined || selRow.value === '') {
        seatField.hidden = true;
        choice.row = undefined;
        refreshGo();
        return;
      }
      const rows = listRows(map, choice.section);
      const r = rows[Number(selRow.value)];
      choice.tier = r.tier;
      choice.row = r.row;
      const n = seatCountInRow(map, choice.section, r.tier, r.row);
      selSeat.innerHTML =
        `<option value="">${t('seat.seatPick')}</option>` +
        Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${t('seat.seatN')} ${i + 1}</option>`).join('');
      seatField.hidden = false;
      choice.seatInRow = undefined;
      refreshGo();
    });

    selSeat.addEventListener('change', () => {
      choice.seatInRow = selSeat.value === '' ? undefined : Number(selSeat.value);
      refreshGo();
    });

    go.addEventListener('click', () => {
      const cell = resolveSeat(map, choice as SeatChoice);
      if (cell < 0) return;
      const idx = store.cells[cell];
      const hex = idx === 0 ? EMPTY_HEX : store.palette[idx] ?? EMPTY_HEX;
      renderCard(hex, idx === 0);
    });
  }

  function renderCard(hex: string, isEmpty: boolean): void {
    const ink = contrastInk(hex);
    const where = `${sectionLabel(choice.section!, sections.length)} · ${t('seat.rowLabel')} ${(document.getElementById('sel-row') as HTMLSelectElement | null)?.selectedOptions[0]?.textContent ?? ''} · ${t('seat.seatN')} ${choice.seatInRow}`;
    app.innerHTML = `
      <div class="card-screen" style="background:${hex};color:${ink}">
        <button class="card-back" id="card-back" style="color:${ink};border-color:${ink}">${t('seat.changeSeat')}</button>
        <div class="card-where">${escapeHtml(where)}</div>
        <div class="card-main">
          ${
            isEmpty
              ? `<div class="card-empty-mark">✕</div>
                 <div class="card-instruction">${t('seat.noCardTitle')}</div>
                 <div class="card-sub">${t('seat.noCardSub')}</div>`
              : `<div class="card-hold">${t('seat.holdUp')}</div>
                 <div class="card-colorname">${colorName(hex)}</div>
                 <div class="card-sub">${t('seat.raiseWhen')}</div>`
          }
        </div>
        <div class="card-foot" style="color:${ink}">
          <span class="card-foot-title">${escapeHtml(title)}</span>
          <span class="card-foot-badge">${t('seat.madeWith')}</span>
        </div>
      </div>`;
    document.getElementById('card-back')!.addEventListener('click', () => renderPicker());
    // Keep the screen awake while showing the card, if supported.
    requestWakeLock();
  }
}

let wakeLock: unknown = null;
async function requestWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } };
    if (nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
  } catch {
    /* not supported / denied — fine */
  }
  void wakeLock;
}

function errorScreen(title: string, body: string): string {
  return `
    <div class="seat-head">
      <div class="seat-brand">TIFO<b>MAKER</b></div>
      <div class="seat-error-title">${escapeHtml(title)}</div>
      <p class="seat-intro">${escapeHtml(body)}</p>
      <a class="seat-go" style="display:inline-block;text-decoration:none;text-align:center;" href="/">${t('seat.goHome')}</a>
    </div>`;
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

void main();
