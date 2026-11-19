/**
 * The emails auto-renew owes a fan (payments v2, 16 Nov 2026), bilingual like
 * the receipt (Arabic first), in the same layout:
 *
 *   reminder   3 days before every renewal: the amount, the date, the card,
 *              and a one-click link that turns renewal off
 *   failed     a renewal did not go through: nothing was charged, when it
 *              will be tried again, how to add another card or stop
 *   ended      auto-renew stopped by itself (the tries ran out, the card
 *              expired, or the reminders could not be delivered)
 *   cancelled  the confirmation that it is off, and until when Pro stays on
 *
 * Every one says what was or will be charged in plain numbers, and none asks
 * the fan to sign in to stop a charge: the cancel link works by itself. They
 * are also the record, if a charge is ever disputed, that it was announced.
 */
import type { EmailMessage } from './email';
import { button, layoutEmail, para, smallPrint, textFooter } from './emailLayout';
import type { ProSubscription } from './payRepo';
import { dayOf, sarOf } from './payReceipt';
import { REMIND_DAYS, type RenewNotice } from './payments';

/** "Visa ending 1111", or just "your card" when Moyasar did not say. */
function cardText(s: ProSubscription, lang: 'en' | 'ar'): string {
  const wallet = s.method === 'applepay' ? 'Apple Pay' : s.method === 'samsungpay' ? 'Samsung Pay' : '';
  const brand = s.brand ? s.brand.charAt(0).toUpperCase() + s.brand.slice(1) : '';
  const name = [wallet, brand].filter(Boolean).join(' · ');
  if (lang === 'ar') return s.lastFour ? `${name || 'البطاقة'} المنتهية بـ${s.lastFour}` : name || 'بطاقتك';
  return s.lastFour ? `${name || 'the card'} ending ${s.lastFour}` : name || 'your card';
}

export interface RenewMailInput {
  notice: RenewNotice;
  to: string;
  base: string;
  contact: string;
}

/** The one-click link: opens /pro, which turns renewal off and says so. */
export const cancelUrlOf = (base: string, sub: ProSubscription): string =>
  `${base}${sub.lang === 'ar' ? '/ar/pro' : '/pro'}?stop=${encodeURIComponent(sub.cancelToken)}`;

