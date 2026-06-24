import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { MatchDaySimulator } from './index';
import { probeQuality, type QualityTier } from './quality';
import { REVEAL_MODES, type RevealMode } from './choreo';
import type { CrowdPreset } from './crowd';

/**
 * Fullscreen Match Day Simulator overlay — the lazy-loaded entry point.
 *
 * Builds its own DOM (no index.html / CSS changes), mounts a MatchDaySimulator
 * and a control bar for every subsystem (camera, quality, crowd, banners/flags,
 * effects, reveal). State is kept here and re-applied when quality changes (which
 * rebuilds the scene), and everything disposes on close.
 */

export interface SimulatorHandle {
  close(): void;
}

const TIER_LABELS: [QualityTier, string][] = [
  ['medium', 'Medium'],
  ['high', 'High'],
  ['ultra', 'Ultra'],
];
const CROWD_PRESETS: [CrowdPreset, string, number][] = [
  ['sellout', 'Sell-out', 0.97],
  ['home', 'Home', 0.9],
  ['away-end', 'Away end', 0.88],
  ['half', 'Half full', 0.5],
  ['empty', 'Empty', 0],
];

const BTN = 'font:12px system-ui,sans-serif;color:#e6e9ee;background:#1c232c;border:1px solid #2c3742;border-radius:7px;padding:6px 10px;cursor:pointer;';
const SEL = 'font:12px system-ui,sans-serif;color:#e6e9ee;background:#1c232c;border:1px solid #2c3742;border-radius:7px;padding:5px 8px;cursor:pointer;';
const LBL = 'font:11px system-ui,sans-serif;color:#aab2bd;display:inline-flex;align-items:center;gap:5px;';

interface SimState {
  camIdx: number;
  tier: QualityTier;
  crowd: CrowdPreset;
  density: number;
  showOnTifo: boolean;
  banners: boolean;
  flags: boolean;
  floods: boolean;
  smoke: boolean;
  fly: boolean;
  reveal: RevealMode;
}

