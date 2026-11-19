/**
 * The emails a refund owes (19 Nov 2026), bilingual like the receipt (Arabic
 * first), in the same layout:
 *
 *   refunded   an order was refunded, from /admin or from Moyasar's
 *              dashboard: which order, how much, when, that its month of Pro
 *              has ended, how the money comes back, and who to ask. Sent once
 *              per refund (payments.ts afterRefund).
 *   received   a fan asked for a refund from the account page: it arrived,
 *              and a person answers within 3 working days
 *   declined   the answer was no, with the reason
 *   owner      to the owner: a request is waiting in /admin (English only)
 *
 * A fan who loses Pro with no word thinks something broke, or asks their bank
 * for the money: these are also the record that they were told.
 *
 * On timing: Moyasar's documentation says a refund returns the funds to the
 * cardholder and gives no number of days (read 19 Nov 2026), so the email
 * says what is true: sent back at once from here, and the bank decides when
 * it shows, usually within a few working days.
 */
import type { EmailMessage } from './email';
import { button, layoutEmail, para, smallPrint, textFooter } from './emailLayout';
import type { ProOrder, RefundRequest } from './payRepo';
import { dayOf, sarOf } from './payReceipt';
import { REFUND_DAYS } from './payments';

/** Working days in which the owner answers a request (the terms' promise for every question). */
export const ANSWER_DAYS = 3;

const refOf = (o: ProOrder): string => o.invoiceId ?? o.paymentId ?? o.id;
/** Where a fan sees and manages what they bought. */
export const purchasesUrl = (base: string): string => `${base}/account#pro`;

export interface RefundMailInput {
  order: ProOrder;
  to: string;
  base: string;
  contact: string;
}

export function refundEmail(r: RefundMailInput): EmailMessage {
  const { order: o } = r;
  const test = o.testMode;
  const ref = refOf(o);
  const amount = sarOf(o.refunded || o.amount);
  const at = o.refundedAt ?? o.paidAt ?? o.createdAt;
  const part = o.refunded > 0 && o.refunded < o.amount;
  const subject = `${test ? '[TEST] ' : ''}رجّعنا لك مبلغ برو · Your TifoMaker Pro refund`;
  const link = purchasesUrl(r.base);
  const ar =
    (test ? para('هذا استرداد تجريبي: ما تحرّك أي مبلغ حقيقي.') : '') +
    para(`رجّعنا لك مبلغ طلبك في تيفو ميكر برو${part ? ' (جزء من المبلغ)' : ''}.`) +
    para(`الطلب: تيفو ميكر برو، ${o.days} يوم`) +
    para(`المبلغ المسترد: ${amount} ريال`) +
    para(`تاريخ الاسترداد: ${dayOf(at, 'ar')}`) +
    para(`رقم المرجع: ${ref}`) +
    para('شهر برو اللي دفعته بهالطلب انتهى على حسابك. وإذا كان التجديد التلقائي شغّال، وقفناه وما راح ينخصم منك شي.') +
    para('المبلغ يرجع على نفس البطاقة أو المحفظة اللي دفعت فيها. أرسلناه من عندنا الحين، وغالبًا يظهر في حسابك خلال كم يوم عمل، والمدة بالضبط على بنكك.') +
    button(link, 'مشترياتك') +
    smallPrint(`عندك سؤال، أو ما وصلك المبلغ؟ رد على هذي الرسالة أو راسلنا على ${r.contact}.`);
  const en =
    (test ? para('This is a test refund: no real money moved.') : '') +
    para(`We've refunded your TifoMaker Pro order${part ? ' (part of the amount)' : ''}.`) +
    para(`Order: TifoMaker Pro, ${o.days} days`) +
    para(`Amount refunded: SAR ${amount}`) +
    para(`Refunded on: ${dayOf(at, 'en')}`) +
    para(`Reference: ${ref}`) +
    para(`The month of Pro this order paid for has ended on your account${o.bonusDays > 0 ? `, and its ${o.bonusDays} free founder days with it` : ''}. If auto-renew was on, it's now off and nothing more will be charged.`) +
    para("The money goes back to the same card or wallet you paid with. We've sent it from our side now; it usually shows within a few working days, and the exact time depends on your bank.") +
    button(link, 'Your purchases') +
    smallPrint(`A question, or the money hasn't arrived? Reply to this email or write to ${r.contact}.`);
  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: r.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }] }),
    text:
      (test ? 'TEST: no real money moved.\n\n' : '') +
      `رجّعنا لك ${amount} ريال (تيفو ميكر برو، المرجع ${ref}). شهر برو حق هالطلب انتهى. المبلغ يرجع على نفس طريقة الدفع، وغالبًا خلال كم يوم عمل حسب بنكك.\n${link}\n\n` +
      `We've refunded SAR ${amount} for TifoMaker Pro (reference ${ref}) on ${dayOf(at, 'en')}. The month of Pro it paid for has ended.\n` +
      `The money goes back the way you paid, usually within a few working days depending on your bank.\nYour purchases: ${link}\nQuestions: ${r.contact}\n` +
      textFooter(r.base),
  };
}

export interface RequestMailInput extends RefundMailInput {
  request: RefundRequest;
}

