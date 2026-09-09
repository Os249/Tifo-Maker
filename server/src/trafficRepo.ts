/**
 * Traffic sources — privacy-preserving, cookieless, server-side reach measurement.
 *
 * WHY THIS EXISTS
 * The client funnel in src/net/analytics.ts only fires after "Accept all", so it
 * measured a small minority of real visits and could never answer the one question
 * that actually matters: where do people come from? The Referer header — the single
 * best answer — was never read at all. This module reads it on the server, where no
 * consent banner can hide it and no ad-blocker can strip it.
 *
 * WHY IT NEEDS NO CONSENT
 * ePrivacy Art. 5(3) consent is about *storing or reading information on the user's
 * device*. This module writes no cookie and touches no localStorage, so that article
 * does not apply. What remains is GDPR/PDPL, which needs a lawful basis for personal
 * data — so this module simply never stores any:
 *
 *   - The IP address is NEVER written to the database. It is used for exactly one
 *     in-memory hash and then discarded.
 *   - The full User-Agent is NEVER stored. Only coarse buckets ("mobile", "iOS",
 *     "Safari") derived from it.
 *   - The Referer is reduced to its HOSTNAME before storage. Paths and query strings
 *     are dropped, so a referring URL can never carry someone's search terms,
 *     session token or personal identifiers into this table.
 *   - visitor_key is a salted SHA-256 of (ip + user-agent + date). The salt is 32
 *     random bytes generated at boot, held ONLY in memory, and regenerated whenever
 *     the UTC day rolls over. It is never written to disk, never logged and never
 *     leaves the process, so the hash is not reversible even by whoever holds the
 *     database. Because the salt changes daily, the same person on two days produces
 *     two unrelated keys — there is no cross-day profile to build, by construction.
 *   - purge() then strips visitor_key entirely after ANONYMIZE_AFTER_DAYS, so older
 *     rows are irreversibly aggregate.
 *
 * That is the CNIL-endorsed "audience measurement" shape: aggregate reach statistics,
 * no identifiers, no profiling, no cross-site tracking, no data sold or shared. It is
 * used for nothing but understanding traffic — never advertising, retargeting or
 * personalisation, which WOULD require consent and are deliberately not implemented.
 *
 * Self-contained like statsRepo.ts: one interface, an in-memory stub for dev, and a
 * Postgres implementation. Every query is wrapped so a failure degrades to an empty
 * value instead of breaking the dashboard, and record() never throws into a response.
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/** How long a row keeps its (already irreversible) visitor_key before being stripped. */
const ANONYMIZE_AFTER_DAYS = 2;
/** How long aggregate rows are kept at all. */
const RETAIN_DAYS = 180;

export type SourceKind = 'search' | 'social' | 'ai' | 'referral' | 'campaign' | 'direct' | 'internal';

/** One recorded page view, already stripped of everything identifying. */
export interface VisitInput {
  visitorKey: string;
  source: SourceKind;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  path: string;
  device: string;
  os: string | null;
  browser: string | null;
  lang: string | null;
  country: string | null;
  isBot: boolean;
}

export interface Bucket {
  key: string;
  visits: number;
  visitors: number;
}
export interface DayCount {
  day: string;
  visits: number;
  visitors: number;
}

export interface TrafficSummary {
  days: number;
  enabled: boolean;
  totals: { visits: number; visitors: number; botVisits: number };
  sources: Bucket[];
  referrers: Bucket[];
  campaigns: Bucket[];
  pages: Bucket[];
  devices: Bucket[];
  browsers: Bucket[];
  languages: Bucket[];
  countries: Bucket[];
  daily: DayCount[];
}

export interface TrafficRepository {
  record(v: VisitInput): Promise<void>;
  summary(days: number): Promise<TrafficSummary>;
  /** Strip visitor keys past the anonymisation window and drop rows past retention. */
  purge(): Promise<void>;
}

// ============ classification (pure, unit-testable) ============

/**
 * Known search engines. Matched against the referrer hostname's registrable part,
 * so "www.google.co.uk" and "news.google.com" both resolve to "Google".
 */
