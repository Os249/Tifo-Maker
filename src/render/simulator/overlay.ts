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
.mds-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.mds-row .mds-btn{flex:1 1 auto;text-align:center;}
.mds-divider{height:1px;background:var(--border-soft);margin:1px 0;}
.mds-checkrow{display:flex;align-items:center;gap:9px;font-size:12.5px;line-height:1.3;color:#cfd6df;cursor:pointer;margin:0;}
.mds-hint{font-size:11px;color:var(--text-faint);}
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
.mds-baracts{display:flex;align-items:center;gap:10px;}
.mds-panel-acts{display:none;}
.mds-brand .brand-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mds-overlay canvas{touch-action:none;display:block;}
@media (max-width:640px){
  .mds-bar{padding:8px 10px;gap:7px;}
  .mds-brand{min-width:0;font-size:14px;}
  .mds-panel{top:auto;left:0;right:0;bottom:0;width:auto;max-height:64vh;height:auto!important;border-radius:16px 16px 0 0;border-left:none;border-right:none;border-bottom:none;padding:10px 12px calc(10px + env(safe-area-inset-bottom));transition:transform var(--t-med) ease,opacity var(--t-med);}
  .mds-panel.collapsed{transform:translateY(102%);opacity:1;}
  .mds-panel-acts{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);}
  .mds-panel-acts .mds-baracts{display:flex;flex-wrap:wrap;gap:8px;width:100%;}
  .mds-panel-acts .mds-baracts .mds-bf{flex:1 1 100%;}
  .mds-panel-acts .mds-baracts .mds-bf .mds-sel{flex:1 1 auto;}
  .mds-panel-acts .mds-baracts .mds-btn{flex:1 1 auto;}
  .mds-btn,.mds-sel,.mds-input{min-height:44px;}
  .mds-icon{min-width:44px;min-height:44px;}
  .mds-shead{min-height:48px;}
  input[type=checkbox].mds-check{width:20px;height:20px;min-width:20px;}
  input[type=checkbox].mds-check::after{left:6px;top:2.5px;width:5px;height:10px;}
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
  helpControls: { en: 'Help & controls (?)', ar: 'المساعدة والأدوات (؟)' },
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
  selectDash: { en: '— select —', ar: '— اختر —' },
  helpSub: { en: 'See your tifo come alive in a packed 3D stadium.', ar: 'شوف تيفوك يصير حقيقة في ملعب ثلاثي الأبعاد ممتلئ.' },
  hMove: { en: 'Move the camera', ar: 'حرّك الكاميرا' },
  hLook: { en: 'Look around', ar: 'انظر حولك' },
  hDrag: { en: 'Drag', ar: 'سحب' },
  hZoom: { en: 'Zoom', ar: 'تكبير' },
  hScroll: { en: 'Scroll / pinch', ar: 'تمرير / قرص' },
  hPan: { en: 'Pan', ar: 'تحريك' },
  hRightDrag: { en: 'Right-drag', ar: 'سحب باليمين' },
  hShortcuts: { en: 'Shortcuts', ar: 'اختصارات' },
  hCamViews: { en: 'Camera views', ar: 'لقطات الكاميرا' },
  hPlayReveal: { en: 'Play the reveal', ar: 'تشغيل الكشف' },
  hFull: { en: 'Fullscreen', ar: 'ملء الشاشة' },
  hHide: { en: 'Hide panel', ar: 'إخفاء اللوحة' },
  hHelp: { en: 'Help', ar: 'مساعدة' },
  hClose: { en: 'Close', ar: 'إغلاق' },
  hYours: { en: 'Make it yours', ar: 'خلّه لك' },
  hBanners: { en: 'Banners and flags', ar: 'اللافتات والأعلام' },
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
  'tip.stairs': { en: 'Also fill the aisles / stairs between sections (unorthodox — off by default)', ar: 'عبّي كمان الممرات/الدرج بين القطاعات (غير معتاد — مطفأ افتراضياً)' },
  'tip.wet': { en: 'Reflective wet-look pitch (heavier on GPU)', ar: 'أرضية مبلّلة عاكسة (أثقل على المعالج الرسومي)' },
  'tip.confetti': { en: 'Burst of confetti', ar: 'انفجار قصاصات' },
  'tip.pyro': { en: 'Burst of pyro flares', ar: 'انفجار شماريخ' },
  'tip.bigBanner': { en: 'Big 3D banner that drapes the whole stand', ar: 'لافتة ثلاثية الأبعاد كبيرة تغطي المدرج كامل' },
  'tip.smallBanner': { en: 'Small banner covering the dark front wall / infrastructure', ar: 'لافتة صغيرة تغطي الجدار الأمامي المعتم' },
  'tip.text': { en: 'Text banner using the text box above', ar: 'لافتة نص باستخدام مربع النص فوق' },
  'tip.floor': { en: 'Banner laid flat on the pitch', ar: 'لافتة مفروشة على الأرضية' },
  'tip.surface': { en: 'Giant draped surface tifo over the stand', ar: 'تيفو سطح عملاق منسدل على المدرج' },
  'tip.flag': { en: 'Huge waving flag over the crowd', ar: 'علم ضخم يرفرف فوق الجمهور' },
  'tip.scarf': { en: 'Waving scarf wall', ar: 'جدار أوشحة يرفرف' },
  'tip.proj': { en: 'Paints your tifo onto the seats from this view — EDITS your design', ar: 'يرسم تيفوك على المقاعد من هذي اللقطة — يعدّل تصميمك' },
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
    stairs: false,
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
  barActions.append(barField(L('quality'), qSel), snapBtn, fullBtn, linkBtn);
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
  const confettiBtn = btn(L('confetti'));
  const pyroBtn = btn(L('pyro'));
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
    row(confettiBtn, pyroBtn),
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
    row(unfurlBtn, printBtn, delBtn, clearAllBtn),
  );

  // Choreography
  const autoBtn = btn(L('autoChoreo'), 'primary');
  const stopBtn = btn(L('stop'));
  const revealSel = sel();
  for (const m of REVEAL_MODES) opt(revealSel, m.id, m.label, false);
  const revealBtn = btn(L('playReveal'));
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
  cueCount.textContent = '0 cues';
  const secChoreo = section(ICONS.choreo, L('choreo'), false);
  secChoreo.body.append(
    row(autoBtn, stopBtn),
    divider(),
    field(L('revealStyle'), revealSel),
    revealBtn,
    divider(),
    document.createTextNode(''),
    field(L('cueTime'), cueTime),
    field(L('cueType'), cueKind),
    row(addCueBtn, playSeqBtn, clearSeqBtn),
    cueCount,
  );

  const actionsHost = document.createElement('div'); // holds barActions on mobile
  actionsHost.className = 'mds-panel-acts';
  panel.append(actionsHost, secCam.root, secCrowd.root, secAtmo.root, secAssets.root, secChoreo.root);
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
  helpCard.innerHTML =
    '<h2>' + L('brand') + '</h2>' +
    '<p class="sub">' + L('helpSub') + '</p>' +
    '<div class="mds-help-grp"><h3>' + L('hMove') + '</h3>' +
    kv(L('hLook'), L('hDrag')) + kv(L('hZoom'), L('hScroll')) + kv(L('hPan'), L('hRightDrag')) + '</div>' +
    '<div class="mds-help-grp"><h3>' + L('hShortcuts') + '</h3>' +
    kv(L('hCamViews'), key('1') + ' to ' + key('9')) +
    kv(L('hPlayReveal'), key('Space')) +
    kv(L('hFull'), key('F')) +
    kv(L('hHide'), key('H')) +
    kv(L('hHelp'), key('?')) +
    kv(L('hClose'), key('Esc')) +
    '</div>' +
    '<div class="mds-help-grp"><h3>' + L('hYours') + '</h3>' +
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
    if (!state.fly) sim.applyShot(shots[state.camIdx] ?? shots[0]);
  }
  function mount(): void {
    sim = new MatchDaySimulator(host, map, store, template, assetStore, { quality: state.tier });
    applyState();
    refreshAssets();
    sim.start();
  }
  mount();
  // Bound the panel height in pixels (inline style beats any CSS) so overflow
  // actually scrolls instead of the panel growing to fit its content.
  const fitPanel = (): void => {
    // On mobile the panel is a bottom sheet sized by CSS (max-height); on desktop
    // we bound it in px so its overflow actually scrolls.
    if (window.innerWidth <= 640) panel.style.height = '';
    else panel.style.height = Math.max(200, window.innerHeight - 76) + 'px';
  };
  fitPanel();
  window.addEventListener('resize', fitPanel);

  // Responsive: move the secondary actions into the panel on phones, back to the
  // top bar on desktop, so the bar never overflows.
  const mqMobile = window.matchMedia('(max-width: 640px)');
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
    sim.dispose();
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
        if (!window.confirm('This PAINTS your tifo onto the seats as seen from this camera — it edits your actual design (undo with Ctrl+Z in the editor). Continue?')) {
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
    flash.classList.remove('go');
    void flash.offsetWidth; // reflow so the flash animation restarts each time
    flash.classList.add('go');
    toast(L('toast.snapSaved'));
  });
  linkBtn.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('sim', '1');
    void navigator.clipboard?.writeText(u.toString());
    toast(L('toast.linkCopied'));
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
    window.removeEventListener('resize', fitPanel);
    mqMobile.removeEventListener('change', placeActions);
    if (document.fullscreenElement) void document.exitFullscreen();
    sim.dispose();
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; // don't hijack typing
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
