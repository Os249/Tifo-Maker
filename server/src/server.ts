import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { generateSeatMap } from '../../src/core/seatmap';
import { TEMPLATES } from '../../src/core/template';
import { MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryEventsRepository, MemoryLeadsRepository } from './memoryRepo';
import { PgAiEventsRepository, PgAiUsageRepository, PgAuthRepository, PgDesignRepository, PgEventsRepository, PgLeadsRepository } from './pgRepo';
import { PgSocialRepository } from './pgSocial';
import { MemorySocialRepository } from './memorySocial';
import { MemoryStadiumRepository, PgStadiumRepository } from './stadiumRepo';
import { MemoryDailyFeatureRepository, PgDailyFeatureRepository, type DailyFeatureRepository } from './featureRepo';
import { MemoryAdminStatsRepository, PgAdminStatsRepository } from './statsRepo';
import { MemoryTrafficRepository, PgTrafficRepository, type TrafficRepository } from './trafficRepo';
import { MemoryFeedbackRepository, PgFeedbackRepository, type FeedbackRepository } from './feedbackRepo';
import { buildApp, type TemplateInfo } from './routes';
import { createEmailSender } from './email';
import { seedShowcase, seedTemplates } from './seedTemplates';
import type { AuthRepository, DesignRepository } from './repo';
import { envNum } from './env';
import { logConfigWarnings, logProviderSetup } from './preflight';
import { schemaStatements } from './schema';
import { SocMonitor, socKeyFrom } from './soc';
import { MemorySocRepository, PgSocRepository } from './socRepo';

