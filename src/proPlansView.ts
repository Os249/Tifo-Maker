/**
 * /pro as one price list (22 Nov 2026, server: PRO_THREE_PLANS): the match
 * pass, the month and the year in one joined card, "every plan includes"
 * under them, the three promises beside the buttons, then what Pro makes and
 * one table of Free against Pro.
 *
 * This file only draws. Who may buy what, the sign-in, Moyasar's form and the
 * return from it stay in proPage.ts, which finds this file's buttons by the
 * same names it always used (#pb-buy, [data-act="buy"], #pb-form, #pb-msg).
 * Every number here is /api/pro's: a plan is listed only when the server
 * sends it, so the page is two plans or three as the switches say.
 *
 * Loaded only when the server says the page is this one, with its styles and
 * its words (docs/pro-three-plans.md).
 */
import './proPlans.css';
import { escapeHtml } from './core/escape';
import { getLang, localPath, t, tv } from './ui/i18n';
import { CROWN_SVG, money, whenDay } from './ui/pro';
import type { AllowanceKind, PlanLimits, ProOffer, ProProduct, ProState } from './net/api';

export interface PlanRow {
  product: ProProduct;
  price: number;
  days: number;
  /** The match pass says its length in hours, as it always has. */
  hours?: number;
  /** The year: a twelfth of its price, for the comparison under the whole price. */
  perMonth?: number;
}

/** The plans on sale, shortest first. The month is always there; the others only while the server sells them. */
export function plansOf(o: ProOffer): PlanRow[] {
  return [
    ...(o.match ? [{ product: 'match' as const, price: o.match.price, days: o.match.days, hours: o.match.hours }] : []),
    { product: 'monthly' as const, price: o.monthly.price, days: o.monthly.days },
    ...(o.year ? [{ product: 'year' as const, price: o.year.price, days: o.year.days, perMonth: o.year.perMonth }] : []),
  ];
}

/** "72 hours", "30 days". */
export function lengthText(p: PlanRow): string {
  return p.hours ? tv('pt.len.hours', { n: p.hours }) : tv('pt.len.days', { n: p.days });
}

/** "Month · 30 days · SAR 9.99": a plan in one line, for the form's heading. */
export function planLine(p: PlanRow): string {
  return `${t(`pt.name.${p.product}`)} · ${lengthText(p)} · ${tv('pb.price', { price: money(p.price) })}`;
}

const CHECK = '<svg class="pt-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>';
const ICON = {
  refund: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12a8 8 0 1 0 2.600-5.900"/><path d="M4 4.500v4.500h4.500"/></svg>',
  card: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3l7 3v5c0 4.500-3 8.200-7 10-4-1.800-7-5.500-7-10V6z"/><path d="M9 12l2.200 2.200L15.200 10"/></svg>',
  once: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.500"/><path d="M8.500 12h7"/></svg>',
};

export interface ListState {
  signedIn: boolean;
  /** Signed in with an email not verified yet: the server would refuse, so the page says it first. */
  unverified: boolean;
  /** When the Pro this account holds ends, or null. */
  heldUntil: string | null;
  /** Whether this account may buy this plan now (proPage.ts mirrors the server's rule). */
  canBuy: (p: ProProduct) => boolean;
  /** The plan a link asked for (/pro?plan=...), shown marked. */
  asked: ProProduct | null;
  /** What "Get Pro" last said. */
  msg: string;
  /** "Keep Pro on" is offered with the month. */
  renew: boolean;
  /** Moyasar's form is the checkout. */
  form: boolean;
  /** Adding to a month in its last week: the month's button says so. */
  adding: boolean;
}

/** What every plan includes: Pro's own rows, with the day's AI designs from the server's limits. */
function includes(o: ProOffer): string[] {
  const unlisted = o.unlisted ?? [];
  const std = unlisted.includes('std') ? null : o.limits?.pro.std?.find((w) => w.period === 'day') ?? null;
  const freeStd = o.limits?.free.std?.find((w) => w.period === 'day') ?? null;
  return [
    t('pp.row.video'), t('pp.row.poster'), t('pp.row.mark'),
    // Only when Pro really gives more of them than Free.
    ...(std && (!freeStd || std.limit > freeStd.limit) ? [tv('pt.incl.ai', { n: std.limit })] : []),
    t('pp.row.styles'), t('pp.row.fonts'), t('pp.row.kit'), t('pp.row.led'), t('pp.row.badge'),
  ];
}

