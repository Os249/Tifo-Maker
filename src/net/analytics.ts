/**
 * Anonymous funnel analytics — fire-and-forget, privacy-respecting.
 *
 * No cookies, no fingerprinting, no PII. A random per-session token (kept in
 * sessionStorage, so it resets when the tab/session ends) lets the server
 * measure conversion THROUGH the funnel without identifying anyone. Each step
 * fires at most once per session. All sends are best-effort and never block or
 * surface errors — analytics must never degrade the product.
 */

export type FunnelEvent =
  | 'landed'
  | 'paint_first'
  | 'view_3d'
  | 'save_clicked'
  | 'signed_up'
  | 'published'
  | 'exported';

const SESSION_KEY = 'tifo_session_v1';
const fired = new Set<FunnelEvent>();

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `s${Date.now()}${Math.random().toString(36).slice(2)}`).slice(0, 64);
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage blocked → ephemeral per-call id (still anonymous).
    return `s${Date.now()}${Math.random().toString(36).slice(2)}`;
  }
}

let signedIn = false;
/** Let the app mark the session as signed-in so events carry the coarse flag. */
export function setAnalyticsSignedIn(value: boolean): void {
  signedIn = value;
}

/**
 * Record a funnel step. De-duplicated per session for funnel steps (each stage
 * is "did this session reach it", not "how many times"). Uses sendBeacon when
 * available so it survives navigation/unload; falls back to fetch keepalive.
 */
export function track(event: FunnelEvent, opts: { once?: boolean } = {}): void {
  const once = opts.once ?? true;
  if (once && fired.has(event)) return;
  fired.add(event);
  const payload = JSON.stringify({ session: sessionId(), name: event, signedIn });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }));
      return;
    }
  } catch {
    /* fall through to fetch */
  }
  // Fallback; keepalive lets it complete during unload.
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}