/** To the fan: the request arrived. */
export function refundReceivedEmail(r: RequestMailInput): EmailMessage {
  const { order: o } = r;
  const test = o.testMode ? '[TEST] ' : '';
  const amount = sarOf(o.amount);
  const subject = `${test}وصلنا طلب الاسترداد · We got your refund request`;
  const link = purchasesUrl(r.base);
  const ar =
    para(`وصلنا طلبك لاسترداد ${amount} ريال (تيفو ميكر برو، دفعة يوم ${dayOf(o.paidAt ?? o.createdAt, 'ar')}).`) +
    para(`أراجع كل طلب بنفسي، وبرد عليك بإيميل خلال ${ANSWER_DAYS} أيام عمل: إذا تمت الموافقة يرجع المبلغ على نفس طريقة الدفع وينتهي شهر برو، وإذا لا أوضح لك السبب.`) +
    para('ولين وقتها برو يبقى شغّال على حسابك، وما تحتاج تسوي شي.') +
    button(link, 'مشترياتك') +
    smallPrint(`إذا مو أنت اللي طلبت، أو عندك سؤال: ${r.contact}`);
  const en =
    para(`We got your request to refund SAR ${amount} (TifoMaker Pro, paid on ${dayOf(o.paidAt ?? o.createdAt, 'en')}).`) +
    para(`I look at every request myself and will answer by email within ${ANSWER_DAYS} working days: if it's approved, the money goes back the way you paid and that month of Pro ends; if not, I'll tell you why.`) +
    para("Until then Pro stays on for your account, and there's nothing you need to do.") +
    button(link, 'Your purchases') +
    smallPrint(`If this wasn't you, or you have a question: ${r.contact}`);
  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: r.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }] }),
    text:
      (o.testMode ? 'TEST: no real money is involved.\n\n' : '') +
      `وصلنا طلبك لاسترداد ${amount} ريال. بنرد عليك خلال ${ANSWER_DAYS} أيام عمل.\n\n` +
      `We got your request to refund SAR ${amount} for TifoMaker Pro. You'll have an answer by email within ${ANSWER_DAYS} working days. Pro stays on until then.\n${link}\n` +
      textFooter(r.base),
  };
}

/** To the fan: the request was declined, and why. */
export function refundDeclinedEmail(r: RequestMailInput): EmailMessage {
  const { order: o } = r;
  const test = o.testMode ? '[TEST] ' : '';
  const amount = sarOf(o.amount);
  const why = r.request.declineReason ?? '';
  const subject = `${test}بخصوص طلب الاسترداد · About your refund request`;
  const ar =
    para(`راجعت طلبك لاسترداد ${amount} ريال (تيفو ميكر برو، دفعة يوم ${dayOf(o.paidAt ?? o.createdAt, 'ar')})، وما قدرت أوافق عليه.`) +
    para(`السبب: ${why}`) +
    para('برو يبقى شغّال على حسابك لين تخلص الأيام المدفوعة، وما انخصم منك شي جديد.') +
    smallPrint(`الشروط تقول: استرداد كامل خلال ${REFUND_DAYS} أيام من الدفع إذا ما استُخدم برو. إذا تشوف إن القرار غلط، رد على هذي الرسالة أو راسلني على ${r.contact} وأراجعه مرة ثانية.`);
  const en =
    para(`I've looked at your request to refund SAR ${amount} (TifoMaker Pro, paid on ${dayOf(o.paidAt ?? o.createdAt, 'en')}), and I couldn't approve it.`) +
    para(`The reason: ${why}`) +
    para("Pro stays on for your account until the days you've paid for end, and nothing new was charged.") +
    smallPrint(`The terms give a full refund within ${REFUND_DAYS} days of paying if Pro hasn't been used. If you think this is wrong, reply to this email or write to ${r.contact} and I'll look again.`);
  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: r.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }] }),
    text:
      (o.testMode ? 'TEST: no real money is involved.\n\n' : '') +
      `ما تمت الموافقة على طلب استرداد ${amount} ريال. السبب: ${why}\n\n` +
      `Your request to refund SAR ${amount} for TifoMaker Pro wasn't approved. The reason: ${why}\nPro stays on until the days you've paid for end.\nIf you think this is wrong: ${r.contact}\n` +
      textFooter(r.base),
  };
}

/** To the owner: a request is waiting. English only; it is his own inbox. */
export function refundOwnerEmail(r: { order: ProOrder; request: RefundRequest; username: string | null; to: string; base: string }): EmailMessage {
  const { order: o, request: rq } = r;
  const test = o.testMode ? '[TEST] ' : '';
  const who = r.username ? `@${r.username}` : 'an account';
  const subject = `${test}Refund request from ${who}: SAR ${sarOf(o.amount)}`;
  const used = rq.used > 0 ? `Pro used: ${rq.used} use${rq.used === 1 ? '' : 's'} counted on this pass` : 'Pro not used (nothing counted against this pass: AI designs, Polishes, cut-outs, stadium photos, reviews, chat; exports, fonts, styles and kits are not counted)';
  const lines = [
    `${who} asked for a refund of SAR ${sarOf(o.amount)}.`,
    `Paid: ${dayOf(o.paidAt ?? o.createdAt, 'en')} (the ${REFUND_DAYS}-day promise runs from then). Reference: ${refOf(o)}`,
    used,
    rq.note ? `They wrote: ${rq.note}` : 'They wrote nothing with it.',
    `Approve or decline it in /admin, Pro, Refund requests. The fan was told to expect an answer within ${ANSWER_DAYS} working days.`,
  ];
  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: r.base, blocks: [{ lang: 'en', html: lines.map(para).join('') + button(`${r.base}/admin`, 'Open /admin') }] }),
    text: lines.join('\n') + `\n${r.base}/admin\n` + textFooter(r.base),
  };
}
