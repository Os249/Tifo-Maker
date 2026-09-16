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
import { loadTifoFonts } from '../core/tifoFonts';
import { EDITOR_UNITS } from '../core/seatmap';
import { buildStadiumContext, describeStadiumContext } from '../core/stadiumContext';
import { critiqueDesign, repairSpec } from '../core/critique';
import { designShuffle } from '../core/promptDesigner';
import { describeActiveArea } from '../core/activeArea';
import { generateAiTifo, critiqueAiTifo, fetchAiQuota, unlockAi, aiUnlockToken, type AiError, type AiQuota, type AiChoice } from '../net/api';
import { isSignedIn, fetchMe, resendVerification } from '../net/api';
import { openAuthModal } from './authModal';
import { openAddEmailModal } from './openAddEmailModal';

import { t, tErr, tv } from './i18n';
// Auto-resend the verification email at most once per session when AI is blocked.
let verifyResent = false;

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
  const progressEl = $('#ai-progress');
  const progressStageEl = $('#ai-progress-stage');
  const progressElapsedEl = $('#ai-progress-elapsed');
  const errorEl = $('#ai-error');
  const resultEl = $('#ai-result');
  const summaryEl = $('#ai-summary');
  const regenBtn = $<HTMLButtonElement>('#ai-regen');
  const revertBtn = $<HTMLButtonElement>('#ai-revert');
  const polishBtn = $<HTMLButtonElement>('#ai-polish');
  const shuffleBtn = $<HTMLButtonElement>('#ai-shuffle');
  const quotaEl = $('#ai-quota');
  const stateEl = $('#ai-state');
  const cancelBtn = $<HTMLButtonElement>('#ai-cancel');
  if (!promptEl || !genBtn) return; // panel not present (e.g. phone build)

  // Snapshot of the canvas before the first AI apply (for revert / clean regen).
  let baselineCells: Uint8Array | null = null;
  let baselinePalette: string[] | null = null;
  let busy = false;
  let lastSuper = false; // so Regenerate repeats the same mode
  let lastSpec: TifoSpec | null = null; // the applied design (for AI critique/polish)
  let lastStadium: string | undefined; // stadium context used (Super AI)
  let shuffleN = 0; // increments per free offline "shuffle"

  // ---- one state card -------------------------------------------------------
  // Everything the panel has to say about a run goes through here. The old code
  // had five independent channels — a status line, an error box, a notes string,
  // a JS-built choice panel and the quota line — so a design that came back with
  // a missing picture could show "Designed with Premium AI" in one place and the
  // failure in grey 11px type in another. A person reads the big green line.
  type Tone = 'good' | 'warn' | 'bad' | 'info';
  interface CardAction {
    label: string;
    primary?: boolean;
    run: () => void;
    /** Seconds until this becomes clickable, counted down in the label. */
    waitSec?: number;
    waitLabel?: (left: string) => string;
  }
  interface Card {
    tone: Tone;
    title: string;
    body?: string;
    actions?: CardAction[];
  }
  const TONE_ICON: Record<Tone, string> = {
    good: 'ti-circle-check',
    warn: 'ti-alert-triangle',
    bad: 'ti-alert-circle',
    info: 'ti-info-circle',
  };
  let cardTimer: number | null = null;
  const clearCard = (): void => {
    if (cardTimer !== null) { clearInterval(cardTimer); cardTimer = null; }
    if (stateEl) { stateEl.hidden = true; }
  };
  const fmtWait = (sec: number): string =>
    sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`;
  const showCard = (card: Card | null): void => {
    clearCard();
    if (!stateEl || !card) return;
    stateEl.dataset.tone = card.tone;
    const icon = stateEl.querySelector('.ai-state-icon') as HTMLElement | null;
    if (icon) icon.className = `ai-state-icon ti ${TONE_ICON[card.tone]}`;
    const title = stateEl.querySelector('.ai-state-title span') as HTMLElement | null;
    if (title) title.textContent = card.title;
    const body = stateEl.querySelector('.ai-state-body') as HTMLElement | null;
    if (body) body.textContent = card.body ?? '';
    const actions = stateEl.querySelector('.ai-state-actions') as HTMLElement | null;
    if (actions) {
      actions.innerHTML = '';
      for (const a of card.actions ?? []) {
        const b = document.createElement('button');
        b.type = 'button';
        if (a.primary) b.className = 'primary';
        b.textContent = a.label;
        // A countdown belongs ON the button it gates, so there is never a live
        // action the user is silently not allowed to press.
        if (a.waitSec && a.waitSec > 0) {
          let left = Math.round(a.waitSec);
          const tick = (): void => {
            if (left > 0) {
              b.disabled = true;
              b.textContent = a.waitLabel ? a.waitLabel(fmtWait(left)) : `${a.label} · ${fmtWait(left)}`;
              left -= 1;
            } else {
              b.disabled = false;
              b.textContent = a.label;
              if (cardTimer !== null) { clearInterval(cardTimer); cardTimer = null; }
            }
          };
          tick();
          cardTimer = window.setInterval(tick, 1000);
        }
        b.addEventListener('click', () => { if (!b.disabled) a.run(); });
        actions.appendChild(b);
      }
    }
    stateEl.hidden = false;
  };
  // Kept so the rest of the panel's call sites keep working; both now render
  // into the single card rather than two competing lines of text.
  const setStatus = (msg: string): void => {
    if (statusEl) statusEl.textContent = msg;
    if (msg) showCard({ tone: 'info', title: msg });
    else clearCard();
  };

  // ---- progress ------------------------------------------------------------
  // The server returns one response for the whole pipeline, so there is no real
  // progress to report. Rather than fake a percentage, show a moving bar, the
  // stage the run has reached (timed to the actual pipeline) and an elapsed
  // counter, so a 45-second Super run never looks like a hung app.
  type Stage = { at: number; text: string };
  const SUPER_STAGES: Stage[] = [
    { at: 0, text: 'Choosing the words…' },
    { at: 7, text: 'Designing the whole bowl…' },
    { at: 22, text: 'Still designing — the whole stadium takes a moment…' },
    { at: 40, text: 'Nearly there…' },
  ];
  const PLAIN_STAGES: Stage[] = [
    { at: 0, text: 'Designing your tifo…' },
    { at: 12, text: 'Still working…' },
  ];
  const POLISH_STAGES: Stage[] = [
    { at: 0, text: 'Looking at the render…' },
    { at: 10, text: 'Reworking the design…' },
  ];
  let progressTimer: number | null = null;
  // A Super run is 20-40s. Leaving someone with no way out of that but a page
  // reload is the thing every loading-state guide warns about, and it matters
  // more now that a cancelled run costs nothing: the credit is charged at the
  // END of a successful generation, not when the request leaves.
  let inflight: AbortController | null = null;

  const stopProgress = (): void => {
    if (progressTimer !== null) { clearInterval(progressTimer); progressTimer = null; }
    if (progressEl) progressEl.hidden = true;
    if (cancelBtn) cancelBtn.hidden = true;
  };

  const startProgress = (stages: Stage[]): void => {
    stopProgress();
    if (!progressEl) return;
    const started = Date.now();
    const tick = (): void => {
      const secs = Math.floor((Date.now() - started) / 1000);
      let stage = stages[0].text;
      for (const s of stages) if (secs >= s.at) stage = s.text;
      if (progressStageEl) progressStageEl.textContent = stage;
      if (progressElapsedEl) progressElapsedEl.textContent = `${secs}s`;
    };
    tick();
    progressEl.hidden = false;
    if (cancelBtn) cancelBtn.hidden = false;
    progressTimer = window.setInterval(tick, 1000);
  };
  const setError = (msg: string | null, actions?: CardAction[]): void => {
    if (errorEl) errorEl.textContent = msg ?? '';
    if (msg) showCard({ tone: 'bad', title: msg, actions });
    else clearCard();
  };
  const resetMins = (q: AiQuota): number => Math.max(1, Math.ceil((q.resetInSec ?? 0) / 60));
  const quotaText = (q: AiQuota): string =>
    q.unlimited || q.admin
      ? 'AI Designer: unlimited'
      : q.remaining > 0
        ? `${q.remaining} of ${q.limit} premium designs left this hour`
        : `Hourly limit reached: resets in ${resetMins(q)} min`;
  const setQuota = (q: AiQuota | null): void => {
    if (!quotaEl) return;
    quotaEl.textContent = q ? quotaText(q) : isSignedIn() ? '' : t('err.aiSignIn');
    // Warn before the wall rather than at it.
    const level = !q || q.unlimited || q.admin ? '' : q.remaining <= 0 ? 'none' : q.remaining <= 2 ? 'low' : '';
    if (level) quotaEl.dataset.level = level;
    else delete quotaEl.dataset.level;
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

  // ---- premium can't deliver right now: say WHICH reason, offer the way out ----
  // Collapsing every refusal into "Premium AI is busy" is the anti-pattern that
  // cost a whole evening of debugging: a quota error, a timeout, an unreachable
  // model and a parsing bug all read identically. Each reason now gets its own
  // words and its own next step.
  const hideChoice = clearCard;
  const showChoice = (choice: AiChoice, prompt: string, useSuper: boolean): void => {
    const quick: CardAction = {
      label: t('ai.card.useQuick'),
      primary: true,
      run: () => { clearCard(); void run(prompt, { super: useSuper, engine: 'offline' }); },
    };
    const retry: CardAction = {
      label: t('ai.card.retryPremium'),
      waitSec: Math.max(0, Math.round(choice.retryAfterSec)),
      waitLabel: (left) => tv('ai.card.premiumFreeIn', { left }),
      run: () => { clearCard(); void run(prompt, { super: useSuper }); },
    };
    const cap = choice.reason === 'quota';
    const mins = Math.max(1, Math.ceil((choice.retryAfterSec ?? 0) / 60));
    showCard(
      cap
        ? {
            tone: 'warn',
            title: tv('ai.card.quotaTitle', { limit: choice.quota?.limit || 10 }),
            body: tv('ai.card.quotaBody', { mins }),
            actions: [quick, retry],
          }
        : {
            tone: 'warn',
            title: t('ai.card.busyTitle'),
            body: choice.detail ? tv('ai.card.reason', { detail: choice.detail }) : t('ai.card.busyBody'),
            actions: [quick, retry],
          },
    );
  };

  cancelBtn?.addEventListener('click', () => {
    if (!inflight) return;
    inflight.abort();
    inflight = null;
  });

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
    await loadTifoFonts();
    compileSpec(working, map, store);

    // Phase 4: deterministic critique of the rendered seats, with ONE bounded
    // repair pass (enlarge fragile text/symbols) when fine detail won't read.
    let critique = critiqueDesign(store.cells, map, working);
    if (critique.paintedSeats > 0 && critique.fragileSeats > critique.paintedSeats * 0.2) {
      const repaired = repairSpec(working, critique);
      if (repaired.changed) {
        working = repaired.spec;
        await loadTifoFonts();
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
        // A picture needs one continuous surface. A run of adjacent stands is
        // one; a SPLIT set ('sides', 'ends') is not, so that collapses to a
        // single stand. 'all' collapses too — a lazy whole-bowl region on a
        // portrait means "big", not "smeared 9:1 across the ring".
        const region = narrowToSingleStand(layer.region);
        const rect = regionRect(region, map);
        // Fit the picture to the region, then scale by scaleFrac.
        //
        // The old code drove off HEIGHT alone and clamped width to 98% of the
        // stand, which only ever shrank: a square portrait in a ~2.4:1 stand
        // came out filling barely a third of its width, which is what made
        // every AI hero look small. 'cover' fills the region and lets the
        // region clip the overflow — the bake is masked by regionPredicate, so
        // it still cannot touch a neighbouring stand.
        //
        // Cover is BOUNDED. If the asset's shape and the region's diverge far
        // enough, covering means throwing most of the picture away — and a
        // portrait cropped to a band of cheek is worse than one with the bare
        // concrete of index 0 showing at its sides. MAX_CROP caps the loss at
        // about a quarter of the long axis. When the shapes match, which is the
        // normal case now that the generator is asked for the region's own
        // aspect, cover and contain are the same number and this never binds.
        const MAX_CROP = 1.3;
        const sx = rect.width / bmp.width;
        const sy = rect.height / bmp.height;
        const contain = Math.min(sx, sy);
        const s = (layer.fit === 'contain' ? contain : Math.min(Math.max(sx, sy), contain * MAX_CROP)) * layer.scaleFrac;
        const w = bmp.width * s;
        const h = bmp.height * s;
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
          cutout: layer.cutout !== false,
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

  const run = async (prompt: string, opts: { super?: boolean; engine?: 'offline' } = {}): Promise<void> => {
    if (busy) return;
    const text = prompt.trim();
    if (!text) { setError(t('ai.card.describeFirst')); return; }
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
    hideChoice();
    genBtn.disabled = true;
    if (superBtn) superBtn.disabled = true;
    if (regenBtn) regenBtn.disabled = true;
    if (polishBtn) polishBtn.disabled = true;
    setStatus('');
    startProgress(useSuper ? SUPER_STAGES : PLAIN_STAGES);
    try {
      // Mode 3 sends the bowl geometry so the director can plan per-stand.
      const stadium = useSuper ? describeStadiumContext(buildStadiumContext(map)) : undefined;
      lastStadium = stadium;
      // Section 3: focus the design on the chosen active area, if any.
      const focus = describeActiveArea();
      const brief = focus ? `${text}: focus the design on ${focus}` : text;
      inflight = new AbortController();
      const res = await generateAiTifo(brief, {
        ...(useSuper ? { mode: 'super', stadium } : {}),
        ...(opts.engine ? { engine: opts.engine } : {}),
        signal: inflight.signal,
      });
      if ('needsChoice' in res) {
        stopProgress();
        setQuota(res.quota);
        // The admin detail (when the server sends it) becomes the card's body
        // rather than a second, competing message elsewhere in the panel.
        showChoice(res, text, useSuper);
        const detail = (res as { detail?: string }).detail;
        if (detail) {
          const bar = document.getElementById('message');
          if (bar) bar.textContent = `${label}: ${detail}`;
        }
        return;
      }
      await applySpec(res.spec);
      stopProgress();
      setQuota(res.quota);
      const bar = document.getElementById('message');
      const outcome = res.outcome;
      if (outcome?.kind === 'degraded') {
        // The case that started this: a design whose hero picture never
        // arrived. It used to say "Designed with Premium AI" and spend a
        // credit, with the failure in grey 11px underneath.
        const n = outcome.missingCount ?? 1;
        const what = n === 1 ? t('ai.card.aPicture') : tv('ai.card.nPictures', { n });
        showCard({
          tone: 'warn',
          title: tv('ai.card.degraded', { what }),
          body:
            (outcome.charged ? t('ai.card.degradedPaid') : t('ai.card.degradedFree')) +
            ' ' +
            (outcome.detail ? tv('ai.card.reason', { detail: outcome.detail }) : t('ai.card.degradedWhy')),
          actions: [
            { label: t('ai.card.tryAgain'), primary: true, run: () => { clearCard(); void run(text, { super: useSuper }); } },
            { label: t('ai.card.keep'), run: clearCard },
          ],
        });
        if (bar) bar.textContent = `${label}: ${tv('ai.card.degraded', { what })}`;
      } else {
        const notes = (res.notes ?? []).filter((n) => !/^Served instantly/.test(n));
        showCard({
          tone: 'good',
          title:
            res.source === 'model'
              ? t(useSuper ? 'ai.card.doneSuper' : 'ai.card.donePremium')
              : t('ai.card.doneQuick'),
          body: notes.length ? notes.join(' · ') : undefined,
        });
        if (bar) bar.textContent = res.source === 'model' ? `${label}: designed ✓` : '';
      }
      // Phone: complete the cycle — close the AI sheet, drop the user onto their
      // 3D result (Stadium view), and pulse Match Day so they open the full show.
      if (window.matchMedia('(max-width: 767px)').matches) {
        document.getElementById('panel')?.classList.remove('open');
        document.querySelector('.panel-scrim')?.classList.remove('show');
        (document.getElementById('view-3d') as HTMLButtonElement | null)?.click();
        setTimeout(() => {
          const md = document.getElementById('match-day');
          if (md) {
            md.classList.add('nudge');
            setTimeout(() => md.classList.remove('nudge'), 4200);
          }
        }, 300);
      }
    } catch (e) {
      const err = e as AiError;
      // A run the user stopped is not a failure and must not be dressed as one.
      if ((e as Error)?.name === 'AbortError') {
        showCard({
          tone: 'info',
          title: t('ai.card.stopped'),
          body: t('ai.card.stoppedBody'),
          actions: [{ label: t('ai.card.startAgain'), primary: true, run: () => { clearCard(); void run(text, { super: useSuper }); } }],
        });
        return;
      }
      const tryAgain: CardAction = {
        label: t('ai.card.tryAgain'),
        primary: true,
        run: () => { clearCard(); void run(text, { super: useSuper }); },
      };
      const useQuick: CardAction = {
        label: t('ai.card.useQuick'),
        run: () => { clearCard(); void run(text, { super: useSuper, engine: 'offline' }); },
      };
      if (err.reason === 'verify') {
        // Signed in but the email isn't usable yet. No email on the account →
        // offer to add one; otherwise it's unverified → offer to resend the link.
        // The code is typed on the account page. A new tab, so a design in
        // progress here is not navigated away from.
        const enterCode: CardAction = {
          label: t('ai.verify.enterCode'),
          primary: true,
          run: () => { window.open('/account', '_blank', 'noopener'); },
        };
        const me = await fetchMe().catch(() => null);
        if (me && !me.email) {
          const added = await openAddEmailModal();
          setError(added ? t('ai.verify.addedCheckInbox') : t('ai.verify.addEmail'), added ? [enterCode] : undefined);
        } else if (!verifyResent) {
          verifyResent = true;
          // Say what actually happened. This used to announce "I just re-sent
          // the link" without waiting, while every one of these requests was
          // being refused with a 400. It also fires about two seconds after a
          // signup, which the server now answers with a cooldown rather than
          // replacing the code in the email that just arrived.
          const res = await resendVerification().catch(() => null);
          if (res?.ok && res.alreadyVerified) setError(t('ai.verify.nowVerified'), [tryAgain]);
          else if (res?.ok) setError(t('ai.verify.sent'), [enterCode]);
          else if (res?.status === 429 && res.error === 'too many verification emails today') setError(tErr(res.error), [enterCode]);
          else if (res?.status === 429) setError(t('ai.verify.onItsWay'), [enterCode]);
          else setError(t('ai.verify.notSent'), [enterCode]);
        } else {
          setError(t('ai.verify.onItsWay'), [enterCode]);
        }
      } else if (err.reason === 'quota' || err.status === 429 || err.status === 402) {
        if (err.quota) setQuota(err.quota);
        showCard({
          tone: 'warn',
          title: err.message || t('ai.card.quotaOut'),
          body: t('ai.card.quotaOutBody'),
          actions: [useQuick],
        });
      } else if (err.status === 401 || err.reason === 'signin') {
        showCard({ tone: 'info', title: t('ai.card.signIn'), body: t('ai.card.signInBody') });
        void openAuthModal();
      } else if (err.status === 403) {
        setError(err.message || 'AI is admin-only right now.');
        setLocked(true);
      } else if (!navigator.onLine) {
        showCard({ tone: 'bad', title: t('ai.card.offline'), body: t('ai.card.offlineBody'), actions: [useQuick] });
      } else {
        // Differentiated where we can be, honest where we cannot — but always
        // with a way forward rather than a dead end.
        showCard({
          tone: 'bad',
          title: t('ai.card.failed'),
          body: err.message || t('ai.card.failedBody'),
          actions: [tryAgain, useQuick],
        });
      }
    } finally {
      // Whatever happened — success, the "busy" choice panel, a thrown error —
      // the bar must not be left spinning over a finished run.
      stopProgress();
      inflight = null;
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
    setStatus('');
    startProgress(POLISH_STAGES);
    try {
      const res = await critiqueAiTifo(spec, captureRender(), lastStadium);
      await applySpec(res.spec);
      const bar = document.getElementById('message');
      stopProgress();
      showCard({
        tone: 'good',
        title: t(res.source === 'model' ? 'ai.card.polished' : 'ai.card.polishKept'),
        body: (res.notes ?? []).join(' · ') || undefined,
      });
      if (bar) bar.textContent = res.source === 'model' ? 'AI: polished ✓' : '';

    } catch (e) {
      const err = e as AiError;
      showCard({
        tone: 'bad',
        title: t('ai.card.polishFailed'),
        body: err.message || t('ai.card.polishFailedBody'),
      });
    } finally {
      // Whatever happened — success, the "busy" choice panel, a thrown error —
      // the bar must not be left spinning over a finished run.
      stopProgress();
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
    if (!text) { setError(t('ai.card.describeFirst')); return; }
    busy = true;
    setError(null);
    try {
      shuffleN++;
      await applySpec(designShuffle(text, shuffleN));
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
  // Club quick-picks: fill the prompt with the club brief and generate at once,
  // so a fan gets their club's tifo in a single tap (the front-door path).
  for (const chip of Array.from(root.querySelectorAll<HTMLButtonElement>('#ai-clubs [data-club]'))) {
    chip.addEventListener('click', () => {
      promptEl.value = chip.dataset.club ?? '';
      genBtn.click();
    });
  }

  // Determine access: admins (account OR unlock token) see the panel; everyone
  // else gets the lock. The server is the real gate — this is UX only.
  setQuota(null);
  fetchAiQuota()
    .then((q) => { setLocked(false); setQuota(q); })
    .catch((e) => {
      const err = e as AiError;
      // Don't show the admin-unlock box for ordinary "sign in / verify" denials.
      setLocked(false);
      if (quotaEl) {
        quotaEl.textContent =
          err.reason === 'verify'
            ? t('err.aiVerify')
            : !isSignedIn()
              ? t('err.aiSignIn')
              : '';
      }
    });
  void getPreview; // reserved: future per-layer live preview in the 3D view
}
