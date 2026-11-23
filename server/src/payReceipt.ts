/**
 * The receipt sent when an order is paid: what was bought, for how much, the
 * dates, Moyasar's reference, and how to ask for a refund. Bilingual like the
 * account emails (Arabic first), in the same layout (emailLayout.ts).
 *
 * The site is run by a freelancer, not a VAT-registered business, so this is
 * a receipt, not a tax invoice, and it says nothing about VAT.
 */
import type { EmailMessage } from './email';
import { button, layoutEmail, para, smallPrint, textFooter } from './emailLayout';
import type { ProOrder } from './payRepo';
import { REFUND_DAYS } from './payments';

/** Riyadh time, as a fan reads it: "12 Nov 2026, 23:40" or "١٢ نوفمبر ٢٠٢٦، ٢٣:٤٠". */
function when(iso: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

const sar = (halalas: number): string => {
  const n = halalas / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

export interface ReceiptInput {
  order: ProOrder;
  to: string;
  /** When the pass ends (null if none was given: the account was deleted first). */
  endsAt: string | null;
  base: string;
  /** Where refunds are asked for. */
  contact: string;
  /**
   * Auto-renew is on for this account (payments v2): when the next renewal is
   * due, and the one-click link that turns it off. Absent or null: the
   * receipt says, as before, that nothing renews.
   */
  renew?: { nextAt: string; cancelUrl: string; /** Halalas each renewal charges (the regular price). Absent: the order's own amount. */ amount?: number } | null;
}

/** The date alone, in Riyadh: "12 December 2026". */
export function dayOf(iso: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(iso));
}

export const sarOf = (halalas: number): string => sar(halalas);

export function receiptEmail(r: ReceiptInput): EmailMessage {
  const { order } = r;
  const test = order.testMode;
  const paidAt = order.paidAt ?? order.createdAt;
  const ref = order.invoiceId ?? order.paymentId ?? order.id;
  const subject = `${test ? '[TEST] ' : ''}إيصال تيفو ميكر برو · Your TifoMaker Pro receipt`;
  const account = `${r.base}/account#pro`;
  const renewal = order.kind === 'renewal';
  const refunded = order.status === 'refunded';
  const rn = refunded ? null : r.renew ?? null;
  // The founders bonus (proLaunch.ts): extra days on this order's pass, at no charge.
  const bonus = order.bonusDays > 0 ? order.bonusDays : 0;
  const bonusAr = bonus ? ` + ${bonus} يوم هدية المؤسسين (المجموع ${order.days + bonus} يوم)` : '';
  const bonusEn = bonus ? ` + ${bonus} founder days free (${order.days + bonus} days in all)` : '';
  // The match pass (22 Nov 2026): the same Pro for a few days, said in hours as the page said it. It never renews.
  const match = order.product === 'match';
  // The year (22 Nov 2026): 365 days of the same Pro, one payment. It never renews either.
  const year = order.product === 'year';
  const itemAr = year
    ? `المنتج: تيفو ميكر برو، سنة: ${order.days} يوم (دفعة وحدة، وما تتجدد)`
    : match
    ? `المنتج: تيفو ميكر برو، باقة المباراة ${order.days * 24} ساعة (دفعة وحدة، وما تتجدد)`
    : rn
      ? `المنتج: تيفو ميكر برو، ${order.days} يوم${bonusAr}${renewal ? ' (تجديد تلقائي)' : ''}`
      : `المنتج: تيفو ميكر برو، ${order.days} يوم${bonusAr} (دفعة وحدة، بدون تجديد تلقائي)`;
  const itemEn = year
    ? `Item: TifoMaker Pro, a year: ${order.days} days (one payment, never renewed)`
    : match
    ? `Item: TifoMaker Pro match pass, ${order.days * 24} hours (one payment, never renewed)`
    : rn
      ? `Item: TifoMaker Pro, ${order.days} days${bonusEn}${renewal ? ' (automatic renewal)' : ''}`
      : `Item: TifoMaker Pro, ${order.days} days${bonusEn} (one payment, no auto-renewal)`;
  // What each renewal charges: the regular price the fan agreed to, which is not always what this order cost.
  const next = sar(rn?.amount ?? order.amount);
  const renewAr = rn
    ? para(`التجديد التلقائي شغّال: بينخصم ${next} ريال يوم ${dayOf(rn.nextAt, 'ar')}، وبعدها كل ${order.days} يوم لين توقفه. بنذكّرك بإيميل قبل كل تجديد بـ3 أيام، وتقدر توقفه بأي وقت بضغطة وحدة، وبرو يبقى معك لين تخلص الأيام المدفوعة.`) +
      button(rn.cancelUrl, 'إيقاف التجديد التلقائي')
    : '';
  const renewEn = rn
    ? para(`Auto-renew is on: SAR ${next} will be charged on ${dayOf(rn.nextAt, 'en')}, and then every ${order.days} days until you turn it off. We'll email you 3 days before each renewal. You can turn it off any time with one click, and Pro stays on until the days you've paid for end.`) +
      button(rn.cancelUrl, 'Turn off auto-renew')
    : '';
  const ar =
    (test ? para('هذا إيصال تجريبي: ما انخصم أي مبلغ حقيقي.') : '') +
    para(renewal ? 'تجدّد برو على حسابك. شكرًا لك!' : 'شكرًا لك! وصلنا دفعك، وبرو مفعّل على حسابك.') +
    para(itemAr) +
    para(`المبلغ: ${sar(order.amount)} ريال (هذا المبلغ كامل، وما فيه ضريبة قيمة مضافة)`) +
    para(`تاريخ الدفع: ${when(paidAt, 'ar')} (بتوقيت الرياض)`) +
    (r.endsAt ? para(`برو شغّال لين: ${when(r.endsAt, 'ar')}`) : '') +
    para(`رقم المرجع: ${ref}`) +
    (refunded ? para(`هذا الطلب تم استرداده يوم ${dayOf(order.refundedAt ?? paidAt, 'ar')}، وبرو حقه انتهى.`) : renewAr) +
    (refunded ? '' : smallPrint(`تقدر تطلب استرداد كامل المبلغ خلال ${REFUND_DAYS} أيام من الدفع إذا ما استخدمت برو: من صفحة حسابك، تحت «برو ومشترياتك»، اضغط «اطلب استرداد» (${account})، أو رد على هذي الرسالة أو راسلنا على ${r.contact}.`));
  const en =
    (test ? para('This is a test receipt: no real money was taken.') : '') +
    para(renewal ? 'Pro has renewed on your account. Thank you!' : 'Thank you! Your payment arrived and Pro is on for your account.') +
    para(itemEn) +
    para(`Amount: SAR ${sar(order.amount)} (the full amount; no VAT is charged)`) +
    para(`Paid: ${when(paidAt, 'en')} (Riyadh time)`) +
    (r.endsAt ? para(`Pro runs until: ${when(r.endsAt, 'en')}`) : '') +
    para(`Reference: ${ref}`) +
    (refunded ? para(`This order was refunded on ${dayOf(order.refundedAt ?? paidAt, 'en')}, and its Pro has ended.`) : renewEn) +
    (refunded ? '' : smallPrint(`You can ask for a full refund within ${REFUND_DAYS} days of paying if you haven't used Pro: on your account page, under "Pro and purchases", press "Request a refund" (${account}), or reply to this email or write to ${r.contact}.`));
  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: r.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }] }),
    text:
      (test ? 'TEST: no real money was taken.\n\n' : '') +
      // The month's lines are as they always were; a match pass is named as one, in hours.
      `${year ? `تيفو ميكر برو، سنة: ${order.days} يوم` : match ? `تيفو ميكر برو، باقة المباراة ${order.days * 24} ساعة` : `تيفو ميكر برو، ${order.days} يوم`}: ${sar(order.amount)} ريال\nالمرجع: ${ref}\n${account}\n\n` +
      `${year ? `TifoMaker Pro, a year: ${order.days} days (one payment, never renewed)` : match ? `TifoMaker Pro match pass, ${order.days * 24} hours (one payment, never renewed)` : `TifoMaker Pro, ${order.days} days${bonusEn}`}: SAR ${sar(order.amount)}\nPaid: ${when(paidAt, 'en')} (Riyadh time)\n` +
      (r.endsAt ? `Pro runs until: ${when(r.endsAt, 'en')}\n` : '') +
      `Reference: ${ref}\n` +
      (refunded ? `Refunded on ${dayOf(order.refundedAt ?? paidAt, 'en')}.\n` : `Refund within ${REFUND_DAYS} days if unused: ask on your account page (${account}) or write to ${r.contact}\n`) +
      (rn ? `Auto-renew is on: SAR ${next} on ${dayOf(rn.nextAt, 'en')}, then every ${order.days} days. Turn it off: ${rn.cancelUrl}\n` : '') +
      textFooter(r.base),
  };
}
