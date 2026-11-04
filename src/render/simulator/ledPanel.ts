/**
 * The LED boards' style in Match Day (Pro): what goes round the ring beyond
 * the words and their colour, which the overlay's LED section already holds.
 *
 *   - a template (ledBoards.ts): the messages; a sponsor board with the
 *     club's crest; a chant ticker; the score; a countdown to the reveal;
 *   - the crest, from the fan's club kit (ui/clubKitStore loadKits, read when
 *     the section is first shown; nothing is uploaded);
 *   - the score's two sides and goals;
 *   - "Your LED boards" on the big screens' list (the Screens section), so a
 *     ground's screens show what the boards show.
 *
 * Built into the overlay's LED section, which is shown only when /api/pro
 * says Pro is on for this account; the overlay re-applies it whenever the
 * ring is rebuilt. Remembered in this browser, defensively, like the words.
 */
import './ledPanel.css';
import { t, tv } from '../../ui/i18n';
import { findFontCss } from '../../core/text';
import { LED_TEMPLATES, cleanGoals, cleanSide, type LedStyle, type LedTemplate } from './ledBoards';

const KEY = 'mds_led_style_v1';

interface Saved {
  template: LedTemplate;
  kit: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

function read(): Saved {
  const base: Saved = { template: 'boards', kit: '', home: '', away: '', homeGoals: 0, awayGoals: 0 };
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (!p || typeof p !== 'object') return base;
    return {
      template: LED_TEMPLATES.includes(p.template as LedTemplate) ? (p.template as LedTemplate) : 'boards',
      kit: typeof p.kit === 'string' && /^k[0-9a-z]{8,32}$/.test(p.kit) ? p.kit : '',
      home: cleanSide(p.home),
      away: cleanSide(p.away),
      homeGoals: cleanGoals(p.homeGoals),
      awayGoals: cleanGoals(p.awayGoals),
    };
  } catch {
    return base; // corrupt JSON is the same answer as none
  }
}

export interface LedStylePanel {
  /** Put the style on the boards again (a rebuilt ring). */
  apply(): void;
}

/**
 * Build the style controls in the LED section's `body` (ahead of `before`). `section`
 * is the section (hidden while Pro is not on), `screenSel` the Screens
 * section's list; `setStyle` reaches the simulator that is current.
 */