/** The price list, with the promises and the links under it. */
export function listHtml(st: ProState, s: ListState): string {
  const o = st.offer!;
  const plans = plansOf(o);
  // One blue button: the month's when it can be bought, else the first plan that can.
  const order: ProProduct[] = ['monthly', 'year', 'match'];
  const blue = order.find((p) => plans.some((x) => x.product === p) && (!s.signedIn || s.canBuy(p))) ?? 'monthly';
  const col = (p: PlanRow): string => {
    const price = money(p.price);
    const label = tv(p.product === 'monthly' && s.adding ? 'pb.renew' : `pt.buy.${p.product}`, { price });
    const cls = `pp-btn${p.product === blue ? '' : ' quiet'}`;
    const btn = !s.signedIn
      ? `<button type="button" class="${cls}" data-act="buy-signin" data-product="${p.product}">${escapeHtml(label)}</button>`
      : s.unverified || !s.canBuy(p.product)
        ? ''
        : `<button type="button" class="${cls}" data-act="buy" data-product="${p.product}">${escapeHtml(label)}</button>`;
    const note = p.product === 'year' ? tv('pt.note.year', { price: money(p.perMonth ?? p.price / 12) }) : t(`pt.note.${p.product}`);
    return (
      `<article class="pt-col${p.product === 'monthly' ? ' pick' : ''}" data-plan="${p.product}"${s.asked === p.product ? ' data-asked="1"' : ''} aria-labelledby="pt-nm-${p.product}">` +
      `<h3 class="pt-nm" id="pt-nm-${p.product}">${escapeHtml(t(`pt.name.${p.product}`))}` +
      (p.product === 'monthly' ? ` <span class="pt-tag">${CROWN_SVG}<span>${escapeHtml(t('pt.pick'))}</span></span>` : '') + `</h3>` +
      `<p class="pt-len">${escapeHtml(lengthText(p))}</p>` +
      // The whole price first; a day of it is only the comparison.
      `<p class="pt-pr">${escapeHtml(tv('pb.price', { price }))}</p>` +
      `<p class="pt-pd"><span>${escapeHtml(tv('pt.perDay', { price: (p.price / p.days).toFixed(2) }))}</span></p>` +
      `<p class="pt-note">${escapeHtml(note)}</p>` +
      btn +
      `</article>`
    );
  };
  // Holding Pro, or an email to verify: said once, above the plans.
  let state = '';
  if (s.signedIn && s.unverified) {
    state = `<div class="pt-state"><p id="pb-verify">${escapeHtml(t('pb.verify.note'))}</p>` +
      `<a class="pp-btn" data-act="verify" href="${escapeHtml(localPath('/account'))}">${escapeHtml(t('pb.verify.btn'))}</a></div>`;
  } else if (s.signedIn && s.heldUntil) {
    const year = plans.some((p) => p.product === 'year') && s.canBuy('year') && !s.canBuy('monthly');
    const waits = !plans.some((p) => s.canBuy(p.product));
    state = `<div class="pt-state"><p>${CROWN_SVG}<span>${escapeHtml(tv('pt.held', { date: whenDay(s.heldUntil) }))} ` +
      `${escapeHtml(year ? t('pt.held.year') : waits ? t('pt.held.later') : t('pb.renewNote'))}</span></p></div>`;
  } else if (!s.signedIn) {
    state = `<p class="pt-signin" id="pb-signin-note">${escapeHtml(t('pb.signin.note'))}</p>`;
  }
  const ar = getLang() === 'ar';
  return (
    `<div class="pt-list" id="pb-buy">` +
    `<div class="pt-head"><h2 id="pt-list-h">${escapeHtml(t('pt.list.h'))}</h2><p>${escapeHtml(t(s.renew ? 'pr.once' : 'pb.once'))} ${escapeHtml(t('pb.vat'))}</p></div>` +
    state +
    `<div class="pt-cols" data-n="${plans.length}">${plans.map(col).join('')}</div>` +
    // Moyasar's form opens here (proPage.ts openForm), under the plans, with what is being paid for said above it.
    `<div class="pb-form" id="pb-form" hidden></div>` +
    `<p class="pb-msg" id="pb-msg" role="status" aria-live="polite">${escapeHtml(s.msg)}</p>` +
    `<div class="pt-foot"><p class="pt-incl-h">${CROWN_SVG}<span>${escapeHtml(t('pt.incl.h'))}</span></p>` +
    `<ul class="pt-ticks">${includes(o).map((x) => `<li>${CHECK}<span>${escapeHtml(x)}</span></li>`).join('')}</ul></div>` +
    `</div>` +
    `<ul class="pt-trust" aria-label="${escapeHtml(t('pt.trust.label'))}">` +
    `<li>${ICON.refund}<span><b>${escapeHtml(t('pb.trust.refund'))}</b></span></li>` +
    `<li>${ICON.card}<span><b>${escapeHtml(t('pt.trust.card.b'))}</b> ${escapeHtml(t(s.form ? 'pt.trust.card' : 'pb.methods'))}</span></li>` +
    `<li>${ICON.once}<span><b>${escapeHtml(t('pt.trust.once.b'))}</b> ${escapeHtml(t(s.renew ? 'pr.once' : 'pt.trust.once'))}</span></li>` +
    `</ul>` +
    `<ul class="pb-links pt-links" aria-label="${escapeHtml(t('pb.trust.links'))}">` +
    `<li><a href="${escapeHtml(localPath('/legal'))}#${ar ? 'terms-ar' : 'terms'}">${escapeHtml(t('pb.trust.terms'))}</a></li>` +
    `<li><a href="${escapeHtml(localPath('/legal'))}#${ar ? 'about-ar' : 'about'}">${escapeHtml(t('pb.trust.contact'))}</a></li>` +
    `</ul>`
  );
}

