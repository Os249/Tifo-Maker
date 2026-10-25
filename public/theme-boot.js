/*
 * Pick the colour theme before the page paints, so a dark-mode visitor never
 * sees a white flash. An external file on purpose: this used to be an inline
 * <script>, and the Content-Security-Policy (script-src 'self', no
 * 'unsafe-inline') blocked it on every page load, so the flash happened anyway.
 */
(function () {
  try {
    var t = localStorage.getItem('tifo_theme_v1');
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: the stylesheet's own default applies */ }
})();

/*
 * And the language (performance plan P3.3). Built pages come in two
 * languages at two addresses (/community, and /ar/community with the Arabic
 * already in its HTML) and say which they are on <html data-lang-page>. An
 * Arabic page is Arabic and right to left already: nothing to do. Any other
 * page takes the language chosen with the toggle (tifo_lang_v1), else the
 * browser's FIRST language (initLang() in src/ui/i18n.ts), and its script
 * translates it in place. Nothing here ever navigates: a page is always
 * served, and painted, at the address that was asked for.
 */
(function () {
  try {
    if (document.documentElement.getAttribute('data-lang-page') === 'ar') return;
    var l = localStorage.getItem('tifo_lang_v1');
    if (l !== 'en' && l !== 'ar') {
      var first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
      l = /^ar\b/i.test(first) ? 'ar' : 'en';
    }
    document.documentElement.setAttribute('lang', l);
    document.documentElement.setAttribute('dir', l === 'ar' ? 'rtl' : 'ltr');
  } catch (e) { /* the page's own initLang() settles it */ }
})();

/*
 * And whether the page's own script will run, so CSS can hide what only a
 * visitor without it needs before the first paint (performance plan P1.10):
 * /community ships a plain list of links for crawlers and no-JS visitors, and
 * painting it and then swapping it for the real grid moved the whole page.
 * Only where ES modules run, because every page script is one: a browser that
 * runs this file but not the module keeps the plain list instead of a feed
 * that never arrives. Set here rather than inline for the same CSP reason.
 */
(function () {
  try {
    if ('noModule' in HTMLScriptElement.prototype) document.documentElement.classList.add('js');
  } catch (e) { /* no class: the server-rendered content stays visible */ }
})();
