/**
 * The founders email (proLaunch.ts): the one message a founder gets when Pro
 * goes on sale. Bilingual like the receipt (Arabic first), in the same layout.
 *
 * Both places a fan became a founder told them they would hear first when Pro
 * opens, so this keeps a promise. It is still news rather than something owed
 * with a purchase, so it is treated as an advertisement is: it says who sends
 * it and why they are getting it, it is sent once, and it carries a link (and
 * the List-Unsubscribe header) that stops emails of this kind for good.
 *
 * It says only what the site does today. With the founders offer on
 * (always, unless PRO_FOUNDERS_BONUS=off) it states the offer, its exact deadline in Riyadh time
 * and its terms; without it, it is the news that Pro is open and its price.
 * No crossed-out price and no word "discount" in either version: the launch
 * price is stated as a price with the date it changes.
 */
import type { EmailMessage } from './email';
import { button, layoutEmail, para, smallLink, smallPrint } from './emailLayout';
import { REFUND_DAYS } from './payments';
import { OFFER } from './proPlan';

/** "22 November 2026, 14:05" in Riyadh. */
function when(iso: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
/** "15 January 2027" in Riyadh. */
function day(iso: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(iso));
}
const sar = (halalas: number): string => (halalas % 100 === 0 ? String(halalas / 100) : (halalas / 100).toFixed(2));

/** The seller, as /legal names him. */
export const SELLER = { en: 'Osamh Alsharekh', ar: 'أسامة الشارخ', document: 'FL-216888773' };

export interface FounderMailInput {
  to: string;
  base: string;
  contact: string;
  /** Halalas a month costs now, and the regular price. */
  price: number;
  regular: number;
  /** When the launch price ends, while it runs. */
  launchUntil: string | null;
  /** The founders offer: buy by `deadline` for `bonusDays` more days. Null: no offer is made. */
  offer: { deadline: string; bonusDays: number } | null;
  /** "Keep Pro on" is offered at checkout: the email then says renewal is a choice, and what it costs. */
  autoRenew: boolean;
  /** Opens the page that stops emails of this kind (/pro?nomail=...), and the address a mail client posts to. */
  stopUrl: string;
  stopPost: string;
}

