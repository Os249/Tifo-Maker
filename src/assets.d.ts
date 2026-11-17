/** Vite turns asset imports into URLs; declare the ones we import directly. */
declare module '*.woff2' {
  const url: string;
  export default url;
}

/** Moyasar's payment form (payments v2): its package ships types its own "exports" map hides. Only init() is used (src/proPage.ts). */
declare module 'moyasar-payment-form' {
  const Moyasar: { init(config: Record<string, unknown>): void };
  export default Moyasar;
}
