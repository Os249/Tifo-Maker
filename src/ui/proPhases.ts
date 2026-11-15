/**
 * Two phases, as the fan chose it: off, or the look of the first phase
 * (simulator/phases.ts). One choice for every film of the tifo: the Full HD
 * and vertical film, the Reel, and Match Day's own film all read it here.
 *
 * It is an export setting, kept in this browser (tifo_pro_phases_v1), not in
 * the design: a saved tifo is the same file with or without it.
 *
 * The control is mounted in the Animation panel, under the reveal, by the
 * Pro export tools (ui/proExport.ts); its words come with them.
 */
import { PHASE_LOOKS, type PhaseLook } from '../render/simulator/phases';
import { onLangChange, t } from './i18n';
import { proChipHtml } from './pro';

const KEY = 'tifo_pro_phases_v1';
let choice: PhaseLook | null | undefined;

/** The first phase's look, or null: one phase, as every film was. */
export function phaseChoice(): PhaseLook | null {
  if (choice === undefined) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      /* private mode: off until chosen */
    }
    choice = (PHASE_LOOKS as readonly string[]).includes(raw ?? '') ? (raw as PhaseLook) : null;
  }
  return choice;
}

export function setPhaseChoice(look: PhaseLook | null): void {
  choice = look;
  try {
    if (look) localStorage.setItem(KEY, look);
    else localStorage.removeItem(KEY);
  } catch {
    /* the choice lasts the visit */
  }
}

/**
 * The control, after `after` (the reveal's row): a picker with its crown and
 * a line saying what it does and where it shows. `state` says whether Pro is
 * on for the account and running; hidden while it is not on.
 */
export function mountPhaseControl(after: Element, state: () => { live: boolean; running: boolean }, changed: () => void): { paint(): void } {
  const box = document.createElement('div');
  box.className = 'pexp-phases';
  box.id = 'sx-phases';
  box.innerHTML =
    `<div class="group"><label for="sx-phase"></label><select id="sx-phase" class="grow0"></select><span class="pexp-crown"></span></div>` +
    `<p class="pexp-note"></p>`;
  after.after(box);
  const select = box.querySelector('select') as HTMLSelectElement;
  const paint = (): void => {
    const st = state();
    box.hidden = !st.live;
    (box.querySelector('label') as HTMLElement).textContent = t('phase.label');
    select.innerHTML = '';
    for (const v of ['off', ...PHASE_LOOKS]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t(`phase.${v}`);
      select.append(o);
    }
    select.value = phaseChoice() ?? 'off';
    (box.querySelector('.pexp-crown') as HTMLElement).innerHTML = phaseChoice() ? proChipHtml({ quiet: st.running, icon: true }) : '';
    (box.querySelector('.pexp-note') as HTMLElement).textContent = t(phaseChoice() ? 'phase.noteOn' : 'phase.note');
  };
  select.addEventListener('change', () => {
    setPhaseChoice(select.value === 'off' ? null : (select.value as PhaseLook));
    paint();
    changed();
  });
  onLangChange(paint);
  paint();
  return { paint };
}