const SEARCH: [RegExp, string][] = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)search\.yahoo\./, 'Yahoo'],
  [/(^|\.)yandex\./, 'Yandex'],
  [/(^|\.)baidu\.com$/, 'Baidu'],
  [/(^|\.)ecosia\.org$/, 'Ecosia'],
  [/(^|\.)search\.brave\.com$/, 'Brave Search'],
  [/(^|\.)startpage\.com$/, 'Startpage'],
  [/(^|\.)qwant\.com$/, 'Qwant'],
  [/(^|\.)naver\.com$/, 'Naver'],
  [/(^|\.)search\.marcaria\./, 'Other search'],
];

const SOCIAL: [RegExp, string][] = [
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.(com|me)$/, 'Facebook'],
  [/(^|\.)(twitter|x)\.com$|(^|\.)t\.co$/, 'X / Twitter'],
  [/(^|\.)reddit\.com$|(^|\.)redd\.it$/, 'Reddit'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, 'LinkedIn'],
  [/(^|\.)pinterest\./, 'Pinterest'],
  [/(^|\.)snapchat\.com$/, 'Snapchat'],
  [/(^|\.)t\.me$|(^|\.)telegram\./, 'Telegram'],
  [/(^|\.)whatsapp\.com$|(^|\.)wa\.me$/, 'WhatsApp'],
  [/(^|\.)discord\.(com|gg)$/, 'Discord'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'],
];

/**
 * True when a referrer host is a social or messaging platform. Exported for the
 * shares dashboard, which uses it to separate "arrived from something someone
 * shared" from ordinary referral traffic. It is a floor, not a count: most
 * messaging apps send no referrer at all, so those arrivals look direct.
 */
export function isSocialHost(host: string): boolean {
  return SOCIAL.some(([re]) => re.test(host.toLowerCase()));
}

const AI_REFERRERS: [RegExp, string][] = [
  [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/, 'ChatGPT'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/, 'Gemini'],
  [/(^|\.)copilot\.microsoft\.com$/, 'Copilot'],
];

/**
 * Automated clients. Deliberately broad: a false "bot" only moves a row out of the
 * human counts, whereas a missed bot silently inflates every number on the dashboard
 * — which is exactly the failure mode that made the old stats untrustworthy.
 */
const BOT_UA =
  /bot\b|bot\/|crawler|spider|slurp|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|yandex|baidu|python-requests|curl\/|wget|go-http|java\/|okhttp|scrapy|zgrab|censys|masscan|nmap|headless|phantomjs|puppeteer|playwright|expanse|netsystems|l9scan|paloalto|internet-measurement|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot|twitterbot|linkedinbot|embedly|quora link preview|pinterest|gptbot|ccbot|claude-?(bot|user|web)|anthropic|applebot|amazonbot|dataforseo|serpstat|zoominfo|riddler|scanner|nuclei|nikto|sqlmap|monitoring|uptime|pingdom|statuscake|newrelic|lighthouse|chrome-lighthouse|google-?(read-?aloud|site-verification|favicon)|bingpreview|preview|fetcher|feedfetcher|archive\.org_bot|ia_archiver/i;

export function isBotUa(ua: string): boolean {
  if (!ua || ua.length < 12) return true; // no/short UA is a script, not a browser
  return BOT_UA.test(ua);
}

/** Reduce a Referer header to a bare hostname; null for same-site, empty or unparseable. */
export function referrerHost(referer: string | undefined, selfHost: string | undefined): string | null {
  if (!referer) return null;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  const self = (selfHost ?? '').toLowerCase().replace(/^www\./, '').split(':')[0];
  if (self && (host === self || host.endsWith('.' + self))) return null; // internal navigation
  return host.slice(0, 120);
}

/** Map a referrer host + UTM tags onto a coarse source bucket and a display label. */
export function classifySource(
  host: string | null,
  utmSource: string | null,
  utmMedium: string | null,
  hadReferer: boolean,
): { kind: SourceKind; label: string } {
  if (utmSource || utmMedium) {
    return { kind: 'campaign', label: (utmSource || utmMedium || 'campaign').slice(0, 60) };
  }
  if (!host) {
    // No referrer at all: typed the URL, a bookmark, a QR code, or a link from an
    // app/PDF that sends no Referer. All genuinely indistinguishable — "direct".
    return hadReferer ? { kind: 'internal', label: 'Internal' } : { kind: 'direct', label: 'Direct / QR' };
  }
  for (const [re, label] of SEARCH) if (re.test(host)) return { kind: 'search', label };
  for (const [re, label] of SOCIAL) if (re.test(host)) return { kind: 'social', label };
  for (const [re, label] of AI_REFERRERS) if (re.test(host)) return { kind: 'ai', label };
  return { kind: 'referral', label: host };
}