export function mountLedStyle(
  { body, section, screenSel, before }: { body: HTMLElement; section: HTMLElement; screenSel: HTMLSelectElement | null; before?: HTMLElement },
  setStyle: (s: LedStyle) => void,
): LedStylePanel {
  const saved = read();
  let crest: LedStyle['crest'] = null;
  let kitsAsked = false;

  const field = (label: string, ctrl: HTMLElement, k: string): HTMLElement => {
    const d = document.createElement('div');
    d.className = 'mds-field';
    d.dataset.k = k;
    const l = document.createElement('div');
    l.className = 'mds-flabel';
    l.textContent = label;
    d.append(l, ctrl);
    return d;
  };
  const select = (k: string): HTMLSelectElement => {
    const s = document.createElement('select');
    s.className = 'mds-sel';
    s.dataset.k = k;
    return s;
  };
  const input = (k: string, type: 'text' | 'number', aria: string): HTMLInputElement => {
    const i = document.createElement('input');
    i.type = type;
    i.className = 'mds-input';
    i.dataset.k = k;
    i.autocomplete = 'off';
    i.setAttribute('aria-label', aria);
    if (type === 'number') { i.min = '0'; i.max = '99'; i.step = '1'; i.inputMode = 'numeric'; }
    else { i.maxLength = 16; i.spellcheck = false; }
    return i;
  };

  const tpl = select('led-style');
  for (const id of LED_TEMPLATES) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = t(`qf.led.t.${id}`);
    tpl.append(o);
  }
  tpl.value = saved.template;
  const hint = document.createElement('div');
  hint.className = 'mds-hint';
  hint.dataset.k = 'led-style-hint';

  const kit = select('led-kit');
  const kitHint = document.createElement('div');
  kitHint.className = 'mds-hint';
  kitHint.dataset.k = 'led-kit-hint';
  kitHint.hidden = true;

  const home = input('led-home', 'text', t('qf.led.home'));
  const away = input('led-away', 'text', t('qf.led.away'));
  const hg = input('led-home-goals', 'number', t('qf.led.homeGoals'));
  const ag = input('led-away-goals', 'number', t('qf.led.awayGoals'));
  home.placeholder = t('qf.led.home');
  away.placeholder = t('qf.led.away');
  home.value = saved.home;
  away.value = saved.away;
  hg.value = String(saved.homeGoals);
  ag.value = String(saved.awayGoals);
  const score = document.createElement('div');
  score.className = 'mds-ledscore';
  score.append(home, hg, ag, away);
  const scoreField = field(t('qf.led.score'), score, 'led-score');

  const parts = [field(t('qf.led.style'), tpl, 'led-style-field'), hint, field(t('qf.led.crest'), kit, 'led-kit-field'), kitHint, scoreField];
  // After the words and their colour, ahead of "Clear the boards".
  if (before?.parentElement === body) before.before(...parts);
  else body.append(...parts);

  const style = (): LedStyle => ({
    template: tpl.value as LedTemplate,
    crest,
    home: cleanSide(home.value),
    away: cleanSide(away.value),
    homeGoals: cleanGoals(hg.value),
    awayGoals: cleanGoals(ag.value),
  });
  const save = (): void => {
    const s = style();
    try {
      localStorage.setItem(KEY, JSON.stringify({ template: s.template, kit: kit.value, home: s.home, away: s.away, homeGoals: s.homeGoals, awayGoals: s.awayGoals }));
    } catch { /* a private window: the style lasts this visit */ }
  };
  const sync = (): void => {
    hint.textContent = t(`qf.led.h.${tpl.value}`);
    scoreField.hidden = tpl.value !== 'score';
  };
  const apply = (): void => setStyle(style());
  const changed = (): void => {
    sync();
    save();
    apply();
  };
  tpl.addEventListener('change', changed);
  for (const el of [home, away, hg, ag]) el.addEventListener('input', changed);
  kit.addEventListener('change', () => {
    crest = crestOf(kit.value);
    kitHint.hidden = !kit.value || !!crest;
    if (kit.value && !crest) kitHint.textContent = t('qf.led.kitNoLogo');
    changed();
  });

  // The club kits: read once, when the section is first on screen.
  let kits: { id: string; name: string; crest: LedStyle['crest'] }[] = [];
  const crestOf = (id: string): LedStyle['crest'] => kits.find((k) => k.id === id)?.crest ?? null;
  const fillKits = (): void => {
    kit.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('qf.led.crestNone');
    kit.append(none);
    kits.forEach((k, i) => {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.name || tv('qf.led.kitN', { n: i + 1 });
      kit.append(o);
    });
    kit.value = kits.some((k) => k.id === saved.kit) ? saved.kit : '';
    crest = crestOf(kit.value);
    if (!kits.length) {
      kitHint.hidden = false;
      kitHint.textContent = t('qf.led.noKit');
    }
    kit.disabled = !kits.length;
  };
  fillKits();
  const askKits = (): void => {
    if (kitsAsked) return;
    kitsAsked = true;
    void import('../../ui/clubKitStore')
      .then((m) => m.loadKits((id) => !!findFontCss(id)))
      .then((r) => {
        kits = r.kits.map((k) => ({ id: k.id, name: k.name, crest: k.logos[0]?.bitmap ?? null }));
        fillKits();
        if (crest) apply();
      })
      .catch(() => { /* no kits: the boards without a crest */ });
  };
  const watch = (): void => {
    if (!section.hidden) askKits();
  };
  new MutationObserver(watch).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  watch();

  // The big screens: "Your LED boards" on their list, while the LED section is.
  if (screenSel && !screenSel.querySelector('option[value="boards"]')) {
    const o = document.createElement('option');
    o.value = 'boards';
    o.textContent = t('qf.screen.boards');
    screenSel.append(o);
    const show = (): void => {
      const on = !section.hidden;
      o.hidden = !on;
      o.disabled = !on;
      if (!on && screenSel.value === 'boards') {
        screenSel.value = 'stadium';
        screenSel.dispatchEvent(new Event('change'));
      }
    };
    new MutationObserver(show).observe(section, { attributes: true, attributeFilter: ['hidden'] });
    show();
  }

  sync();
  return { apply };
}
