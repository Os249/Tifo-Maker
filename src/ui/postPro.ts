/**
 * Pro where fans already are: the Post it sheet (22 Nov 2026).
 *
 * WHY
 *   In 30 days 394 people opened Post it and 79 shared; 3 saw the export
 *   sheet, the only place Pro's exports were offered. Pro sells the vertical
 *   video, Full HD without the mark and the 4K poster, and fans were not
 *   taking the path where it was sold.
 *
 * WHAT (only when the server says so: /api/pro offer.post, PRO_POST_OFFERS)
 *   Under the sheet's own buttons, so posting the free picture stays first
 *   and exactly as it was:
 *
 *   - one closed row, "Pro versions of this tifo". Opened, it lists the three
 *     and offers a short, small preview of the vertical video of THIS tifo,
 *     with the mark on it: the value first.
 *   - then one way on, in plain words: with Pro running (paid or the gift)
 *     the three just work; without, the gift when there is one waiting, a free
 *     account when that brings the 7 days, or Get Pro with its price, and the
 *     match pass beside it when it is sold. Never more than one of these.
 *   - for a visitor who is signed out, one line offering an account, with
 *     Google in one tap and email beside it. The tifo is kept in this browser
 *     first and moved to the account after, so nothing is lost either way.
 *
 *   No timer, nothing pre-ticked, nothing hidden or made worse: the picture's
 *   own buttons do what they always did. The blue button stays the sheet's
 *   own (Post it…); everything here is gold-tinted or quiet.
 *
 * Loaded by the Post it sheet only when it has something to show, so none of
 * its words are in the editor's start.
 */
import './postPro.css';
import { escapeHtml } from '../core/escape';
import { availableProviders, fetchPro, forgetPro, isSignedIn, type ProState } from '../net/api';
import { track } from '../net/analytics';
import type { RevealId } from '../core/reveal';
import { inAppBrowser } from './authModal';
import { currentCredit } from './creditLine';
import { t, tv } from './i18n';
import { CROWN_SVG, money } from './pro';
import { cleanByDefault } from './proMark';
import { getPressed, offerSeen, proLink, type ProPlace } from './proWhere';
import { otherPlansHtml, plansListed, wirePlanList } from './proPlanList';

export interface PostProContext {
  /** Where the block goes: after this element. */
  after: HTMLElement;
  state: ProState;
  title: string;
  /** Close the sheet (a film or the poster takes the screen). */
  close(): void;
  /** Run when the sheet closes. */
  whenClosed(run: () => void): void;
  /** An account from here (ui/toolbar.ts accountFromPost), when the page can make one. */
  account?: (how: 'google' | 'email') => Promise<boolean>;
  /** 'post' on the Post it sheet, 'share' on the share dialog. */
  place: ProPlace;
}

const revealNow = (): RevealId => ((document.getElementById('reveal-preset') as HTMLSelectElement | null)?.value || 'sweep') as RevealId;

/** The three Pro versions, as the row lists them. */
const VERSIONS = ['pp2.v', 'pp2.hd', 'pp2.poster'] as const;

/**
 * The account offer: one line, Google in one tap where it can work, email
 * beside it. Only for a visitor who is signed out, and never in the way: the
 * sheet's own buttons are above it and untouched.
 */
function accountLine(ctx: PostProContext): HTMLElement | null {
  if (isSignedIn() || !ctx.account) return null;
  const days = ctx.state.offer?.gift.days ?? 7;
  const box = document.createElement('div');
  box.className = 'pa-line';
  box.innerHTML =
    `<p class="pa-text">${escapeHtml(ctx.state.offer?.autoGift ? tv('pa.lineGift', { n: days }) : t('pa.line'))}</p>` +
    `<div class="pa-acts">` +
    `<button type="button" class="pro-alt pa-google" data-how="google" hidden><i class="ti ti-brand-google" aria-hidden="true"></i><span>${escapeHtml(t('auth.google'))}</span></button>` +
    `<button type="button" class="pro-alt" data-how="email"><i class="ti ti-mail" aria-hidden="true"></i><span>${escapeHtml(t('pa.email'))}</span></button>` +
    `</div><p class="pa-note" role="status" aria-live="polite">${escapeHtml(t('pa.note'))}</p>`;
  track('signup_offer_post');
  const note = box.querySelector('.pa-note') as HTMLElement;
  // Google's page does not open inside TikTok's or X's own browser: the button is only offered where it works.
  void availableProviders().then((list) => {
    if (list.includes('google') && !inAppBrowser()) (box.querySelector('.pa-google') as HTMLElement).hidden = false;
  });
  box.querySelectorAll<HTMLButtonElement>('[data-how]').forEach((b) =>
    b.addEventListener('click', async () => {
      const how = b.dataset.how === 'google' ? 'google' : 'email';
      box.querySelectorAll<HTMLButtonElement>('[data-how]').forEach((x) => { x.disabled = true; });
      note.textContent = t('pa.saving');
      const ok = await ctx.account!(how).catch(() => false);
      if (ok) {
        box.querySelector('.pa-acts')?.remove();
        (box.querySelector('.pa-text') as HTMLElement).textContent = t('pa.done');
        note.textContent = '';
        // The gift, if it starts for this account, is said once the sheet is out of the way.
        ctx.whenClosed(() => forgetPro());
        return;
      }
      // Google: the page is leaving. Email: the form was closed.
      if (how === 'email') {
        box.querySelectorAll<HTMLButtonElement>('[data-how]').forEach((x) => { x.disabled = false; });
        note.textContent = t('pa.note');
      }
    }));
  return box;
}

