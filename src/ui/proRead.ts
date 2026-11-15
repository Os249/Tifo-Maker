/**
 * "Can the camera read it?": a second opinion before a tifo is posted.
 *
 * The Post it sheet holds the stadium picture about to go out. One press
 * sends a small copy of it to the server (POST /api/ai/read), where a vision
 * model is asked which words the cards spell, and the answer is put beside
 * the words the design's own text layers say: the same word, another word,
 * or nothing readable. An unreadable tifo is found out here, not on the
 * timeline.
 *
 * It is an opinion, and worded as one: the camera "read", it does not
 * "know", and it says when it was not sure of every letter. The seat
 * preview's measured verdict is untouched and still the first word on
 * whether text reads; when the check cannot answer, the line says so and
 * points back to it.
 *
 * Pro: the button shows for an account Pro is on for; the free plan's press
 * opens what Pro adds. Twenty checks a day, counted by the server. The
 * picture is not kept (the note under the button says where it goes).
 *
 * Loaded with the Pro export tools; its words come with it.
 */
import { cameraRead, fetchPro, type CameraReadError } from '../net/api';
import { t, tv } from './i18n';
import { proChipHtml } from './pro';

/** The longest side of the picture sent, and the most bytes the server takes. */
const EDGE = 1024;
const MAX_BYTES = 560 * 1024;

/** Letters and digits only, no accents, harakat or tatweel: what "the same word" is compared on. */
export function plainWord(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ًͯ-ٰٟـ]/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** Whether what the camera read is what the design says (either holds the other, three letters or more). */
export function sameWords(read: string, yours: readonly string[]): boolean {
  const a = plainWord(read);
  if (a.length < 2) return false;
  return yours.some((w) => {
    const b = plainWord(w);
    return b.length >= 2 && (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))));
  });
}

/** `shot` as a JPEG data URL no larger than the server takes. */
function small(shot: HTMLCanvasElement): string {
  const k = Math.min(1, EDGE / Math.max(shot.width, shot.height, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(shot.width * k));
  c.height = Math.max(1, Math.round(shot.height * k));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(shot, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const url = c.toDataURL('image/jpeg', q);
    if (url.length * 0.75 <= MAX_BYTES) return url;
  }
  return c.toDataURL('image/jpeg', 0.4);
}

/** The line that says what came back. */
export function readingLine(text: string, sure: boolean, yours: readonly string[]): string {
  const mine = yours.map((w) => w.trim()).filter(Boolean).join(' · ').slice(0, 60);
  let line: string;
  if (text) {
    line = !mine ? tv('read.got', { text }) : sameWords(text, yours) ? tv('read.match', { text }) : tv('read.differs', { text, yours: mine });
    if (!sure) line += ` ${t('read.unsure')}`;
  } else line = mine ? tv('read.noneYours', { yours: mine }) : t('read.none');
  return line;
}

/**
 * The check, for the Post it sheet: a button, the answer under it, and where
 * the picture goes. `shot` makes the picture to read (the view straight at
 * the tifo); `words` are the design's text layers as they are now.
 */
export function cameraCheck(shot: () => HTMLCanvasElement, words: () => string[], running: boolean): HTMLElement {
  const box = document.createElement('div');
  box.className = 'pro-read';
  box.innerHTML =
    `<button type="button" class="pro-alt pro-read-go"><i class="ti ti-eye" aria-hidden="true"></i> <span></span> ${proChipHtml({ quiet: running, icon: true })}</button>` +
    `<p class="pro-read-out" role="status" aria-live="polite"></p><p class="pro-read-note"></p>`;
  const go = box.querySelector('.pro-read-go') as HTMLButtonElement;
  const label = go.querySelector('span') as HTMLElement;
  const out = box.querySelector('.pro-read-out') as HTMLElement;
  label.textContent = t('read.ask');
  (box.querySelector('.pro-read-note') as HTMLElement).textContent = t('read.note');
  go.addEventListener('click', async () => {
    if (go.disabled) return;
    go.disabled = true;
    label.textContent = t('read.reading');
    out.textContent = '';
    try {
      const r = await cameraRead(small(shot()));
      out.textContent = readingLine(r.text, r.sure, words());
    } catch (e) {
      const reason = (e as CameraReadError).reason;
      if (reason === 'pro') {
        // The free plan: what Pro adds, with this named first.
        const st = await fetchPro().catch(() => null);
        if (st?.live) void import('./proSheets').then((m) => m.openProSheet(st, { title: t('read.proTitle'), lead: t('read.proLead') }));
      } else out.textContent = t(reason === 'quota' ? 'read.quota' : reason === 'signin' ? 'read.signin' : 'read.busy');
    } finally {
      go.disabled = false;
      label.textContent = t('read.ask');
    }
  });
  return box;
}
