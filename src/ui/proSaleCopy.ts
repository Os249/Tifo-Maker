/**
 * /pro's words when Pro is on sale: which string takes the place of each
 * coming-soon string in pro.html. One list for the two places that swap them:
 * the server, which sends the page already saying so once Pro is on sale to
 * everyone (server/src/routes.ts, so nobody arriving from a link sees "coming
 * soon" first), and the page itself (src/proPage.ts setSaleCopy), for an
 * account that can buy before that and for a change of language.
 *
 * No DOM and no imports: the server reads this file too.
 */

/** Each coming-soon key in pro.html with its on-sale key. */
export const SALE_KEYS: readonly (readonly [soon: string, sale: string])[] = [
  ['ps.eyebrow', 'pb.eyebrow'], ['ps.title', 'pb.title'], ['ps.lead', 'pb.lead'],
  ['ps.step1.t', 'pb.step1.t'], ['ps.step1.b', 'pb.step1.b'],
  ['ps.step2.t', 'pb.step2.t'], ['ps.step2.b', 'pb.step2.b'],
  ['ps.step3.t', 'pb.step3.t'], ['ps.step3.b', 'pb.step3.b'],
  ['pp.faq.a5', 'pb.faq.a5'], ['pp.faq.a2', 'pp.faq.a2'],
];

/** The words that differ when Moyasar's form is the checkout (payments v2). */
const FORM_COPY: Record<string, string> = { 'pb.step1.t': 'pf.step1.t', 'pb.step1.b': 'pf.step1.b', 'pb.faq.a5': 'pf.faq.a5' };
/** The words that differ when "Keep Pro on" is offered. */
const RENEW_COPY: Record<string, string> = { 'pb.step3.t': 'pr.step3.t', 'pb.step3.b': 'pr.step3.b', 'pp.faq.a2': 'pr.faq.a2', 'pb.lead': 'pr.lead' };

/** The key an on-sale string is shown under, given how Pro is being sold. */
export function saleKey(sale: string, how: { form: boolean; renew: boolean }): string {
  return (how.renew && RENEW_COPY[sale]) || (how.form && FORM_COPY[sale]) || sale;
}

/** Every key one of pro.html's swapped elements can carry: its coming-soon key and each on-sale variant. */
export function keysOf(soon: string, sale: string): string[] {
  return [...new Set([soon, sale, FORM_COPY[sale], RENEW_COPY[sale]].filter((k): k is string => !!k))];
}