// ------------------------------------------------ under the list: the rest ---

const FILM = { free: '/pro/free-video.webp', pro: '/pro/film.webp' } as const;
/** Which side of the film's switch is showing; kept across a repaint (a language switch). */
let filmSide: keyof typeof FILM = 'pro';

function showHtml(): string {
  const row = (pic: string, tall: boolean, title: string, body: string): string =>
    `<div class="pt-row"><div class="pt-pic${tall ? ' tall' : ''}">${pic}</div><div class="pt-words"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div></div>`;
  const img = (src: string, w: number, h: number, alt: string, id = ''): string =>
    `<img${id ? ` id="${id}"` : ''} src="${src}" width="${w}" height="${h}" loading="lazy" decoding="async" alt="${escapeHtml(alt)}">`;
  const side = (k: keyof typeof FILM, key: string): string =>
    `<button type="button" data-film="${k}" aria-pressed="${filmSide === k}">${escapeHtml(t(key))}</button>`;
  return (
    `<h2 id="pt-show-h">${escapeHtml(t('pp.show.title'))}</h2><p class="pp-show-lead">${escapeHtml(t('pp.show.lead'))}</p>` +
    `<div class="pt-rows">` +
    row(`<div class="pt-phone">${img('/pro/reel-cut.webp', 480, 853, t('pp.show.reel2.alt'))}</div>`, true, t('pt.show.video.t'), t('pt.show.video.d')) +
    row(img('/pro/poster.webp', 960, 540, t('pp.show.poster.alt')), false, t('pp.show.poster.t'), t('pp.show.poster.d')) +
    row(
      img(FILM[filmSide], 800, 450, t(filmSide === 'pro' ? 'pp.show.film.alt' : 'pp.show.free.alt'), 'pt-film') +
      `<div class="pt-seg" role="group" aria-label="${escapeHtml(t('pt.show.switch'))}">${side('free', 'pt.show.free')}${side('pro', 'pt.show.pro')}</div>`,
      false, t('pt.show.film.t'), t('pt.show.film.d'),
    ) +
    `</div>`
  );
}

