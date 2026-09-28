/**
 * Why an AI call failed — two answers for two audiences.
 *
 * The provider hands back text like
 *   gemini "gemini-3.5-flash": HTTP 503: { "error": { "code": 503, "message": "This model is currently experiencing high demand..." } }
 * and that string used to travel all the way to the editor, where it was shown
 * inside the Arabic card and again, in English, on the status line. To a
 * person designing a tifo it says nothing they can act on, and it names the
 * vendor, the model id and our retry plumbing.
 *
 * So a failure is classified ONCE, here, into:
 *  - `reason`: a precise category the operator reads in /admin → AI, next to
 *    the account and a sanitized copy of what the provider actually said;
 *  - `cause`: a coarse, vendor-free word the client turns into a translated
 *    sentence with a next step. Nothing else about the failure leaves the server.
 */

/** What the operator sees. Specific enough to decide what to fix. */
export type AiFailReason =
  | 'overloaded'      // 503 / 529 / "high demand": the provider's own capacity spike
  | 'rate_limited'    // 429 / RESOURCE_EXHAUSTED: our key's quota with the provider
  | 'budget'          // our own AI_DAILY_BUDGET breaker tripped
  | 'timeout'         // no answer inside AI_TIMEOUT(_PREMIUM)_MS
  | 'network'         // could not reach the provider at all
  | 'auth'            // 401 / 403: key missing, wrong, or without access to the model
  | 'model_not_found' // 404: the model id in the env does not exist (any more)
  | 'bad_request'     // 400: the provider refused the shape of the request
  | 'safety'          // the provider's safety filter refused the brief or the answer
  | 'prompt_screen'   // our own first-line prompt screen refused the brief
  | 'truncated'       // ran out of output tokens mid-JSON
  | 'bad_output'      // an answer, but not JSON we could read
  | 'invalid_design'  // JSON, but the spec validator rejected it
  | 'picture_failed'  // the design arrived, a picture did not (not charged)
  | 'no_provider'     // no AI provider configured on this server
  | 'upstream_error'  // any other 5xx from the provider
  | 'unknown';

/** What the user is told, in their language. Deliberately coarse and vendor-free. */
export type AiCause = 'busy' | 'resting' | 'slow' | 'content' | 'garbled' | 'unavailable';

export interface AiFailure {
  reason: AiFailReason;
  /** Sanitized provider text for the operator. Never sent to a user. */
  detail: string;
  status?: number;
}

const DETAIL_MAX = 400;

/**
 * Strip anything credential-shaped and bound the length. The provider's error
 * body is echoed into a database row an admin page renders, so it is treated
 * as untrusted: keys in query strings, bearer tokens and vendor key prefixes
 * are masked, and the page escapes it on the way out as well.
 */
export function sanitizeDetail(s: string | undefined | null): string {
  if (!s) return '';
  return String(s)
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/\b(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]+/g, '$1***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);
}

/**
 * Classify a provider failure from its message and HTTP status. The status
 * wins when there is one: string matching is the fallback, not the rule.
 */
export function classifyAiFailure(error: string | undefined | null, status?: number): AiFailure {
  const msg = String(error ?? '');
  const low = msg.toLowerCase();
  const st = status ?? (Number(/\bHTTP (\d{3})\b/.exec(msg)?.[1]) || undefined);
  const out = (reason: AiFailReason): AiFailure => ({ reason, detail: sanitizeDetail(msg), ...(st ? { status: st } : {}) });

  if (/no ai provider configured|generation disabled/.test(low)) return out('no_provider');
  // An HTTP status is the provider's own verdict; read it before any wording.
  if (st === 503 || st === 529) return out('overloaded');
  if (st === 429) return out('rate_limited');
  if (st === 401 || st === 403) return out('auth');
  if (st === 404) return out('model_not_found');
  if (st === 504 || st === 408) return out('timeout');
  if (/high demand|overloaded|\bunavailable\b/.test(low)) return out('overloaded');
  if (/resource_exhausted|rate limit|quota/.test(low)) return out('rate_limited');
  if (/api key|permission_denied|unauthenticated/.test(low)) return out('auth');
  if (/not found for api version|is not found|model_not_found/.test(low)) return out('model_not_found');
  if (/timed out|timeout|deadline/.test(low)) return out('timeout');
  if (/network error|fetch failed|econnreset|enotfound|econnrefused/.test(low)) return out('network');
  if (/safety|blockreason|prohibited_content|finishreason (?:safety|recitation)/.test(low)) return out('safety');
  if (/max_tokens|output tokens/.test(low)) return out('truncated');
  if (/spec failed validation/.test(low)) return out('invalid_design');
  if (/not valid json|empty response|stopped early|did not answer/.test(low)) return out('bad_output');
  if (st === 400) return out('bad_request');
  if (st && st >= 500) return out('upstream_error');
  return out('unknown');
}

/** The one word the client is allowed to know. */
export function publicCause(reason: AiFailReason): AiCause {
  switch (reason) {
    case 'overloaded':
    case 'upstream_error':
      return 'busy';
    case 'rate_limited':
    case 'budget':
      return 'resting';
    case 'timeout':
    case 'network':
      return 'slow';
    case 'safety':
    case 'prompt_screen':
      return 'content';
    case 'truncated':
    case 'bad_output':
    case 'invalid_design':
      return 'garbled';
    default:
      return 'unavailable';
  }
}
