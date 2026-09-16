/**
 * The shape every account email goes out in.
 *
 * The verification email went to Gmail's spam folder with SPF, DKIM and DMARC
 * all passing and no tracking rewrites, so authentication was not the problem.
 * What was left were the signals a filter reads from the message itself. The
 * body was a bare fragment (no doctype, no <head>, no charset, no title),
 * with no footer saying who sent it or why, sent from an address nobody
 * could reply to. This fixes the parts of that the code owns.
 *
 * Deliberately plain: no images, no web fonts, no remote CSS, every link on
 * the site's own domain, and well under Gmail's 102 KB clipping limit. Table
 * layout and inline styles, because that is what mail clients render.
 */

export interface EmailBlock {
  lang: 'ar' | 'en';
  /** Trusted HTML built by the caller from the helpers below. */
  html: string;
}

export interface LayoutOptions {
  /** Shown in the tab of a web-mail client; normally the subject. */
  title: string;
  blocks: EmailBlock[];
  /** The site's own origin, for the footer link. */
  siteUrl: string;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial,sans-serif";
const INK = '#1b1d22';
const MUTED = '#5f6672';

export const para = (text: string): string =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK}">${escapeHtml(text)}</p>`;

/** A one-time code. Always left-to-right, even inside the Arabic block. */
export const codeBox = (code: string): string =>
  `<p dir="ltr" style="margin:6px 0 18px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${INK}">${escapeHtml(code)}</p>`;

/**
 * A button that is a real link, so it still works where styles are stripped.
 *
 * The green must be `background-color`, not the `background` shorthand.
 * SpamAssassin only reads the longhand. With the shorthand it saw the white label
 * as white text on a white page and scored HTML_FONT_LOW_CONTRAST (+0.7), the
 * rule meant for hidden text. The `bgcolor` attribute is for old clients.
 */
export const button = (href: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px"><tr>` +
  `<td bgcolor="#15924d" style="border-radius:8px;background-color:#15924d">` +
  `<a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>` +
  `</td></tr></table>`;

export const smallPrint = (text: string): string =>
  `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${MUTED}">${escapeHtml(text)}</p>`;

export function layoutEmail(opts: LayoutOptions): string {
  const site = opts.siteUrl.replace(/\/+$/, '');
  const host = site.replace(/^https?:\/\//, '');
  const block = (b: EmailBlock): string => {
    const dir = b.lang === 'ar' ? 'rtl' : 'ltr';
    const align = b.lang === 'ar' ? 'right' : 'left';
    return `<tr><td dir="${dir}" lang="${b.lang}" style="padding:20px 28px 6px;text-align:${align};font-family:${FONT}">${b.html}</td></tr>`;
  };
  const rule = `<tr><td style="padding:0 28px"><div style="border-top:1px solid #e6e8ec;font-size:0;line-height:0">&nbsp;</div></td></tr>`;
  return (
    `<!doctype html>` +
    `<html lang="ar">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<title>${escapeHtml(opts.title)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:#f3f4f6">` +
    // No hidden "preheader" text: invisible text is a common template trick and
    // exactly what spam filters look for.
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background-color:#f3f4f6">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:560px;background-color:#ffffff;border-radius:12px">` +
    `<tr><td dir="ltr" style="padding:22px 28px 0;font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:1px;color:${INK}">TIFO<span style="color:#15924d">MAKER</span></td></tr>` +
    opts.blocks.map(block).join(rule) +
    `</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">` +
    `<tr><td dir="rtl" lang="ar" style="padding:16px 28px 0;text-align:right;font-family:${FONT}">` +
    smallPrint('وصلتك هذه الرسالة لأن بريدك استُخدم في حساب على تيفو ميكر.') +
    `</td></tr>` +
    `<tr><td dir="ltr" lang="en" style="padding:4px 28px 0;text-align:left;font-family:${FONT}">` +
    smallPrint('You received this because your address was used for an account on TifoMaker.') +
    `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${MUTED}">TifoMaker · <a href="${escapeHtml(site)}" style="color:${MUTED}">${escapeHtml(host)}</a></p>` +
    `</td></tr>` +
    `</table>` +
    `</td></tr>` +
    `</table>` +
    `</body>` +
    `</html>`
  );
}

/** The plain-text part's matching footer. */
export const textFooter = (siteUrl: string): string =>
  `\n\n--\nوصلتك هذه الرسالة لأن بريدك استُخدم في حساب على تيفو ميكر.\n` +
  `You received this because your address was used for an account on TifoMaker.\n` +
  `TifoMaker · ${siteUrl.replace(/\/+$/, '')}`;
