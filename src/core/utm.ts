/**
 * Tagged links.
 *
 * Every link the site hands out to be shared carries utm_source (the platform)
 * and utm_medium=share. The server's visit log files those under "Shared by
 * visitors" (server/src/trafficRepo.ts), which is the only way a link passed
 * round WhatsApp, Telegram or Discord is ever seen: those apps send no
 * referrer, so before this every one of them was counted as "Direct".
 *
 * Pure apart from cleanAddressBar(), which touches `history`.
 */

export type ShareSource =
  | 'x' | 'whatsapp' | 'telegram' | 'facebook' | 'reddit' | 'email'
  | 'instagram' | 'tiktok' | 'discord' | 'snapchat'
  | 'copy' | 'webshare' | 'qr' | 'link';

/**
 * The same URL with the share tags set. `campaign` says which kind of thing was
 * shared ("tifo" for a design's page, "post" for a picture posted from the
 * editor), so the two can be told apart later.
 */
export function tagShareUrl(url: string, source: ShareSource, campaign = 'tifo'): string {
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : 'https://tifomaker.org');
    u.searchParams.set('utm_source', source);
    u.searchParams.set('utm_medium', 'share');
    u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return url;
  }
}

const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

/**
 * Take the tags out of the address bar once the page has loaded.
 *
 * The server counted the visit when it sent the page, so the tags have done
 * their job. Left in, they travel: someone who arrived from one of your X
 * posts and copies the address to send a friend passes your tag on, and that
 * friend is counted as another visit from X.
 */
export function cleanAddressBar(): void {
  try {
    const u = new URL(location.href);
    let changed = false;
    for (const k of UTM) {
      if (u.searchParams.has(k)) {
        u.searchParams.delete(k);
        changed = true;
      }
    }
    if (changed) history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch {
    /* never break a page over this */
  }
}