/** Mount Pro's part of the sheet. Returns nothing: it adds itself after `ctx.after`, or adds nothing. */
export function mountPostPro(ctx: PostProContext): void {
  const st = ctx.state;
  if (!st.live || !st.offer?.post) return;
  const offer = st.offer;
  const running = !!st.plan && st.plan !== 'free';
  const inEditor = !!document.getElementById('rail-anim');

  const wrap = document.createElement('div');
  wrap.className = 'pp2';
  wrap.dir = document.documentElement.dir || 'ltr';
  ctx.after.after(wrap);

  const acct = accountLine(ctx);
  if (acct) wrap.appendChild(acct);

  // The share dialog shares a link to a published tifo: there is no export of its own to offer Pro on.
  // The Post it sheet is in the editor, where the film and the poster can be made.
  if (!inEditor || ctx.place !== 'post') return;

  const sec = document.createElement('section');
  sec.className = 'pp2-pro';
  sec.innerHTML =
    `<button type="button" class="pp2-sum" aria-expanded="false" aria-controls="pp2-body">${CROWN_SVG}<span>${escapeHtml(t('pp2.sum'))}</span><i class="ti ti-chevron-down" aria-hidden="true"></i></button>` +
    `<div class="pp2-body" id="pp2-body" hidden></div>`;
  wrap.appendChild(sec);
  const sum = sec.querySelector('.pp2-sum') as HTMLButtonElement;
  const body = sec.querySelector('.pp2-body') as HTMLElement;
  if (!running) offerSeen(ctx.place);

  let built = false;
  const build = (): void => {
    if (built) return;
    built = true;
    if (running) {
      // Pro is on (paid or the gift): they just work.
      body.innerHTML =
        `<p class="pp2-line">${escapeHtml(t('pp2.yours'))}</p>` +
        `<div class="pp2-make">` +
        `<button type="button" class="pro-btn" data-make="vertical">${CROWN_SVG}<span>${escapeHtml(t('pp2.make.v'))}</span></button>` +
        `<button type="button" class="pro-btn" data-make="landscape">${CROWN_SVG}<span>${escapeHtml(t('pp2.make.hd'))}</span></button>` +
        (document.getElementById('sx-poster') ? `<button type="button" class="pro-btn" data-make="poster">${CROWN_SVG}<span>${escapeHtml(t('pp2.make.poster'))}</span></button>` : '') +
        `</div>`;
      body.querySelectorAll<HTMLButtonElement>('[data-make]').forEach((b) =>
        b.addEventListener('click', async () => {
          const what = b.dataset.make;
          ctx.close();
          if (what === 'poster') {
            document.getElementById('sx-poster')?.click();
            return;
          }
          const { filmFromEditor } = await import('./proFilm');
          await filmFromEditor({
            shape: what === 'vertical' ? 'vertical' : 'landscape',
            reveal: { kind: 'order', id: revealNow() },
            mark: !cleanByDefault(true),
            creditLine: currentCredit().text || undefined,
            name: `${ctx.title}-matchday`,
          }).catch(() => null);
        }));
      return;
    }

    const gift = st.gift?.state === 'offered';
    const signedOut = !st.signedIn;
    const m = offer.paymentsOpen ? offer.match : undefined;
    let action: string;
    let price = '';
    if (gift) {
      action = `<button type="button" class="pro-btn" data-act="gift">${CROWN_SVG}<span>${escapeHtml(t('pro.act.useGift'))}</span></button>`;
    } else if (signedOut && offer.autoGift && ctx.account) {
      // The account line above is the way: said once, there.
      action = `<p class="pp2-line">${escapeHtml(tv('pp2.acct', { n: offer.gift.days }))}</p>`;
    } else if (offer.paymentsOpen) {
      price = `<p class="pp2-line">${escapeHtml(tv('pp2.price', { price: money(offer.monthly.price), days: offer.monthly.days }))}` +
        (m && !plansListed(offer) ? ` ${escapeHtml(tv('pp2.priceMatch', { hours: m.hours, price: money(m.price) }))}` : '') + `</p>`;
      action =
        `<div class="pp2-make"><a class="pro-btn" data-act="get" href="${escapeHtml(proLink(ctx.place))}">${CROWN_SVG}<span>${escapeHtml(t('pp2.get'))}</span></a>` +
        (m && !plansListed(offer) ? `<a class="pro-alt" data-act="get" href="${escapeHtml(proLink(ctx.place, 'match'))}">${escapeHtml(t('pp2.matchGet'))}</a>` : '') + `</div>` +
        // Where every plan on sale is named (PRO_THREE_PLANS): the match pass and the year under the month's button.
        otherPlansHtml(offer, ctx.place);
    } else {
      action = `<a class="pro-text-btn" href="${escapeHtml(proLink(ctx.place))}">${escapeHtml(t('pro.act.seePage'))}</a>`;
    }
    body.innerHTML =
      `<ul class="pp2-list">${VERSIONS.map((k) => `<li>${CROWN_SVG}<span>${escapeHtml(t(k))}</span></li>`).join('')}</ul>` +
      `<div class="pp2-see"><button type="button" class="pro-alt" data-act="see"><i class="ti ti-player-play" aria-hidden="true"></i><span>${escapeHtml(t('pp2.see'))}</span></button>` +
      `<p class="pp2-note" role="status" aria-live="polite"></p></div>` +
      price + action +
      `<p class="pp2-note">${escapeHtml(t('pp2.free'))}</p>`;
    body.querySelectorAll('[data-act="get"]').forEach((a) => a.addEventListener('click', () => getPressed(ctx.place)));
    wirePlanList(body, offer, ctx.place);
    body.querySelector('[data-act="gift"]')?.addEventListener('click', async () => {
      const { openGiftSheet } = await import('./proSheets');
      if (await openGiftSheet(st)) forgetPro();
    });
    const see = body.querySelector('[data-act="see"]') as HTMLButtonElement;
    const note = body.querySelector('.pp2-see .pp2-note') as HTMLElement;
    see.addEventListener('click', async () => {
      see.disabled = true;
      note.textContent = t('pp2.seeing');
      // The fan's own tifo as the vertical film: small, short of full size, and with the mark. Free to look at.
      const canvas = document.createElement('canvas');
      canvas.className = 'pp2-film';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', t('pp2.v'));
      see.after(canvas);
      try {
        const { previewFilm } = await import('./proFilm');
        track('pro_preview_post');
        note.textContent = t('pp2.seeNote');
        await previewFilm(canvas, { shape: 'vertical', reveal: { kind: 'order', id: revealNow() }, mark: true, name: '' });
      } catch {
        canvas.remove();
        note.textContent = t('pp2.seeFail');
      }
      see.disabled = false;
    });
  };
  sum.addEventListener('click', () => {
    const open = body.hidden;
    if (open) build();
    body.hidden = !open;
    sum.setAttribute('aria-expanded', String(open));
    if (open) body.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * The share dialog (a link to a published tifo) has no export of its own, so
 * Pro is not sold on it: one quiet row says the Pro versions exist and opens
 * the Post it sheet, where they are. Only when the server says so.
 */
export function mountShareRow(host: HTMLElement, close: () => void): void {
  const post = document.getElementById('post-tifo');
  if (!post) return;
  void fetchPro().then((st) => {
    if (!st.live || !st.offer?.post || !host.isConnected) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pp2-sum pp2-share';
    b.innerHTML = `${CROWN_SVG}<span>${escapeHtml(t('pp2.shareRow'))}</span><i class="ti ti-chevron-right" aria-hidden="true"></i>`;
    host.after(b);
    if (!st.plan || st.plan === 'free') offerSeen('share');
    b.addEventListener('click', () => {
      close();
      post.click();
    });
  }).catch(() => {});
}
