import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { MatchDaySimulator, type TimeOfDay } from './index';
import { probeQuality, type QualityTier } from './quality';
import { REVEAL_MODES, type RevealMode } from './choreo';
import type { CrowdPreset } from './crowd';
import type { AssetStore } from '../../core/sceneAssets';
import type { Cue, EffectName } from './timeline';
import type { Weather } from './weather';
import { dbg } from './debug';

/**
 * Fullscreen Match Day Simulator overlay — the lazy-loaded entry point.
 *
 * UI: a slim top bar (global actions) plus a collapsible left "glass" panel with
 * five accordion sections (Camera, Crowd, Atmosphere, Tifo Assets, Choreography),
 * so the controls are organized and discoverable rather than a wall of buttons.
 * All controls drive the same MatchDaySimulator API; state is re-applied when
 * quality changes (which rebuilds the scene), and everything disposes on close.
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

const CSS = `
.mds-overlay{position:fixed;inset:0;z-index:10000;background:#05070a;display:flex;flex-direction:column;font:13px/1.4 system-ui,-apple-system,sans-serif;color:#e6e9ee;}
.mds-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:rgba(10,13,18,.92);backdrop-filter:blur(8px);border-bottom:1px solid #1c232c;flex:0 0 auto;z-index:3;}
.mds-brand{font-weight:700;font-size:15px;letter-spacing:.2px;display:flex;align-items:center;gap:8px;}
.mds-brand .dot{width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 9px #3fb950;}
.mds-spacer{margin-left:auto;}
.mds-status{font-size:12px;color:#7fcf96;min-width:6px;transition:opacity .3s;}
.mds-bf{display:flex;align-items:center;gap:6px;font-size:12px;color:#8a93a0;}
.mds-btn{font:13px system-ui,sans-serif;color:#e6e9ee;background:#1c232c;border:1px solid #2c3742;border-radius:8px;padding:7px 12px;cursor:pointer;transition:background .12s,border-color .12s,transform .05s;white-space:nowrap;}
.mds-btn:hover{background:#283340;border-color:#3a4654;}
.mds-btn:active{transform:translateY(1px);}
.mds-btn.active{background:#225338;border-color:#3fb950;color:#eafff0;}
.mds-btn.primary{background:#3fb950;border-color:#3fb950;color:#06210f;font-weight:600;}
.mds-btn.primary:hover{background:#4ad063;}
.mds-icon{padding:7px 10px;font-size:14px;}
.mds-sel,.mds-input{font:13px system-ui,sans-serif;color:#e6e9ee;background:#161b22;border:1px solid #2c3742;border-radius:8px;padding:6px 9px;cursor:pointer;width:100%;box-sizing:border-box;}
.mds-input{cursor:text;}
.mds-input[type=file]{font-size:11px;color:#aab2bd;padding:5px;cursor:pointer;}
.mds-input[type=number]{width:80px;}
.mds-panel{position:absolute;top:62px;left:14px;width:286px;height:calc(100vh - 76px);overflow-y:auto;overscroll-behavior:contain;background:rgba(13,17,23,.92);backdrop-filter:blur(12px);border:1px solid #242c37;border-radius:14px;padding:8px;display:flex;flex-direction:column;gap:7px;box-shadow:0 12px 44px rgba(0,0,0,.55);z-index:2;transition:transform .22s ease,opacity .22s;}
.mds-panel.collapsed{transform:translateX(-310px);opacity:0;pointer-events:none;}
.mds-panel::-webkit-scrollbar{width:8px;}
.mds-panel::-webkit-scrollbar-thumb{background:#2c3742;border-radius:8px;}
.mds-section{border:1px solid #1e2630;border-radius:10px;overflow:hidden;background:#10151c;}
.mds-shead{display:flex;align-items:center;gap:9px;width:100%;padding:11px 12px;background:#141a22;border:none;color:#e6e9ee;font:600 13px system-ui,sans-serif;cursor:pointer;text-align:left;}
.mds-shead:hover{background:#1a212b;}
.mds-shead .ico{font-size:15px;}
.mds-shead .chev{margin-left:auto;transition:transform .15s;color:#8a93a0;font-size:12px;}
.mds-section.open .chev{transform:rotate(90deg);}
.mds-sbody{display:none;flex-direction:column;gap:11px;padding:13px 12px;}
.mds-section.open .mds-sbody{display:flex;}
.mds-field{display:flex;flex-direction:column;gap:5px;}
.mds-flabel{font-size:11px;color:#8a93a0;}
.mds-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.mds-row .mds-btn{flex:1 1 auto;text-align:center;}
.mds-divider{height:1px;background:#1e2630;margin:1px 0;}
.mds-checkrow{display:flex;align-items:center;gap:9px;font-size:12.5px;color:#cfd6df;cursor:pointer;}
.mds-hint{font-size:11px;color:#6b7480;}
input[type=range].mds-range{width:100%;accent-color:#3fb950;}
input[type=checkbox].mds-check{accent-color:#3fb950;width:15px;height:15px;min-width:15px;margin:0;flex:0 0 auto;cursor:pointer;}
.mds-checkrow{line-height:1.2;}
`;

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
  tod: TimeOfDay;
  weather: Weather;
  wet: boolean;
}

export function openMatchDaySimulator(
  map: SeatMap,
  store: DesignStore,
  template: StadiumTemplate,
  assetStore: AssetStore,
  opts: { onClose?: () => void } = {},
): SimulatorHandle {
  const startTier = probeQuality();
  const state: SimState = {
    camIdx: 0,
    tier: startTier === 'low' ? 'medium' : startTier,
    crowd: 'sellout',
    density: 0.97,
    showOnTifo: false,
    banners: false,
    flags: true,
    floods: false,
    smoke: false,
    fly: false,
    reveal: 'wipe-lr',
    tod: 'dusk',
    weather: 'clear',
    wet: false,
  };

  const overlay = document.createElement('div');
  overlay.className = 'mds-overlay';
  const style = document.createElement('style');
  style.textContent = CSS;
  overlay.appendChild(style);

  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto;position:relative;min-height:0;';

  // ---------- top bar ----------
  const bar = document.createElement('div');
  bar.className = 'mds-bar';
  const panelToggle = btn('☰', 'mds-icon');
  panelToggle.title = 'Show/hide controls';
  const brand = document.createElement('div');
  brand.className = 'mds-brand';
  brand.innerHTML = '<span class="dot"></span>Match Day Simulator';
  brand.title = 'Shortcuts: 1-9 camera views · H hide panel · F fullscreen · Space play show';
  const spacer = document.createElement('div');
  spacer.className = 'mds-spacer';
  const status = document.createElement('div');
  status.className = 'mds-status';
  const qSel = sel();
  for (const [tier, label] of TIER_LABELS) opt(qSel, tier, label, tier === state.tier);
  const snapBtn = btn('Snapshot');
  const fullBtn = btn('Fullscreen');
  const linkBtn = btn('Copy link');
  const closeBtn = btn('Close');
  bar.append(panelToggle, brand, spacer, status, barField('Quality', qSel), snapBtn, fullBtn, linkBtn, closeBtn);

  let toastT = 0;
  const toast = (m: string): void => {
    status.textContent = m;
    status.style.opacity = '1';
    window.clearTimeout(toastT);
    toastT = window.setTimeout(() => {
      status.style.opacity = '0';
    }, 2200);
  };

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.className = 'mds-panel';

  // Camera & Views
  const camSel = sel();
  const flyBtn = btn('Cinematic flyover');
  const secCam = section('🎥', 'Camera & Views', true);
  secCam.body.append(field('View', camSel), flyBtn);

  // Crowd
  const crowdSel = sel();
  for (const [id, label] of CROWD_PRESETS) opt(crowdSel, id, label, id === state.crowd);
  const density = rng(0, 100, Math.round(state.density * 100));
  const onTifo = chk(state.showOnTifo);
  const secCrowd = section('👥', 'Crowd', false);
  secCrowd.body.append(field('Stadium fill', crowdSel), field('Density', density), checkField('Show crowd on tifo seats', onTifo));

  // Atmosphere
  const todSel = sel();
  for (const [v, l] of [['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night'], ['sunset', 'Sunset']]) opt(todSel, v, l, v === state.tod);
  const weatherSel = sel();
  for (const [v, l] of [['clear', 'Clear'], ['rain', 'Rain'], ['snow', 'Snow']]) opt(weatherSel, v, l, false);
  const expRange = rng(0.4, 2, 1.05, 0.05);
  const sunRange = rng(0, 3, 1.25, 0.05);
  const floods = chk(state.floods);
  const smoke = chk(state.smoke);
  const bannersChk = chk(state.banners);
  const flagsChk = chk(state.flags);
  const wetChk = chk(state.wet);
  const confettiBtn = btn('Confetti');
  const pyroBtn = btn('Pyro');
  const secAtmo = section('🌇', 'Atmosphere', false);
  secAtmo.body.append(
    field('Time of day', todSel),
    field('Weather', weatherSel),
    field('Exposure', expRange),
    field('Sun intensity', sunRange),
    checkField('Floodlights', floods),
    checkField('Smoke', smoke),
    checkField('Rail banners', bannersChk),
    checkField('Corner flags', flagsChk),
    checkField('Wet pitch (reflections)', wetChk),
    row(confettiBtn, pyroBtn),
  );

  // Tifo Assets
  const standSel = sel();
  for (const [v, l] of [['1', 'North'], ['3', 'South'], ['0', 'East'], ['2', 'West']]) opt(standSel, v, l, false);
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = 'ULTRAS';
  textInput.className = 'mds-input';
  const addBannerBtn = btn('Big banner');
  const addSmallBtn = btn('Small banner');
  const addTextBtn = btn('Text');
  const addFloorBtn = btn('Floor');
  const addSurfaceBtn = btn('Surface');
  const addFlagBtn = btn('Mega-flag');
  const addScarfBtn = btn('Scarves');
  const projInput = fileInput();
  const assetSel = sel();
  const imgInput = fileInput();
  const wRange = rng(4, 60, 18);
  const hRange = rng(1, 30, 4);
  const yRange = rng(0, 60, 14);
  const unfurlBtn = btn('Unfurl');
  const printBtn = btn('Print panels');
  const delBtn = btn('Delete selected');
  const clearAllBtn = btn('Clear all');
  const secAssets = section('🎌', 'Tifo Assets', false);
  secAssets.body.append(
    field('Add to stand', standSel),
    field('Banner / surface text', textInput),
    row(addBannerBtn, addSmallBtn),
    row(addTextBtn, addFloorBtn),
    row(addSurfaceBtn, addFlagBtn, addScarfBtn),
    divider(),
    field('Paint design onto seats from this view (edits your tifo)', projInput),
    divider(),
    field('Selected asset', assetSel),
    field('Replace image', imgInput),
    field('Width', wRange),
    field('Height', hRange),
    field('Height off ground', yRange),
    row(unfurlBtn, printBtn, delBtn, clearAllBtn),
  );

  // Choreography
  const autoBtn = btn('Auto choreo', 'primary');
  const stopBtn = btn('Stop');
  const revealSel = sel();
  for (const m of REVEAL_MODES) opt(revealSel, m.id, m.label, false);
  const revealBtn = btn('Play reveal');
  const cueTime = document.createElement('input');
  cueTime.type = 'number';
  cueTime.min = '0';
  cueTime.max = '40';
  cueTime.step = '0.5';
  cueTime.value = '0';
  cueTime.className = 'mds-input';
  const cueKind = sel();
  for (const [v, l] of [['reveal', 'Reveal'], ['camera', 'Camera (current)'], ['confetti', 'Confetti'], ['pyro', 'Pyro'], ['smoke-on', 'Smoke on'], ['floods-on', 'Floodlights on']]) opt(cueKind, v, l, false);
  const addCueBtn = btn('Add cue');
  const playSeqBtn = btn('Play sequence', 'primary');
  const clearSeqBtn = btn('Clear');
  const cueCount = document.createElement('div');
  cueCount.className = 'mds-hint';
  cueCount.textContent = '0 cues';
  const secChoreo = section('🎬', 'Choreography', false);
  secChoreo.body.append(
    row(autoBtn, stopBtn),
    divider(),
    field('Reveal style', revealSel),
    revealBtn,
    divider(),
    document.createTextNode(''),
    field('Cue time (seconds)', cueTime),
    field('Cue type', cueKind),
    row(addCueBtn, playSeqBtn, clearSeqBtn),
    cueCount,
  );

  panel.append(secCam.root, secCrowd.root, secAtmo.root, secAssets.root, secChoreo.root);
  overlay.append(bar, panel, host);
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // Bulletproof panel scroll: drive it manually and stop the wheel reaching the
  // editor's global zoom handler behind the overlay (which was eating the scroll).
  panel.addEventListener(
    'wheel',
    (e) => {
      panel.scrollTop += e.deltaY;
      dbg('panel wheel d=' + e.deltaY + ' top=' + Math.round(panel.scrollTop) + '/' + (panel.scrollHeight - panel.clientHeight));
      e.preventDefault();
      e.stopPropagation();
    },
    { passive: false },
  );

  // Hover tooltips on the non-obvious controls.
  for (const [elT, t] of [
    [panelToggle, 'Show or hide the controls panel'],
    [snapBtn, 'Download a PNG of the current view'],
    [fullBtn, 'Toggle fullscreen'],
    [linkBtn, 'Copy a link that opens straight into the simulator'],
    [flyBtn, 'Toggle a cinematic auto-orbit camera'],
    [density, 'Fraction of seats with spectators'],
    [todSel, 'Sky + lighting time of day'],
    [weatherSel, 'Rain or snow'],
    [expRange, 'Overall brightness'],
    [sunRange, 'Sun / key light strength'],
    [floods, 'Floodlight towers + light beams'],
    [smoke, 'Drifting smoke'],
    [wetChk, 'Reflective wet-look pitch (heavier on GPU)'],
    [confettiBtn, 'Burst of confetti'],
    [pyroBtn, 'Burst of pyro flares'],
    [addBannerBtn, 'Big 3D banner that drapes the whole stand'],
    [addSmallBtn, 'Small banner covering the dark front wall / infrastructure'],
    [addTextBtn, 'Text banner using the text box above'],
    [addFloorBtn, 'Banner laid flat on the pitch'],
    [addSurfaceBtn, 'Giant draped surface tifo over the stand'],
    [addFlagBtn, 'Huge waving flag over the crowd'],
    [addScarfBtn, 'Waving scarf wall'],
    [projInput, 'Paints your tifo onto the seats from this view — EDITS your design'],
    [imgInput, 'Put a custom image on the selected asset'],
    [unfurlBtn, 'Drop / unfurl the selected surface tifo'],
    [printBtn, 'Print the selected image as tiled paper panels'],
    [delBtn, 'Delete the selected asset'],
    [clearAllBtn, 'Remove every asset you added'],
    [autoBtn, 'Play a ready-made choreography show'],
    [stopBtn, 'Stop the choreography'],
    [revealBtn, 'Play the selected reveal animation'],
    [addCueBtn, 'Add this cue to your sequence'],
    [playSeqBtn, 'Play your built sequence (or auto choreo if empty)'],
    [clearSeqBtn, 'Clear the sequence'],
  ] as [HTMLElement, string][]) {
    elT.title = t;
  }

  // ---------- simulator instance + state ----------
  let sim: MatchDaySimulator;

  function refreshAssets(): void {
    const assets = sim.listAssets();
    assetSel.replaceChildren();
    opt(assetSel, '', assets.length ? '— select —' : '(no assets yet)', false);
    assets.forEach((a, i) => opt(assetSel, a.id, a.type + ' ' + (i + 1), false));
    assetSel.value = sim.selectedAssetId ?? '';
  }
  function applyState(): void {
    const shots = sim.shots();
    if (camSel.options.length !== shots.length) {
      camSel.replaceChildren();
      shots.forEach((s, i) => opt(camSel, String(i), s.name, false));
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
    sim.setTimeOfDay(state.tod);
    sim.setWeather(state.weather);
    sim.setWetPitch(state.wet);
    if (!state.fly) sim.applyShot(shots[state.camIdx] ?? shots[0]);
  }
  function mount(): void {
    sim = new MatchDaySimulator(host, map, store, template, assetStore, { quality: state.tier });
    applyState();
    refreshAssets();
    sim.start();
  }
  mount();
  dbg('panel @mount', { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, overflowing: panel.scrollHeight > panel.clientHeight });

  // ---------- wiring ----------
  panelToggle.addEventListener('click', () => panel.classList.toggle('collapsed'));
  camSel.addEventListener('change', () => {
    state.camIdx = Number(camSel.value);
    state.fly = false;
    flyBtn.classList.remove('active');
    sim.applyShot(sim.shots()[state.camIdx]);
  });
  qSel.addEventListener('change', () => {
    state.tier = qSel.value as QualityTier;
    sim.dispose();
    mount();
    toast('Quality: ' + state.tier);
  });
  flyBtn.addEventListener('click', () => {
    state.fly = !state.fly;
    flyBtn.classList.toggle('active', state.fly);
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
  todSel.addEventListener('change', () => {
    state.tod = todSel.value as TimeOfDay;
    sim.setTimeOfDay(state.tod);
  });
  weatherSel.addEventListener('change', () => {
    state.weather = weatherSel.value as Weather;
    sim.setWeather(state.weather);
  });
  expRange.addEventListener('input', () => sim.setExposure(Number(expRange.value)));
  sunRange.addEventListener('input', () => sim.setSunIntensity(Number(sunRange.value)));
  floods.addEventListener('change', () => {
    state.floods = floods.checked;
    sim.setFloodlights(state.floods);
  });
  smoke.addEventListener('change', () => {
    state.smoke = smoke.checked;
    sim.setSmoke(state.smoke);
  });
  bannersChk.addEventListener('change', () => {
    state.banners = bannersChk.checked;
    sim.setBannersVisible(state.banners);
  });
  flagsChk.addEventListener('change', () => {
    state.flags = flagsChk.checked;
    sim.setFlagsVisible(state.flags);
  });
  wetChk.addEventListener('change', () => {
    state.wet = wetChk.checked;
    dbg('wet toggle ->', state.wet, '(turn Floodlights on + Night to see it best)');
    sim.setWetPitch(state.wet);
  });
  confettiBtn.addEventListener('click', () => sim.burstConfetti());
  pyroBtn.addEventListener('click', () => sim.burstPyro());

  const stand = (): 0 | 1 | 2 | 3 => (Number(standSel.value) || 1) as 0 | 1 | 2 | 3;
  addBannerBtn.addEventListener('click', () => {
    sim.addBanner(stand());
    refreshAssets();
  });
  addSmallBtn.addEventListener('click', () => {
    sim.addSmallBanner(stand());
    refreshAssets();
  });
  addTextBtn.addEventListener('click', () => {
    sim.addTextBanner(textInput.value.trim() || 'ULTRAS', stand());
    refreshAssets();
  });
  addFloorBtn.addEventListener('click', () => {
    sim.addFloorBanner();
    refreshAssets();
  });
  addSurfaceBtn.addEventListener('click', () => {
    sim.addSurface(stand());
    refreshAssets();
  });
  addFlagBtn.addEventListener('click', () => {
    sim.addMegaFlag(stand());
    refreshAssets();
  });
  addScarfBtn.addEventListener('click', () => {
    sim.addScarves(stand());
    refreshAssets();
  });
  unfurlBtn.addEventListener('click', () => sim.unfurlSelected());
  printBtn.addEventListener('click', () => {
    if (!sim.printSelectedPanels()) toast('Select an image asset first');
  });
  projInput.addEventListener('change', () => {
    const f = projInput.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result !== 'string') return;
      const img = new Image();
      img.onload = () => {
        if (!window.confirm('This PAINTS your tifo onto the seats as seen from this camera — it edits your actual design (undo with Ctrl+Z in the editor). Continue?')) {
          projInput.value = '';
          return;
        }
        const n = sim.projectImageToMosaic(img);
        toast(n.toLocaleString() + ' seats painted');
        projInput.value = '';
      };
      img.src = r.result;
    };
    r.readAsDataURL(f);
  });
  assetSel.addEventListener('change', () => sim.selectAsset(assetSel.value || null));
  imgInput.addEventListener('change', () => {
    const f = imgInput.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result === 'string') sim.updateSelected({ imageRef: r.result });
    };
    r.readAsDataURL(f);
  });
  const applySize = (): void => sim.updateSelected({ scale: { x: Number(wRange.value), y: Number(hRange.value), z: 1 } });
  wRange.addEventListener('input', applySize);
  hRange.addEventListener('input', applySize);
  yRange.addEventListener('input', () => sim.setSelectedY(Number(yRange.value)));
  delBtn.addEventListener('click', () => {
    dbg('delete selected ->', sim.selectedAssetId, '(assets:', sim.listAssets().length + ')');
    sim.removeSelected();
    refreshAssets();
  });
  clearAllBtn.addEventListener('click', () => {
    dbg('clear all assets, count was', sim.listAssets().length);
    assetStore.clear();
    refreshAssets();
  });

  revealBtn.addEventListener('click', () => sim.playReveal(state.reveal));
  revealSel.addEventListener('change', () => {
    state.reveal = revealSel.value as RevealMode;
  });
  const cues: Cue[] = [];
  const updateCueCount = (): void => {
    cueCount.textContent = cues.length + ' cue' + (cues.length === 1 ? '' : 's') + ' in sequence';
  };
  autoBtn.addEventListener('click', () => sim.playAutoChoreo());
  stopBtn.addEventListener('click', () => sim.stopTimeline());
  addCueBtn.addEventListener('click', () => {
    const t = Number(cueTime.value) || 0;
    const k = cueKind.value;
    if (k === 'reveal') cues.push({ kind: 'reveal', start: t, dur: 4, mode: state.reveal });
    else if (k === 'camera') {
      const shot = sim.shots()[Number(camSel.value)] ?? sim.shots()[0];
      cues.push({ kind: 'camera', start: t, shot: shot.name });
    } else cues.push({ kind: 'effect', start: t, effect: k as EffectName });
    updateCueCount();
  });
  playSeqBtn.addEventListener('click', () => {
    if (!cues.length) {
      sim.playAutoChoreo();
      return;
    }
    const dur = Math.max(5, ...cues.map((c) => c.start)) + 5;
    sim.playTimeline({ duration: dur, cues: cues.slice() });
  });
  clearSeqBtn.addEventListener('click', () => {
    cues.length = 0;
    updateCueCount();
  });

  snapBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = sim.snapshot();
    a.download = 'tifo-matchday.png';
    a.click();
    toast('Snapshot saved');
  });
  linkBtn.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('sim', '1');
    void navigator.clipboard?.writeText(u.toString());
    toast('Link copied');
  });

  const onFsChange = (): void => {
    fullBtn.textContent = document.fullscreenElement ? 'Exit full' : 'Fullscreen';
  };
  fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void overlay.requestFullscreen?.();
  });
  document.addEventListener('fullscreenchange', onFsChange);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    if (document.fullscreenElement) void document.exitFullscreen();
    sim.dispose();
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; // don't hijack typing
    if (e.key === 'Escape') {
      if (!document.fullscreenElement) close();
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const i = Number(e.key) - 1;
      const shots = sim.shots();
      if (shots[i]) {
        state.camIdx = i;
        state.fly = false;
        flyBtn.classList.remove('active');
        camSel.value = String(i);
        sim.applyShot(shots[i]);
      }
    } else if (e.key === 'f' || e.key === 'F') {
      fullBtn.click();
    } else if (e.key === 'h' || e.key === 'H') {
      panel.classList.toggle('collapsed');
    } else if (e.key === ' ') {
      e.preventDefault();
      sim.playAutoChoreo();
    }
  };
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  return { close };
}

// ---------- DOM helpers ----------
function btn(label: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = 'mds-btn' + (cls ? ' ' + cls : '');
  return b;
}
function sel(): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'mds-sel';
  return s;
}
function opt(s: HTMLSelectElement, value: string, label: string, selected: boolean): void {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  s.appendChild(o);
}
function fileInput(): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = 'image/*';
  i.className = 'mds-input';
  return i;
}
function rng(min: number, max: number, val: number, step = 1): HTMLInputElement {
  const r = document.createElement('input');
  r.type = 'range';
  r.min = String(min);
  r.max = String(max);
  r.value = String(val);
  r.step = String(step);
  r.className = 'mds-range';
  return r;
}
function chk(checked: boolean): HTMLInputElement {
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.className = 'mds-check';
  return c;
}
function field(label: string, ctrl: HTMLElement): HTMLElement {
  const d = document.createElement('div');
  d.className = 'mds-field';
  const l = document.createElement('div');
  l.className = 'mds-flabel';
  l.textContent = label;
  d.append(l, ctrl);
  return d;
}
function checkField(label: string, c: HTMLInputElement): HTMLElement {
  const l = document.createElement('label');
  l.className = 'mds-checkrow';
  l.append(c, document.createTextNode(label));
  return l;
}
function row(...els: HTMLElement[]): HTMLElement {
  const d = document.createElement('div');
  d.className = 'mds-row';
  d.append(...els);
  return d;
}
function divider(): HTMLElement {
  const d = document.createElement('div');
  d.className = 'mds-divider';
  return d;
}
function barField(label: string, ctrl: HTMLElement): HTMLElement {
  const d = document.createElement('div');
  d.className = 'mds-bf';
  const l = document.createElement('span');
  l.textContent = label;
  d.append(l, ctrl);
  return d;
}
function section(icon: string, title: string, open: boolean): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'mds-section' + (open ? ' open' : '');
  const head = document.createElement('button');
  head.className = 'mds-shead';
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = icon;
  const t = document.createElement('span');
  t.textContent = title;
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '›';
  head.append(ico, t, chev);
  const body = document.createElement('div');
  body.className = 'mds-sbody';
  // Exclusive accordion: opening one section closes the rest, so the panel stays
  // short and every control (incl. Delete / Clear) is reachable without a fight.
  head.addEventListener('click', () => {
    const wasOpen = root.classList.contains('open');
    root.parentElement?.querySelectorAll('.mds-section').forEach((s) => s.classList.remove('open'));
    if (!wasOpen) root.classList.add('open');
  });
  root.append(head, body);
  return { root, body };
}
