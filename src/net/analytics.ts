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
  | 'project_created'  // named a project and picked its stadium (or had the AI do it)
  | 'paint_first'
  | 'view_3d'
  | 'view_banner'      // opened the Banner view
  | 'draft_restored'   // came back and their work was still here
  | 'save_clicked'
  | 'save_local'       // kept without an account
  | 'account_prompt'   // the "keep it anywhere" offer was shown, after a save
  | 'auth_opened'      // they opened the sign-up form
  | 'signed_up'
  | 'draft_claimed'    // their local draft was attached to the new account
  | 'published'
  | 'exported'
  | 'post_opened'      // opened "Post it" (the picture of their tifo, ready to post)
  | 'shared'           // sent a tifo or its picture to a platform (any share button)
  | 'guide_started'    // the guided first tifo opened (ui/guide.ts)
  | 'guide_done'       // ...and was followed to its last step, Post it
  | 'guide_free'       // ...or left for the whole editor ("Free mode")
  | 'ai_cta'           // pressed "Generate with AI" outside the editor (Projects page)
  | 'ai_bar'           // asked the AI from the prompt bar on the canvas
  | 'template_cta'     // pressed "Use as template" on the home page's showcase
  | 'pro_viewed'       // opened the Pro page
  | 'event_view'       // opened a tifo event's page
  | 'event_enter'      // entered a tifo in an event
  | 'event_vote'       // voted for an entry in an event
  | 'pro_limit'        // met a Pro limit card
  | 'pro_notify'       // asked to be told when Pro opens
  | 'pro_ask_seen'     // the editor's founding-fans card asked them (priceAsk.ts)
  | 'pro_price'        // said what a month of Pro is worth (/pro or the editor's card)
  | 'pro_checkout'     // pressed Get Pro and was sent to Moyasar's page (payments v1)
  | 'pro_paid'         // came back from Moyasar with Pro on
  | 'gift_accepted'    // accepted the 7-day Pro gift
  | 'cutout_used'      // a smart cut-out came back
  | 'export_sheet'     // the export sheet listed Pro items
  | 'export_free'      // ...and they exported without them
  // The Pro funnel (22 Nov 2026): a Pro offer was seen, and Get Pro pressed, by where (ui/proWhere.ts).
  | `pro_offer_${ProPlace}`
  | `pro_get_${ProPlace}`
  | 'pro_preview_post'   // saw their own tifo as the Pro version, on Post it
  | 'monthly_bought'     // came back from paying for 30 days of Pro
  | 'match_bought'       // came back from paying for a match pass
  | 'year_bought'        // came back from paying for a year
  // The three plans (PRO_THREE_PLANS): the plan list was shown at a place, and which plan was pressed there.
  | `pro_plans_${ProPlace}`
  | `pro_pick_${'monthly' | 'match' | 'year'}_${ProPlace}`
  | 'gift_auto'          // the 7-day gift started by itself for them
  | 'gift_welcome'       // ...and they saw the welcome
  | 'gift_end_seen'      // saw the card that says the gift ended
  | 'bought_after_gift'  // paid for Pro after their gift
  | 'signup_offer_post'  // the account offer was shown on Post it or share
  | 'signup_post';       // ...and they made an account from it

/** Where a Pro offer can be seen (server/src/proRoutes.ts OFFER_PLACES keeps the same list). */
export type ProPlace = 'post' | 'share' | 'export' | 'page' | 'giftend' | 'limit' | 'account';

const SESSION_KEY = 'tifo_session_v1';
const fired = new Set<FunnelEvent>();

/**
 * Non-essential analytics run only after explicit "Accept all" consent. We read
 * the consent banner's localStorage key directly (no import) to avoid coupling;
 * until the user accepts all, nothing is sent.
 */
export function analyticsAllowed(): boolean {
  try {
    return localStorage.getItem('tifo_consent_v1') === 'all';
  } catch {
    return false;
  }
}

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
  if (!analyticsAllowed()) return;
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