/**
 * Production bootstrap.
 *
 * - DATABASE_URL selects Postgres and the schema is applied on boot (idempotent
 *   CREATE TABLE IF NOT EXISTS), so a fresh database is usable immediately.
 * - Without DATABASE_URL the server still runs on in-memory repos, but ONLY in
 *   development: in production (NODE_ENV=production) a missing DATABASE_URL is a
 *   hard error, because the silent in-memory fallback would lose every design on
 *   restart — a dangerous default to ship by accident.
 * - Serves the built frontend (dist/) from the same origin as the API.
 *
 * Seat counts come from the SAME generator the browser uses — core/ being
 * DOM-free is what makes server-side validation byte-identical.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';

const templates: TemplateInfo[] = TEMPLATES.map((t) => ({
  id: t.id,
  version: t.version,
  name: t.name,
  seatCount: generateSeatMap(t).count,
}));

// Locate the built frontend. In the container the layout is /app/dist next to
// /app/server; DIST_DIR overrides for other layouts.
function resolveDist(): string | undefined {
  if (process.env.DIST_DIR) return existsSync(process.env.DIST_DIR) ? process.env.DIST_DIR : undefined;
  for (const candidate of [join(__dirname, '../../dist'), join(process.cwd(), 'dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

async function applySchema(pool: pg.Pool): Promise<void> {
  const schemaPath = join(__dirname, '../schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  // Run statements individually so one failing statement on a pre-existing
  // database can't abort the rest. The splitter is in schema.ts so a test can
  // apply the file exactly the way a deploy does — see the Postgres block in
  // server.test.mts, which forces password_hash back to NOT NULL and checks the
  // migration takes.
  const statements = schemaStatements(sql);
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (e) {
      console.error('[tifo] schema statement skipped:', (e as Error).message);
    }
  }
}

async function main(): Promise<void> {
  const staticDir = resolveDist();
  if (!staticDir) {
    console.warn('[tifo] no dist/ found: serving API only (run `npm run build` first to serve the app)');
  }
  // Moderators are designated via env, never via any API — bootstrap-safe.
  const adminUsernames = (process.env.ADMIN_USERNAMES ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  let app;
  let seedRepos: { designs: DesignRepository; auth: AuthRepository } | null = null;
  // One sender for account mail and security alerts, so the email tab's
  // delivery counts cover both.
  const emailSender = createEmailSender();
  const socOptions = {
    key: socKeyFrom(process.env),
    sender: emailSender,
    alertTo: process.env.SECURITY_ALERT_TO,
    publicUrl: process.env.PUBLIC_URL,
  };
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await applySchema(pool);
    // Community stadium submissions — best-effort table init so a schema slip here
    // can never block server boot; on failure the feature is simply disabled.
    let stadiums: PgStadiumRepository | undefined;
    try {
      const s = new PgStadiumRepository(pool);
      await s.init();
      stadiums = s;
    } catch (e) {
      console.error('[tifo] community_stadiums init failed: submissions disabled:', e);
    }
    // Traffic sources — best-effort table init, like community_stadiums above, so a
    // schema slip here can never block boot; on failure the feature simply stays off.
    let traffic: TrafficRepository | undefined;
    try {
      const t = new PgTrafficRepository(pool);
      await t.init();
      await t.purge();
      // Daily minimisation: strip visitor keys past the anonymisation window and drop
      // rows past retention. unref() so this timer never holds the process open.
      setInterval(() => void t.purge(), 24 * 60 * 60 * 1000).unref();
      traffic = t;
    } catch (e) {
      console.error('[tifo] visits init failed: traffic sources disabled:', e);
    }
    let feedback: FeedbackRepository | undefined;
    try {
      const fb = new PgFeedbackRepository(pool);
      await fb.init();
      feedback = fb;
    } catch (e) {
      console.error('[tifo] feedback init failed: in-product reports disabled:', e);
    }
    // Tifo of the day — same best-effort init. Without the table the home page
    // simply has no featured section; it is never a reason to fail a deploy.
    let featured: DailyFeatureRepository | undefined;
    try {
      const df = new PgDailyFeatureRepository(pool);
      await df.init();
      featured = df;
    } catch (e) {
      console.error('[tifo] daily_features init failed: tifo of the day disabled:', e);
    }
    // Security monitor. Best-effort like the tables above: if its tables cannot
    // be created, alerts and recent events still work from memory, history is
    // not kept, and the Security tab shows the storage error.
    const socRepo = new PgSocRepository(pool);
    try {
      await socRepo.init();
      await socRepo.purge();
      // Thirty days, then gone. unref() so the timer never holds the process open.
      setInterval(() => void socRepo.purge().catch(() => {}), 6 * 60 * 60 * 1000).unref();
    } catch (e) {
      console.error('[tifo] security log init failed: history will not be kept:', e);
    }
    const soc = new SocMonitor({ ...socOptions, repo: socRepo });
    const pgDesigns = new PgDesignRepository(pool);
    const pgAuth = new PgAuthRepository(pool);
    seedRepos = { designs: pgDesigns, auth: pgAuth };
    app = await buildApp(pgDesigns, pgAuth, templates, {
      staticDir,
      rateLimit: true,
      logger: isProd,
      events: new PgEventsRepository(pool),
      adminUsernames: adminUsernames,
      social: new PgSocialRepository(pool),
      leads: new PgLeadsRepository(pool),
      aiUsage: new PgAiUsageRepository(pool),
      aiEvents: new PgAiEventsRepository(pool),
      aiFreeLimit: envNum('AI_FREE_LIMIT', 10, 0), // premium designs per hour
      stadiums,
      stats: new PgAdminStatsRepository(pool),
      traffic,
      feedback,
      featured,
      feedbackTo: process.env.FEEDBACK_TO,
      emailSender,
      publicUrl: process.env.PUBLIC_URL,
      verifyResendCooldownMs: envNum('VERIFY_RESEND_COOLDOWN_MS', 60_000, 0, 3_600_000),
      soc,
      database: 'postgres',
    });
  } else {
    if (isProd) {
      console.error(
        '[tifo] FATAL: DATABASE_URL is required in production. Without it the server would ' +
          'use an in-memory store and lose all designs on restart. Set DATABASE_URL or unset NODE_ENV.',
      );
      process.exit(1);
    }
    const auth = new MemoryAuthRepository();
    const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
    seedRepos = { designs, auth };
    app = await buildApp(designs, auth, templates, {
      staticDir,
      rateLimit: false,
      logger: false,
      events: new MemoryEventsRepository(),
      adminUsernames: adminUsernames,
      social: new MemorySocialRepository(designs, auth),
      leads: new MemoryLeadsRepository(),
      aiUsage: new MemoryAiUsageRepository(),
      aiEvents: new MemoryAiEventsRepository((id) => auth.usernameOf(id)),
      aiFreeLimit: envNum('AI_FREE_LIMIT', 10, 0), // premium designs per hour
      stadiums: new MemoryStadiumRepository(),
      stats: new MemoryAdminStatsRepository(designs),
      traffic: new MemoryTrafficRepository(),
      feedback: new MemoryFeedbackRepository(),
      featured: new MemoryDailyFeatureRepository(),
      feedbackTo: process.env.FEEDBACK_TO,
      emailSender,
      publicUrl: process.env.PUBLIC_URL,
      verifyResendCooldownMs: envNum('VERIFY_RESEND_COOLDOWN_MS', 60_000, 0, 3_600_000),
      soc: new SocMonitor({ ...socOptions, repo: new MemorySocRepository() }),
      database: 'memory',
    });
  }

  // Say what the deployment has not been told, before it starts serving. Every
  // one of these has a safe default, which is why they go unnoticed.
  logConfigWarnings();
  logProviderSetup();

  const port = envNum('PORT', 8787, 1, 65535);
  await app.listen({ port, host: '0.0.0.0' });

  // Railway stops the old container with SIGTERM on every deploy. Without a
  // handler Node exits on the spot: requests in flight are cut, a reset email
  // queued after its reply is never sent, and the last seconds of the security
  // log are lost. Close properly, but never hang a deploy waiting for it.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.log(`[tifo] ${signal}: closing (in-flight requests, queued email, security log)`);
      setTimeout(() => process.exit(0), 10_000).unref();
      app.close().then(() => process.exit(0), () => process.exit(0));
    });
  }
  console.log(
    `tifo-maker on :${port} (${process.env.DATABASE_URL ? 'postgres' : 'memory'} repos, ` +
      `${staticDir ? 'serving app + api' : 'api only'}, ` +
      `${templates.map((t) => `${t.id}=${t.seatCount}`).join(', ')})`,
  );

  // Load the starter-template library — AFTER listen, and not awaited.
  //
  // It used to run before, and on a fresh Postgres it took about forty seconds
  // to write 619 designs, so the port opened too late and Railway killed the
  // deploy on its thirty-second healthcheck. Nothing about seeding needs to
  // block the site from answering: a gallery that fills a second after boot is
  // strictly better than one that never gets to come up. Best-effort, too, so a
  // problem in the library can never take the site down.
  if (seedRepos) {
    const { designs, auth: authRepo } = seedRepos;
    void (async () => {
      try {
        const file = join(__dirname, '../data/templates.jsonl');
        const started = Date.now();
        const r = await seedTemplates(designs, authRepo, file);
        if (r.added || r.skipped.length) {
          console.log(`[tifo] templates: +${r.added} added, ${r.existing} already present` +
            (r.skipped.length ? `, ${r.skipped.length} skipped` : '') +
            ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        }
        // The banner showcase, after the library so it is the newest of it.
        const sc = await seedShowcase(designs, authRepo, join(__dirname, '../data/showcase.jsonl'));
        if (sc.added || sc.skipped.length) {
          console.log(`[tifo] banner showcase: +${sc.added} added, ${sc.existing} already present` +
            (sc.skipped.length ? `, skipped ${sc.skipped.join(', ')}` : ''));
        }
        // AFTER the library lands, not before. Its batch insert does not set the
        // filter facets, so running the backfill first would sweep an empty
        // table and then miss all 619 rows until the next restart.
        if (designs instanceof PgDesignRepository) {
          const n = await designs.backfillFacets();
          if (n) console.log(`[tifo] filter facets: backfilled ${n} design(s)`);
        }
      } catch (e) {
        console.warn('[tifo] template seeding skipped:', (e as Error).message);
      }
    })();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
