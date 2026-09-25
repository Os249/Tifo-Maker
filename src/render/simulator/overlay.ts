import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { MatchDaySimulator, type TimeOfDay } from './index';
import { probeQuality, type QualityTier } from './quality';
import { DEFAULT_LEVELS, type SoundBus, type SoundLevels } from './atmosphere';
import { REVEAL_MODES, type RevealMode } from './choreo';
import { DRUM_CALL } from '../../core/drumCall';
import type { CrowdPreset } from './crowd';
import type { AssetStore } from '../../core/sceneAssets';
import type { BannerStore } from '../../core/banner';
import type { Cue, EffectName } from './timeline';
import type { Weather } from './weather';
import { dbg } from './debug';
import { getLang } from '../../ui/i18n';

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

/**
 * Where the simulator stops being a desktop app.
 *
 * 899, to match `PHONE_MAX` in `ui/mobileShell.ts` — one number for the whole
 * product. It used to be 640, and the 641-899 band was a trap: measured at
 * 844x390 (a phone turned sideways) the top bar overflowed by 17px and put
 * **Close** off the right edge, and at 768x1024 (iPad portrait) it overflowed
 * by 93px and took Help with it. With no keyboard there is no Escape, so the
 * only way out of the simulator was to leave the page — which is the "adding
 * an image hangs" dead end again, one screen further in.
 */
const MOBILE_MAX = 899;

