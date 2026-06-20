/**
 * AI Tifo Designer panel.
 *
 * The thin UI layer over the generation pipeline: takes a prompt, asks the
 * server for a validated TifoSpec, and compiles it into the live DesignStore via
 * compileSpec(). The result is an ordinary editable design — every tool, undo,
 * save and export work on it unchanged.
 *
 * Non-destructive by design: the canvas state from before the first generation
 * is snapshotted, so "Regenerate" replaces the previous result (compileSpec
 * clears + repaints in one stroke) and "Revert" restores the original canvas.
 * The spec is retained in memory so the result can be regenerated/refined.
 */

import type { Editor } from '../render/editor';
import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';
import type { ObjectLayer } from '../core/objects';
import type { Preview3D } from '../render/preview3d';
import type { TifoSpec } from '../core/tifoSpec';
import { compileSpec } from '../core/specCompiler';
import { generateAiTifo, fetchAiQuota, type AiError, type AiQuota } from '../net/api';
import { isSignedIn } from '../net/api';
import { openAuthModal } from './authModal';

export interface AiPanelDeps {
  root: HTMLElement;
  store: DesignStore;
  editor: Editor;
  map: SeatMap;
  objects: ObjectLayer;
  getPreview?: () => Preview3D | null;
  /** Refresh swatch UI + 3D after the palette/cells change (from the toolbar). */
  refresh: () => void;
}

export function mountAiPanel(deps: AiPanelDeps): void {
  const { root, store, editor, map, objects, getPreview, refresh } = deps;
  const $ = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);

  const promptEl = $<HTMLTextAreaElement>('#ai-prompt');
  const genBtn = $<HTMLButtonElement>('#ai-generate');
  const statusEl = $('#ai-status');
  const errorEl = $('#ai-error');
  const resultEl = $('#ai-result');
  const summaryEl = $('#ai-summary');
  const regenBtn = $<HTMLButtonElement>('#ai-regen');
  const revertBtn = $<HTMLButtonElement>('#ai-revert');
  const quotaEl = $('#ai-quota');
  if (!promptEl || !genBtn) return; // panel not present (e.g. phone build)

  // Snapshot of the canvas before the first AI apply (for revert / clean regen).
  let baselineCells: Uint8Array | null = null;
  let baselinePalette: string[] | null = null;
  let lastSpec: TifoSpec | null = null;
  let busy = false;

  const setStatus = (msg: string): void => { if (statusEl) statusEl.textContent = msg; };
  const setError = (msg: string | null): void => {
    if (!errorEl) return;
    errorEl.style.display = msg ? '' : 'none';
    errorEl.textContent = msg ?? '';
  };
  const quotaText = (q: AiQuota): string =>
    q.remaining > 0
      ? `${q.remaining} of ${q.limit} free generations left`
      : `No free generations left (used ${q.used}/${q.limit}).`;
  const setQuota = (q: AiQuota | null): void => {
    if (!quotaEl) return;
    quotaEl.textContent = q ? quotaText(q) : isSignedIn() ? '' : 'Sign in to use the AI designer — 5 free generations.';
  };

  const captureBaseline = (): void => {
    if (baselineCells === null) {
      baselineCells = store.cells.slice();
      baselinePalette = [...store.palette];
    }
  };

  const applySpec = (spec: TifoSpec): void => {
    captureBaseline();
    objects.clear(); // floating (unbaked) objects don't belong to a fresh generation
    const result = compileSpec(spec, map, store);
    lastSpec = spec;
    refresh();
    editor.fitToView();
    if (summaryEl) {
      const warn = result.fragileSeats > result.seatsPainted * 0.25
        ? ' · some thin detail may not read at scale'
        : '';
      summaryEl.textContent = (spec.summary ?? spec.title) + warn;
    }
    if (resultEl) resultEl.style.display = '';
  };

  const revert = (): void => {
    if (baselineCells === null || baselinePalette === null) return;
    store.setPalette(baselinePalette);
    store.beginStroke();
    for (let i = 0; i < map.count && i < baselineCells.length; i++) store.paint(i, baselineCells[i]);
    store.commitStroke();
    baselineCells = null;
    baselinePalette = null;
    lastSpec = null;
    refresh();
    if (resultEl) resultEl.style.display = 'none';
    setStatus('Reverted to your previous canvas.');
  };

  const run = async (prompt: string): Promise<void> => {
    if (busy) return;
    const text = prompt.trim();
    if (!text) { setError('Describe the tifo you want first.'); return; }
    if (!isSignedIn()) {
      setError(null);
      setStatus('Sign in to use the AI designer.');
      void openAuthModal();
      return;
    }
    busy = true;
    setError(null);
    genBtn.disabled = true;
    if (regenBtn) regenBtn.disabled = true;
    setStatus('Designing your tifo…');
    try {
      const res = await generateAiTifo(text);
      applySpec(res.spec);
      setStatus(res.source === 'model' ? 'Designed with AI.' : 'Designed.');
      setQuota(res.quota);
    } catch (e) {
      const err = e as AiError;
      if (err.status === 401) {
        setStatus('');
        setError('Please sign in to generate.');
        void openAuthModal();
      } else if (err.status === 402) {
        setStatus('');
        setError(err.message || 'You have used all your free AI generations.');
        if (err.quota) setQuota(err.quota);
      } else {
        setStatus('');
        setError(err.message || 'Generation failed. Please try again.');
      }
    } finally {
      busy = false;
      genBtn.disabled = false;
      if (regenBtn) regenBtn.disabled = false;
    }
  };

  genBtn.addEventListener('click', () => void run(promptEl.value));
  regenBtn?.addEventListener('click', () => void run(promptEl.value));
  revertBtn?.addEventListener('click', revert);
  // Ctrl/Cmd+Enter generates from the textarea.
  promptEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void run(promptEl.value);
    }
  });
  // Example chips fill the prompt.
  for (const chip of Array.from(root.querySelectorAll<HTMLButtonElement>('#ai-examples [data-ex]'))) {
    chip.addEventListener('click', () => {
      promptEl.value = chip.dataset.ex ?? '';
      promptEl.focus();
    });
  }

  // Initial quota (best-effort; ignored when signed out).
  setQuota(null);
  if (isSignedIn()) fetchAiQuota().then(setQuota).catch(() => {});
  void getPreview; // reserved: future per-layer live preview in the 3D view
}
