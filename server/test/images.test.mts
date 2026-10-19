/**
 * AI pictures: the backup provider, the breaker, and the alert emails.
 *
 * Written after 28 Sep 2026, when the Pollinations balance ran out and every
 * Super AI design shipped with a bare stand for a day. Every provider call here
 * goes to a stubbed fetch; nothing leaves the machine.
 *
 *   npm run test:images
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { SUPER_AI_EXEMPLARS } from '../../src/core/exemplars';
import type { EmailMessage } from '../src/email';
import { classifyImageFailure, imageHealth, ALERT_COOLDOWN_MS, FAILING_THRESHOLD } from '../src/imageHealth';
import { fallbackImageProvider, generateImage, imageProviderChain, picturesStatus } from '../src/imageAssets';
import { MemoryAuthRepository, MemoryDesignRepository, MemoryLeadsRepository, MemoryAiUsageRepository, MemoryAiEventsRepository } from '../src/memoryRepo';
import { MemoryAdminStatsRepository } from '../src/statsRepo';
import { MemorySocialRepository } from '../src/memorySocial';
import { buildApp, type TemplateInfo } from '../src/routes';
import { configWarnings } from '../src/preflight';

void gzipSync;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Environment, restored at the end so nothing leaks.
const ENV_KEYS = [
  'AI_IMAGE_PROVIDER', 'AI_IMAGE_FALLBACK', 'AI_POLLINATIONS_KEY', 'POLLINATIONS_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'AI_IMAGE_RETRY_MS', 'AI_IMAGE_BREAKER_MS', 'AI_IMAGE_TIMEOUT_MS', 'AI_PROVIDER', 'AI_ADMIN_PASSWORD', 'AI_RETRY_DELAY_MS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_COPYWRITER',
  'AI_CLOUDFLARE_ACCOUNT_ID', 'AI_CLOUDFLARE_API_TOKEN', 'AI_CLOUDFLARE_IMAGE_MODEL', 'AI_CLOUDFLARE_STEPS',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function env(vals: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { AI_IMAGE_RETRY_MS: '0' }, vals);
}

// ---------------------------------------------------------------------------
// A fetch that plays both providers.
type Answer = { status: number; body?: string } | 'image';
const script: { pollinations: Answer[]; gemini: Answer[]; cloudflare: Answer[]; model: string[] } = { pollinations: [], gemini: [], cloudflare: [], model: [] };
const calls = { pollinations: 0, gemini: 0, cloudflare: 0, model: 0 };
const cfSeen: Array<{ url: string; auth: string | null; body: { prompt?: string; steps?: number } }> = [];
const JPEG_B64 = Buffer.from('ffd8ffe0' + '00'.repeat(300), 'hex').toString('base64');
const PNG = Buffer.from('89504e470d0a1a0a' + '00'.repeat(200), 'hex');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://gen.pollinations.ai/')) {
    calls.pollinations++;
    const a = script.pollinations.shift() ?? 'image';
    if (a === 'image') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response(a.body ?? '', { status: a.status });
  }
  if (/generativelanguage\.googleapis\.com\/v1beta\/models\/[^:]*image[^:]*:generateContent/.test(url)) {
    calls.gemini++;
    const a = script.gemini.shift() ?? 'image';
    if (a === 'image') {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }), { status: 200 });
    }
    return new Response(a.body ?? '', { status: a.status });
  }
  if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
    calls.cloudflare++;
    cfSeen.push({ url, auth: new Headers(init?.headers as HeadersInit).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : {} });
    const a = script.cloudflare.shift() ?? 'image';
    if (a === 'image') return new Response(JSON.stringify({ result: { image: JPEG_B64 }, success: true, errors: [], messages: [] }), { status: 200 });
    return new Response(a.body ?? '', { status: a.status });
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    calls.model++;
    const text = script.model.shift() ?? '{}';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;
const resetCalls = (): void => {
  calls.pollinations = 0; calls.gemini = 0; calls.cloudflare = 0; calls.model = 0;
  script.pollinations = []; script.gemini = []; script.cloudflare = []; script.model = []; cfSeen.length = 0;
};
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
const CF_DAILY = { status: 429, body: '{"result":null,"success":false,"errors":[{"code":3036,"message":"You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage."}],"messages":[]}' };

const NO_CREDIT = { status: 402, body: '{"success":false,"error":{"message":"Insufficient balance. This request costs ~0.0020 pollen, but your available balance is 0.0005. Top up at https://enter.pollinations.ai"}}' };
const GEMINI_NO_BILLING = { status: 429, body: '{"error":{"code":429,"message":"You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image","status":"RESOURCE_EXHAUSTED"}}' };
const BUSY = { status: 503, body: '{"error":{"code":503,"message":"high demand"}}' };

// A clock the breaker and the alert cooldowns read.
let now = Date.UTC(2026, 8, 29, 18, 0, 0);
const clock = (): number => now;
const mails: EmailMessage[] = [];
const sender = { send: async (m: EmailMessage): Promise<void> => { mails.push(m); } };
function fresh(to: string | null = 'ops@example.test'): void {
  imageHealth.reset(clock);
  imageHealth.configure({ sender, to: to ?? undefined, publicUrl: 'https://tifomaker.org', log: () => {} });
  mails.length = 0;
  resetCalls();
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

try {
  console.log('\n— classifying a failure —');
  await check('the exact 402 from 28 Sep is "credit"', () => {
    assert.equal(classifyImageFailure(402, `pollinations: HTTP 402: ${NO_CREDIT.body}`), 'credit');
  });
  await check('Gemini without billing (429, limit: 0) is "credit", not a busy minute', () => {
    assert.equal(classifyImageFailure(429, GEMINI_NO_BILLING.body), 'credit');
    assert.equal(classifyImageFailure(429, 'Too many requests'), 'rate');
  });
  await check('keys: 401, a 403 that says key, and Gemini\'s 400 "API key not valid"', () => {
    assert.equal(classifyImageFailure(401, 'unauthorized'), 'auth');
    assert.equal(classifyImageFailure(403, 'PERMISSION_DENIED: API key has no access'), 'auth');
    assert.equal(classifyImageFailure(400, 'API key not valid. Please pass a valid API key.'), 'auth');
    assert.equal(classifyImageFailure(undefined, 'pollinations needs a key, create one at enter.pollinations.ai and set AI_POLLINATIONS_KEY'), 'auth');
  });
  await check('a 403 that does not mention a key is the prompt, so it never pauses a provider', () => {
    assert.equal(classifyImageFailure(403, 'content policy'), 'refused');
    assert.equal(classifyImageFailure(400, 'bad prompt'), 'refused');
  });
  await check('outages and timeouts are "down"', () => {
    assert.equal(classifyImageFailure(503, 'x'), 'down');
    assert.equal(classifyImageFailure(undefined, 'pollinations: request timed out'), 'down');
    assert.equal(classifyImageFailure(undefined, 'pollinations returned an empty image'), 'down');
  });

  console.log('\n— which providers are tried —');
  await check('both keys: Pollinations first, Gemini as the backup', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST' });
    assert.deepEqual(imageProviderChain(), ['pollinations', 'gemini']);
  });
  await check('AI_IMAGE_FALLBACK=none: no backup', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_IMAGE_FALLBACK: 'none' });
    assert.deepEqual(imageProviderChain(), ['pollinations']);
  });
  await check('Gemini as main: Pollinations is its backup', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_IMAGE_PROVIDER: 'gemini' });
    assert.deepEqual(imageProviderChain(), ['gemini', 'pollinations']);
  });
  await check('a backup without a key is not a backup', () => {
    env({ AI_POLLINATIONS_KEY: 'pk' });
    assert.equal(fallbackImageProvider(), null);
    env({ AI_POLLINATIONS_KEY: 'pk', AI_IMAGE_FALLBACK: 'gemini' });
    assert.equal(fallbackImageProvider(), null);
  });
  await check('AI_IMAGE_PROVIDER=none means no pictures at all, backup included', async () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_IMAGE_PROVIDER: 'none' });
    fresh();
    assert.deepEqual(imageProviderChain(), []);
    const r = await generateImage('an eagle');
    assert.equal(r.url, null);
    assert.match(r.error ?? '', /disabled/);
    assert.equal(calls.pollinations + calls.gemini, 0, 'and nothing is called');
  });

  console.log('\n— the day the credit ran out —');
  env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_IMAGE_BREAKER_MS: String(10 * MIN) });
  fresh();
  await check('Pollinations 402 → Gemini makes the picture', async () => {
    script.pollinations = [NO_CREDIT];
    const r = await generateImage('an eagle', { aspect: 2 });
    assert.ok(r.url?.startsWith('data:image/png;base64,'), 'a picture came back');
    assert.equal(r.provider, 'gemini');
    assert.equal(r.viaBackup, true);
    assert.equal(calls.pollinations, 1, 'a 402 is not retried: it will not pass in 1.5 s');
    assert.equal(calls.gemini, 1);
  });
  await check('and the operator hears about it once, told people are covered and what to do', async () => {
    await imageHealth.settled();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'ops@example.test');
    assert.match(mails[0].subject, /Pollinations is out of credit/);
    assert.match(mails[0].text ?? '', /being made by Gemini instead/);
    assert.match(mails[0].text ?? '', /enter\.pollinations\.ai/);
    assert.match(mails[0].text ?? '', /Insufficient balance/, 'with what the provider said');
    assert.match(mails[0].html ?? '', /Open the AI tab/);
  });
  await check('while paused, Pollinations is not asked at all', async () => {
    const r = await generateImage('a lion');
    assert.equal(r.provider, 'gemini');
    assert.equal(calls.pollinations, 1, 'no second doomed round trip');
    assert.equal(calls.gemini, 2);
    await imageHealth.settled();
    assert.equal(mails.length, 1, 'no second email');
  });
  await check('the dashboard says so', () => {
    const p = picturesStatus();
    assert.equal(p.main, 'pollinations');
    assert.equal(p.backup, 'gemini');
    const poll = p.providers.find((x) => x.provider === 'pollinations')!;
    assert.equal(poll.pausedFor, 'credit');
    assert.ok(poll.pausedUntil);
    assert.equal(poll.lastFailure?.kind, 'credit');
    assert.equal(p.servedByBackup, 2);
    assert.equal(p.failedEverywhere, 0);
    assert.equal(p.alerts.to, 'o•••@example.test', 'the address is masked');
    assert.equal(p.alerts.sent[0].delivered, true);
  });
  await check('after the pause it is tried again; still empty → still no second email inside 6 h', async () => {
    now += 11 * MIN;
    script.pollinations = [NO_CREDIT];
    const r = await generateImage('a falcon');
    assert.equal(r.provider, 'gemini');
    assert.equal(calls.pollinations, 2, 'tried again after the breaker');
    await imageHealth.settled();
    assert.equal(mails.length, 1);
  });
  await check('six hours on, a balance that is still empty is worth another email', async () => {
    now += ALERT_COOLDOWN_MS;
    script.pollinations = [NO_CREDIT];
    await generateImage('a hawk');
    await imageHealth.settled();
    assert.equal(mails.length, 2);
  });
  await check('a top-up heals on its own: next try after the pause goes back to Pollinations', async () => {
    now += 11 * MIN;
    const r = await generateImage('a wolf');
    assert.equal(r.provider, 'pollinations');
    assert.equal(r.viaBackup, false);
    const poll = picturesStatus().providers.find((x) => x.provider === 'pollinations')!;
    assert.equal(poll.pausedUntil, null, 'no longer paused');
    assert.ok(poll.lastOk);
  });

  console.log('\n— when the backup cannot help either —');
  fresh();
  await check('Pollinations 402 and Gemini without billing: no picture, both reasons returned', async () => {
    script.pollinations = [NO_CREDIT];
    script.gemini = [GEMINI_NO_BILLING];
    const r = await generateImage('an eagle');
    assert.equal(r.url, null);
    assert.equal(r.kind, 'credit');
    assert.match(r.error ?? '', /pollinations: HTTP 402.*; then .*HTTP 429/);
    assert.equal(calls.gemini, 1, 'a "limit: 0" 429 is not retried');
  });
  await check('the emails say people ARE affected, and name the Gemini fix', async () => {
    await imageHealth.settled();
    const poll = mails.find((m) => /Pollinations/.test(m.subject))!;
    const gem = mails.find((m) => /Gemini/.test(m.subject))!;
    assert.match(poll.text ?? '', /did not produce the picture either/);
    assert.match(gem.text ?? '', /backup/);
    assert.match(gem.text ?? '', /billing/);
  });
  await check('a paused provider is still asked when nothing else delivered (so a top-up heals at once)', async () => {
    script.pollinations = ['image'];
    script.gemini = [GEMINI_NO_BILLING];
    const r = await generateImage('a lion');
    assert.equal(r.provider, 'pollinations');
  });
  await check(`${FAILING_THRESHOLD} lost pictures in 30 minutes → "pictures are failing"`, async () => {
    fresh();
    for (let i = 0; i < FAILING_THRESHOLD; i++) {
      script.pollinations = [BUSY, BUSY];
      script.gemini = [BUSY, BUSY];
      await generateImage('x');
    }
    await imageHealth.settled();
    const failing = mails.filter((m) => /pictures are failing/i.test(m.subject));
    assert.equal(failing.length, 1);
    assert.equal(mails.length, 1, 'an outage is not a credit problem: no provider email');
    assert.equal(picturesStatus().failedEverywhere, FAILING_THRESHOLD);
  });
  await check('a busy provider gets one retry before the backup', async () => {
    fresh();
    script.pollinations = [BUSY, BUSY];
    const r = await generateImage('x');
    assert.equal(calls.pollinations, 2);
    assert.equal(r.provider, 'gemini');
    assert.equal(picturesStatus().providers[0].pausedUntil, null, 'a 503 never pauses a provider');
  });

  console.log('\n— without an alert address —');
  await check('nothing is emailed, and the dashboard says nobody is told', async () => {
    fresh(null);
    script.pollinations = [NO_CREDIT];
    await generateImage('x');
    await imageHealth.settled();
    assert.equal(mails.length, 0);
    const p = picturesStatus();
    assert.equal(p.alerts.to, null);
    assert.match(p.alerts.sent[0].error ?? '', /AI_ALERT_TO/);
  });
  await check('credential-shaped text never reaches the dashboard or an email', async () => {
    fresh();
    script.pollinations = [{ status: 401, body: 'bad token Bearer abcdef.123456 key=AIzaSyA1234567890abcdef' }];
    await generateImage('x');
    await imageHealth.settled();
    const detail = picturesStatus().providers[0].lastFailure?.detail ?? '';
    assert.ok(!/abcdef\.123456|AIzaSyA1234567890/.test(detail + mails.map((m) => m.text).join('')), detail);
  });

  console.log('\n— boot warnings —');
  await check('production without a Pollinations key says where pictures will come from', () => {
    const covered = configWarnings({ NODE_ENV: 'production', GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv).find((w) => w.key === 'AI_POLLINATIONS_KEY');
    assert.match(covered?.effect ?? '', /backup, Gemini/);
    const bare = configWarnings({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).find((w) => w.key === 'AI_POLLINATIONS_KEY');
    assert.match(bare?.effect ?? '', /no backup/);
    assert.equal(configWarnings({ NODE_ENV: 'production', AI_POLLINATIONS_KEY: 'pk' } as NodeJS.ProcessEnv).some((w) => w.key === 'AI_POLLINATIONS_KEY'), false);
  });
  await check('gemini forced without a key is covered by Pollinations when it can be', () => {
    const w = configWarnings({ AI_IMAGE_PROVIDER: 'gemini', AI_POLLINATIONS_KEY: 'pk', AI_ADMIN_PASSWORD: 'x' } as NodeJS.ProcessEnv);
    assert.match(w[0]?.effect ?? '', /from the backup, Pollinations/);
  });

  // -------------------------------------------------------------------------
  // 18 October 2026: Gemini's pictures have no free quota, and a backup that
  // costs $30 up front to exist is no backup. Cloudflare Workers AI runs the
  // same FLUX model free for about 170 pictures a day.
  console.log('\n— Cloudflare, the free backup —');
  await check('with Cloudflare set up it is the backup, ahead of a Gemini key', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, AI_CLOUDFLARE_API_TOKEN: 'cf-token' });
    assert.deepEqual(imageProviderChain(), ['pollinations', 'cloudflare']);
    process.env.AI_IMAGE_FALLBACK = 'cloudflare,gemini';
    assert.deepEqual(imageProviderChain(), ['pollinations', 'cloudflare', 'gemini'], 'a list is asked in order');
    process.env.AI_IMAGE_FALLBACK = 'gemini';
    assert.deepEqual(imageProviderChain(), ['pollinations', 'gemini'], 'and naming Gemini still works');
  });
  await check('a backup setting with no provider name in it ("on", a typo) means auto, not off', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_IMAGE_FALLBACK: 'on' });
    assert.deepEqual(imageProviderChain(), ['pollinations', 'gemini']);
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_IMAGE_FALLBACK: 'cloudfare', AI_CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, AI_CLOUDFLARE_API_TOKEN: 'cf-token' });
    assert.deepEqual(imageProviderChain(), ['pollinations', 'cloudflare']);
    assert.ok(configWarnings({ AI_IMAGE_FALLBACK: 'cloudfare' } as NodeJS.ProcessEnv).some((w) => w.key === 'AI_IMAGE_FALLBACK' && w.state === 'wrong'), 'and the boot report names the word');
  });
  await check('Cloudflare as the main provider: Pollinations behind it; without its keys, Pollinations makes every picture', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', AI_IMAGE_PROVIDER: 'cloudflare', AI_CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, AI_CLOUDFLARE_API_TOKEN: 'cf-token' });
    assert.deepEqual(imageProviderChain(), ['cloudflare', 'pollinations']);
    env({ AI_POLLINATIONS_KEY: 'pk', AI_IMAGE_PROVIDER: 'cloudflare' });
    assert.deepEqual(imageProviderChain(), ['pollinations']);
    const prodCf = { NODE_ENV: 'production', AI_IMAGE_PROVIDER: 'cloudflare', AI_CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, AI_CLOUDFLARE_API_TOKEN: 't' } as NodeJS.ProcessEnv;
    assert.equal(configWarnings(prodCf).filter((w) => /AI_POLLINATIONS_KEY|AI_IMAGE_PROVIDER|CLOUDFLARE/.test(w.key)).length, 0, 'a working Cloudflare main needs no Pollinations warning');
    assert.ok(configWarnings({ NODE_ENV: 'production', AI_IMAGE_PROVIDER: 'cloudflare', AI_POLLINATIONS_KEY: 'pk' } as NodeJS.ProcessEnv).some((w) => w.key === 'AI_IMAGE_PROVIDER' && /Pollinations/.test(w.effect)));
  });
  await check('half a Cloudflare setup, or a malformed account id, is not a backup', () => {
    env({ AI_POLLINATIONS_KEY: 'pk', AI_CLOUDFLARE_API_TOKEN: 'cf-token' });
    assert.deepEqual(imageProviderChain(), ['pollinations']);
    env({ AI_POLLINATIONS_KEY: 'pk', AI_CLOUDFLARE_ACCOUNT_ID: '../../evil', AI_CLOUDFLARE_API_TOKEN: 'cf-token' });
    assert.deepEqual(imageProviderChain(), ['pollinations']);
  });
  await check('Pollinations 402 → Cloudflare makes the picture, and Gemini is never asked', async () => {
    env({ AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaTEST', AI_CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, AI_CLOUDFLARE_API_TOKEN: 'cf-token' });
    fresh();
    script.pollinations = [NO_CREDIT];
    const r = await generateImage('an eagle with spread wings, for: hilal', { aspect: 2.4, palette: ['#262a33', '#0033a0', '#ffffff'] });
    assert.ok(r.url?.startsWith('data:image/jpeg;base64,'), String(r.error));
    assert.equal(r.provider, 'cloudflare');
    assert.equal(r.viaBackup, true);
    assert.equal(r.model, '@cf/black-forest-labs/flux-1-schnell');
    assert.equal(calls.gemini, 0, 'the paid backup is not touched');
    const seen = cfSeen[0];
    assert.equal(seen.url, `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`);
    assert.equal(seen.auth, 'Bearer cf-token');
    assert.equal(seen.body.steps, 4);
    assert.ok(seen.body.prompt!.startsWith('an eagle with spread wings') && seen.body.prompt!.length <= 2048, 'the subject first, inside the 2,048-character limit');
    const { pictureCostMicros } = await import('../src/aiPricing');
    assert.equal(pictureCostMicros('cloudflare', r.model), 634, 'priced (free inside the daily allowance)');
    await imageHealth.settled();
    const mail = mails.find((m) => /Pollinations is out of credit/.test(m.subject));
    assert.ok(mail && /Cloudflare instead/.test(mail.text ?? ''), 'the email says Cloudflare is covering');
  });
  await check('a very long subject is cut to fit; the style is what gets shortened', async () => {
    fresh();
    script.pollinations = [NO_CREDIT];
    await generateImage('x'.repeat(5000), { aspect: 1 });
    assert.ok(cfSeen[0].body.prompt!.length <= 2048);
    assert.ok(cfSeen[0].body.prompt!.startsWith('x'.repeat(600)));
  });
  await check('Cloudflare\'s daily allowance spent: "out of credit", paused, and the email says it comes back at 00:00 UTC', async () => {
    fresh();
    script.pollinations = [NO_CREDIT];
    script.cloudflare = [CF_DAILY];
    const r = await generateImage('a lion', { aspect: 1 });
    assert.equal(r.url, null);
    assert.equal(calls.cloudflare, 1, 'no retry: it will not pass in a second and a half');
    assert.equal(classifyImageFailure(429, CF_DAILY.body), 'credit');
    assert.equal(picturesStatus().providers.find((p) => p.provider === 'cloudflare')?.pausedFor, 'credit');
    await imageHealth.settled();
    assert.ok(mails.some((m) => /Cloudflare is out of credit/.test(m.subject) && /00:00 UTC/.test(m.text ?? '')));
  });
  await check('a wrong Cloudflare token is the key, not the prompt', () => {
    assert.equal(classifyImageFailure(400, 'cloudflare: HTTP 400: {"success":false,"errors":[{"code":6003,"message":"Invalid request headers","error_chain":[{"code":6111,"message":"Invalid format for Authorization header"}]}]}'), 'auth');
    assert.equal(classifyImageFailure(403, 'cloudflare: HTTP 403: {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'), 'auth');
  });
  await check('a model that answers with the image bytes works too; a ".." model id is ignored', async () => {
    fresh();
    script.pollinations = [NO_CREDIT];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.cloudflare.com/')) { cfSeen.push({ url, auth: null, body: {} }); return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }); }
      return real(input, init);
    }) as typeof fetch;
    process.env.AI_CLOUDFLARE_IMAGE_MODEL = '@cf/../..';
    try {
      const r = await generateImage('a lion', { aspect: 1 });
      assert.ok(r.url?.startsWith('data:image/png;base64,'), String(r.error));
      assert.ok(cfSeen[0].url.endsWith('/ai/run/@cf/black-forest-labs/flux-1-schnell'), cfSeen[0].url);
    } finally {
      globalThis.fetch = real;
      delete process.env.AI_CLOUDFLARE_IMAGE_MODEL;
    }
  });
  await check('with two backups that both fail, the email names both', async () => {
    fresh();
    process.env.AI_IMAGE_FALLBACK = 'cloudflare,gemini';
    script.pollinations = [NO_CREDIT];
    script.cloudflare = [CF_DAILY];
    script.gemini = [GEMINI_NO_BILLING];
    const r = await generateImage('a lion', { aspect: 1 });
    assert.equal(r.url, null);
    assert.deepEqual([calls.pollinations, calls.cloudflare, calls.gemini], [1, 1, 1]);
    await imageHealth.settled();
    assert.ok(mails.some((m) => /The backups, Cloudflare and Gemini, did not produce/.test(m.text ?? '')), mails.map((m) => m.text).join('\n---\n').slice(0, 600));
    delete process.env.AI_IMAGE_FALLBACK;
  });
  await check('an answer with no image is a refusal, not an outage', async () => {
    fresh();
    script.pollinations = [NO_CREDIT];
    script.cloudflare = [{ status: 200, body: '{"result":null,"success":false,"errors":[{"code":5004,"message":"bad input"}]}' }];
    const r = await generateImage('a lion', { aspect: 1 });
    assert.equal(r.url, null);
    assert.match(r.error ?? '', /cloudflare returned no image: bad input/);
    assert.equal(picturesStatus().providers.find((p) => p.provider === 'cloudflare')?.pausedFor, null, 'not paused for it');
  });
  await check('the dashboard lists Cloudflare as a backup', () => {
    const p = picturesStatus();
    assert.deepEqual(p.backups, ['cloudflare']);
    assert.equal(p.providers.find((x) => x.provider === 'cloudflare')?.role, 'backup');
  });
  await check('boot warnings: Gemini as the only backup says it has no free quota; half a Cloudflare setup is named', () => {
    const prod = { NODE_ENV: 'production', AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIza' } as NodeJS.ProcessEnv;
    assert.ok(configWarnings(prod).some((w) => w.key === 'AI_CLOUDFLARE_API_TOKEN' && /no free quota/.test(w.effect)));
    assert.equal(configWarnings({ ...prod, AI_CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, AI_CLOUDFLARE_API_TOKEN: 't' }).filter((w) => /CLOUDFLARE/.test(w.key)).length, 0);
    assert.ok(configWarnings({ ...prod, AI_CLOUDFLARE_API_TOKEN: 't' }).some((w) => w.key === 'AI_CLOUDFLARE_ACCOUNT_ID' && w.state === 'wrong'));
  });

  // -------------------------------------------------------------------------
  console.log('\n— a real Super AI generation through the route —');
  env({
    AI_POLLINATIONS_KEY: 'pk', GEMINI_API_KEY: 'AIzaSyTESTKEY0000000000', AI_PROVIDER: 'gemini',
    AI_ADMIN_PASSWORD: 'correct horse battery staple', AI_RETRY_DELAY_MS: '100',
    // The copywriter stage is a separate model call; off, so the one scripted
    // reply is the design itself.
    AI_COPYWRITER: '0',
  });
  const portrait = SUPER_AI_EXEMPLARS.find((e) => e.spec.layers.some((l) => l.kind === 'image'));
  assert.ok(portrait, 'the exemplar gallery has a portrait design to reply with');
  const map = generateSeatMap(DEFAULT_TEMPLATE);
  const templates: TemplateInfo[] = [{ id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count }];
  const auth = new MemoryAuthRepository();
  const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
  const app = await buildApp(designs, auth, templates, {
    social: new MemorySocialRepository(designs, auth),
    leads: new MemoryLeadsRepository(),
    aiUsage: new MemoryAiUsageRepository(),
    aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
    stats: new MemoryAdminStatsRepository(designs),
    emailSender: sender,
    aiAlertTo: 'ops@example.test',
  });
  imageHealth.reset(clock);
  mails.length = 0;
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'fan_pics', password: 'quartz-lantern-echo7', email: 'fan_pics@example.test', acceptedVersion: 'test' } });
  const token = (reg.json() as { token: string }).token;
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } })).json() as { id: string };
  await auth.markEmailVerified(me.id);
  const unlock = (await app.inject({ method: 'POST', url: '/api/ai/unlock', payload: { password: 'correct horse battery staple' } })).json().token as string;

  const superGen = async (prompt: string): Promise<{ body: Record<string, unknown>; raw: string }> => {
    // The director writes "<subject>, for: <brief>"; that suffix is what the
    // route strips for its second, bare-subject attempt.
    const spec = JSON.parse(JSON.stringify(portrait!.spec)) as { layers: Array<Record<string, unknown>> };
    for (const l of spec.layers) if (l.kind === 'image') l.prompt = `${String(l.prompt ?? 'portrait')}, for: ${prompt}`;
    script.model = [JSON.stringify(spec)];
    const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: { authorization: `Bearer ${token}` }, payload: { prompt, mode: 'super' } });
    assert.equal(r.statusCode, 200, r.body.slice(0, 300));
    return { body: r.json() as Record<string, unknown>, raw: r.body };
  };
  const imageRefs = (b: Record<string, unknown>): unknown[] =>
    ((b.spec as { layers?: Array<{ kind: string; assetRef?: unknown }> } | undefined)?.layers ?? []).filter((l) => l.kind === 'image').map((l) => l.assetRef);

  await check('Pollinations out of credit: the design still arrives WITH its picture, from Gemini', async () => {
    resetCalls();
    script.pollinations = [NO_CREDIT];
    const { body, raw } = await superGen('farewell to our captain, black and gold');
    const refs = imageRefs(body);
    assert.ok(refs.length >= 1, `the design has a picture layer: ${raw.slice(0, 400)} model calls ${calls.model}`);
    assert.ok(refs.every((u) => typeof u === 'string' && u.startsWith('data:image/png;base64,')), 'and every one has a picture');
    assert.ok(!/Picture not generated/.test(raw), 'no "picture not generated" note');
    assert.ok(!/pollinations|402|Insufficient/i.test(raw), 'nothing of the provider reply reaches the editor');
    await imageHealth.settled();
    assert.equal(mails.filter((m) => /Pollinations is out of credit/.test(m.subject)).length, 1, 'and the operator was emailed');
  });
  await check('both out of credit: one attempt each, no second "bare prompt" round trip', async () => {
    imageHealth.reset(clock);
    resetCalls();
    script.pollinations = [NO_CREDIT, NO_CREDIT, NO_CREDIT, NO_CREDIT];
    script.gemini = [GEMINI_NO_BILLING, GEMINI_NO_BILLING, GEMINI_NO_BILLING, GEMINI_NO_BILLING];
    // A different brief: the first design was complete, so it is cached.
    const { body, raw } = await superGen('farewell to our keeper, green and white');
    const wanted = imageRefs(body).length;
    assert.ok(wanted >= 1);
    assert.equal(calls.pollinations, wanted, 'one call per picture, not two');
    assert.equal(calls.gemini, wanted);
    assert.ok(/Picture not generated/.test(raw), 'the design says the picture is missing');
    assert.ok(!/pollinations|gemini|HTTP 4\d\d|RESOURCE_EXHAUSTED|limit: 0/i.test(raw), `still vendor-free: ${(raw.match(/.{60}(pollinations|gemini|HTTP 4\d\d|RESOURCE_EXHAUSTED|limit: 0).{60}/i) ?? [''])[0]}`);
  });
  await check('/admin → AI carries the Pictures state', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/ai?days=30', headers: { 'x-ai-unlock': unlock } });
    assert.equal(r.statusCode, 200);
    const j = r.json() as { pictures?: ReturnType<typeof picturesStatus>; failures?: Array<{ reason: string }> };
    assert.ok(j.pictures, 'pictures are in the reply');
    assert.equal(j.pictures!.main, 'pollinations');
    assert.equal(j.pictures!.backup, 'gemini');
    assert.equal(j.pictures!.providers.find((p) => p.provider === 'gemini')?.pausedFor, 'credit');
    assert.ok(j.failures?.some((f) => f.reason === 'picture_failed'), 'the lost picture is also on file as before');
    assert.ok(!/AIzaSyTESTKEY0000000000|Bearer pk/.test(r.body), 'no key in the admin reply');
    const t = (r.json() as { text?: { main: string; backup: string | null; models: { fast: string; premium: string } } }).text;
    assert.equal(t?.main, 'gemini', 'and which text models answer');
    assert.equal(t?.backup, null);
  });
  await check('and an ordinary account cannot read it', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/ai', headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.statusCode, 403);
  });
  await check('with Cloudflare set up, a Super design whose Pollinations is out of credit arrives with a free picture', async () => {
    process.env.AI_CLOUDFLARE_ACCOUNT_ID = CF_ACCOUNT;
    process.env.AI_CLOUDFLARE_API_TOKEN = 'cf-token';
    imageHealth.reset(clock);
    resetCalls();
    script.pollinations = [NO_CREDIT, NO_CREDIT, NO_CREDIT, NO_CREDIT];
    const { body, raw } = await superGen('farewell to our striker, red and black');
    const refs = imageRefs(body);
    assert.ok(refs.length >= 1 && refs.every((u) => typeof u === 'string' && u.startsWith('data:image/jpeg;base64,')), raw.slice(0, 300));
    assert.equal(calls.gemini, 0, 'Gemini is not asked for pictures');
    assert.ok(!/cloudflare|neurons/i.test(raw), 'vendor-free reply');
    const j = (await app.inject({ method: 'GET', url: '/api/admin/ai?days=30', headers: { 'x-ai-unlock': unlock } })).json() as { pictures: ReturnType<typeof picturesStatus> };
    assert.deepEqual(j.pictures.backups, ['cloudflare']);
    assert.ok(!/cf-token/.test(JSON.stringify(j)), 'no token in the admin reply');
  });
  await app.close();

  // The dashboard script still parses with the new section in it.
  await check('the admin dashboard script parses and has a Pictures section', async () => {
    const { ADMIN_JS } = await import('../src/adminPage');
    new Function(ADMIN_JS.replace(/^\s*import .*$/gm, ''));
    assert.match(ADMIN_JS, /function picturesSection\(p\)/);
    assert.match(ADMIN_JS, /picturesSection\(a\.pictures\)/);
    assert.match(ADMIN_JS, /textModelsSection\(a\.text\)/);
  });

  console.log(`\nimages: ${passed} checks passed`);
} finally {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