export function renewEmail(r: RenewMailInput): EmailMessage {
  const { notice: n, base } = r;
  const s = n.sub;
  const test = s.testMode ? '[TEST] ' : '';
  const price = sarOf(s.amount);
  const cancel = cancelUrlOf(base, s);
  const proPage = `${base}/pro`;
  const until = (lang: 'en' | 'ar'): string =>
    n.kind !== 'reminder' && n.endsAt
      ? lang === 'ar' ? `برو يبقى شغّال معك لين ${dayOf(n.endsAt, 'ar')}.` : `Pro stays on until ${dayOf(n.endsAt, 'en')}.`
      : '';
  let subject: string;
  let ar: string;
  let en: string;
  let text: string;

  if (n.kind === 'reminder') {
    subject = `${test}تذكير: برو يتجدد بعد ${REMIND_DAYS} أيام · Pro renews in ${REMIND_DAYS} days`;
    // A founder's first month ran longer (proLaunch.ts): this first renewal comes after all of it, and says so.
    const firstAr = n.firstDays ? para(`أول ${n.firstDays} يوم لك (شهرك المدفوع وشهر هدية المؤسسين) تخلص هذاك اليوم، وهذا أول تجديد لك.`) : '';
    const firstEn = n.firstDays ? para(`Your first ${n.firstDays} days (the month you paid for and your free founder month) end that day, and this is your first renewal.`) : '';
    ar =
      para(`تذكير: اشتراكك في تيفو ميكر برو بيتجدد تلقائيًا يوم ${dayOf(n.chargeAt, 'ar')}.`) +
      firstAr +
      para(`المبلغ: ${price} ريال، لمدة ${s.days} يوم، من ${cardText(s, 'ar')}.`) +
      para('إذا تبي تكمّل، ما عليك شي. وإذا ما تبي التجديد، أوقفه الحين بضغطة وحدة، وبرو يبقى معك لين تخلص الأيام المدفوعة:') +
      button(cancel, 'إيقاف التجديد التلقائي') +
      smallPrint(`بعد كل تجديد يوصلك إيصال، وتقدر تسترد المبلغ كامل خلال 7 أيام إذا ما استخدمت برو. وكل هذا تديره من صفحة حسابك: ${base}/account#pro`);
    en =
      para(`A reminder: your TifoMaker Pro renews automatically on ${dayOf(n.chargeAt, 'en')}.`) +
      firstEn +
      para(`Amount: SAR ${price}, for ${s.days} days, from ${cardText(s, 'en')}.`) +
      para("To carry on, there's nothing to do. If you'd rather not renew, turn it off now with one click; Pro stays on until the days you've paid for end:") +
      button(cancel, 'Turn off auto-renew') +
      smallPrint(`You get a receipt after every renewal, and a full refund within 7 days if you haven't used Pro. You can manage all of it on your account page: ${base}/account#pro`);
    text =
      `برو يتجدد يوم ${dayOf(n.chargeAt, 'ar')}: ${price} ريال. للإيقاف: ${cancel}\n\n` +
      `TifoMaker Pro renews on ${dayOf(n.chargeAt, 'en')}: SAR ${price} for ${s.days} days, from ${cardText(s, 'en')}.\nTurn off auto-renew (one click): ${cancel}\n`;
  } else if (n.kind === 'failed') {
    subject = `${test}ما قدرنا نجدد برو · We couldn't renew Pro`;
    ar =
      para(`حاولنا نجدد تيفو ميكر برو (${price} ريال) من ${cardText(s, 'ar')} وما تمت العملية. ما انخصم منك شي.`) +
      para(`بنحاول مرة ثانية يوم ${dayOf(n.retryAt, 'ar')}، وكم مرة بعدها خلال أيام. إذا ما نجحت، يتوقف التجديد لحاله وما ينخصم شي.`) +
      (until('ar') ? para(until('ar')) : '') +
      para('تبي تدفع ببطاقة ثانية؟ اشترِ شهر من صفحة برو وفعّل «خلّ المميّزة شغّالة» من جديد. وإذا ما تبي التجديد، أوقفه من هنا:') +
      button(cancel, 'إيقاف التجديد التلقائي');
    en =
      para(`We tried to renew TifoMaker Pro (SAR ${price}) from ${cardText(s, 'en')} and it didn't go through. Nothing was charged.`) +
      para(`We'll try again on ${dayOf(n.retryAt, 'en')}, and a few more times over the following days. If it still doesn't work, auto-renew stops by itself and nothing is charged.`) +
      (until('en') ? para(until('en')) : '') +
      para('Want to use another card? Buy a month on the Pro page and tick "Keep Pro on" again. To stop renewing instead:') +
      button(cancel, 'Turn off auto-renew');
    text =
      `ما تم تجديد برو، وما انخصم شي. المحاولة الجاية: ${dayOf(n.retryAt, 'ar')}. للإيقاف: ${cancel}\n\n` +
      `We couldn't renew TifoMaker Pro (SAR ${price}); nothing was charged. Next try: ${dayOf(n.retryAt, 'en')}.\nAnother card: ${proPage}\nTurn off auto-renew: ${cancel}\n`;
  } else if (n.kind === 'ended') {
    const expired = n.why === 'card_expired';
    subject = expired
      ? `${test}بطاقتك انتهت: حدّثها عشان يكمل برو · Your card expired: update it to keep Pro`
      : `${test}توقف التجديد التلقائي لبرو · Pro auto-renew has stopped`;
    ar =
      para(
        expired ? `${cardText(s, 'ar')} انتهت صلاحيتها، فوقفنا التجديد التلقائي لتيفو ميكر برو. ما انخصم منك شي.`
        : n.why === 'unreachable' ? 'ما قدرنا نوصّل لك تذكير التجديد على الإيميل، فوقفنا التجديد التلقائي لتيفو ميكر برو. ما انخصم منك شي.'
        : 'حاولنا نجدد تيفو ميكر برو كم مرة وما تمت العملية، فوقفنا التجديد التلقائي. ما انخصم منك شي.',
      ) +
      (until('ar') ? para(until('ar')) : '') +
      para(expired ? 'عشان تحدّث بطاقتك: اشترِ شهر من صفحة برو ببطاقتك الجديدة وفعّل «خلّ المميّزة شغّالة».' : 'تقدر ترجع لبرو بأي وقت من صفحته.') +
      button(proPage, expired ? 'تحديث البطاقة' : 'صفحة برو');
    en =
      para(
        expired ? `${cardText(s, 'en').replace(/^t/, 'T').replace(/^y/, 'Y')} has expired, so we've turned off auto-renew for TifoMaker Pro. Nothing was charged.`
        : n.why === 'unreachable' ? "We couldn't deliver the renewal reminder to your email, so we've turned off auto-renew for TifoMaker Pro. Nothing was charged."
        : "We tried to renew TifoMaker Pro a few times and it didn't go through, so auto-renew has stopped. Nothing was charged.",
      ) +
      (until('en') ? para(until('en')) : '') +
      para(expired ? 'To update your card: buy a month on the Pro page with the new card and tick "Keep Pro on".' : 'You can come back to Pro any time from its page.') +
      button(proPage, expired ? 'Update my card' : 'The Pro page');
    text =
      `توقف التجديد التلقائي لبرو، وما انخصم شي. ${until('ar')}\n${proPage}\n\n` +
      `Auto-renew for TifoMaker Pro has stopped${expired ? ' because the card expired' : ''}. Nothing was charged. ${until('en')}\n${proPage}\n`;
  } else {
    subject = `${test}أوقفنا التجديد التلقائي لبرو · Pro auto-renew is off`;
    ar =
      para('أوقفنا التجديد التلقائي لتيفو ميكر برو، وما راح ينخصم منك شي بعد اليوم. وحذفنا بيانات البطاقة المحفوظة عند ميسّر.') +
      (until('ar') ? para(until('ar')) : '') +
      smallPrint(`إذا مو أنت اللي أوقفته، أو عندك سؤال: ${r.contact}`);
    en =
      para("Auto-renew for TifoMaker Pro is off, and nothing more will be charged. The saved card has been deleted at Moyasar.") +
      (until('en') ? para(until('en')) : '') +
      smallPrint(`If this wasn't you, or you have a question: ${r.contact}`);
    text =
      `أوقفنا التجديد التلقائي لبرو. ${until('ar')}\n\n` +
      `Auto-renew for TifoMaker Pro is off; nothing more will be charged. ${until('en')}\n`;
  }

  return {
    to: r.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }] }),
    text: (s.testMode ? 'TEST: no real money is involved.\n\n' : '') + text + textFooter(base),
  };
}
