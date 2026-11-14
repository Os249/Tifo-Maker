/**
 * The receipt sent when an order is paid: what was bought, for how much, the
 * dates, Moyasar's reference, and how to ask for a refund. Bilingual like the
 * account emails (Arabic first), in the same layout (emailLayout.ts).
 *
 * The site is run by a freelancer, not a VAT-registered business, so this is
 * a receipt, not a tax invoice, and it says nothing about VAT.
 */
import type { EmailMessage } from './email';
import { layoutEmail, para, smallPrint, textFooter } from './emailLayout';
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
}

export function receiptEmail(r: ReceiptInput): EmailMessage {
  const { order } = r;
  const test = order.testMode;
  const paidAt = order.paidAt ?? order.createdAt;
  const ref = order.invoiceId ?? order.id;
  const subject = `${test ? '[TEST] ' : ''}إيصال تيفو ميكر برو · Your TifoMaker Pro receipt`;
  const account = `${r.base}/account#pro`;
  const ar =
    (test ? para('هذا إيصال تجريبي: ما انخصم أي مبلغ حقيقي.') : '') +
    para('شكرًا لك! وصلنا دفعك، وبرو مفعّل على حسابك.') +
    para(`المنتج: تيفو ميكر برو، ${order.days} يوم (دفعة وحدة، بدون تجديد تلقائي)`) +
    para(`المبلغ: ${sar(order.amount)} ريال`) +
    para(`تاريخ الدفع: ${when(paidAt, 'ar')} (بتوقيت الرياض)`) +
    (r.endsAt ? para(`برو شغّال لين: ${when(r.endsAt, 'ar')}`) : '') +
    para(`رقم المرجع: ${ref}`) +
    smallPrint(`تقدر تطلب استرداد كامل المبلغ خلال ${REFUND_DAYS} أيام من الدفع إذا ما استخدمت برو، بالرد على هذي الرسالة أو على ${r.contact}.`);
  const en =
    (test ? para('This is a test receipt: no real money was taken.') : '') +
    para('Thank you! Your payment arrived and Pro is on for your account.') +
    para(`Item: TifoMaker Pro, ${order.days} days (one payment, no auto-renewal)`) +
    para(`Amount: SAR ${sar(order.amount)}`) +
    para(`Paid: ${when(paidAt, 'en')} (Riyadh time)`) +
    (r.endsAt ? para(`Pro runs until: ${when(r.endsAt, 'en')}`) : '') +
    para(`Reference: ${ref}`) +
    smallPrint(`You can ask for a full refund within ${REFUND_DAYS} days of paying if you haven't used Pro: reply to this email or write to ${r.contact}.`);
  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: r.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }] }),
    text:
      (test ? 'TEST: no real money was taken.\n\n' : '') +
      `تيفو ميكر برو، ${order.days} يوم: ${sar(order.amount)} ريال\nالمرجع: ${ref}\n${account}\n\n` +
      `TifoMaker Pro, ${order.days} days: SAR ${sar(order.amount)}\nPaid: ${when(paidAt, 'en')} (Riyadh time)\n` +
      (r.endsAt ? `Pro runs until: ${when(r.endsAt, 'en')}\n` : '') +
      `Reference: ${ref}\nRefund within ${REFUND_DAYS} days if unused: ${r.contact}\n` +
      textFooter(r.base),
  };
}