const TIER_LABELS: [QualityTier, string][] = [
  // 'low' is offered, not just probed into. A three-year-old Android is most
  // of this audience, and the honest answer to a stuttering bowl is fewer
  // pixels — not a menu whose floor is already above what the phone can hold.
  ['low', 'Low'],
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
.mds-overlay{
  --bg:#05070a;--surface:#0d1117;--surface-2:#10151c;--surface-3:#161b22;
  --panel:rgba(13,17,23,.92);--bar:rgba(10,13,18,.92);--head:#141a22;--head-hover:#1a212b;
  --elev:#1c232c;--elev-hover:#283340;
  --border:#2c3742;--border-soft:#1e2630;--border-strong:#3a4554;
  --text:#e6e9ee;--text-dim:#8a93a0;--text-faint:#6b7480;
  --accent:#3fb950;--accent-hover:#4ad063;--accent-weak:#225338;--accent-ink:#06210f;--accent-soft:#7fcf96;
  --r:8px;--r-lg:14px;--r-sm:5px;
  --shadow:0 12px 44px rgba(0,0,0,.55);
  --t-fast:.12s;--t-med:.22s;
  --focus:0 0 0 2px rgba(63,185,80,.6);
  position:fixed;inset:0;z-index:10000;background:var(--bg);display:flex;flex-direction:column;font:13px/1.4 system-ui,-apple-system,sans-serif;color:var(--text);}
.mds-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--bar);backdrop-filter:blur(8px);border-bottom:1px solid var(--elev);flex:0 0 auto;z-index:3;}
.mds-brand{font-weight:700;font-size:15px;letter-spacing:.2px;display:flex;align-items:center;gap:8px;}
.mds-brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 9px var(--accent);}
.mds-spacer{margin-left:auto;}
.mds-status{font-size:12px;color:var(--accent-soft);min-width:6px;transition:opacity .3s;}
.mds-bf{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);}
.mds-btn{font:13px system-ui,sans-serif;color:var(--text);background:var(--elev);border:1px solid var(--border);border-radius:var(--r);padding:7px 12px;cursor:pointer;transition:background var(--t-fast),border-color var(--t-fast),transform .05s,box-shadow var(--t-fast);white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px;}
.mds-btn:hover{background:var(--elev-hover);border-color:var(--border-strong);}
.mds-btn:active{transform:translateY(1px);}
.mds-btn.active{background:var(--accent-weak);border-color:var(--accent);color:#eafff0;}
.mds-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;}
.mds-btn.primary:hover{background:var(--accent-hover);}
.mds-btn[hidden]{display:none;}
.mds-icon{padding:7px 10px;}
.mds-icon svg{width:16px;height:16px;display:block;}
.mds-sel,.mds-input{font:13px system-ui,sans-serif;color:var(--text);background:var(--surface-3);border:1px solid var(--border);border-radius:var(--r);padding:6px 9px;cursor:pointer;width:100%;box-sizing:border-box;transition:border-color var(--t-fast),box-shadow var(--t-fast);}
.mds-input{cursor:text;}
.mds-input[type=file]{font-size:11px;color:#aab2bd;padding:5px;cursor:pointer;}
.mds-input[type=number]{width:80px;}
.mds-panel{position:absolute;top:62px;left:14px;width:286px;overflow-y:auto;overscroll-behavior:contain;background:var(--panel);backdrop-filter:blur(12px);border:1px solid #242c37;border-radius:var(--r-lg);padding:8px;display:block;box-shadow:var(--shadow);z-index:2;transition:transform var(--t-med) ease,opacity var(--t-med);}
.mds-panel.collapsed{transform:translateX(-310px);opacity:0;pointer-events:none;}
.mds-overlay[dir="rtl"] .mds-panel{left:auto;right:14px;}
.mds-overlay[dir="rtl"] .mds-panel.collapsed{transform:translateX(310px);}
.mds-panel::-webkit-scrollbar{width:8px;}
.mds-panel::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px;}
.mds-section{border:1px solid var(--border-soft);border-radius:10px;overflow:hidden;background:var(--surface-2);margin-bottom:7px;}
.mds-shead{display:flex;align-items:center;gap:9px;width:100%;padding:11px 12px;background:var(--head);border:none;color:var(--text);font:600 13px system-ui,sans-serif;cursor:pointer;text-align:left;transition:background var(--t-fast);}
.mds-shead:hover{background:var(--head-hover);}
.mds-shead .ico{display:flex;align-items:center;color:var(--accent);}
.mds-shead .ico svg{width:16px;height:16px;display:block;}
.mds-shead .chev{margin-left:auto;display:flex;align-items:center;transition:transform .15s;color:var(--text-dim);}
.mds-shead .chev svg{width:14px;height:14px;display:block;}
.mds-section.open .chev{transform:rotate(90deg);}
.mds-sbody{display:none;flex-direction:column;gap:11px;padding:13px 12px;}
.mds-section.open .mds-sbody{display:flex;}
.mds-field{display:flex;flex-direction:column;gap:5px;}
.mds-flabel{font-size:11px;color:var(--text-dim);}
.mds-flabel-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
.mds-fval{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent-soft);}
.mds-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.mds-row .mds-btn{flex:1 1 auto;text-align:center;}
.mds-divider{height:1px;background:var(--border-soft);margin:1px 0;}
.mds-checkrow{display:flex;align-items:center;gap:9px;font-size:12.5px;line-height:1.3;color:#cfd6df;cursor:pointer;margin:0;}
.mds-hint{font-size:11px;color:var(--text-faint);}
.mds-beats{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:6;display:flex;gap:10px;align-items:center;padding:8px 13px;border-radius:999px;background:rgba(6,10,18,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .2s;pointer-events:none;}
.mds-beats.show{opacity:1;}
.mds-beats i{width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,.22);transition:transform .1s,background .08s;}
.mds-beats i.on{background:#0FBF6B;}
.mds-beats[data-phase=down] i.on{background:#F5B43C;}
.mds-beats i.hit{transform:scale(1.45);}
input[type=range].mds-range{width:100%;accent-color:var(--accent);}
input[type=checkbox].mds-check{appearance:none;-webkit-appearance:none;position:relative;width:16px;height:16px;min-width:16px;margin:0;flex:0 0 auto;cursor:pointer;border:1.5px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);transition:background .15s,border-color .15s;}
input[type=checkbox].mds-check:checked{background:var(--accent);border-color:var(--accent);}
input[type=checkbox].mds-check::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) scale(0);transition:transform .12s ease;}
input[type=checkbox].mds-check:checked::after{transform:rotate(45deg) scale(1);}
.mds-checkrow span{flex:1;}
.mds-help{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(3,5,8,.55);backdrop-filter:blur(3px);opacity:0;pointer-events:none;transition:opacity var(--t-med);}
.mds-help.show{opacity:1;pointer-events:auto;}
.mds-help-card{width:min(440px,92vw);max-height:84vh;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:22px;transform:translateY(8px) scale(.98);transition:transform var(--t-med);}
.mds-help.show .mds-help-card{transform:none;}
.mds-help-card h2{margin:0 0 4px;font-size:18px;}
.mds-help-card .sub{margin:0 0 16px;color:var(--text-dim);font-size:13px;}
.mds-help-grp{margin:0 0 14px;}
.mds-help-grp h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--accent);}
.mds-kv{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--border-soft);font-size:13px;}
.mds-kv:last-child{border-bottom:none;}
.mds-kv .k{color:var(--text-dim);}
.mds-key{display:inline-block;min-width:16px;text-align:center;padding:1px 6px;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:5px;background:var(--surface-3);font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);}
.mds-help-actions{display:flex;justify-content:flex-end;margin-top:8px;}
.mds-fail{position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(3,5,8,.82);backdrop-filter:blur(3px);}
.mds-fail.show{display:flex;}
.mds-fail-card{width:min(420px,92vw);background:var(--panel);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:22px;text-align:center;}
.mds-fail-card h2{margin:0 0 8px;font-size:17px;}
.mds-fail-card p{margin:0 0 16px;color:var(--text-dim);font-size:13px;line-height:1.55;}
.mds-fail-acts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.mds-fail-acts .mds-btn{flex:0 1 auto;}
.mds-baracts{display:flex;align-items:center;gap:10px;}
.mds-panel-acts{display:none;}
.mds-brand .brand-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mds-overlay canvas{touch-action:none;display:block;}
@media (max-width:${MOBILE_MAX}px){
  .mds-bar{padding:8px 10px;gap:7px;}
  .mds-brand{min-width:0;font-size:14px;}
  .mds-panel{top:auto;left:0;right:0;bottom:0;width:auto;max-height:64vh;height:auto!important;border-radius:16px 16px 0 0;border-left:none;border-right:none;border-bottom:none;padding:10px 12px calc(10px + env(safe-area-inset-bottom));transition:transform var(--t-med) ease,opacity var(--t-med);}
  .mds-panel.collapsed{transform:translateY(102%);opacity:1;}
  /* The base sheet has two RTL rules, .mds-overlay[dir=rtl] .mds-panel and
     ...collapsed, and those outrank a bare .mds-panel however late it comes.
     Without the two below to answer them, Arabic on
     a phone kept the 286px side rail pinned to the right edge AND the sideways
     collapse: measured at 360px the panel sat at x=310, 90% off-screen, with
     fourteen controls — quality, cameras, crowd, atmosphere, recording — that
     could not be reached at all. Both bug reports that started this work were
     written in Arabic. */
  .mds-overlay[dir="rtl"] .mds-panel{left:0;right:0;}
  .mds-overlay[dir="rtl"] .mds-panel.collapsed{transform:translateY(102%);}
  .mds-panel-acts{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);}
  .mds-panel-acts .mds-baracts{display:flex;flex-wrap:wrap;gap:8px;width:100%;}
  .mds-panel-acts .mds-baracts .mds-bf{flex:1 1 100%;}
  .mds-panel-acts .mds-baracts .mds-bf .mds-sel{flex:1 1 auto;}
  .mds-panel-acts .mds-baracts .mds-btn{flex:1 1 auto;}
  .mds-btn,.mds-sel,.mds-input{min-height:44px;}
  .mds-icon{min-width:44px;min-height:44px;}
  .mds-shead{min-height:48px;}
  /* 24px is the WCAG 2.2 target-size floor and the number the rest of this app
     is held to. These were 20, which nothing caught while the Sound section
     was two checkboxes deep in a collapsed panel and is very visible now that
     it is five faders and five boxes. */
  input[type=checkbox].mds-check{width:24px;height:24px;min-width:24px;}
  input[type=checkbox].mds-check::after{left:8px;top:3.5px;width:6px;height:12px;}
  /* A range input is 20px tall by default, which is a fader you cannot grab. */
  input[type=range].mds-range{min-height:28px;}
  .mds-help-card{padding:18px;}
}
@keyframes mds-in{from{opacity:0}to{opacity:1}}
@keyframes mds-pop{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
@keyframes mds-flash{0%{opacity:0}10%{opacity:.85}100%{opacity:0}}
.mds-overlay{animation:mds-in .26s ease;}
.mds-section.open .mds-sbody{animation:mds-pop .2s ease;}
.mds-btn{box-shadow:0 1px 2px rgba(0,0,0,.18);}
.mds-btn:hover{box-shadow:0 3px 14px rgba(0,0,0,.3);}
.mds-btn:active{box-shadow:0 1px 2px rgba(0,0,0,.25);}
.mds-flash{position:absolute;inset:0;z-index:7;background:#fff;opacity:0;pointer-events:none;}
.mds-flash.go{animation:mds-flash .5s ease;}
.mds-overlay :focus-visible{outline:none;box-shadow:var(--focus);border-color:var(--accent);}
@media (prefers-reduced-motion: reduce){.mds-overlay,.mds-overlay *,.mds-overlay *::after{transition-duration:.01ms!important;animation-duration:.01ms!important;}}
`;

/** Inline line-icons (stroke = currentColor), sized via CSS. Replaces emoji. */
const ICONS = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10.5l6-3.5v10l-6-3.5Z"/></svg>',
  crowd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.5"/><path d="M18.5 20a5.5 5.5 0 0 0-2.7-4.7"/></svg>',
  atmosphere: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
  assets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>',
  choreo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 8l2.5-4h3.5L6.5 8M11 8l2.5-4H17l-2.5 4"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M9.3 9.2a2.7 2.7 0 1 1 3.9 2.5c-.8.4-1.2.9-1.2 1.8"/><path d="M12 17h.01"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L12 19V5L7.5 9H4Z"/><path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>',
  record: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10.5l6-3.5v10l-6-3.5Z"/><circle cx="8.5" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
} as const;

/**
 * Self-contained Arabic for the simulator (keyed, so homonyms like "Clear" stay
 * distinct). L(key) returns the live language each time the overlay is opened.
 */
const MDS_T: Record<string, { en: string; ar: string }> = {
  brand: { en: 'Match Day Simulator', ar: 'محاكي يوم المباراة' },
  showHide: { en: 'Show/hide controls', ar: 'إظهار/إخفاء الأدوات' },
  shortcuts: { en: 'Shortcuts: 1-9 camera views · H hide panel · F fullscreen · Space play show', ar: 'اختصارات: ١-٩ لقطات الكاميرا · H إخفاء اللوحة · F ملء الشاشة · مسافة لتشغيل العرض' },
  quality: { en: 'Quality', ar: 'الجودة' },
  snapshot: { en: 'Snapshot', ar: 'لقطة' },
  fullscreen: { en: 'Fullscreen', ar: 'ملء الشاشة' },
  copyLink: { en: 'Copy link', ar: 'انسخ الرابط' },
  close: { en: 'Close', ar: 'إغلاق' },
  exitFull: { en: 'Exit full', ar: 'إنهاء ملء الشاشة' },
  helpControls: { en: 'Help & controls (?)', ar: 'المساعدة والأدوات (؟)' },
  noWebgl: { en: 'This phone cannot run the stadium', ar: 'هذا الجهاز ما يقدر يشغّل الملعب' },
  noWebglBody: {
    en: 'Match Day needs 3D graphics (WebGL), and this browser did not give us any. Try another browser, or open tifomaker.org on a computer.',
    ar: 'يوم المباراة يحتاج رسومات ثلاثية الأبعاد (WebGL)، وهذا المتصفح ما وفّرها. جرّب متصفح ثاني، أو افتح tifomaker.org على كمبيوتر.',
  },
  lost: { en: 'The stadium ran out of memory', ar: 'الملعب خلصت ذاكرته' },
  lostBody: {
    en: 'Your phone reclaimed the 3D view — usually because another app needed the memory. Rebuild it, or drop the quality first.',
    ar: 'جهازك سحب الذاكرة من العرض ثلاثي الأبعاد — غالبًا لأن تطبيق ثاني احتاجها. أعد البناء، أو نزّل الجودة أول.',
  },
  rebuild: { en: 'Rebuild', ar: 'أعد البناء' },
  'tier.low': { en: 'Low', ar: 'منخفض' },
  'tier.medium': { en: 'Medium', ar: 'متوسط' },
  'tier.high': { en: 'High', ar: 'عالي' },
  'tier.ultra': { en: 'Ultra', ar: 'فائق' },
  camCam: { en: 'Camera & Views', ar: 'الكاميرا واللقطات' },
  view: { en: 'View', ar: 'اللقطة' },
  flyover: { en: 'Cinematic flyover', ar: 'تحليق سينمائي' },
  crowd: { en: 'Crowd', ar: 'الجمهور' },
  stadiumFill: { en: 'Stadium fill', ar: 'امتلاء الملعب' },
  density: { en: 'Density', ar: 'الكثافة' },
  showCrowd: { en: 'Show crowd on tifo seats', ar: 'إظهار الجمهور على مقاعد التيفو' },
  'crowd.sellout': { en: 'Sell-out', ar: 'كامل العدد' },
  'crowd.home': { en: 'Home', ar: 'أرضنا' },
  'crowd.away-end': { en: 'Away end', ar: 'مدرج الضيوف' },
  'crowd.half': { en: 'Half full', ar: 'نصف ممتلئ' },
  'crowd.empty': { en: 'Empty', ar: 'فاضي' },
  atmo: { en: 'Atmosphere', ar: 'الأجواء' },
  timeOfDay: { en: 'Time of day', ar: 'وقت اليوم' },
  weather: { en: 'Weather', ar: 'الطقس' },
  exposure: { en: 'Exposure', ar: 'السطوع' },
  sunIntensity: { en: 'Sun intensity', ar: 'شدة الشمس' },
  floodlights: { en: 'Floodlights', ar: 'الكشافات' },
  smoke: { en: 'Smoke', ar: 'الدخان' },
  railBanners: { en: 'Rail banners', ar: 'لافتات الفواصل' },
  coverStairs: { en: 'Cover stairs', ar: 'تغطية الدرج' },
  cornerFlags: { en: 'Corner flags', ar: 'أعلام الأركان' },
  wetPitch: { en: 'Wet pitch (reflections)', ar: 'أرضية مبلّلة (انعكاسات)' },
  phoneFlashes: { en: 'Phone flashes in the stands', ar: 'أضواء الجوالات في المدرجات' },
  confetti: { en: 'Confetti', ar: 'قصاصات' },
  pyro: { en: 'Pyro', ar: 'شماريخ' },
  'tod.day': { en: 'Day', ar: 'نهار' },
  'tod.dusk': { en: 'Dusk', ar: 'غروب' },
  'tod.night': { en: 'Night', ar: 'ليل' },
  'tod.sunset': { en: 'Sunset', ar: 'مغيب' },
  'weather.clear': { en: 'Clear', ar: 'صحو' },
  'weather.rain': { en: 'Rain', ar: 'مطر' },
  'weather.snow': { en: 'Snow', ar: 'ثلج' },
  assets: { en: 'Tifo Assets', ar: 'عناصر التيفو' },
  addToStand: { en: 'Add to stand', ar: 'أضف للمدرج' },
  bannerText: { en: 'Banner / surface text', ar: 'نص اللافتة / السطح' },
  bigBanner: { en: 'Big banner', ar: 'لافتة كبيرة' },
  smallBanner: { en: 'Small banner', ar: 'لافتة صغيرة' },
  text: { en: 'Text', ar: 'نص' },
  floor: { en: 'Floor', ar: 'أرضية' },
  surface: { en: 'Surface', ar: 'سطح' },
  megaFlag: { en: 'Mega-flag', ar: 'علم عملاق' },
  scarves: { en: 'Scarves', ar: 'أوشحة' },
  projectField: { en: 'Paint design onto seats from this view (edits your tifo)', ar: 'ارسم التصميم على المقاعد من هذي اللقطة (يعدّل تيفوك)' },
  selectedAsset: { en: 'Selected asset', ar: 'العنصر المحدد' },
  posX: { en: 'Move ↔ (X)', ar: 'تحريك ↔ (X)' },
  posZ: { en: 'Move ↕ (Z)', ar: 'تحريك ↕ (Z)' },
  rotate: { en: 'Rotate', ar: 'تدوير' },
  replaceImage: { en: 'Replace image', ar: 'استبدل الصورة' },
  width: { en: 'Width', ar: 'العرض' },
  height: { en: 'Height', ar: 'الارتفاع' },
  heightOff: { en: 'Height off ground', ar: 'الارتفاع عن الأرض' },
  unfurl: { en: 'Unfurl', ar: 'انشر' },
  printPanels: { en: 'Print panels', ar: 'اطبع الألواح' },
  deleteSelected: { en: 'Delete selected', ar: 'احذف المحدد' },
  clearAll: { en: 'Clear all', ar: 'امسح الكل' },
  'stand.1': { en: 'North', ar: 'الشمالي' },
  'stand.3': { en: 'South', ar: 'الجنوبي' },
  'stand.0': { en: 'East', ar: 'الشرقي' },
  'stand.2': { en: 'West', ar: 'الغربي' },
  choreo: { en: 'Choreography', ar: 'الكوريغرافيا' },
  autoChoreo: { en: 'Auto choreo', ar: 'كوريغرافيا تلقائية' },
  stop: { en: 'Stop', ar: 'إيقاف' },
  revealStyle: { en: 'Reveal style', ar: 'نمط الكشف' },
  'rm.wipe-lr': { en: 'Wipe across', ar: 'مسح بالعرض' },
  'rm.wipe-up': { en: 'Wipe upward', ar: 'مسح للأعلى' },
  'rm.center-out': { en: 'Center out', ar: 'من النص للأطراف' },
  'rm.sparkle': { en: 'Sparkle in', ar: 'يتلألأ' },
  'rm.drum-call': { en: 'Drum call (Saudi style)', ar: 'على الطبل (الطريقة السعودية)' },
  drumHold: { en: 'Hold it up for', ar: 'يثبت مرفوع لمدة' },
  drumTimes: { en: 'How many times', ar: 'كم مرة' },
  'drumTimes.1': { en: 'Once', ar: 'مرة وحدة' },
  'drumTimes.2': { en: 'Twice', ar: 'مرتين' },
  'drumTimes.3': { en: 'Three times', ar: 'ثلاث مرات' },
  drumHint: { en: 'Three hits of the drum and the whole stand lifts its cards at once. Three more and they all come down, and the picture vanishes.', ar: 'ثلاث ضربات طبل ويرفع المدرج كله الكروت مرة وحدة. ثلاث ضربات ثانية وتنزل كلها ويختفي التيفو.' },
  drumSoundHint: { en: 'Turn on Sound to hear the drum', ar: 'شغّل الصوت عشان تسمع الطبل' },
  drumBeats: { en: 'Drum count', ar: 'عدّ الطبل' },
  cueDrumCall: { en: 'Drum call added', ar: 'انضافت ضربات الطبل' },
  secs: { en: '{n}s', ar: '{n} ث' },
  cueCount: { en: '{n} cues in sequence', ar: 'عدد اللقطات في التسلسل: {n}' },
  cueCountOne: { en: '1 cue in sequence', ar: 'لقطة وحدة في التسلسل' },
  playReveal: { en: 'Play reveal', ar: 'شغّل الكشف' },
  cueTime: { en: 'Cue time (seconds)', ar: 'وقت اللقطة (ثواني)' },
  cueType: { en: 'Cue type', ar: 'نوع اللقطة' },
  addCue: { en: 'Add cue', ar: 'أضف لقطة' },
  playSeq: { en: 'Play sequence', ar: 'شغّل التسلسل' },
  clearSeq: { en: 'Clear', ar: 'مسح' },
  'cue.reveal': { en: 'Reveal', ar: 'كشف' },
  'cue.camera': { en: 'Camera (current)', ar: 'كاميرا (الحالية)' },
  'cue.confetti': { en: 'Confetti', ar: 'قصاصات' },
  'cue.pyro': { en: 'Pyro', ar: 'شماريخ' },
  'cue.smoke-on': { en: 'Smoke on', ar: 'تشغيل الدخان' },
  'cue.floods-on': { en: 'Floodlights on', ar: 'تشغيل الكشافات' },
  noAssets: { en: '(no assets yet)', ar: '(ما في عناصر بعد)' },
  selectDash: { en: '(select)', ar: '(اختر)' },
  helpSub: { en: 'See your tifo come alive in a packed 3D stadium.', ar: 'شوف تيفوك يصير حقيقة في ملعب ثلاثي الأبعاد ممتلئ.' },
  hMove: { en: 'Move the camera', ar: 'حرّك الكاميرا' },
  hLook: { en: 'Look around', ar: 'انظر حولك' },
  hDrag: { en: 'Drag', ar: 'سحب' },
  hZoom: { en: 'Zoom', ar: 'تكبير' },
  hScroll: { en: 'Scroll / pinch', ar: 'تمرير / قرص' },
  hPan: { en: 'Pan', ar: 'تحريك' },
  hRightDrag: { en: 'Right-drag', ar: 'سحب باليمين' },
  hOneFinger: { en: 'One finger', ar: 'إصبع واحد' },
  hTwoFinger: { en: 'Two fingers', ar: 'إصبعين' },
  hPinch: { en: 'Pinch', ar: 'قرص' },
  hShortcuts: { en: 'Shortcuts', ar: 'اختصارات' },
  hCamViews: { en: 'Camera views', ar: 'لقطات الكاميرا' },
  hPlayReveal: { en: 'Play the reveal', ar: 'تشغيل الكشف' },
  hFull: { en: 'Fullscreen', ar: 'ملء الشاشة' },
  hHide: { en: 'Hide panel', ar: 'إخفاء اللوحة' },
  hHelp: { en: 'Help', ar: 'مساعدة' },
  hClose: { en: 'Close', ar: 'إغلاق' },
  hYours: { en: 'Make it yours', ar: 'خلّه لك' },
  hBanners: { en: 'Flags and quick banners', ar: 'الأعلام واللافتات السريعة' },
  hYourBanners: { en: 'Banners you drew', ar: 'اللافتات اللي رسمتها' },
  hTimeWeather: { en: 'Time, weather, effects', ar: 'الوقت والطقس والمؤثرات' },
  hAutoChoreo: { en: 'Auto choreography', ar: 'كوريغرافيا تلقائية' },
  gotIt: { en: 'Got it', ar: 'تمام' },
  'tip.panel': { en: 'Show or hide the controls panel', ar: 'إظهار أو إخفاء لوحة الأدوات' },
  'tip.snap': { en: 'Download a PNG of the current view', ar: 'نزّل صورة PNG للقطة الحالية' },
  'tip.full': { en: 'Toggle fullscreen', ar: 'تبديل ملء الشاشة' },
  'tip.link': { en: 'Copy a link that opens straight into the simulator', ar: 'انسخ رابط يفتح المحاكي مباشرة' },
  'tip.fly': { en: 'Toggle a cinematic auto-orbit camera', ar: 'تبديل كاميرا دوران سينمائي تلقائي' },
  'tip.density': { en: 'Fraction of seats with spectators', ar: 'نسبة المقاعد اللي فيها جمهور' },
  'tip.tod': { en: 'Sky + lighting time of day', ar: 'السماء والإضاءة حسب وقت اليوم' },
  'tip.weather': { en: 'Rain or snow', ar: 'مطر أو ثلج' },
  'tip.exp': { en: 'Overall brightness', ar: 'السطوع العام' },
  'tip.sun': { en: 'Sun / key light strength', ar: 'قوة ضوء الشمس الرئيسي' },
  'tip.floods': { en: 'Floodlight towers + light beams', ar: 'أبراج الكشافات وأشعة الضوء' },
  'tip.smoke': { en: 'Drifting smoke', ar: 'دخان منساب' },
  'tip.banners': { en: 'Fill the dark walkway gap between tiers with your design', ar: 'عبّي الفراغ المعتم بين الطوابق بتصميمك' },
  'tip.stairs': { en: 'Also fill the aisles / stairs between sections (unorthodox, off by default)', ar: 'عبّي كمان الممرات/الدرج بين القطاعات (غير معتاد، مطفأ افتراضياً)' },
  'tip.wet': { en: 'Reflective wet-look pitch (heavier on GPU)', ar: 'أرضية مبلّلة عاكسة (أثقل على المعالج الرسومي)' },
  'tip.sparkles': { en: 'Twinkling phone lights across the crowd — off by default, so a still tifo reads still', ar: 'أضواء جوالات تتلألأ بين الجمهور — مطفأة افتراضياً ليبقى التيفو الثابت ثابتاً' },
  'tip.confetti': { en: 'Burst of confetti', ar: 'انفجار قصاصات' },
  'tip.pyro': { en: 'Burst of pyro flares', ar: 'انفجار شماريخ' },
  'tip.bigBanner': { en: 'Big 3D banner that drapes the whole stand', ar: 'لافتة ثلاثية الأبعاد كبيرة تغطي المدرج كامل' },
  'tip.smallBanner': { en: 'Small banner covering the dark front wall / infrastructure', ar: 'لافتة صغيرة تغطي الجدار الأمامي المعتم' },
  'tip.text': { en: 'Text banner using the text box above', ar: 'لافتة نص باستخدام مربع النص فوق' },
  'tip.floor': { en: 'Banner laid flat on the pitch', ar: 'لافتة مفروشة على الأرضية' },
  'tip.surface': { en: 'Giant draped surface tifo over the stand', ar: 'تيفو سطح عملاق منسدل على المدرج' },
  'tip.flag': { en: 'Huge waving flag over the crowd', ar: 'علم ضخم يرفرف فوق الجمهور' },
  'tip.scarf': { en: 'Waving scarf wall', ar: 'جدار أوشحة يرفرف' },
  'tip.proj': { en: 'Paints your tifo onto the seats from this view, EDITS your design', ar: 'يرسم تيفوك على المقاعد من هذي اللقطة، يعدّل تصميمك' },
  'tip.img': { en: 'Put a custom image on the selected asset', ar: 'حط صورة مخصصة على العنصر المحدد' },
  'tip.unfurl': { en: 'Drop / unfurl the selected surface tifo', ar: 'أسقط / انشر تيفو السطح المحدد' },
  'tip.print': { en: 'Print the selected image as tiled paper panels', ar: 'اطبع الصورة المحددة كألواح ورقية' },
  'tip.del': { en: 'Delete the selected asset', ar: 'احذف العنصر المحدد' },
  'tip.clearAll': { en: 'Remove every asset you added', ar: 'احذف كل العناصر اللي أضفتها' },
  'tip.auto': { en: 'Play a ready-made choreography show', ar: 'شغّل عرض كوريغرافيا جاهز' },
  'tip.stop': { en: 'Stop the choreography', ar: 'أوقف الكوريغرافيا' },
  'tip.reveal': { en: 'Play the selected reveal animation', ar: 'شغّل حركة الكشف المحددة' },
  'tip.addCue': { en: 'Add this cue to your sequence', ar: 'أضف هذي اللقطة لتسلسلك' },
  'tip.playSeq': { en: 'Play your built sequence (or auto choreo if empty)', ar: 'شغّل تسلسلك (أو الكوريغرافيا التلقائية لو فاضي)' },
  'tip.clearSeq': { en: 'Clear the sequence', ar: 'امسح التسلسل' },
  'toast.quality': { en: 'Quality: ', ar: 'الجودة: ' },
  'toast.printFirst': { en: 'Select an image asset first', ar: 'اختر عنصر صورة أول' },
  'toast.painted': { en: ' seats painted', ar: ' مقعد تم رسمها' },
  'toast.snapSaved': { en: 'Snapshot saved', ar: 'تم حفظ اللقطة' },
  'toast.linkCopied': { en: 'Link copied', ar: 'تم نسخ الرابط' },
  record: { en: 'Record', ar: 'تسجيل' },
  recording: { en: 'Recording…', ar: 'يسجّل…' },
  recordSaved: { en: 'Reveal video saved', ar: 'تم حفظ فيديو الكشف' },
  recordSize: { en: 'MB', ar: 'م.ب' },
  sound: { en: 'Sound', ar: 'الصوت' },
  soundOn: { en: 'Stadium sound', ar: 'صوت الملعب' },
  mute: { en: 'Mute', ar: 'كتم الصوت' },
  crowdNoise: { en: 'Crowd', ar: 'صوت الجمهور' },
  volume: { en: 'Volume', ar: 'مستوى الصوت' },
  volMaster: { en: 'Overall', ar: 'العام' },
  volCrowd: { en: 'Crowd', ar: 'الجمهور' },
  volSfx: { en: 'Effects', ar: 'المؤثرات' },
  volAmb: { en: 'Weather', ar: 'الطقس' },
  volDrum: { en: 'Drum', ar: 'الطبل' },
  reactive: { en: 'Crowd follows the stadium fill', ar: 'صوت الجمهور يتبع امتلاء الملعب' },
  weatherSound: { en: 'Weather you can hear', ar: 'صوت المطر والهواء' },
  drum: { en: 'Ultras drum', ar: 'طبل الألتراس' },
  tryRoar: { en: 'Roar', ar: 'هدير' },
  tryWhistle: { en: 'Whistle', ar: 'صافرة' },
  tryApplause: { en: 'Applause', ar: 'تصفيق' },
  tryHorn: { en: 'Air horn', ar: 'بوق' },
  tryChant: { en: 'Chant', ar: 'هتاف' },
  soundBlocked: { en: 'This browser would not start audio. Click anywhere, then try again.', ar: 'المتصفح ما سمح بتشغيل الصوت. اضغط أي مكان وجرّب مرة ثانية.' },
  'tip.crowdNoise': { en: 'The stadium, synthesised — it swells on its own and roars when the tifo goes up', ar: 'صوت الملعب مولَّد — يعلو وينخفض لحاله ويهدر لما يطلع التيفو' },
  'tip.soundOn': { en: 'The whole rig: crowd, effects, weather and drum. Nothing plays until you ask', ar: 'كل الأصوات: الجمهور والمؤثرات والطقس والطبل. ما يشتغل شي إلا لما تطلبه' },
  'tip.mute': { en: 'Silence everything without losing where you set the faders', ar: 'اسكت كل شي بدون ما تفقد إعدادات المستويات' },
  'tip.volMaster': { en: 'Everything at once, after the four below', ar: 'كل شي مرة وحدة، بعد الأربعة اللي تحت' },
  'tip.volCrowd': { en: 'The bed, its swell, roars, applause and the chant', ar: 'الأرضية وتموجها والهدير والتصفيق والهتاف' },
  'tip.volSfx': { en: 'Whistle, air horn, pyro, confetti, the floodlight contactor', ar: 'الصافرة والبوق والألعاب النارية والقصاصات وكشافات الملعب' },
  'tip.volAmb': { en: 'Rain and wind, when the weather is set to them', ar: 'المطر والهواء، لما يكون الطقس عليهم' },
  'tip.volDrum': { en: 'The terrace drum on its own — it is the most intrusive thing here', ar: 'طبل المدرج لحاله — هو أكثر شي يفرض نفسه هنا' },
  'tip.reactive': { en: 'An empty stadium should not roar like a sell-out', ar: 'الملعب الفاضي ما يصير يهدر مثل الممتلئ' },
  'tip.weatherSound': { en: 'Rain on the roof and wind round the bowl, following the Atmosphere setting', ar: 'صوت المطر والهواء، يتبع إعداد الأجواء' },
  'tip.tryApplause': { en: 'Hands, not voices', ar: 'تصفيق، مو أصوات' },
  'tip.tryHorn': { en: 'The one every away end owns exactly one of', ar: 'البوق اللي ما يخلو منه مدرج ضيوف' },
  'tip.tryChant': { en: 'One call-and-response cycle, over the drum', ar: 'دورة هتاف وحدة، فوق الطبل' },
  'tip.drum': { en: 'The terrace drum behind the crowd, about 96 beats a minute', ar: 'طبل المدرج خلف الجمهور، حوالي ٩٦ نبضة في الدقيقة' },
  recordNotUniversal: {
    en: 'This browser could not record H.264, so the file may not open on every device.',
    ar: 'هذا المتصفح ما قدر يسجّل بصيغة H.264، فقد ما يفتح الملف على كل الأجهزة.',
  },
  recordUnsupported: { en: 'Recording is not supported in this browser', ar: 'التسجيل غير مدعوم في هذا المتصفح' },
  recTitle: { en: 'Recording', ar: 'التسجيل' },
  recLength: { en: 'Length', ar: 'المدة' },
  frameRate: { en: 'Frame rate', ar: 'معدل الإطارات' },
  resolution: { en: 'Resolution', ar: 'الدقة' },
  resSource: { en: 'Source', ar: 'الأصلية' },
  recPreview: { en: 'Preview', ar: 'معاينة' },
  recordVideo: { en: 'Record video', ar: 'سجّل فيديو' },
  previewing: { en: 'Previewing the reveal…', ar: 'معاينة الكشف…' },

  // ---- banners ----
  bannersTitle: { en: 'Banners', ar: 'اللافتات' },
  theBanner: { en: 'Banner', ar: 'اللافتة' },
  noBanners: { en: '(draw one in the Banner view)', ar: '(ارسم وحدة في عرض اللافتة)' },
  lookAtIt: { en: 'Look at it', ar: 'شوفها' },
  playIt: { en: 'Play the reveal', ar: 'شغّل الكشف' },
  scrub: { en: 'Scrub', ar: 'تقديم' },
  onStand: { en: 'Stand', ar: 'المدرج' },
  acrossStands: { en: 'Across', ar: 'الامتداد' },
  acrossOne: { en: 'This stand', ar: 'هذا المدرج' },
  acrossTwo: { en: 'Two stands, round the corner', ar: 'مدرجان، حول الزاوية' },
  acrossPair: { en: '{a} and {b}, round the corner', ar: '{a} و{b}، حول الزاوية' },
  firstBlock: { en: 'First block', ar: 'القطاع الأول' },
  howManyBlocks: { en: 'How many', ar: 'عدد القطاعات' },
  whichTier: { en: 'Tier', ar: 'الطابق' },
  blockCentred: { en: 'Centred', ar: 'في المنتصف' },
  blockN: { en: 'Block {n}', ar: 'القطاع {n}' },
  spanOne: { en: 'One block', ar: 'قطاع واحد' },
  spanN: { en: '{n} blocks', ar: '{n} قطاعات' },
  tierAll: { en: 'Whole stand', ar: 'المدرج كامل' },
  tierN: { en: 'Tier {n}', ar: 'الطابق {n}' },
  centreIt: { en: 'Centre it', ar: 'وسّطها' },
  bannerWind: { en: 'Wind', ar: 'الهواء' },
  showBanner: { en: 'Show it', ar: 'أظهرها' },
  alreadyUp: { en: 'This banner is already up — it has no reveal to play. Pick a reveal for it in the Banner view.', ar: 'هذي اللافتة موجودة من قبل — ما لها كشف يتشغّل. اختر لها طريقة كشف في عرض اللافتة.' },
  dragHint: { en: 'Click a banner to pick it out, then drag it to move it along the stand.', ar: 'اضغط على اللافتة عشان تختارها، وبعدين اسحبها عشان تحركها على المدرج.' },
  'snap.centre': { en: 'centre of the stand', ar: 'منتصف المدرج' },
  'snap.quarter': { en: 'quarter', ar: 'الربع' },
  'snap.end': { en: 'end of the stand', ar: 'طرف المدرج' },
  'snap.section': { en: 'section edge', ar: 'حد القطاع' },
  'snap.block': { en: 'a whole block', ar: 'قطاع كامل' },
  'snap.halfway': { en: 'the halfway line', ar: 'خط المنتصف' },
  'snap.goal': { en: 'the goal centre line', ar: 'منتصف المرمى' },
  'snap.rail': { en: 'the front rail', ar: 'السور الأمامي' },
  'snap.back': { en: 'the back row', ar: 'الصف الأخير' },
  'snap.middle': { en: 'half way up', ar: 'نص الارتفاع' },
  'snap.tier': { en: 'the top of a tier', ar: 'أعلى الطابق' },
  snapped: { en: 'Snapped to {what}', ar: 'انحاذت على {what}' },
  'tip.lookAtIt': { en: 'Put the camera where this banner is meant to be read from', ar: 'حط الكاميرا من المكان اللي تنقرأ منه هذي اللافتة' },
  'tip.playIt': { en: 'Run its reveal: the unroll, the haul, the pass over the crowd', ar: 'شغّل كشفها: الانفراد، السحب، المرور فوق الجمهور' },
  'tip.scrub': { en: 'Hold the reveal anywhere in the middle, to line up a shot', ar: 'وقّف الكشف بأي لحظة، عشان تظبط اللقطة' },
  'tip.centreIt': { en: 'Put it dead centre on the stand', ar: 'حطها بالضبط في منتصف المدرج' },
  'tip.snapOn': { en: 'Catch the stand centre, the tier tops and the section edges', ar: 'تمسك منتصف المدرج وأعلى الطوابق وحدود القطاعات' },
};
const L = (k: string): string => {
  const e = MDS_T[k];
  return e ? (getLang() === 'ar' ? e.ar : e.en) : k;
};

interface SimState {
  camIdx: number;
  tier: QualityTier;
  crowd: CrowdPreset;
  density: number;
  showOnTifo: boolean;
  banners: boolean;
  stairs: boolean;
  flags: boolean;
  floods: boolean;
  smoke: boolean;
  fly: boolean;
  reveal: RevealMode;
  /** The drum call: seconds held up, and how many times round. */
  drumHold: number;
  drumTimes: number;
  tod: TimeOfDay;
  weather: Weather;
  wet: boolean;
  sparkles: boolean;
  sound: boolean;
  muted: boolean;
  levels: SoundLevels;
  drum: boolean;
  reactive: boolean;
  weatherSound: boolean;
}

/**
 * What the Sound section remembers.
 *
 * One key holding one object, parsed defensively, because the last shape of
 * this was a bare number under `mds_volume` read back with
 * `Number(localStorage.getItem(...))` — and `Number(null)` is `0`, which passed
 * every guard it was given. The result was that **every visitor who had never
 * touched the slider got master volume 0**, so the crowd, the drum, the roar
 * and the whistle were all wired up correctly and all completely silent. Nothing
 * below reaches `Number()` without a `typeof` check first.
 */
interface SoundPrefs {
  /** Stadium sound on or off. On unless someone has turned it off. */
  on: boolean;
  levels: SoundLevels;
  muted: boolean;
  drum: boolean;
  reactive: boolean;
  weather: boolean;
}

/**
 * v2 (September 2026): new defaults for everybody — sound on, quieter levels,
 * the terrace drum off. A v1 mix is not carried over on purpose: most of them
 * were the old loud defaults, saved the first time someone touched anything.
 */
const SOUND_KEY = 'mds_sound_v2';

function readSoundPrefs(): SoundPrefs {
  const base: SoundPrefs = {
    on: true,
    levels: { ...DEFAULT_LEVELS },
    muted: false,
    // The terrace drum is off until asked for: under a drum call it is a second
    // drum, and on its own it is the loudest thing in the mix.
    drum: false,
    reactive: true,
    weather: true,
  };
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SOUND_KEY);
    if (raw === null) return base;
  } catch {
    return base; // private mode: the defaults are the point
  }
  try {
    const p = JSON.parse(raw) as Partial<SoundPrefs> | null;
    if (!p || typeof p !== 'object') return base;
    const lv = p.levels as Partial<SoundLevels> | undefined;
    return {
      on: bool(p.on, base.on),
      levels: {
        master: num(lv?.master, base.levels.master),
        crowd: num(lv?.crowd, base.levels.crowd),
        sfx: num(lv?.sfx, base.levels.sfx),
        amb: num(lv?.amb, base.levels.amb),
        drum: num(lv?.drum, base.levels.drum),
      },
      muted: bool(p.muted, base.muted),
      drum: bool(p.drum, base.drum),
      reactive: bool(p.reactive, base.reactive),
      weather: bool(p.weather, base.weather),
    };
  } catch {
    return base; // corrupt JSON is the same answer as no JSON
  }
}

export function openMatchDaySimulator(
  map: SeatMap,
  store: DesignStore,
  template: StadiumTemplate,
  assetStore: AssetStore,
  opts: { onClose?: () => void; bannerStore?: BannerStore; focusBanner?: string | null } = {},
): SimulatorHandle {
  const state: SimState = {
    camIdx: 0,
    // Take the probe's word for it. This used to read
    // `startTier === 'low' ? 'medium' : startTier`, which meant the one device
    // the probe was written to protect — a phone reporting <=3GB of memory —
    // was the one device that got overruled, into 1.5x pixel ratio with MSAA
    // and image-based lighting. LOW is a real tier the simulator renders; the
    // picker now offers it, so nobody is stuck below the floor either.
    tier: probeQuality(),
    crowd: 'sellout',
    density: 0.97,
    showOnTifo: false,
    banners: false,
    stairs: false,
    flags: true,
    floods: true,
    smoke: false,
    fly: false,
    reveal: 'wipe-lr',
    drumHold: DRUM_CALL.hold,
    drumTimes: DRUM_CALL.times,
    tod: 'dusk',
    weather: 'clear',
    wet: true,
    // Always off when the simulator opens, every time. This is a deliberate
    // default, not a remembered preference — nothing persists it.
    sparkles: false,
    // On by default (Osamah's call, September 2026): a tifo show is half
    // sound, and a switch nobody finds is a show nobody hears. Remembered if
    // someone turns it off. The browser still wants a gesture before audio
    // can start — see armSoundStart.
    ...(() => {
      const p = readSoundPrefs();
      return { sound: p.on, muted: p.muted, levels: p.levels, drum: p.drum, reactive: p.reactive, weatherSound: p.weather };
    })(),
  };

  const saveSound = (): void => {
    try {
      localStorage.setItem(SOUND_KEY, JSON.stringify({
        on: state.sound,
        levels: state.levels, muted: state.muted, drum: state.drum,
        reactive: state.reactive, weather: state.weatherSound,
      } satisfies SoundPrefs));
    } catch { /* private mode: the session keeps it, the next one does not */ }
  };

  /**
   * Coarse *primary* pointer → this is a finger, whatever the viewport says.
   *
   * `maxTouchPoints > 0` would be wrong here: a touchscreen Windows laptop
   * reports touch and is still driven with a mouse, and it would be told to
   * pinch. `(pointer: coarse)` asks about the pointer someone is actually
   * using, which is the question.
   */
  const TOUCH =
    typeof matchMedia === 'function'
      ? matchMedia('(pointer: coarse)').matches
      : (navigator.maxTouchPoints ?? 0) > 0;
  /** A hover-capable pointer implies a keyboard; a phone in a dock is rare enough. */
  const KEYS = typeof matchMedia !== 'function' || matchMedia('(hover: hover)').matches;

  const overlay = document.createElement('div');
  overlay.className = 'mds-overlay';
  overlay.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
  const style = document.createElement('style');
  style.textContent = CSS;
  overlay.appendChild(style);

  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto;position:relative;min-height:0;';

  // ---------- top bar ----------
  const bar = document.createElement('div');
  bar.className = 'mds-bar';
  const panelToggle = btn('', 'mds-icon');
  panelToggle.innerHTML = ICONS.menu;
  panelToggle.title = L('showHide');
  panelToggle.setAttribute('aria-label', L('showHide'));
  const brand = document.createElement('div');
  brand.className = 'mds-brand';
  brand.innerHTML = '<span class="dot"></span><span class="brand-txt">' + L('brand') + '</span>';
  brand.title = L('shortcuts');
  const spacer = document.createElement('div');
  spacer.className = 'mds-spacer';
  const status = document.createElement('div');
  status.className = 'mds-status';
  const qSel = sel();
  for (const [tier] of TIER_LABELS) opt(qSel, tier, L('tier.' + tier), tier === state.tier);
  const snapBtn = btn(L('snapshot'));
  const recBtn = btn(L('record'));
  const fullBtn = btn(L('fullscreen'));
  const linkBtn = btn(L('copyLink'));
  const helpBtn = btn('', 'mds-icon');
  helpBtn.innerHTML = ICONS.help;
  helpBtn.title = L('helpControls');
  helpBtn.setAttribute('aria-label', L('helpControls'));
  const closeBtn = btn(L('close'));
  // Secondary actions are grouped so they can relocate into the bottom-sheet
  // panel on mobile (keeps the top bar from overflowing on small screens).
  const barActions = document.createElement('div');
  barActions.className = 'mds-baracts';
  barActions.append(barField(L('quality'), qSel), snapBtn, recBtn, fullBtn, linkBtn);
  bar.append(panelToggle, brand, spacer, status, barActions, helpBtn, closeBtn);

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
  const flyBtn = btn(L('flyover'));
  const secCam = section(ICONS.camera, L('camCam'), true);
  secCam.body.append(field(L('view'), camSel), flyBtn);

  // Crowd
  const crowdSel = sel();
  for (const [id] of CROWD_PRESETS) opt(crowdSel, id, L('crowd.' + id), id === state.crowd);
  const density = rng(0, 100, Math.round(state.density * 100));
  const onTifo = chk(state.showOnTifo);
  const secCrowd = section(ICONS.crowd, L('crowd'), false);
  secCrowd.body.append(field(L('stadiumFill'), crowdSel), field(L('density'), density), checkField(L('showCrowd'), onTifo));

  // Atmosphere
  const todSel = sel();
  for (const v of ['day', 'dusk', 'night', 'sunset']) opt(todSel, v, L('tod.' + v), v === state.tod);
  const weatherSel = sel();
  for (const v of ['clear', 'rain', 'snow']) opt(weatherSel, v, L('weather.' + v), false);
  const expRange = rng(0.4, 2, 1.05, 0.05);
  const sunRange = rng(0, 3, 1.25, 0.05);
  const floods = chk(state.floods);
  const smoke = chk(state.smoke);
  const bannersChk = chk(state.banners);
  const stairsChk = chk(state.stairs);
  const flagsChk = chk(state.flags);
  const wetChk = chk(state.wet);
  const sparklesChk = chk(state.sparkles);
  const confettiBtn = btn(L('confetti'));
  const pyroBtn = btn(L('pyro'));
  const soundChk = chk(state.sound);
  const muteChk = chk(state.muted);
  const reactChk = chk(state.reactive);
  const weatherSndChk = chk(state.weatherSound);
  const drumChk = chk(state.drum);
  const lvl: Record<'master' | SoundBus, HTMLInputElement> = {
    master: rng(0, 1, state.levels.master, 0.05),
    crowd: rng(0, 1, state.levels.crowd, 0.05),
    sfx: rng(0, 1, state.levels.sfx, 0.05),
    amb: rng(0, 1, state.levels.amb, 0.05),
    drum: rng(0, 1, state.levels.drum, 0.05),
  };
  const roarBtn = btn(L('tryRoar'));
  const whistleBtn = btn(L('tryWhistle'));
  const applauseBtn = btn(L('tryApplause'));
  const hornBtn = btn(L('tryHorn'));
  const chantBtn = btn(L('tryChant'));
  const secAtmo = section(ICONS.atmosphere, L('atmo'), false);
  secAtmo.body.append(
    field(L('timeOfDay'), todSel),
    field(L('weather'), weatherSel),
    field(L('exposure'), expRange),
    field(L('sunIntensity'), sunRange),
    checkField(L('floodlights'), floods),
    checkField(L('smoke'), smoke),
    checkField(L('railBanners'), bannersChk),
    checkField(L('coverStairs'), stairsChk),
    checkField(L('cornerFlags'), flagsChk),
    checkField(L('wetPitch'), wetChk),
    checkField(L('phoneFlashes'), sparklesChk),
    row(confettiBtn, pyroBtn),
  );

  // Sound gets its own section rather than a line in Atmosphere: it is the one
  // control on this panel that makes a noise in a room, so it should be easy to
  // find and easier to turn off.
  //
  // Five faders, not one. "Louder" is several different requests — the crowd up
  // and the drum down for a clip, the whole thing at 10% at 2am, the roar
  // landing on a projector — and a single master could answer none of them.
  const secSound = section(ICONS.sound, L('sound'), false);
  secSound.body.append(
    checkField(L('soundOn'), soundChk),
    checkField(L('mute'), muteChk),
    levelField(L('volMaster'), lvl.master),
    divider(),
    levelField(L('volCrowd'), lvl.crowd),
    levelField(L('volSfx'), lvl.sfx),
    levelField(L('volAmb'), lvl.amb),
    checkField(L('drum'), drumChk),
    levelField(L('volDrum'), lvl.drum),
    divider(),
    checkField(L('reactive'), reactChk),
    checkField(L('weatherSound'), weatherSndChk),
    row(roarBtn, applauseBtn, chantBtn),
    row(hornBtn, whistleBtn),
  );

  // Tifo Assets
  const standSel = sel();
  for (const v of ['1', '3', '0', '2']) opt(standSel, v, L('stand.' + v), false);
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = 'ULTRAS';
  textInput.className = 'mds-input';
  const addBannerBtn = btn(L('bigBanner'));
  const addSmallBtn = btn(L('smallBanner'));
  const addTextBtn = btn(L('text'));
  const addFloorBtn = btn(L('floor'));
  const addSurfaceBtn = btn(L('surface'));
  const addFlagBtn = btn(L('megaFlag'));
  const addScarfBtn = btn(L('scarves'));
  const projInput = fileInput();
  const assetSel = sel();
  const imgInput = fileInput();
  const wRange = rng(4, 60, 18);
  const hRange = rng(1, 30, 4);
  const yRange = rng(0, 60, 14);
  const xRange = rng(-140, 140, 0);
  const zRange = rng(-140, 140, 0);
  const rotRange = rng(0, 360, 0);
  const unfurlBtn = btn(L('unfurl'));
  const printBtn = btn(L('printPanels'));
  const delBtn = btn(L('deleteSelected'));
  const clearAllBtn = btn(L('clearAll'));
  const secAssets = section(ICONS.assets, L('assets'), false);
  secAssets.body.append(
    field(L('addToStand'), standSel),
    field(L('bannerText'), textInput),
    row(addBannerBtn, addSmallBtn),
    row(addTextBtn, addFloorBtn),
    row(addSurfaceBtn, addFlagBtn, addScarfBtn),
    divider(),
    field(L('projectField'), projInput),
    divider(),
    field(L('selectedAsset'), assetSel),
    field(L('replaceImage'), imgInput),
    field(L('width'), wRange),
    field(L('height'), hRange),
    field(L('heightOff'), yRange),
    field(L('posX'), xRange),
    field(L('posZ'), zRange),
    field(L('rotate'), rotRange),
    row(unfurlBtn, printBtn, delBtn, clearAllBtn),
  );

  // Banners. Separate from Tifo Assets on purpose: an asset is a decoration
  // you add here, a banner is a thing you DREW, in its own view, with its own
  // rig and its own reveal. Mixing them into one list would make the two feel
  // like the same object, and they behave nothing alike.
  const bnSel = sel();
  const bnLook = btn(L('lookAtIt'));
  const bnPlay = btn(L('playIt'), 'primary');
  const bnScrub = rng(0, 100, 100);
  const bnStand = sel();
  // North, East, South, West — clockwise, and the same order as the Banner
  // view's own picker, so the two lists never disagree about where East is.
  for (const v of ['1', '0', '3', '2']) opt(bnStand, v, L('stand.' + v), v === '1');
  // Blocks and a tier, not sliders. The stand is divided into blocks by its
  // own aisles, a banner covers a run of them, and there is nothing in
  // between to land on — which is why a banner can no longer end up
  // straddling an aisle with a corner hanging into the sky.
  const bnAcross = sel();
  const bnBlock = sel();
  const bnSpan = sel();
  const bnTier = sel();
  const bnCentre = btn(L('centreIt'));
  const bnWind = rng(0, 100, 25);
  const bnShow = chk(true);
  const bnHint = document.createElement('div');
  bnHint.className = 'mds-hint';
  bnHint.textContent = L('dragHint');
  const secBanners = section(ICONS.assets, L('bannersTitle'), false);
  secBanners.body.append(
    field(L('theBanner'), bnSel),
    row(bnLook, bnPlay),
    field(L('scrub'), bnScrub),
    divider(),
    field(L('onStand'), bnStand),
    field(L('acrossStands'), bnAcross),
    field(L('firstBlock'), bnBlock),
    field(L('howManyBlocks'), bnSpan),
    field(L('whichTier'), bnTier),
    row(bnCentre),
    field(L('bannerWind'), bnWind),
    checkField(L('showBanner'), bnShow),
    bnHint,
  );

  // Choreography
  const autoBtn = btn(L('autoChoreo'), 'primary');
  const stopBtn = btn(L('stop'));
  const revealSel = sel();
  for (const m of REVEAL_MODES) opt(revealSel, m.id, L(m.labelKey), false);
  const revealBtn = btn(L('playReveal'));
  // The drum call's own controls, shown only while it is the chosen style.
  const drumHold = rng(2, 10, state.drumHold, 0.5);
  const secs = (n: number): string => L('secs').replace('{n}', String(n));
  const drumHoldField = field(L('drumHold') + ' · ' + secs(state.drumHold), drumHold);
  const drumTimes = sel();
  for (const n of [1, 2, 3]) opt(drumTimes, String(n), L('drumTimes.' + n), n === state.drumTimes);
  const drumHint = document.createElement('div');
  drumHint.className = 'mds-hint';
  drumHint.textContent = L('drumHint');
  const drumBox = document.createElement('div');
  drumBox.className = 'mds-drumcall';
  drumBox.style.cssText = 'flex-direction:column;gap:10px;';
  drumBox.append(drumHint, drumHoldField, field(L('drumTimes'), drumTimes));
  // style.display, not `hidden`: an inline display beats the [hidden] rule.
  const showDrumBox = (): void => {
    drumBox.style.display = state.reveal === 'drum-call' ? 'flex' : 'none';
  };
  showDrumBox();
  const cueTime = document.createElement('input');
  cueTime.type = 'number';
  cueTime.min = '0';
  cueTime.max = '40';
  cueTime.step = '0.5';
  cueTime.value = '0';
  cueTime.className = 'mds-input';
  const cueKind = sel();
  for (const v of ['reveal', 'camera', 'confetti', 'pyro', 'smoke-on', 'floods-on']) opt(cueKind, v, L('cue.' + v), false);
  const addCueBtn = btn(L('addCue'));
  const playSeqBtn = btn(L('playSeq'), 'primary');
  const clearSeqBtn = btn(L('clearSeq'));
  const cueCount = document.createElement('div');
  cueCount.className = 'mds-hint';
  cueCount.textContent = L('cueCount').replace('{n}', '0');
  // Stable handles for tests, which cannot go by the translated labels.
  for (const [el, k] of [[autoBtn, 'auto'], [stopBtn, 'stop'], [revealSel, 'reveal'], [revealBtn, 'play-reveal'],
    [drumHold, 'drum-hold'], [drumTimes, 'drum-times'], [cueKind, 'cue-kind'], [addCueBtn, 'add-cue'], [playSeqBtn, 'play-seq']] as [HTMLElement, string][]) el.dataset.k = k;
  const secChoreo = section(ICONS.choreo, L('choreo'), false);
  secChoreo.body.append(
    row(autoBtn, stopBtn),
    divider(),
    field(L('revealStyle'), revealSel),
    drumBox,
    revealBtn,
    divider(),
    document.createTextNode(''),
    field(L('cueTime'), cueTime),
    field(L('cueType'), cueKind),
    row(addCueBtn, playSeqBtn, clearSeqBtn),
    cueCount,
  );

  // Recording — configurable reveal capture (duration / fps / resolution) with a
  // Preview that plays exactly what will be recorded.
  const recDur = sel();
  recDur.dataset.k = 'rec-length';
  // 20 and 30 are for the drum call: twice round is about twenty seconds.
  for (const [v, l] of [['6', '6s'], ['9', '9s'], ['12', '12s'], ['15', '15s'], ['20', '20s'], ['30', '30s']]) opt(recDur, v, l, v === '9');
  const recFps = sel();
  for (const f of ['24', '30', '60']) opt(recFps, f, f + ' fps', f === '30');
  const recRes = sel();
  for (const [v, l] of [['720', '720p'], ['1080', '1080p'], ['source', L('resSource')]]) opt(recRes, v, l, v === '720');
  const previewBtn = btn(L('recPreview'));
  const recordBtn2 = btn(L('recordVideo'), 'primary');
  const secRecord = section(ICONS.record, L('recTitle'), false);
  secRecord.body.append(
    field(L('recLength'), recDur),
    field(L('frameRate'), recFps),
    field(L('resolution'), recRes),
    row(previewBtn, recordBtn2),
  );

  const actionsHost = document.createElement('div'); // holds barActions on mobile
  actionsHost.className = 'mds-panel-acts';
  // A stable name per section, so a test (or a deep link, later) can find one
  // without matching its heading — which is translated, and which is exactly
  // the kind of coupling that makes an Arabic run fail for no real reason.
  for (const [key, sec] of [
    ['camera', secCam], ['crowd', secCrowd], ['atmosphere', secAtmo], ['sound', secSound],
    ['assets', secAssets], ['banners', secBanners], ['choreo', secChoreo], ['record', secRecord],
  ] as [string, { root: HTMLElement }][]) sec.root.dataset.sec = key;
  panel.append(actionsHost, secCam.root, secCrowd.root, secAtmo.root, secSound.root, secAssets.root, secBanners.root, secChoreo.root, secRecord.root);
  overlay.append(bar, panel, host);
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // ---------- onboarding / help ----------
  const help = document.createElement('div');
  help.className = 'mds-help';
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-modal', 'true');
  help.setAttribute('aria-label', 'Match Day Simulator help');
  const helpCard = document.createElement('div');
  helpCard.className = 'mds-help-card';
  const kv = (k: string, v: string): string => '<div class="mds-kv"><span class="k">' + k + '</span><span>' + v + '</span></div>';
  const key = (s: string): string => '<span class="mds-key">' + s + '</span>';
  // The first card a phone user ever sees said "Right-drag to pan" and then
  // listed six keyboard shortcuts. Read the input, not the width: a laptop with
  // a touchscreen still has the keys.
  helpCard.innerHTML =
    '<h2>' + L('brand') + '</h2>' +
    '<p class="sub">' + L('helpSub') + '</p>' +
    '<div class="mds-help-grp"><h3>' + L('hMove') + '</h3>' +
    kv(L('hLook'), TOUCH ? L('hOneFinger') : L('hDrag')) +
    kv(L('hZoom'), TOUCH ? L('hPinch') : L('hScroll')) +
    kv(L('hPan'), TOUCH ? L('hTwoFinger') : L('hRightDrag')) + '</div>' +
    (KEYS
      ? '<div class="mds-help-grp"><h3>' + L('hShortcuts') + '</h3>' +
        kv(L('hCamViews'), key('1') + ' to ' + key('9')) +
        kv(L('hPlayReveal'), key('Space')) +
        kv(L('hFull'), key('F')) +
        kv(L('hHide'), key('H')) +
        kv(L('hHelp'), key('?')) +
        kv(L('hClose'), key('Esc')) +
        '</div>'
      : '') +
    '<div class="mds-help-grp"><h3>' + L('hYours') + '</h3>' +
    kv(L('hYourBanners'), L('bannersTitle')) +
    kv(L('hBanners'), L('assets')) +
    kv(L('hTimeWeather'), L('atmo')) +
    kv(L('hAutoChoreo'), L('choreo')) +
    '</div>';
  const gotBtn = btn(L('gotIt'), 'primary');
  const helpActions = document.createElement('div');
  helpActions.className = 'mds-help-actions';
  helpActions.append(gotBtn);
  helpCard.append(helpActions);
  help.append(helpCard);
  const flash = document.createElement('div'); // snapshot capture flash
  flash.className = 'mds-flash';
  overlay.append(help, flash);
  // The drum call's count, on the picture — so it reads with the sound off.
  const beats = document.createElement('div');
  beats.className = 'mds-beats';
  beats.setAttribute('role', 'img');
  beats.setAttribute('aria-label', L('drumBeats'));
  const beatDots = [0, 1, 2].map(() => document.createElement('i'));
  beats.append(...beatDots);
  host.appendChild(beats);
  const renderBeat = (b: { count: number; phase: 'up' | 'down' | null; pulse: number }): void => {
    beats.classList.toggle('show', b.count > 0);
    beats.dataset.phase = b.phase ?? '';
    beatDots.forEach((d, i) => {
      d.classList.toggle('on', i < b.count);
      d.classList.toggle('hit', i === b.count - 1 && b.pulse > 0.55);
    });
  };

  const showHelp = (): void => help.classList.add('show');
  const hideHelp = (): void => help.classList.remove('show');
  const helpOpen = (): boolean => help.classList.contains('show');
  helpBtn.addEventListener('click', () => (helpOpen() ? hideHelp() : showHelp()));
  gotBtn.addEventListener('click', hideHelp);
  help.addEventListener('click', (e) => {
    if (e.target === help) hideHelp();
  });
  // Greet first-time visitors once.
  try {
    if (!localStorage.getItem('mds_seen_intro')) {
      showHelp();
      localStorage.setItem('mds_seen_intro', '1');
    }
  } catch {
    /* storage blocked — skip the intro */
  }

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
  for (const [elT, k] of [
    [panelToggle, 'tip.panel'],
    [snapBtn, 'tip.snap'],
    [fullBtn, 'tip.full'],
    [linkBtn, 'tip.link'],
    [flyBtn, 'tip.fly'],
    [density, 'tip.density'],
    [todSel, 'tip.tod'],
    [weatherSel, 'tip.weather'],
    [expRange, 'tip.exp'],
    [sunRange, 'tip.sun'],
    [floods, 'tip.floods'],
    [smoke, 'tip.smoke'],
    [bannersChk, 'tip.banners'],
    [stairsChk, 'tip.stairs'],
    [wetChk, 'tip.wet'],
    [sparklesChk, 'tip.sparkles'],
    [soundChk, 'tip.soundOn'],
    [muteChk, 'tip.mute'],
    [lvl.master, 'tip.volMaster'],
    [lvl.crowd, 'tip.volCrowd'],
    [lvl.sfx, 'tip.volSfx'],
    [lvl.amb, 'tip.volAmb'],
    [lvl.drum, 'tip.volDrum'],
    [reactChk, 'tip.reactive'],
    [weatherSndChk, 'tip.weatherSound'],
    [applauseBtn, 'tip.tryApplause'],
    [hornBtn, 'tip.tryHorn'],
    [chantBtn, 'tip.tryChant'],
    [drumChk, 'tip.drum'],
    [confettiBtn, 'tip.confetti'],
    [pyroBtn, 'tip.pyro'],
    [addBannerBtn, 'tip.bigBanner'],
    [addSmallBtn, 'tip.smallBanner'],
    [addTextBtn, 'tip.text'],
    [addFloorBtn, 'tip.floor'],
    [addSurfaceBtn, 'tip.surface'],
    [addFlagBtn, 'tip.flag'],
    [addScarfBtn, 'tip.scarf'],
    [projInput, 'tip.proj'],
    [imgInput, 'tip.img'],
    [unfurlBtn, 'tip.unfurl'],
    [printBtn, 'tip.print'],
    [delBtn, 'tip.del'],
    [clearAllBtn, 'tip.clearAll'],
    [autoBtn, 'tip.auto'],
    [stopBtn, 'tip.stop'],
    [revealBtn, 'tip.reveal'],
    [addCueBtn, 'tip.addCue'],
    [playSeqBtn, 'tip.playSeq'],
    [clearSeqBtn, 'tip.clearSeq'],
  ] as [HTMLElement, string][]) {
    elT.title = L(k);
  }

  // ---------- simulator instance + state ----------
  let sim: MatchDaySimulator;

  function refreshAssets(): void {
    const assets = sim.listAssets();
    assetSel.replaceChildren();
    opt(assetSel, '', assets.length ? L('selectDash') : L('noAssets'), false);
    assets.forEach((a, i) => opt(assetSel, a.id, a.type + ' ' + (i + 1), false));
    assetSel.value = sim.selectedAssetId ?? '';
  }

  const bannerStore = opts.bannerStore ?? null;
  let bnSyncing = false;
  /** Read the banner store back into the Banners section. */
  function refreshBanners(): void {
    const list = bannerStore ? bannerStore.list() : [];
    bnSel.replaceChildren();
    if (!list.length) opt(bnSel, '', L('noBanners'), false);
    for (const b of list) opt(bnSel, b.id, b.name, false);
    const a = bannerStore?.active ?? null;
    bnSel.value = a?.id ?? '';
    const off = !a;
    for (const el of [bnLook, bnPlay, bnCentre] as HTMLButtonElement[]) el.disabled = off;
    for (const el of [bnScrub, bnWind, bnShow] as HTMLInputElement[]) el.disabled = off;
    for (const el of [bnStand, bnAcross, bnBlock, bnSpan, bnTier] as HTMLSelectElement[]) el.disabled = off;
    if (!a) return;
    // Every one of these assignments fires `input`/`change` in some browsers,
    // which would write the value straight back into the store mid-drag. The
    // flag is what keeps a refresh from becoming an edit.
    bnSyncing = true;
    bnStand.value = String(a.slot.stand);
    bnAcross.replaceChildren();
    opt(bnAcross, '1', L('acrossOne'), false);
    // Which two: the run goes on from this stand into the next one round.
    opt(bnAcross, '2', L('acrossPair').replace('{a}', L('stand.' + a.slot.stand)).replace('{b}', L('stand.' + ((a.slot.stand + 1) % 4))), false);
    bnAcross.value = String(a.slot.stands);
    const shape = sim.standSlots(a.slot.stand, a.id, a.slot.stands);
    const nb = Math.max(1, shape.blocks);
    // Only the runs that actually make it bigger — see `maxUsefulSpan`.
    const nSpan = Math.max(1, Math.min(nb, shape.maxSpan));
    bnBlock.replaceChildren();
    opt(bnBlock, '-1', L('blockCentred'), false);
    for (let i = 0; i < nb; i++) opt(bnBlock, String(i), L('blockN').replace('{n}', String(i + 1)), false);
    bnBlock.value = a.slot.blockFrom < 0 ? '-1' : String(Math.min(nb - 1, a.slot.blockFrom));
    bnSpan.replaceChildren();
    for (let i = 1; i <= nSpan; i++) {
      opt(bnSpan, String(i), i === 1 ? L('spanOne') : L('spanN').replace('{n}', String(i)), false);
    }
    bnSpan.value = String(Math.max(1, Math.min(nSpan, a.slot.blockSpan)));
    bnTier.replaceChildren();
    opt(bnTier, '-1', L('tierAll'), false);
    for (const i of shape.tierOptions) opt(bnTier, String(i), L('tierN').replace('{n}', String(i + 1)), false);
    bnTier.value = shape.tierOptions.includes(a.slot.tier) ? String(a.slot.tier) : '-1';
    bnWind.value = String(Math.round(a.wind * 100));
    bnShow.checked = a.visible !== false;
    bnSyncing = false;
  }
  const unsubBanners = bannerStore ? bannerStore.onChange(refreshBanners) : null;
  /**
   * Push every sound setting at the rig.
   *
   * A function declaration rather than a const, because `applyState` below
   * calls it and `applyState` runs from `mount()` — long before the wiring
   * section further down has been reached.
   */
  function applySound(): void {
    for (const k of ['master', 'crowd', 'sfx', 'amb', 'drum'] as ('master' | SoundBus)[]) {
      sim.setSoundLevel(k, state.levels[k]);
    }
    sim.setSoundMuted(state.muted);
    sim.setCrowdReactive(state.reactive);
    sim.setWeatherSound(state.weatherSound);
    sim.setDrum(state.sound && state.drum);
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
    sim.setStairsVisible(state.stairs);
    sim.setFlagsVisible(state.flags);
    sim.setFloodlights(state.floods);
    sim.setSmoke(state.smoke);
    sim.setFlyover(state.fly);
    sim.setTimeOfDay(state.tod);
    sim.setWeather(state.weather);
    sim.setWetPitch(state.wet);
    sim.setSparkles(state.sparkles);
    sim.setAutoReveal(state.reveal);
    sim.setDrumCall({ hold: state.drumHold, times: state.drumTimes });
    sim.onDrumBeat = renderBeat;
    if (!state.fly) sim.applyShot(shots[state.camIdx] ?? shots[0]);
    // Changing the quality tier disposes the simulator and builds a new one,
    // and the new one's atmosphere starts silent and at its defaults. Without
    // this, dropping from High to Medium halfway through turned the sound off
    // and left the checkbox saying it was on.
    applySound();
    if (state.sound && !sim.soundOn()) {
      void sim.setSound(true).then(() => {
        if (sim.soundOn()) applySound();
        else armSoundStart();
      });
    }
  }
  /**
   * Sound is on by default, but a browser will not start audio until the
   * person has done something on the page. Opened from the editor they have
   * (the click that opened it counts); opened straight from a shared link they
   * have not. So the first press, tap or key anywhere starts it — the checkbox
   * already says on, and now it is.
   */
  function armSoundStart(): void {
    if (soundArmed) return;
    soundArmed = true;
    const go = (): void => {
      disarmSoundStart();
      if (!state.sound || !mountedNow() || sim.soundOn()) return;
      void sim.setSound(true).then(() => { if (sim.soundOn()) applySound(); });
    };
    soundStartFn = go;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, go, { capture: true, passive: true });
  }
  function disarmSoundStart(): void {
    if (!soundArmed || !soundStartFn) return;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, soundStartFn, { capture: true });
    soundArmed = false;
    soundStartFn = null;
  }
  /**
   * True once a simulator instance exists and is safe to talk to.
   *
   * Everything below assumes `sim`. A phone with WebGL switched off (or a
   * browser that hands back a null context under memory pressure) makes the
   * constructor throw, and `main.ts` catches that and does nothing at all — so
   * the report is "I tapped Match Day and nothing happened", which is
   * unfixable from the outside. The overlay now stays up and says what
   * happened.
   */
  let mounted = false;
  let soundArmed = false;
  let soundStartFn: (() => void) | null = null;
  const mountedNow = (): boolean => mounted;
  /**
   * An instance exists and has not been disposed.
   *
   * Separate from `mounted` on purpose. A lost context clears `mounted` — the
   * object is no longer safe to drive — but the instance, and its canvas, are
   * still there. Folding the two together meant Rebuild skipped `dispose()`
   * and left the dead canvas in the DOM: two canvases, and the GPU memory of
   * the one that just died still held, on the device that had just run out of
   * it.
   */
  let built = false;
  function disposeSim(): void {
    if (!built) return;
    built = false;
    mounted = false;
    try {
      sim.dispose();
    } catch {
      /* a lost context makes most GL teardown a no-op; never block on it */
    }
  }
  function mount(): boolean {
    try {
      sim = new MatchDaySimulator(host, map, store, template, assetStore, {
        quality: state.tier,
        onContextLost: () => showFail('lost'),
        bannerStore: opts.bannerStore,
      });
    } catch {
      built = false;
      mounted = false;
      showFail('nogl');
      return false;
    }
    built = true;
    mounted = true;
    hideFail();
    // Dragging a banner in the bowl and the panel's own sliders are two views
    // of one number, so the drag reports back rather than letting them drift.
    sim.onBannerSelect = () => refreshBanners();
    sim.onBannerSnap = (keys) => {
      bnHint.textContent = keys.length
        ? L('snapped').replace('{what}', keys.map((k) => L('snap.' + k)).join(' + '))
        : L('dragHint');
    };
    applyState();
    refreshAssets();
    refreshBanners();
    sim.start();
    return true;
  }

  // ---------- the "it did not start" card ----------
  const fail = document.createElement('div');
  fail.className = 'mds-fail';
  fail.setAttribute('role', 'alertdialog');
  fail.setAttribute('aria-modal', 'true');
  const failCard = document.createElement('div');
  failCard.className = 'mds-fail-card';
  const failTitle = document.createElement('h2');
  const failBody = document.createElement('p');
  const failActs = document.createElement('div');
  failActs.className = 'mds-fail-acts';
  const failRetry = btn(L('rebuild'), 'primary');
  const failClose = btn(L('close'));
  failActs.append(failRetry, failClose);
  failCard.append(failTitle, failBody, failActs);
  fail.append(failCard);
  overlay.append(fail);

  const hideFail = (): void => fail.classList.remove('show');
  function showFail(kind: 'nogl' | 'lost'): void {
    mounted = false;
    failTitle.textContent = L(kind === 'nogl' ? 'noWebgl' : 'lost');
    failBody.textContent = L(kind === 'nogl' ? 'noWebglBody' : 'lostBody');
    // No WebGL is not something a second attempt fixes; a reclaimed context is.
    failRetry.hidden = kind === 'nogl';
    fail.classList.add('show');
    fail.setAttribute('aria-label', failTitle.textContent);
  }
  failRetry.addEventListener('click', () => {
    disposeSim();
    mount();
  });
  failClose.addEventListener('click', () => close());

  mount();
  // Opened from the Banner view to look at a banner: open ON it, with its
  // section showing, rather than on the default gantry shot with the banner
  // somewhere behind the camera and three clicks between you and it.
  const openOnBanner = (id: string): void => {
    if (!mounted || !bannerStore?.get(id)) return;
    bannerStore.setActive(id);
    secBanners.root.parentElement?.querySelectorAll('.mds-section').forEach((s) => {
      s.classList.remove('open');
      s.querySelector('.mds-shead')?.setAttribute('aria-expanded', 'false');
    });
    secBanners.root.classList.add('open');
    secBanners.root.querySelector('.mds-shead')?.setAttribute('aria-expanded', 'true');
    // Not picked out in the bowl. The camera opens filled with this banner,
    // and a banner that is picked out takes hold of any drag that lands on
    // it — so from here every attempt to look around slid the banner along
    // the stand instead. The panel is on it; a click on the fabric picks it
    // out when you want to move it.
    sim.selectBanner(null);
    state.fly = false;
    flyBtn.classList.remove('active');
    sim.focusBanner(id);
  };
  if (opts.focusBanner) openOnBanner(opts.focusBanner);
  // Bound the panel height in pixels (inline style beats any CSS) so overflow
  // actually scrolls instead of the panel growing to fit its content.
  const fitPanel = (): void => {
    // On mobile the panel is a bottom sheet sized by CSS (max-height); on desktop
    // we bound it in px so its overflow actually scrolls.
    if (window.innerWidth <= MOBILE_MAX) panel.style.height = '';
    else panel.style.height = Math.max(200, window.innerHeight - 76) + 'px';
  };
  fitPanel();
  window.addEventListener('resize', fitPanel);

  // Responsive: move the secondary actions into the panel on phones, back to the
  // top bar on desktop, so the bar never overflows.
  const mqMobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
  const placeActions = (): void => {
    if (mqMobile.matches) {
      if (barActions.parentElement !== actionsHost) actionsHost.appendChild(barActions);
    } else if (barActions.parentElement !== bar) {
      bar.insertBefore(barActions, helpBtn);
    }
    fitPanel();
  };
  placeActions();
  mqMobile.addEventListener('change', placeActions);
  if (mqMobile.matches) panel.classList.add('collapsed'); // start clear on phones
  dbg('panel @mount client=' + panel.clientHeight + ' scroll=' + panel.scrollHeight + ' (open Tifo Assets, then scroll)');

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
    disposeSim();
    mount();
    toast(L('toast.quality') + L('tier.' + state.tier));
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
  stairsChk.addEventListener('change', () => {
    state.stairs = stairsChk.checked;
    dbg('cover stairs ->', state.stairs);
    sim.setStairsVisible(state.stairs);
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
  // Sound. The checkbox IS the user gesture the browser demands, so the
  // AudioContext is created inside this handler and nowhere earlier — one
  // created at construction sits suspended and silently does nothing, which
  // reads as a broken feature rather than as a refused one.
  soundChk.addEventListener('change', () => {
    void (async () => {
      state.sound = soundChk.checked;
      disarmSoundStart();
      await sim.setSound(state.sound);
      if (state.sound && !sim.soundOn()) {
        soundChk.checked = false;
        state.sound = false;
        toast(L('soundBlocked'));
        return;
      }
      applySound();
      // Remembered now that it is on by default: someone who turns it off
      // should not have it come back on every time they open Match Day.
      saveSound();
    })();
  });
  muteChk.addEventListener('change', () => {
    state.muted = muteChk.checked;
    sim.setSoundMuted(state.muted);
    saveSound();
  });
  for (const k of ['master', 'crowd', 'sfx', 'amb', 'drum'] as ('master' | SoundBus)[]) {
    lvl[k].addEventListener('input', () => {
      state.levels[k] = Number(lvl[k].value);
      sim.setSoundLevel(k, state.levels[k]);
      // Remembered, like the on/off: how loud someone wants it is theirs.
      saveSound();
    });
  }
  drumChk.addEventListener('change', () => {
    state.drum = drumChk.checked;
    sim.setDrum(state.sound && state.drum);
    saveSound();
  });
  reactChk.addEventListener('change', () => {
    state.reactive = reactChk.checked;
    sim.setCrowdReactive(state.reactive);
    saveSound();
  });
  weatherSndChk.addEventListener('change', () => {
    state.weatherSound = weatherSndChk.checked;
    sim.setWeatherSound(state.weatherSound);
    saveSound();
  });
  roarBtn.addEventListener('click', () => sim.roar(1));
  whistleBtn.addEventListener('click', () => sim.whistle());
  applauseBtn.addEventListener('click', () => sim.applause(1));
  hornBtn.addEventListener('click', () => sim.airhorn());
  chantBtn.addEventListener('click', () => sim.chant());

  sparklesChk.addEventListener('change', () => {
    state.sparkles = sparklesChk.checked;
    sim.setSparkles(state.sparkles);
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
    if (!sim.printSelectedPanels()) toast(L('toast.printFirst'));
  });
  projInput.addEventListener('change', () => {
    const f = projInput.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result !== 'string') return;
      const img = new Image();
      img.onload = () => {
        if (!window.confirm('This PAINTS your tifo onto the seats as seen from this camera, it edits your actual design (undo with Ctrl+Z in the editor). Continue?')) {
          projInput.value = '';
          return;
        }
        const n = sim.projectImageToMosaic(img);
        toast(n.toLocaleString() + L('toast.painted'));
        projInput.value = '';
      };
      img.src = r.result;
    };
    r.readAsDataURL(f);
  });
  const syncAssetControls = (): void => {
    const a = assetStore.selected;
    if (!a) return;
    wRange.value = String(Math.round(Math.abs(a.scale.x)));
    hRange.value = String(Math.round(Math.abs(a.scale.y)));
    yRange.value = String(Math.round(a.position.y));
    xRange.value = String(Math.round(a.position.x));
    zRange.value = String(Math.round(a.position.z));
    rotRange.value = String(Math.round((a.rotationY * 180) / Math.PI));
  };
  assetSel.addEventListener('change', () => { sim.selectAsset(assetSel.value || null); syncAssetControls(); });
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
  xRange.addEventListener('input', () => sim.setSelectedX(Number(xRange.value)));
  zRange.addEventListener('input', () => sim.setSelectedZ(Number(zRange.value)));
  rotRange.addEventListener('input', () => sim.setSelectedRot(Number(rotRange.value)));
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

  // ---------- banners ----------
  const bnEdit = (fn: () => void): void => {
    if (bnSyncing || !bannerStore) return;
    bannerStore.begin();
    fn();
    bannerStore.commit();
  };
  bnSel.addEventListener('change', () => {
    bannerStore?.setActive(bnSel.value || null);
    sim.selectBanner(bnSel.value || null);
    refreshBanners();
  });
  bnLook.addEventListener('click', () => {
    const id = bannerStore?.activeId_;
    if (!id) return;
    // Looking at a banner ends the flyover, and the button should say so.
    state.fly = false;
    flyBtn.classList.remove('active');
    if (!sim.focusBanner(id)) toast(L('noBanners'));
  });
  /**
   * The scrub bar follows the reveal while it plays.
   *
   * It jumped to the end the moment Play was pressed and sat there while a
   * hanging banner took a minute to come up its ropes, so the one control
   * that says where a reveal has got to said it was over before it began.
   */
  let scrubRaf = 0;
  const followReveal = (id: string): void => {
    cancelAnimationFrame(scrubRaf);
    const tick = (): void => {
      const st = sim.bannerRevealState(id);
      if (!st) return;
      bnScrub.value = String(Math.round(st.progress * 100));
      if (st.playing) scrubRaf = requestAnimationFrame(tick);
    };
    scrubRaf = requestAnimationFrame(tick);
  };
  bnPlay.addEventListener('click', () => {
    const id = bannerStore?.activeId_;
    if (!id) return;
    // A banner that is already up has nothing to play, and saying so beats a
    // button that silently does nothing.
    if (bannerStore?.get(id)?.reveal === 'cut') {
      toast(L('alreadyUp'));
      return;
    }
    sim.playBannerReveal(id);
    followReveal(id);
  });
  bnScrub.addEventListener('input', () => {
    const id = bannerStore?.activeId_;
    cancelAnimationFrame(scrubRaf);
    if (id) sim.setBannerProgress(id, Number(bnScrub.value) / 100);
  });
  // East is stand ZERO. `Number(v) || 1` turned it into North, so choosing
  // East here moved the banner to the North stand instead.
  bnStand.addEventListener('change', () => {
    const v = Number(bnStand.value);
    if (!(v >= 0 && v <= 3)) return;
    bnEdit(() => bannerStore?.patchSlot({ stand: v as 0 | 1 | 2 | 3 }));
  });
  bnAcross.addEventListener('change', () => bnEdit(() => bannerStore?.patchSlot({
    stands: Math.max(1, Number(bnAcross.value) || 1),
    // The block numbering changes with the window, so a run pinned to a block
    // index would jump somewhere arbitrary. Centred is the honest reset.
    blockFrom: -1,
  })));
  bnBlock.addEventListener('change', () => bnEdit(() => bannerStore?.patchSlot({ blockFrom: Number(bnBlock.value) })));
  bnSpan.addEventListener('change', () => bnEdit(() => bannerStore?.patchSlot({ blockSpan: Math.max(1, Number(bnSpan.value)) })));
  bnTier.addEventListener('change', () => bnEdit(() => bannerStore?.patchSlot({ tier: Number(bnTier.value) })));
  // One undo step per drag of the wind slider, not one per pixel of it.
  let windOpen = false;
  let windTimer = 0;
  const windClose = (): void => {
    window.clearTimeout(windTimer);
    if (!windOpen) return;
    windOpen = false;
    bannerStore?.commit();
  };
  bnWind.addEventListener('input', () => {
    if (bnSyncing || !bannerStore) return;
    if (!windOpen) {
      windOpen = true;
      bannerStore.begin();
    }
    bannerStore.patch({ wind: Number(bnWind.value) / 100 });
    window.clearTimeout(windTimer);
    windTimer = window.setTimeout(windClose, 500);
  });
  bnWind.addEventListener('change', windClose);
  bnShow.addEventListener('change', () => bnEdit(() => bannerStore?.patch({ visible: bnShow.checked })));
  bnCentre.addEventListener('click', () => {
    bnEdit(() => bannerStore?.patchSlot({ blockFrom: -1 }));
    toast(L('snapped').replace('{what}', L('snap.centre')));
  });

  /** The drum is half of the drum call; say so once if the sound is off. */
  let drumHintShown = false;
  const nudgeDrumSound = (): void => {
    if (state.reveal !== 'drum-call' || state.sound || drumHintShown) return;
    drumHintShown = true;
    toast(L('drumSoundHint'));
  };
  /** A clip of a drum call has to be long enough to reach the drop. */
  const fitRecordLength = (): void => {
    if (state.reveal !== 'drum-call') return;
    const need = sim.autoChoreoSeconds();
    if (Number(recDur.value) >= need) return;
    const fit = Array.from(recDur.options).map((o) => Number(o.value)).find((v) => v >= need);
    recDur.value = String(fit ?? recDur.options[recDur.options.length - 1].value);
  };
  revealBtn.addEventListener('click', () => {
    nudgeDrumSound();
    sim.playReveal(state.reveal);
  });
  revealSel.addEventListener('change', () => {
    state.reveal = revealSel.value as RevealMode;
    sim.setAutoReveal(state.reveal);
    showDrumBox();
    fitRecordLength();
  });
  const drumHoldLabel = drumHoldField.querySelector<HTMLElement>('.mds-flabel');
  drumHold.addEventListener('input', () => {
    state.drumHold = Number(drumHold.value);
    if (drumHoldLabel) drumHoldLabel.textContent = L('drumHold') + ' · ' + secs(state.drumHold);
    sim.setDrumCall({ hold: state.drumHold });
    fitRecordLength();
  });
  drumTimes.addEventListener('change', () => {
    state.drumTimes = Number(drumTimes.value);
    sim.setDrumCall({ times: state.drumTimes });
    fitRecordLength();
  });
  const cues: Cue[] = [];
  const updateCueCount = (): void => {
    cueCount.textContent = cues.length === 1 ? L('cueCountOne') : L('cueCount').replace('{n}', String(cues.length));
  };
  autoBtn.addEventListener('click', () => {
    nudgeDrumSound();
    sim.playAutoChoreo();
  });
  stopBtn.addEventListener('click', () => sim.stopTimeline());
  addCueBtn.addEventListener('click', () => {
    const t = Number(cueTime.value) || 0;
    const k = cueKind.value;
    if (k === 'reveal' && state.reveal === 'drum-call') {
      // A drum call is its hits and its crowd as well as its cards.
      cues.push(...sim.drumCallCues(t, false));
      toast(L('cueDrumCall'));
    } else if (k === 'reveal') cues.push({ kind: 'reveal', start: t, dur: 4, mode: state.reveal });
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
    // Long enough for the longest cue to finish, not only to start.
    const dur = Math.max(5, ...cues.map((c) => c.start + ('dur' in c ? c.dur : 0))) + 5;
    if (cues.some((c) => c.kind === 'reveal' && c.mode === 'drum-call')) nudgeDrumSound();
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
    flash.classList.remove('go');
    void flash.offsetWidth; // reflow so the flash animation restarts each time
    flash.classList.add('go');
    toast(L('toast.snapSaved'));
  });
  // Record the choreography reveal as a shareable WebM (the growth artifact).
  const recOpts = (): { seconds: number; fps: number; height?: number } => ({
    seconds: Number(recDur.value),
    fps: Number(recFps.value),
    height: recRes.value === 'source' ? undefined : Number(recRes.value),
  });
  const doRecord = async (): Promise<void> => {
    if (sim.isRecording()) return;
    recBtn.disabled = true;
    recordBtn2.disabled = true;
    const clip = await sim.recordReveal(recOpts(), (s) => toast(L('recording') + ' ' + s));
    recBtn.disabled = false;
    recordBtn2.disabled = false;
    if (!clip) {
      toast(L('recordUnsupported'));
      return;
    }
    const url = URL.createObjectURL(clip.blob);
    const a = document.createElement('a');
    a.href = url;
    // The extension follows what the recorder actually produced. Naming a WebM
    // .mp4 because that is what we asked for would be the one outcome worse than
    // handing over a WebM.
    a.download = `tifo-matchday.${clip.extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    // Say how big it came out — the clip is sized to a budget rather than to a
    // fixed bitrate, so the number is the only way anyone can see that working —
    // and, when the browser could not give us H.264, that this one may not open
    // everywhere, rather than letting them find out when they try to post it.
    const size = `${(clip.blob.size / (1024 * 1024)).toFixed(1)} ${L('recordSize')}`;
    toast(clip.universal ? `${L('recordSaved')} — ${size}` : `${L('recordSaved')} — ${size}. ${L('recordNotUniversal')}`);
  };
  // Preview plays the exact reveal (with the selected style) without recording.
  previewBtn.addEventListener('click', () => {
    nudgeDrumSound();
    sim.playAutoChoreo();
    toast(L('previewing'));
  });
  recordBtn2.addEventListener('click', () => void doRecord());
  recBtn.addEventListener('click', () => void doRecord());
  linkBtn.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('sim', '1');
    void navigator.clipboard?.writeText(u.toString());
    toast(L('toast.linkCopied'));
  });

  // iOS Safari implements fullscreen for <video> only — Element.requestFullscreen
  // is not there at all. Left in, the button sat on the most common phone in
  // this audience doing precisely nothing when tapped.
  const canFullscreen =
    typeof overlay.requestFullscreen === 'function' && document.fullscreenEnabled !== false;
  fullBtn.hidden = !canFullscreen;
  const onFsChange = (): void => {
    fullBtn.textContent = document.fullscreenElement ? L('exitFull') : L('fullscreen');
  };
  fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void overlay.requestFullscreen?.();
  });
  document.addEventListener('fullscreenchange', onFsChange);

  /**
   * One history entry, owned by the overlay.
   *
   * Back is the phone's Escape, and there is no Escape on a phone. Before
   * this, Back from the simulator did not dismiss it — it left `/app`
   * altogether and took the unsaved design with it, because a fullscreen div
   * puts nothing on the history stack. We push an entry when the simulator
   * opens and spend it when it closes, whichever end the user reaches first.
   * `pushed` is cleared before either direction acts, so back → popstate →
   * close → back cannot loop.
   */
  let pushed = false;
  try {
    history.pushState({ mds: 1 }, '');
    pushed = true;
  } catch {
    /* history unavailable (sandboxed iframe) — Escape and Close still work */
  }
  const onPop = (): void => {
    pushed = false;
    close();
  };
  window.addEventListener('popstate', onPop);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    disarmSoundStart();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    window.removeEventListener('resize', fitPanel);
    window.removeEventListener('popstate', onPop);
    mqMobile.removeEventListener('change', placeActions);
    // The banner store outlives this overlay — it belongs to the editor — so
    // the subscription has to come off with the panel that owned it.
    unsubBanners?.();
    if (document.fullscreenElement) void document.exitFullscreen();
    disposeSim();
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    if (pushed) {
      pushed = false;
      try {
        history.back();
      } catch {
        /* nothing to unwind */
      }
    }
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; // don't hijack typing
    // Nothing mounted: every shortcut below dereferences `sim`. Escape still
    // has to work, because the failure card is the only thing on screen.
    if (!mounted) {
      if (e.key === 'Escape') close();
      return;
    }
    if (e.key === 'Escape') {
      if (helpOpen()) hideHelp();
      else if (!document.fullscreenElement) close();
      return;
    }
    if (e.key === '?') {
      if (helpOpen()) hideHelp();
      else showHelp();
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
    } else if ((e.key === 'f' || e.key === 'F') && canFullscreen) {
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
  b.type = 'button';
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
  // `step` BEFORE `value`. A range input sanitises whatever you assign against
  // the step it has at that moment, and the default step is 1 — so setting
  // `value = '0.7'` first and `step = '0.05'` second stores 1, silently, and
  // the slider opens at the far right. Every fader in the Sound section read
  // 100% because of this, and the exposure slider was landing on 1.4 instead
  // of 1.05 for the same reason.
  r.step = String(step);
  r.value = String(val);
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
/**
 * A fader with its own number on it.
 *
 * A row of five unlabelled sliders is a mixing desk with the scribble strip
 * torn off: you can tell they are at different heights and not what any of them
 * is set to, and "is the drum at 20% or off?" is exactly the question these are
 * here to answer. The readout follows the input event, so it is right while the
 * thumb is still moving.
 */
function levelField(label: string, ctrl: HTMLInputElement): HTMLElement {
  const d = document.createElement('div');
  d.className = 'mds-field';
  const l = document.createElement('div');
  l.className = 'mds-flabel mds-flabel-row';
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('span');
  val.className = 'mds-fval';
  const show = (): void => { val.textContent = Math.round(Number(ctrl.value) * 100) + '%'; };
  show();
  ctrl.addEventListener('input', show);
  l.append(name, val);
  d.append(l, ctrl);
  return d;
}
function checkField(label: string, c: HTMLInputElement): HTMLElement {
  const l = document.createElement('label');
  l.className = 'mds-checkrow';
  const t = document.createElement('span');
  t.textContent = label;
  l.append(c, t);
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
  head.type = 'button';
  head.className = 'mds-shead';
  head.setAttribute('aria-expanded', String(open));
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.innerHTML = icon;
  const t = document.createElement('span');
  t.textContent = title;
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.innerHTML = ICONS.chevron;
  head.append(ico, t, chev);
  const body = document.createElement('div');
  body.className = 'mds-sbody';
  // Exclusive accordion: opening one section closes the rest, so the panel stays
  // short and every control (incl. Delete / Clear) is reachable without a fight.
  head.addEventListener('click', () => {
    const wasOpen = root.classList.contains('open');
    root.parentElement?.querySelectorAll('.mds-section').forEach((s) => {
      s.classList.remove('open');
      s.querySelector('.mds-shead')?.setAttribute('aria-expanded', 'false');
    });
    if (!wasOpen) {
      root.classList.add('open');
      head.setAttribute('aria-expanded', 'true');
    }
  });
  root.append(head, body);
  return { root, body };
}