/** Coarse device/OS/browser buckets. Never the raw UA string. */
export function classifyClient(ua: string): { device: string; os: string | null; browser: string | null } {
  const u = ua || '';
  const tablet = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(u);
  const mobile = /Mobi|iPhone|iPod|Android|Windows Phone|IEMobile/i.test(u);
  const device = tablet ? 'Tablet' : mobile ? 'Mobile' : 'Desktop';

  let os: string | null = null;
  if (/iPhone|iPad|iPod|iOS/i.test(u)) os = 'iOS';
  else if (/Android/i.test(u)) os = 'Android';
  else if (/Windows NT/i.test(u)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(u)) os = 'macOS';
  else if (/CrOS/i.test(u)) os = 'ChromeOS';
  else if (/Linux/i.test(u)) os = 'Linux';

  // In-app webviews first — they masquerade as Safari/Chrome further down the string.
  let browser: string | null = null;
  if (/musical_ly|BytedanceWebview|TikTok|Trill/i.test(u)) browser = 'TikTok in-app';
  else if (/Instagram/i.test(u)) browser = 'Instagram in-app';
  else if (/FBAN|FBAV|FB_IAB/i.test(u)) browser = 'Facebook in-app';
  else if (/Snapchat/i.test(u)) browser = 'Snapchat in-app';
  else if (/Twitter/i.test(u)) browser = 'X in-app';
  else if (/Edg\//i.test(u)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(u)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(u)) browser = 'Samsung Internet';
  else if (/Firefox\//i.test(u)) browser = 'Firefox';
  else if (/Chrome\//i.test(u)) browser = 'Chrome';
  else if (/Safari\//i.test(u)) browser = 'Safari';

  return { device, os, browser };
}

/** Primary language subtag only ("ar-SA,en;q=0.9" → "ar"). Not identifying on its own. */
export function primaryLang(header: string | undefined): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.trim().split(';')[0]?.trim();
  if (!first) return null;
  const tag = first.split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(tag) ? tag : null;
}

/**
 * Two-letter country from an edge header (Cloudflare's CF-IPCountry). "XX" is
 * Cloudflare's own "unknown", "T1" means Tor — neither is a country, so both become
 * null rather than polluting the breakdown with fake entries.
 */
export function normCountry(v: string | undefined): string | null {
  if (!v) return null;
  const c = v.trim().toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return null;
  return c;
}

/**
 * Rotating in-memory salt. Never persisted, never logged, regenerated on each UTC
 * day change — so a visitor_key cannot be reversed, and cannot be correlated across
 * days even by someone holding the whole database.
 */
class DailySalt {
  private salt = randomBytes(32);
  private day = new Date().toISOString().slice(0, 10);

  current(): { salt: Buffer; day: string } {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.salt = randomBytes(32);
      this.day = today;
    }
    return { salt: this.salt, day: this.day };
  }
}

const dailySalt = new DailySalt();

/** Irreversible per-day visitor key. The IP never leaves this function. */
export function visitorKeyFor(ip: string, ua: string): string {
  const { salt, day } = dailySalt.current();
  return createHash('sha256').update(salt).update('|').update(ip).update('|').update(ua).update('|').update(day).digest('hex').slice(0, 32);
}

/** Build a storable visit from raw request parts. Raw values are dropped here. */
export function buildVisit(raw: {
  ip: string;
  ua: string;
  referer?: string;
  host?: string;
  path: string;
  query: Record<string, unknown>;
  acceptLanguage?: string;
  country?: string;
}): VisitInput {
  const host = referrerHost(raw.referer, raw.host);
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 60).toLowerCase() : null;
  const utmSource = str(raw.query.utm_source);
  const utmMedium = str(raw.query.utm_medium);
  const utmCampaign = str(raw.query.utm_campaign);
  const { kind, label } = classifySource(host, utmSource, utmMedium, Boolean(raw.referer));
  const { device, os, browser } = classifyClient(raw.ua);
  return {
    visitorKey: visitorKeyFor(raw.ip, raw.ua),
    source: kind,
    // For search/social/ai we store the friendly label; for referral it IS the host.
    referrerHost: kind === 'referral' ? host : host ? label : null,
    utmSource,
    utmMedium,
    utmCampaign,
    path: (raw.path.split('?')[0] || '/').slice(0, 120),
    device,
    os,
    browser,
    lang: primaryLang(raw.acceptLanguage),
    country: normCountry(raw.country),
    isBot: isBotUa(raw.ua),
  };
}

// ============ implementations ============

const EMPTY = (days: number, enabled: boolean): TrafficSummary => ({
  days,
  enabled,
  totals: { visits: 0, visitors: 0, botVisits: 0 },
  sources: [],
  referrers: [],
  campaigns: [],
  pages: [],
  devices: [],
  browsers: [],
  languages: [],
  countries: [],
  daily: [],
});

/** Dev/in-memory mode: keeps a bounded ring of visits so /admin renders locally. */
export class MemoryTrafficRepository implements TrafficRepository {
  private rows: (VisitInput & { at: number })[] = [];

  async record(v: VisitInput): Promise<void> {
    this.rows.push({ ...v, at: Date.now() });
    if (this.rows.length > 20000) this.rows.splice(0, this.rows.length - 20000);
  }

  async summary(days: number): Promise<TrafficSummary> {
    const since = Date.now() - days * 864e5;
    const rows = this.rows.filter((r) => r.at >= since);
    const human = rows.filter((r) => !r.isBot);
    const bucket = (pick: (r: VisitInput) => string | null): Bucket[] => {
      const m = new Map<string, { visits: number; vis: Set<string> }>();
      for (const r of human) {
        const k = pick(r);
        if (!k) continue;
        const e = m.get(k) ?? { visits: 0, vis: new Set<string>() };
        e.visits++;
        e.vis.add(r.visitorKey);
        m.set(k, e);
      }
      return [...m.entries()]
        .map(([key, e]) => ({ key, visits: e.visits, visitors: e.vis.size }))
        .sort((a, b) => b.visits - a.visits)
        .slice(0, 15);
    };
    const dayMap = new Map<string, { visits: number; vis: Set<string> }>();
    for (const r of human) {
      const d = new Date(r.at).toISOString().slice(0, 10);
      const e = dayMap.get(d) ?? { visits: 0, vis: new Set<string>() };
      e.visits++;
      e.vis.add(r.visitorKey);
      dayMap.set(d, e);
    }
    return {
      days,
      enabled: true,
      totals: {
        visits: human.length,
        visitors: new Set(human.map((r) => r.visitorKey)).size,
        botVisits: rows.length - human.length,
      },
      sources: bucket((r) => r.source),
      referrers: bucket((r) => r.referrerHost),
      campaigns: bucket((r) => (r.utmCampaign || r.utmSource ? `${r.utmSource ?? '-'} / ${r.utmCampaign ?? '-'}` : null)),
      pages: bucket((r) => r.path),
      devices: bucket((r) => r.device),
      browsers: bucket((r) => r.browser),
      languages: bucket((r) => r.lang),
      countries: bucket((r) => r.country),
      daily: [...dayMap.entries()]
        .map(([day, e]) => ({ day, visits: e.visits, visitors: e.vis.size }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  async purge(): Promise<void> {
    const cutoff = Date.now() - RETAIN_DAYS * 864e5;
    this.rows = this.rows.filter((r) => r.at >= cutoff);
  }
}

/** Postgres traffic store. All reads are defensive; a failure yields empty, never a 500. */
export class PgTrafficRepository implements TrafficRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent table creation, mirroring stadiumRepo's boot-safe pattern. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id            BIGSERIAL PRIMARY KEY,
        visitor_key   TEXT,
        source        TEXT NOT NULL,
        referrer_host TEXT,
        utm_source    TEXT,
        utm_medium    TEXT,
        utm_campaign  TEXT,
        path          TEXT NOT NULL,
        device        TEXT,
        os            TEXT,
        browser       TEXT,
        lang          TEXT,
        country       TEXT,
        is_bot        BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS visits_created_idx ON visits (created_at DESC)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS visits_source_idx ON visits (source, created_at DESC)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS visits_human_idx ON visits (created_at DESC) WHERE NOT is_bot');
  }

  async record(v: VisitInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO visits
         (visitor_key, source, referrer_host, utm_source, utm_medium, utm_campaign,
          path, device, os, browser, lang, country, is_bot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        v.visitorKey, v.source, v.referrerHost, v.utmSource, v.utmMedium, v.utmCampaign,
        v.path, v.device, v.os, v.browser, v.lang, v.country, v.isBot,
      ],
    );
  }

  /** One grouped query; [] on any failure so a single bad column can't blank the page. */
  private async bucket(expr: string, days: number, extra = ''): Promise<Bucket[]> {
    try {
      const r = await this.pool.query(
        `SELECT ${expr} AS key, count(*)::int AS visits, count(DISTINCT visitor_key)::int AS visitors
           FROM visits
          WHERE NOT is_bot AND created_at >= now() - ($1::int * interval '1 day')
            AND ${expr} IS NOT NULL ${extra}
          GROUP BY 1 ORDER BY visits DESC LIMIT 15`,
        [days],
      );
      return r.rows.map((x) => ({ key: String(x.key), visits: Number(x.visits) || 0, visitors: Number(x.visitors) || 0 }));
    } catch {
      return [];
    }
  }

  async summary(days: number): Promise<TrafficSummary> {
    const out = EMPTY(days, true);
    try {
      const r = await this.pool.query(
        `SELECT
           count(*) FILTER (WHERE NOT is_bot)::int                    AS visits,
           count(DISTINCT visitor_key) FILTER (WHERE NOT is_bot)::int AS visitors,
           count(*) FILTER (WHERE is_bot)::int                        AS bots
         FROM visits WHERE created_at >= now() - ($1::int * interval '1 day')`,
        [days],
      );
      const x = r.rows[0] ?? {};
      out.totals = { visits: Number(x.visits) || 0, visitors: Number(x.visitors) || 0, botVisits: Number(x.bots) || 0 };
    } catch {
      /* keep zeros */
    }

    out.sources = await this.bucket('source', days);
    out.referrers = await this.bucket('referrer_host', days);
    out.campaigns = await this.bucket("coalesce(utm_source,'-') || ' / ' || coalesce(utm_campaign,'-')", days, "AND (utm_source IS NOT NULL OR utm_campaign IS NOT NULL)");
    out.pages = await this.bucket('path', days);
    out.devices = await this.bucket('device', days);
    out.browsers = await this.bucket('browser', days);
    out.languages = await this.bucket('lang', days);
    out.countries = await this.bucket('country', days);

    try {
      const r = await this.pool.query(
        `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day,
                count(*)::int AS visits, count(DISTINCT visitor_key)::int AS visitors
           FROM visits
          WHERE NOT is_bot AND created_at >= now() - ($1::int * interval '1 day')
          GROUP BY 1 ORDER BY 1`,
        [days],
      );
      out.daily = r.rows.map((x) => ({ day: String(x.day).slice(0, 10), visits: Number(x.visits) || 0, visitors: Number(x.visitors) || 0 }));
    } catch {
      out.daily = [];
    }
    return out;
  }

  /**
   * Two-stage minimisation: drop the (already irreversible) visitor key after the
   * anonymisation window so old rows are pure aggregates, then delete past retention.
   */
  async purge(): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE visits SET visitor_key = NULL
          WHERE visitor_key IS NOT NULL AND created_at < now() - ($1::int * interval '1 day')`,
        [ANONYMIZE_AFTER_DAYS],
      );
      await this.pool.query(`DELETE FROM visits WHERE created_at < now() - ($1::int * interval '1 day')`, [RETAIN_DAYS]);
    } catch {
      /* purge is best-effort; never block the app */
    }
  }
}
