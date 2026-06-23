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
import { type TifoSpec, narrowToSingleStand } from '../core/tifoSpec';
import { compileSpec, regionRect, regionPredicate } from '../core/specCompiler';
import { EDITOR_UNITS } from '../core/seatmap';
import { buildStadiumContext, describeStadiumContext } from '../core/stadiumContext';
import { critiqueDesign, repairSpec } from '../core/critique';
import { composeSuperOffline } from '../core/promptDesigner';
import { describeActiveArea } from '../core/activeArea';
import { generateAiTifo, critiqueAiTifo, fetchAiQuota, unlockAi, aiUnlockToken, type AiError, type AiQuota } from '../net/api';
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

/** Decode a data: URL into an ImageBitmap via an <img> (CSP allows img-src data:). */
async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return createImageBitmap(img);
}

export function mountAiPanel(deps: AiPanelDeps): void {
  const { root, store, editor, map, objects, getPreview, refresh } = deps;
  const $ = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);

  const promptEl = $<HTMLTextAreaElement>('#ai-prompt');
  const genBtn = $<HTMLButtonElement>('#ai-generate');
  const superBtn = $<HTMLButtonElement>('#ai-generate-super');
  const statusEl = $('#ai-status');
  const errorEl = $('#ai-error');
  const resultEl = $('#ai-result');
  const summaryEl = $('#ai-summary');
  const regenBtn = $<HTMLButtonElement>('#ai-regen');
  const revertBtn = $<HTMLButtonElement>('#ai-revert');
  const polishBtn = $<HTMLButtonElement>('#ai-polish');
  const shuffleBtn = $<HTMLButtonElement>('#ai-shuffle');
  const quotaEl = $('#ai-quota');
  if (!promptEl || !genBtn) return; // panel not present (e.g. phone build)

  // Snapshot of the canvas before the first AI apply (for revert / clean regen).
  let baselineCells: Uint8Array | null = null;
  let baselinePalette: string[] | null = null;
  let busy = false;
  let lastSuper = false; // so Regenerate repeats the same mode
  let lastSpec: TifoSpec | null = null; // the applied design (for AI critique/polish)
  let lastStadium: string | undefined; // stadium context used (Super AI)
  let shuffleN = 0; // increments per free offline "shuffle"

  const setStatus = (msg: string): void => { if (statusEl) statusEl.textContent = msg; };
  const setError = (msg: string | null): void => {
    if (!errorEl) return;
    errorEl.style.display = msg ? '' : 'none';
    errorEl.textContent = msg ?? '';
  };
  const quotaText = (q: AiQuota): string =>
    q.admin
      ? 'Admin mode — unlimited (AI is in admin-only rebuild).'
      : q.remaining > 0
        ? `${q.remaining} of ${q.limit} free generations left`
        : `No free generations left (used ${q.used}/${q.limit}).`;
  const setQuota = (q: AiQuota | null): void => {
    if (!quotaEl) return;
    quotaEl.textContent = q ? quotaText(q) : isSignedIn() ? '' : 'Sign in to use the AI designer.';
  };

  // ---- admin lock (Phase 1 of the AI rebuild): gate the panel behind unlock ----
  const section = (promptEl.closest('.panel-section') as HTMLElement | null) ?? root;
  const examplesEl = $('#ai-examples');
  const lockEl = document.createElement('div');
  lockEl.className = 'ai-lock';
  lockEl.style.display = 'none';
  lockEl.innerHTML = `
    <p class="hint" style="font-size:12px;color:var(--text-2);margin:0 0 8px;">🔒 The AI Designer is being rebuilt and is currently <b>admin-only</b>.</p>
    <input type="password" id="ai-pw" placeholder="Admin password" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line-1);border-radius:var(--r-md);background:var(--bg-1);color:var(--text-1);" />
    <button id="ai-unlock" class="primary" style="width:100%;margin-top:8px;">Unlock AI</button>
    <p id="ai-unlock-msg" class="hint" style="font-size:11px;color:var(--text-3);margin:8px 0 0;"></p>`;
  section.appendChild(lockEl);

  const lockToggle = ([promptEl, genBtn, superBtn, shuffleBtn, examplesEl, quotaEl] as (HTMLElement | null)[]).filter(
    (e): e is HTMLElement => !!e,
  );
  const setLocked = (locked: boolean): void => {
    lockEl.style.display = locked ? '' : 'none';
    for (const el of lockToggle) el.style.display = locked ? 'none' : '';
    if (locked && resultEl) resultEl.style.display = 'none';
  };
  lockEl.querySelector('#ai-unlock')!.addEventListener('click', async () => {
    const pwEl = lockEl.querySelector('#ai-pw') as HTMLInputElement;
    const msgEl = lockEl.querySelector('#ai-unlock-msg') as HTMLElement;
    msgEl.textContent = 'Checking…';
    if (await unlockAi(pwEl.value)) {
      setLocked(false);
      setStatus('Admin mode unlocked.');
      fetchAiQuota().then(setQuota).catch(() => {});
    } else {
      msgEl.textContent = 'Incorrect password.';
    }
  });

  const captureBaseline = (): void => {
    if (baselineCells === null) {
      baselineCells = store.cells.slice();
      baselinePalette = [...store.palette];
    }
  };

  const applySpec = async (spec: TifoSpec): Promise<void> => {
    captureBaseline();
    objects.clear(); // floating (unbaked) objects don't belong to a fresh generation
    let working = spec;
    compileSpec(working, map, store);

    // Phase 4: deterministic critique of the rendered seats, with ONE bounded
    // repair pass (enlarge fragile text/symbols) when fine detail won't read.
    let critique = critiqueDesign(store.cells, map, working);
    if (critique.paintedSeats > 0 && critique.fragileSeats > critique.paintedSeats * 0.2) {
      const repaired = repairSpec(working, critique);
      if (repaired.changed) {
        working = repaired.spec;
        compileSpec(working, map, store);
        critique = critiqueDesign(store.cells, map, working);
      }
    }

    // Image layers (portraits/figures): place each in its region and BAKE into
    // the seats (reusing the Image-tool quantizer) so it shows in 2D AND 3D and
    // becomes part of the design — not an unbaked floating object.
    for (const layer of working.layers) {
      if (layer.kind !== 'image' || !layer.assetRef) continue;
      try {
        const bmp = await dataUrlToBitmap(layer.assetRef);
        // Phase 3: a portrait belongs to ONE stand — narrow multi-stand/'all'
        // image regions so the hero never stretches across the whole bowl.
        const region = narrowToSingleStand(layer.region);
        const rect = regionRect(region, map);
        // Portrait is the hero: fill the stand's HEIGHT (its natural large axis),
        // let width follow the image aspect, and cap to the stand width so it
        // never bleeds into the neighbouring stands.
        const aspect = bmp.width / bmp.height || 1;
        let h = layer.scaleFrac * rect.height;
        let w = h * aspect;
        const maxW = rect.width * 0.98;
        if (w > maxW) { w = maxW; h = w / aspect; }
        const created = objects.addImage({
          cx: rect.cx,
          cy: rect.cy,
          width: w,
          height: h,
          colorIndex: 0,
          tier: typeof region.tier === 'number' ? region.tier : null,
          bitmap: bmp,
          name: 'AI image',
          dither: layer.dither,
          halftone: layer.halftone,
          alphaThreshold: 128,
        });
        // Clip the bake to the stand so the portrait can't bleed into neighbours.
        objects.bake(created, store, map, EDITOR_UNITS.width, regionPredicate(region, map));
      } catch {
        /* decode/bake failed → skip this image */
      }
    }
    objects.clear(); // floating copies are now baked into the cells

    refresh();
    editor.fitToView();
    if (summaryEl) {
      const base = working.summary ?? working.title;
      summaryEl.textContent = critique.issues.length ? `${base}  ·  ${critique.issues[0]}` : base;
    }
    lastSpec = working; // the live design — input for AI critique/polish
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
    refresh();
    if (resultEl) resultEl.style.display = 'none';
    setStatus('Reverted to your previous canvas.');
  };

  const run = async (prompt: string, opts: { super?: boolean } = {}): Promise<void> => {
    if (busy) return;
    const text = prompt.trim();
    if (!text) { setError('Describe the tifo you want first.'); return; }
    if (!isSignedIn() && !aiUnlockToken()) {
      setError(null);
      setStatus('Sign in or unlock with the admin password.');
      void openAuthModal();
      return;
    }
    const useSuper = !!opts.super;
    lastSuper = useSuper;
    const label = useSuper ? 'Super AI' : 'AI';
    busy = true;
    setError(null);
    genBtn.disabled = true;
    if (superBtn) superBtn.disabled = true;
    if (regenBtn) regenBtn.disabled = true;
    if (polishBtn) polishBtn.disabled = true;
    setStatus(useSuper ? 'Super AI is designing the whole stadium…' : 'Designing your tifo…');
    try {
      // Mode 3 sends the bowl geometry so the director can plan per-stand.
      const stadium = useSuper ? describeStadiumContext(buildStadiumContext(map)) : undefined;
      lastStadium = stadium;
      // Section 3: focus the design on the chosen active area, if any.
      const focus = describeActiveArea();
      const brief = focus ? `${text} — focus the design on ${focus}` : text;
      const res = await generateAiTifo(brief, useSuper ? { mode: 'super', stadium } : {});
      await applySpec(res.spec);
      setStatus(res.source === 'model' ? `Designed with Gemini${useSuper ? ' (Super AI)' : ''}.` : 'Designed (offline designer — model not reached).');
      setQuota(res.quota);
      // Surface server diagnostics in the panel AND the footer "ground bar".
      const notes = res.notes ?? [];
      const bar = document.getElementById('message');
      if (notes.length) {
        setError(notes.join('  ·  '));
        if (bar) bar.textContent = `${label}: ` + notes.join('  ·  ');
      } else {
        setError(null);
        if (bar) bar.textContent = res.source === 'model' ? `${label}: designed with Gemini ✓` : '';
      }
    } catch (e) {
      const err = e as AiError;
      if (err.status === 403) {
        setStatus('');
        setError(err.message || 'AI is admin-only right now.');
        setLocked(true);
      } else if (err.status === 401) {
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
      if (superBtn) superBtn.disabled = false;
      if (regenBtn) regenBtn.disabled = false;
      if (polishBtn) polishBtn.disabled = false;
    }
  };

  // Capture a low-res flat render of the current seats (mirrors viewer.paint2D) for
  // the vision critic — kept local to avoid importing the viewer's heavy 3D graph.
  const captureRender = (): string | undefined => {
    try {
      const bw = map.bounds.maxX - map.bounds.minX;
      const bh = map.bounds.maxY - map.bounds.minY;
      const W = 384;
      const scale = W / bw;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = Math.max(1, Math.round(bh * scale));
      const ctx = c.getContext('2d');
      if (!ctx) return undefined;
      ctx.fillStyle = '#07080A';
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < map.count; i++) {
        ctx.fillStyle = store.cells[i] === 0 ? '#262a33' : store.palette[store.cells[i]] ?? '#262a33';
        const x = (map.xy[i * 2] - map.bounds.minX) * scale;
        const y = (map.xy[i * 2 + 1] - map.bounds.minY) * scale;
        ctx.fillRect(x, y, Math.max(0.6, 3.2 * scale), Math.max(1, 8 * scale * 0.85));
      }
      return c.toDataURL('image/jpeg', 0.82);
    } catch {
      return undefined;
    }
  };

  // Phase 4b: vision critique — send the render + spec, apply the improved design.
  const polish = async (): Promise<void> => {
    const spec = lastSpec;
    if (busy || !spec) return;
    busy = true;
    setError(null);
    genBtn.disabled = true;
    if (superBtn) superBtn.disabled = true;
    if (regenBtn) regenBtn.disabled = true;
    if (polishBtn) polishBtn.disabled = true;
    setStatus('Polishing with AI critique…');
    try {
      const res = await critiqueAiTifo(spec, captureRender(), lastStadium);
      await applySpec(res.spec);
      const bar = document.getElementById('message');
      setStatus(res.source === 'model' ? 'Polished by AI critique.' : 'Kept your design (critique suggested no change).');
      if (bar) bar.textContent = res.source === 'model' ? 'AI: polished ✓' : '';
      if (res.notes && res.notes.length) setError(res.notes.join('  ·  '));
    } catch (e) {
      const err = e as AiError;
      setStatus('');
      setError(err.message || 'Polish failed. Please try again.');
    } finally {
      busy = false;
      genBtn.disabled = false;
      if (superBtn) superBtn.disabled = false;
      if (regenBtn) regenBtn.disabled = false;
      if (polishBtn) polishBtn.disabled = false;
    }
  };

  // Free offline "shuffle": re-compose a multi-stand design client-side (no model,
  // no tokens, instant) with a different variant each click. Portraits need the
  // server path, so a shuffled person-brief shows the layout without the face.
  const shuffle = async (): Promise<void> => {
    if (busy) return;
    const text = promptEl.value.trim();
    if (!text) { setError('Describe the tifo you want first.'); return; }
    busy = true;
    setError(null);
    try {
      shuffleN++;
      await applySpec(composeSuperOffline(text, { variant: shuffleN }));
      setStatus(`Shuffled a free offline variation (#${shuffleN}).`);
      const bar = document.getElementById('message');
      if (bar) bar.textContent = 'AI: offline shuffle ✓ (no tokens)';
    } finally {
      busy = false;
    }
  };

  genBtn.addEventListener('click', () => void run(promptEl.value));
  superBtn?.addEventListener('click', () => void run(promptEl.value, { super: true }));
  regenBtn?.addEventListener('click', () => void run(promptEl.value, { super: lastSuper }));
  polishBtn?.addEventListener('click', () => void polish());
  shuffleBtn?.addEventListener('click', () => void shuffle());
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

  // Determine access: admins (account OR unlock token) see the panel; everyone
  // else gets the lock. The server is the real gate — this is UX only.
  setQuota(null);
  fetchAiQuota()
    .then((q) => { setLocked(false); setQuota(q); })
    .catch((e) => { setLocked((e as AiError).status === 403); });
  void getPreview; // reserved: future per-layer live preview in the 3D view
}