export function openMatchDaySimulator(
  map: SeatMap,
  store: DesignStore,
  template: StadiumTemplate,
  opts: { onClose?: () => void } = {},
): SimulatorHandle {
  const startTier = probeQuality();
  const state: SimState = {
    camIdx: 0,
    tier: startTier === 'low' ? 'medium' : startTier,
    crowd: 'sellout',
    density: 0.97,
    showOnTifo: false,
    banners: true,
    flags: true,
    floods: false,
    smoke: false,
    fly: false,
    reveal: 'wipe-lr',
  };

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#05070a;display:flex;flex-direction:column;';
  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto;position:relative;min-height:0;';

  // ----- top bar -----
  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:9px 14px;background:#0a0d12;border-bottom:1px solid #1c232c;color:#e6e9ee;font:13px system-ui,sans-serif;flex:0 0 auto;flex-wrap:wrap;';
  const title = document.createElement('div');
  title.textContent = 'Match Day Simulator';
  title.style.cssText = 'font-weight:700;margin-right:auto;';
  const camSel = document.createElement('select');
  camSel.style.cssText = SEL;
  const qSel = document.createElement('select');
  qSel.style.cssText = SEL;
  for (const [tier, label] of TIER_LABELS) {
    const o = document.createElement('option');
    o.value = tier;
    o.textContent = label;
    if (tier === state.tier) o.selected = true;
    qSel.appendChild(o);
  }
  const flyBtn = document.createElement('button');
  flyBtn.textContent = 'Flyover';
  flyBtn.style.cssText = BTN;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = BTN;
  bar.append(title, wrap('Camera', camSel), wrap('Quality', qSel), flyBtn, closeBtn);

  // ----- controls row -----
  const ctrls = document.createElement('div');
  ctrls.style.cssText =
    'display:flex;align-items:center;gap:14px;padding:8px 14px;background:#080b10;border-bottom:1px solid #161b22;flex:0 0 auto;flex-wrap:wrap;';

  const crowdSel = document.createElement('select');
  crowdSel.style.cssText = SEL;
  for (const [id, label] of CROWD_PRESETS) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    if (id === state.crowd) o.selected = true;
    crowdSel.appendChild(o);
  }
  const density = document.createElement('input');
  density.type = 'range';
  density.min = '0';
  density.max = '100';
  density.value = String(Math.round(state.density * 100));
  const onTifo = checkbox(state.showOnTifo);
  const banners = checkbox(state.banners);
  const flags = checkbox(state.flags);
  const floods = checkbox(state.floods);
  const smoke = checkbox(state.smoke);
  const confettiBtn = document.createElement('button');
  confettiBtn.textContent = 'Confetti';
  confettiBtn.style.cssText = BTN;
  const pyroBtn = document.createElement('button');
  pyroBtn.textContent = 'Pyro';
  pyroBtn.style.cssText = BTN;
  const revealSel = document.createElement('select');
  revealSel.style.cssText = SEL;
  for (const m of REVEAL_MODES) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    revealSel.appendChild(o);
  }
  const revealBtn = document.createElement('button');
  revealBtn.textContent = 'Play reveal';
  revealBtn.style.cssText = BTN;

  ctrls.append(
    wrap('Crowd', crowdSel),
    wrap('Density', density),
    wrap('On tifo', onTifo),
    wrap('Banners', banners),
    wrap('Flags', flags),
    wrap('Floodlights', floods),
    wrap('Smoke', smoke),
    confettiBtn,
    pyroBtn,
    wrap('Reveal', revealSel),
    revealBtn,
  );

  overlay.append(bar, ctrls, host);
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  let sim: MatchDaySimulator;

  function applyState(): void {
    const shots = sim.shots();
    if (camSel.options.length !== shots.length) {
      camSel.replaceChildren();
      shots.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = s.name;
        camSel.appendChild(o);
      });
    }
    camSel.value = String(state.camIdx);
    sim.setCrowdPreset(state.crowd);
    sim.setCrowdDensity(state.density);
    sim.setCrowdShowOnTifo(state.showOnTifo);
    sim.setBannersVisible(state.banners);
    sim.setFlagsVisible(state.flags);
    sim.setFloodlights(state.floods);
    sim.setSmoke(state.smoke);
    sim.setFlyover(state.fly);
    if (!state.fly) sim.applyShot(shots[state.camIdx] ?? shots[0]);
  }

  function mount(): void {
    sim = new MatchDaySimulator(host, map, store, template, { quality: state.tier });
    applyState();
    sim.start();
  }
  mount();

  // ----- wiring -----
  camSel.addEventListener('change', () => {
    state.camIdx = Number(camSel.value);
    state.fly = false;
    flyBtn.style.background = '#1c232c';
    sim.applyShot(sim.shots()[state.camIdx]);
  });
  qSel.addEventListener('change', () => {
    state.tier = qSel.value as QualityTier;
    sim.dispose();
    mount();
  });
  flyBtn.addEventListener('click', () => {
    state.fly = !state.fly;
    flyBtn.style.background = state.fly ? '#2a6f43' : '#1c232c';
    sim.setFlyover(state.fly);
  });
  crowdSel.addEventListener('change', () => {
    state.crowd = crowdSel.value as CrowdPreset;
    const d = CROWD_PRESETS.find((c) => c[0] === state.crowd)?.[2] ?? state.density;
    state.density = d;
    density.value = String(Math.round(d * 100));
    sim.setCrowdPreset(state.crowd);
  });
  density.addEventListener('input', () => {
    state.density = Number(density.value) / 100;
    sim.setCrowdDensity(state.density);
  });
  onTifo.addEventListener('change', () => {
    state.showOnTifo = onTifo.checked;
    sim.setCrowdShowOnTifo(state.showOnTifo);
  });
  banners.addEventListener('change', () => {
    state.banners = banners.checked;
    sim.setBannersVisible(state.banners);
  });
  flags.addEventListener('change', () => {
    state.flags = flags.checked;
    sim.setFlagsVisible(state.flags);
  });
  floods.addEventListener('change', () => {
    state.floods = floods.checked;
    sim.setFloodlights(state.floods);
  });
  smoke.addEventListener('change', () => {
    state.smoke = smoke.checked;
    sim.setSmoke(state.smoke);
  });
  confettiBtn.addEventListener('click', () => sim.burstConfetti());
  pyroBtn.addEventListener('click', () => sim.burstPyro());
  revealSel.addEventListener('change', () => {
    state.reveal = revealSel.value as RevealMode;
  });
  revealBtn.addEventListener('click', () => sim.playReveal(state.reveal));

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

function wrap(label: string, el: HTMLElement): HTMLElement {
  const span = document.createElement('label');
  span.style.cssText = LBL;
  span.append(document.createTextNode(label), el);
  return span;
}
function checkbox(checked: boolean): HTMLInputElement {
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = checked;
  return c;
}