/** "3 a day": an allowance's first window, as the table says it. */
function limitText(l: PlanLimits[AllowanceKind] | undefined): string {
  const w = l?.[0];
  return w ? tv(`pp.per.${w.period}`, { n: w.limit }) : t('pp.notIncluded');
}

function cmpHtml(o: ProOffer): string {
  const yes = `<span class="pt-yes">${CHECK}<span class="pt-sr">${escapeHtml(t('pp.included'))}</span></span>`;
  const no = `<span class="pt-no" aria-hidden="true">—</span><span class="pt-sr">${escapeHtml(t('pp.notIncluded'))}</span>`;
  const unlisted = o.unlisted ?? [];
  // An allowance is a row only where Pro gives more of it than Free (proPage.ts rowsFor has the same rule).
  const kinds = (['std', 'critique'] as AllowanceKind[]).filter((k) =>
    !unlisted.includes(k) && JSON.stringify(o.limits?.pro[k] ?? null) !== JSON.stringify(o.limits?.free[k] ?? null));
  const rows: [string, string, string][] = [
    [t('pp.row.free'), yes, yes],
    [t('pt.cmp.video'), escapeHtml(t('pt.cmp.video.free')), escapeHtml(t('pt.cmp.video.pro'))],
    [t('pp.row.poster'), no, yes],
    ...kinds.map((k): [string, string, string] => [t(`pp.row.${k}`), escapeHtml(limitText(o.limits?.free[k])), escapeHtml(limitText(o.limits?.pro[k]))]),
    ...(['pp.row.styles', 'pp.row.fonts', 'pp.row.kit', 'pp.row.led', 'pp.row.badge'] as const).map((k): [string, string, string] => [t(k), no, yes]),
  ];
  return (
    `<h2 id="pt-cmp-h">${escapeHtml(t('pt.cmp.h'))}</h2>` +
    `<div class="pt-table"><table><thead><tr><th scope="col"><span class="pt-sr">${escapeHtml(t('pt.cmp.what'))}</span></th>` +
    `<th scope="col">${escapeHtml(t('pp.free.name'))}</th><th scope="col" class="pro">${CROWN_SVG}<span>${escapeHtml(t('pp.pro.name'))}</span></th></tr></thead><tbody>` +
    rows.map((r) => `<tr><th scope="row">${escapeHtml(r[0])}</th><td>${r[1]}</td><td class="pro">${r[2]}</td></tr>`).join('') +
    `</tbody></table></div>`
  );
}

/** A section of this page's own, made once and put before the questions. */
function section(id: string, labelledBy: string, cls: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('section');
    el.id = id;
    el.className = cls;
    el.setAttribute('aria-labelledby', labelledBy);
    const faq = document.querySelector('#pp-open .pp-faq');
    faq?.parentElement?.insertBefore(el, faq);
  }
  return el;
}

/** What Pro makes, the one table, and the question about the plans: painted again on every repaint, for the language. */
export function paintRest(st: ProState): void {
  const o = st.offer;
  if (!o) return;
  const show = section('pt-show', 'pt-show-h', 'pt-show');
  show.innerHTML = showHtml();
  show.querySelectorAll<HTMLButtonElement>('[data-film]').forEach((b) =>
    b.addEventListener('click', () => {
      filmSide = b.dataset.film === 'free' ? 'free' : 'pro';
      const img = document.getElementById('pt-film') as HTMLImageElement | null;
      if (img) {
        img.src = FILM[filmSide];
        img.alt = t(filmSide === 'pro' ? 'pp.show.film.alt' : 'pp.show.free.alt');
      }
      show.querySelectorAll('[data-film]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
  section('pt-cmp', 'pt-cmp-h', 'pt-cmp').innerHTML = cmpHtml(o);
  // The first question a page with more than one plan gets.
  const faq = document.querySelector('#pp-open .pp-faq');
  let q = document.getElementById('pt-faq-plans');
  if (!q && faq) {
    q = document.createElement('details');
    q.id = 'pt-faq-plans';
    faq.querySelector('h2')?.insertAdjacentElement('afterend', q);
  }
  if (q) q.innerHTML = `<summary>${escapeHtml(t('pt.faq.q0'))}</summary><p>${escapeHtml(t('pt.faq.a0'))}</p>`;
}