export function founderEmail(m: FounderMailInput): EmailMessage {
  const days = OFFER.monthly.days;
  const price = sar(m.price);
  const regular = sar(m.regular);
  const total = days + (m.offer?.bonusDays ?? 0);
  const subject = m.offer
    ? 'برو انفتح، وأنت من المؤسسين · Pro is open, and you are a founder'
    : 'تيفو ميكر برو انفتح · TifoMaker Pro is open';
  const proAr = `${m.base}/ar/pro`;
  const proEn = `${m.base}/pro`;

  const priceAr = m.launchUntil
    ? `السعر: ${price} ريال لمدة ${days} يوم. هذا سعر الإطلاق، ومن يوم ${day(m.launchUntil, 'ar')} يصير السعر ${regular} ريال.`
    : `السعر: ${price} ريال لمدة ${days} يوم.`;
  const priceEn = m.launchUntil
    ? `The price: SAR ${price} for ${days} days. That is the launch price; from ${day(m.launchUntil, 'en')} the price will be SAR ${regular}.`
    : `The price: SAR ${price} for ${days} days.`;
  const renewAr = m.autoRenew
    ? `دفعة وحدة، وما يتجدد إلا إذا أنت اخترت «خلّ برو شغّال» وقت الدفع، والتجديد وقتها بـ${regular} ريال كل ${days} يوم لين توقفه.`
    : 'دفعة وحدة، وما يتجدد لحاله: ما ينخصم منك شي مرة ثانية.';
  const renewEn = m.autoRenew
    ? `One payment. It renews only if you choose "Keep Pro on" when you pay; renewals are then SAR ${regular} every ${days} days until you turn it off.`
    : 'One payment, and it does not renew by itself: nothing is charged again.';
  const whatAr = 'برو يضيف على المجاني: تصدير بدون علامة tifomaker.org، وفيلم يوم المباراة بدقة Full HD وفيديو طولي 9:16، وبوستر 4K، وخطوط وستايلات صور من برو، وهوية ناديك، وتصاميم ومراجعات أكثر بالذكاء الاصطناعي. وكل شي مجاني يبقى مجاني.';
  const whatEn = 'Pro adds to what is free: exports without the tifomaker.org mark, the match-day film in Full HD and a vertical 9:16 video, a 4K poster, Pro fonts and portrait styles, your club kit, and more AI designs and reviews. Everything free stays free.';

  const offerAr = m.offer
    ? para(`عرض المؤسسين: اشترِ برو قبل ${when(m.offer.deadline, 'ar')} (بتوقيت الرياض) وتاخذ شهر زيادة مجانًا، يعني ${total} يوم بسعر ${days}.`)
    : '';
  const offerEn = m.offer
    ? para(`The founders offer: buy Pro before ${when(m.offer.deadline, 'en')} (Riyadh time) and you get an extra month free: ${total} days for the price of ${days}.`)
    : '';
  const termsAr = m.offer
    ? smallPrint(`شروط العرض: لحسابك أنت بس، ومرة وحدة، على أول شراء لك إذا تم الدفع قبل الموعد فوق. إذا استرديت مبلغ هالطلب تروح أيام الهدية معه. وتقدر تسترد المبلغ كامل خلال ${REFUND_DAYS} أيام من الدفع إذا ما استخدمت برو.`)
    : smallPrint(`تقدر تسترد المبلغ كامل خلال ${REFUND_DAYS} أيام من الدفع إذا ما استخدمت برو.`);
  const termsEn = m.offer
    ? smallPrint(`The offer's terms: for your account only, once, on your first purchase when it is paid before the time above. If that order is refunded, the free days go with it. You can have a full refund within ${REFUND_DAYS} days of paying if you haven't used Pro.`)
    : smallPrint(`You can have a full refund within ${REFUND_DAYS} days of paying if you haven't used Pro.`);
  const sellerAr = smallPrint(`البائع: ${SELLER.ar}، مستقل مسجّل في منصة العمل الحر (وثيقة رقم ${SELLER.document}). السعر هو المبلغ كامل، وما فيه ضريبة قيمة مضافة. للتواصل: ${m.contact}`);
  const sellerEn = smallPrint(`Sold by ${SELLER.en}, a freelancer registered on Saudi Arabia's freelance platform (document ${SELLER.document}). The price is the full amount; no VAT is charged. Contact: ${m.contact}`);

  const ar =
    para('تيفو ميكر برو صار متاح للشراء.') +
    para('وأنت من مؤسسيه: طلبت نعلّمك أول ما يفتح، أو قلت لنا كم يسوى شهر برو عندك، ومن أجوبتكم حددنا السعر. شكرًا لك.') +
    offerAr +
    para(priceAr) +
    para(renewAr) +
    para(whatAr) +
    button(proAr, 'شوف برو') +
    termsAr + sellerAr +
    smallLink('هذي رسالة إعلانية نرسلها مرة وحدة. إذا ما تبي رسائل مثلها:', m.stopUrl, 'أوقف هالرسائل');
  const en =
    para('TifoMaker Pro is now on sale.') +
    para("You're one of its founders: you asked to hear first when it opened, or told us what a month of Pro is worth to you, and we set the price from those answers. Thank you.") +
    offerEn +
    para(priceEn) +
    para(renewEn) +
    para(whatEn) +
    button(proEn, 'See Pro') +
    termsEn + sellerEn +
    smallLink("This is an advertisement, sent once. If you'd rather not get emails like it:", m.stopUrl, 'Stop these emails');

  const why = {
    ar: 'وصلتك هذه الرسالة لأنك طلبت من حسابك في تيفو ميكر تعرف أول ما يفتح برو.',
    en: 'You received this because, from your TifoMaker account, you asked to hear when Pro opens.',
  };
  return {
    to: m.to,
    subject,
    html: layoutEmail({ title: subject, siteUrl: m.base, blocks: [{ lang: 'ar', html: ar }, { lang: 'en', html: en }], why }),
    text:
      `تيفو ميكر برو صار متاح للشراء، وأنت من مؤسسيه.\n` +
      (m.offer ? `عرض المؤسسين: اشترِ قبل ${when(m.offer.deadline, 'ar')} (بتوقيت الرياض) وتاخذ ${total} يوم بسعر ${days}. مرة وحدة لحسابك، على أول شراء.\n` : '') +
      `${priceAr}\n${renewAr}\n${proAr}\n\n` +
      `TifoMaker Pro is now on sale, and you're one of its founders.\n` +
      (m.offer ? `The founders offer: buy before ${when(m.offer.deadline, 'en')} (Riyadh time) and get ${total} days for the price of ${days}. Once, for your account, on your first purchase; a refund of that order ends the free days too.\n` : '') +
      `${priceEn}\n${renewEn}\n${whatEn}\n${proEn}\n` +
      `Full refund within ${REFUND_DAYS} days of paying if you haven't used Pro.\n` +
      `Sold by ${SELLER.en} (freelance document ${SELLER.document}). No VAT is charged. Contact: ${m.contact}\n\n` +
      `--\n${why.ar}\n${why.en}\n` +
      `هذي رسالة إعلانية نرسلها مرة وحدة. لإيقاف رسائل مثلها: ${m.stopUrl}\n` +
      `This is an advertisement, sent once. To stop emails like it: ${m.stopUrl}\n` +
      `TifoMaker · ${m.base.replace(/\/+$/, '')}`,
    // The mail client's own unsubscribe button: one click, no sign-in (RFC 8058).
    headers: { 'List-Unsubscribe': `<${m.stopPost}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
