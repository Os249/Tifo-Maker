/**
 * Escaping text for HTML. One implementation, because there were ten.
 *
 * Five of them were this; the other five were the `textContent` trick:
 *
 *     const d = document.createElement('div');
 *     d.textContent = s;
 *     return d.innerHTML;
 *
 * which escapes `&`, `<` and `>` and **not quotes** — the serialiser has no
 * reason to escape a quote in text, because in text a quote is not special.
 * Interpolate that result into an attribute and a `"` in the input closes the
 * attribute early. Nothing was exploitable when the audit found it, because
 * every call site happened to pass a literal or a translated constant. That is
 * a property of today's call sites, not of the function, and it is one careless
 * interpolation away from stopping being true.
 *
 * So the escape covers quotes, and it lives in one file, so the next copy
 * someone reaches for is an import.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Safe for element text AND for a quoted attribute value. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
