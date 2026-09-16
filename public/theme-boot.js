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
