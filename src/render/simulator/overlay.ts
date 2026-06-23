import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { MatchDaySimulator } from './index';
import { CAMERA_PRESETS } from '../preview3d';
import { probeQuality, type QualityTier } from './quality';

/**
 * Fullscreen Match Day Simulator overlay — the lazy-loaded entry point.
 *
 * Builds its own DOM (no index.html / CSS changes), mounts a MatchDaySimulator
 * in a fresh host, and fully disposes it on close so the heavy WebGL context is
 * released back to the editor. Changing quality recreates the scene (simple and
 * leak-free). Styling is inline to stay additive.
 */

export interface SimulatorHandle {
  close(): void;
}

const TIER_LABELS: [QualityTier, string][] = [
  ['medium', 'Medium'],
  ['high', 'High'],
  ['ultra', 'Ultra'],
];

const BTN =
  'font:13px system-ui,sans-serif;color:#e6e9ee;background:#1c232c;border:1px solid #2c3742;border-radius:8px;padding:7px 12px;cursor:pointer;';
const SELECT =
  'font:13px system-ui,sans-serif;color:#e6e9ee;background:#1c232c;border:1px solid #2c3742;border-radius:8px;padding:6px 10px;cursor:pointer;';

export function openMatchDaySimulator(
  map: SeatMap,
  store: DesignStore,
  template: StadiumTemplate,
  opts: { onClose?: () => void } = {},
): SimulatorHandle {
  const startTier: QualityTier = (() => {
    const t = probeQuality();
    return t === 'low' ? 'medium' : t;
  })();

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;background:#05070a;display:flex;flex-direction:column;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:10px 14px;background:#0a0d12;' +
    'border-bottom:1px solid #1c232c;color:#e6e9ee;font:13px system-ui,sans-serif;flex:0 0 auto;';

  const title = document.createElement('div');
  title.textContent = 'Match Day Simulator';
  title.style.cssText = 'font-weight:700;letter-spacing:.2px;margin-right:auto;';

  const camSel = document.createElement('select');
  camSel.style.cssText = SELECT;
  camSel.title = 'Camera';
  CAMERA_PRESETS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.name;
    camSel.appendChild(o);
  });

  const qSel = document.createElement('select');
  qSel.style.cssText = SELECT;
  qSel.title = 'Quality';
  for (const [tier, label] of TIER_LABELS) {
    const o = document.createElement('option');
    o.value = tier;
    o.textContent = label;
    if (tier === startTier) o.selected = true;
    qSel.appendChild(o);
  }

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = BTN;

  bar.append(title, camSel, qSel, closeBtn);

  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto;position:relative;min-height:0;';

  overlay.append(bar, host);
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  let sim = new MatchDaySimulator(host, map, store, template, { quality: startTier });
  sim.start();

  camSel.addEventListener('change', () => {
    sim.applyPreset(CAMERA_PRESETS[Number(camSel.value)]);
  });

  qSel.addEventListener('change', () => {
    const tier = qSel.value as QualityTier;
    const camIdx = Number(camSel.value);
    sim.dispose();
    sim = new MatchDaySimulator(host, map, store, template, { quality: tier });
    sim.applyPreset(CAMERA_PRESETS[camIdx] ?? CAMERA_PRESETS[0]);
    sim.start();
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    sim.dispose();
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  return { close };
}
