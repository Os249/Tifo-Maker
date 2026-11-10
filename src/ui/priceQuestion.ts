/**
 * The price question's pieces shared by /pro (src/proPage.ts) and the card
 * the editor shows a signed-in fan once (src/ui/priceAsk.ts): the quick
 * amounts, reading what was typed, and saying an answer back.
 *
 * Quick amounts make answering one tap instead of a guess from nothing.
 * They pull answers toward themselves, so they span well below and above
 * the planned SAR 19 (about USD 5), and typing any other amount stays one
 * box away.
 */
import type { PriceAnswer, PriceCurrency } from '../net/api';
import { getLang, t, tv } from './i18n';

export const QUICK_PICKS: Record<PriceCurrency, number[]> = {
  SAR: [5, 10, 15, 20, 30],
  USD: [1, 2, 3, 5, 8],
};

/** Riyals for the Arabic page, dollars for the English one, until the fan picks. */
export const defaultCurrency = (): PriceCurrency => (getLang() === 'ar' ? 'SAR' : 'USD');

/** "SAR 15" / "15 ريال". */
export const priceText = (amount: number, currency: PriceCurrency): string =>
  tv(`ps.price.${currency}`, { n: Number.isInteger(amount) ? String(amount) : amount.toFixed(2) });

/** The thanks for an answer: the price said back, or "not for you". */
export const thanksText = (a: PriceAnswer): string =>
  a.wontPay ? t('ps.thanks.wont') : tv('ps.thanks', { price: priceText(a.amount, a.currency) });

/**
 * What was typed, as a number: Arabic-Indic digits and the Arabic decimal
 * mark count (a phone in Arabic types them), as do a comma and spaces.
 * Null unless it is 0 to 999 with at most two decimals.
 */
export function readAmount(raw: string): number | null {
  const s = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.')
    .replace(/[\s٬]/g, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 999 ? n : null;
}
