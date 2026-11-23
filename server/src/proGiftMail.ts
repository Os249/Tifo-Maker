/**
 * The automatic gift's three emails (proGift.ts sends them): Pro is on, Pro
 * ends in about a day, Pro has ended. Bilingual like the receipt (Arabic
 * first), in the same layout (emailLayout.ts).
 *
 * What each one is, and why it is written the way it is (docs/pro-turnaround.md,
 * "Legal reading"):
 *
 *   start, soon   notices about the account: what is on, until when, that no
 *                 card was taken and nothing is charged. No price and nothing
 *                 to buy in them, so they are not advertisements.
 *   end           a notice too, for everyone: it ended, and everything made
 *                 stays. Only when the fan ticked "email me Pro's news and
 *                 offers" (never ticked for them) does it also carry the
 *                 price and a button to /pro; that part is an advertisement,
 *                 so it says so and names the seller.
 *
 * All three carry the link, and the mail client's own unsubscribe button,
 * that stops every email of this kind for good.
 */
import type { EmailMessage } from './email';
import { button, layoutEmail, para, smallLink, smallPrint } from './emailLayout';
import { SELLER } from './proLaunchMail';
import type { GiftMailKind } from './proRepo';

/** "22 November 2026, 14:05" in Riyadh. */
function when(iso: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
const sar = (halalas: number): string => (halalas % 100 === 0 ? String(halalas / 100) : (halalas / 100).toFixed(2));

export interface GiftMailInput {
  kind: GiftMailKind;
  to: string;
  base: string;
  contact: string;
  /** How long the gift is, in days. */
  days: number;
  endsAt: string;
  /** The page that stops emails of this kind (/pro?nomail=...), and the address a mail client posts to. */
  stopUrl: string;
  stopPost: string;
  /**
   * The end email only, and only for a fan who asked for Pro's offers by
   * email: what Pro costs now (halalas), and the match pass when it is sold.
   * Null: the email carries no price and nothing to buy.
   */
  offer?: { monthly: number; monthlyDays: number; match: { price: number; hours: number } | null; year?: { price: number; days: number } | null; autoRenew: boolean } | null;
}

export function giftEmail(m: GiftMailInput): EmailMessage {
  const projectsAr = `${m.base}/ar/projects`;
  const projectsEn = `${m.base}/projects`;
  const untilAr = when(m.endsAt, 'ar');
  const untilEn = when(m.endsAt, 'en');
  const stopAr = smallLink('إذا ما تبي رسائل عن برو:', m.stopUrl, 'أوقف هالرسائل');
  const stopEn = smallLink("If you'd rather not get emails about Pro:", m.stopUrl, 'Stop these emails');
  const noCardAr = 'ما أخذنا منك بطاقة، وما ينخصم منك شي: الأيام تنتهي لحالها وترجع للباقة المجانية.';
  const noCardEn = 'No card was taken and nothing will be charged: the days end by themselves and you go back to the free plan.';

  let subject: string;
  let ar: string;
  let en: string;
  let text: string;

  if (m.kind === 'start') {
    subject = `برو شغّال على حسابك ${m.days} أيام · Pro is on for your account for ${m.days} days`;
    ar =
      para(`فعّلنا لك تيفو ميكر برو ${m.days} أيام مجانًا، وهو شغّال على حسابك لين ${untilAr} (بتوقيت الرياض).`) +
      para(noCardAr) +
      para('أول شي جرّبه: افتح تيفوك واضغط «تصدير»، واختر الفيديو الطولي 9:16. يطلع لك فيلم يوم المباراة لتيفوك جاهز لسناب وتيك توك وحالة الواتساب، وبدون علامة tifomaker.org.') +
      button(projectsAr, 'افتح مشاريعي') +
      stopAr;
    en =
      para(`TifoMaker Pro is on for your account for ${m.days} days, free, until ${untilEn} (Riyadh time).`) +
      para(noCardEn) +
      para('The first thing to try: open your tifo, press Export and pick the vertical 9:16 video. You get the match-day film of your tifo, ready for Snapchat, TikTok and WhatsApp Status, without the tifomaker.org mark.') +
      button(projectsEn, 'Open my projects') +
      stopEn;
    text =
      `برو شغّال على حسابك ${m.days} أيام مجانًا، لين ${untilAr} (بتوقيت الرياض). ${noCardAr}\n${projectsAr}\n\n` +
      `TifoMaker Pro is on for your account for ${m.days} days, free, until ${untilEn} (Riyadh time). ${noCardEn}\n` +
      `First thing to try: Export, then the vertical 9:16 video.\n${projectsEn}\n`;
  } else if (m.kind === 'soon') {
    subject = 'أيام برو تنتهي قريب · Your days of Pro end soon';
    ar =
      para(`أيام برو المجانية على حسابك تنتهي ${untilAr} (بتوقيت الرياض).`) +
      para('كل شي سويته يبقى لك: تصاميمك في مشاريعك، والفيديوهات والصور اللي حمّلتها عندك. وإذا في تيفو تبي تصدّره بدون العلامة أو بفيديو طولي، هذا وقته.') +
      para(noCardAr) +
      button(projectsAr, 'افتح مشاريعي') +
      stopAr;
    en =
      para(`The free days of Pro on your account end on ${untilEn} (Riyadh time).`) +
      para('Everything you made stays yours: your designs in your projects, and the videos and pictures you downloaded. If there is a tifo you want to export without the mark or as a vertical video, now is the time.') +
      para(noCardEn) +
      button(projectsEn, 'Open my projects') +
      stopEn;
    text =
      `أيام برو المجانية تنتهي ${untilAr} (بتوقيت الرياض). كل شي سويته يبقى لك. ${noCardAr}\n${projectsAr}\n\n` +
      `The free days of Pro on your account end on ${untilEn} (Riyadh time). Everything you made stays yours. ${noCardEn}\n${projectsEn}\n`;
  } else {
    subject = 'خلصت أيام برو · Your days of Pro have ended';
    const o = m.offer ?? null;
    const matchAr = o?.match ? ` أو باقة المباراة: ${o.match.hours} ساعة بـ${sar(o.match.price)} ريال، دفعة وحدة وما تتجدد.` : '';
    const matchEn = o?.match ? ` Or a match pass: ${o.match.hours} hours for SAR ${sar(o.match.price)}, one payment, never renewed.` : '';
    const yearAr = o?.year ? ` أو سنة: ${o.year.days} يوم بـ${sar(o.year.price)} ريال، دفعة وحدة وما تتجدد.` : '';
    const yearEn = o?.year ? ` Or a year: ${o.year.days} days for SAR ${sar(o.year.price)}, one payment, never renewed.` : '';
    const renewAr = o?.autoRenew ? 'وما يتجدد إلا إذا أنت اخترت «خلّ برو شغّال» وقت الدفع.' : 'دفعة وحدة، وما يتجدد لحاله.';
    const renewEn = o?.autoRenew ? 'It renews only if you choose "Keep Pro on" when you pay.' : 'One payment, and it does not renew by itself.';
    const offerAr = o
      ? para(`إعلان: إذا تبي برو يكمّل معك، ${o.monthlyDays} يوم بـ${sar(o.monthly)} ريال. ${renewAr}${matchAr}${yearAr}`) +
        button(`${m.base}/ar/pro`, 'شوف برو') +
        smallPrint(`البائع: ${SELLER.ar}، مستقل مسجّل في منصة العمل الحر (وثيقة رقم ${SELLER.document}). السعر هو المبلغ كامل، وما فيه ضريبة قيمة مضافة. وتقدر تسترد المبلغ كامل خلال 7 أيام من الدفع إذا ما استخدمت برو. للتواصل: ${m.contact}`)
      : '';
    const offerEn = o
      ? para(`Advertisement: to keep Pro, it is SAR ${sar(o.monthly)} for ${o.monthlyDays} days. ${renewEn}${matchEn}${yearEn}`) +
        button(`${m.base}/pro`, 'See Pro') +
        smallPrint(`Sold by ${SELLER.en}, a freelancer registered on Saudi Arabia's freelance platform (document ${SELLER.document}). The price is the full amount; no VAT is charged. Full refund within 7 days of paying if you haven't used Pro. Contact: ${m.contact}`)
      : '';
    ar =
      para(`خلصت أيام برو المجانية على حسابك، ورجعت للباقة المجانية. ما انخصم منك شي.`) +
      para('كل شي سويته باقي: تصاميمك في مشاريعك مثل ما هي، والفيديوهات والصور اللي حمّلتها عندك ولك.') +
      offerAr +
      (o ? '' : button(projectsAr, 'افتح مشاريعي')) +
      stopAr;
    en =
      para('The free days of Pro on your account have ended, and you are back on the free plan. Nothing was charged.') +
      para('Everything you made is still there: your designs in your projects, as they were, and the videos and pictures you downloaded are yours.') +
      offerEn +
      (o ? '' : button(projectsEn, 'Open my projects')) +
      stopEn;
    text =
      `خلصت أيام برو المجانية على حسابك. ما انخصم منك شي، وكل شي سويته باقي.\n${o ? `${m.base}/ar/pro` : projectsAr}\n\n` +
      `The free days of Pro on your account have ended. Nothing was charged, and everything you made is still there.\n` +
      (o ? `Advertisement: to keep Pro, it is SAR ${sar(o.monthly)} for ${o.monthlyDays} days. ${renewEn}${matchEn}\n${m.base}/pro\nSold by ${SELLER.en} (freelance document ${SELLER.document}). No VAT is charged. Contact: ${m.contact}\n` : `${projectsEn}\n`);
  }

  const why = {
    ar: 'وصلتك هذه الرسالة لأن حسابك في تيفو ميكر أخذ أيام برو المجانية.',
    en: 'You received this because your TifoMaker account was given free days of Pro.',
  };
  return {
    to: m.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: m.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }], why }),
    text:
      text +
      `\n--\n${why.ar}\n${why.en}\n` +
      `لإيقاف رسائل برو: ${m.stopUrl}\nTo stop emails about Pro: ${m.stopUrl}\n` +
      `TifoMaker · ${m.base.replace(/\/+$/, '')}`,
    // The mail client's own unsubscribe button: one click, no sign-in (RFC 8058).
    headers: { 'List-Unsubscribe': `<${m.stopPost}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
