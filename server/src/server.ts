import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { shippedTemplateInfo } from './templates';
import { MemoryAiBudgetRepository, MemoryAiEventsRepository, MemoryAiUsageRepository, MemoryAuthRepository, MemoryDesignRepository, MemoryEventsRepository, MemoryLeadsRepository } from './memoryRepo';
import { PgAiBudgetRepository, PgAiEventsRepository, PgAiUsageRepository, PgAuthRepository, PgDesignRepository, PgEventsRepository, PgLeadsRepository } from './pgRepo';
import { MemoryProRepository, PgProRepository } from './proRepo';
import { PgSocialRepository } from './pgSocial';
import { MemorySocialRepository } from './memorySocial';
import { MemoryStadiumRepository, PgStadiumRepository } from './stadiumRepo';
import { MemoryDailyFeatureRepository, PgDailyFeatureRepository, type DailyFeatureRepository } from './featureRepo';
import { MemoryAdminStatsRepository, PgAdminStatsRepository } from './statsRepo';
import { BatchedTrafficRepository, MemoryTrafficRepository, PgTrafficRepository, type TrafficRepository } from './trafficRepo';
import { MemoryFeedbackRepository, PgFeedbackRepository, type FeedbackRepository } from './feedbackRepo';
import { buildApp, ORIGIN_SECRET_MIN, TRASH_DAYS, type TemplateInfo } from './routes';
import { createEmailSender } from './email';
import { seedShowcase, seedTemplates } from './seedTemplates';
import { EVENTS_RETENTION_DAYS, type AuthRepository, type DesignRepository } from './repo';
import { envNum } from './env';
import { logConfigWarnings, logProviderSetup } from './preflight';
import { applyForeignKeyIndexes, applyMaintenanceIndexes, HASH_RECOMPUTE_TASK, hashTrustAfterBoot, SchemaLedger, schemaStatements, type SchemaReport } from './schema';
import { randomCursorKey, storedCursorKey } from './feedCursor';
import { runRetention } from './retention';
import { SocMonitor, socKeyFrom } from './soc';
import { createPool } from './db';
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

// Every ground that ships, not only the three generic bowls — see templates.ts.
const templates: TemplateInfo[] = shippedTemplateInfo();

// Locate the built frontend. In the container the layout is /app/dist next to
// /app/server; DIST_DIR overrides for other layouts.
function resolveDist(): string | undefined {
  if (process.env.DIST_DIR) return existsSync(process.env.DIST_DIR) ? process.env.DIST_DIR : undefined;
  for (const candidate of [join(__dirname, '../../dist'), join(process.cwd(), 'dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

/**
 * schema.sql, through the schema ledger (schema.ts, performance plan P2.15):
 * what a previous boot applied is skipped, what is already in the database is
 * recorded without being run, and the rest runs one statement at a time with
 * a 3 s lock timeout, so a deploy never queues behind a long lock while the
 * old instance is serving. One that fails is logged and tried again at the
 * next boot; a security one not in force shows on the posture panel. The
 * splitter is in schema.ts so a test can apply the file exactly the way a
 * deploy does (the Postgres block in server.test.mts).
 */
async function applySchema(pool: pg.Pool): Promise<{ ledger: SchemaLedger; report: SchemaReport }> {
  const sql = readFileSync(join(__dirname, '../schema.sql'), 'utf8');
  const ledger = new SchemaLedger(pool);
  const started = Date.now();
  await ledger.load();
  const report = await ledger.applyAll(schemaStatements(sql));
  console.log(
    `[tifo] schema: ${report.applied} applied, ${report.skipped + report.present} already in place` +
      (report.failed.length ? `, ${report.failed.length} not applied (tried again at the next boot)` : '') +
      ` (${Date.now() - started} ms)`,
  );
  if (report.pendingSecurity.length) {
    console.error(`[tifo] SECURITY: not in force in the database: ${report.pendingSecurity.map((p) => p.id).join(', ')}. See /admin#security.`);
  }
  return { ledger, report };
}

async function main(): Promise<void> {
  // The origin lock (routes.ts, performance plan P2.2) is only as good as its
  // secret: a short one is refused here, before anything is served.
  const originSecret = process.env.ORIGIN_SECRET?.trim();
  if (originSecret && originSecret.length < ORIGIN_SECRET_MIN) {
    console.error(`[tifo] FATAL: ORIGIN_SECRET is ${originSecret.length} characters; it must be at least ${ORIGIN_SECRET_MIN} random characters (openssl rand -hex 32). Unset it to run without the origin lock.`);
    process.exit(1);
  }
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
  let maintenancePool: pg.Pool | null = null;
  // Page views wait here and are written every five seconds (performance plan
  // P2.18); the last of them are written when the server is stopped (below).
  let visitBuffer: BatchedTrafficRepository | null = null;
  // Slow, non-request work that waits for the port to open (P2.15): the
  // purges, and the hashes of pictures stored before hashes were (P2.4).
  const afterListen: (() => Promise<unknown>)[] = [];
  if (process.env.DATABASE_URL) {
    // Requests on one pool, slow non-request work on a small one of its own
    // (server/src/db.ts, performance plan P1.26).
    const pool = createPool(process.env.DATABASE_URL, 'app');
    const maint = createPool(process.env.DATABASE_URL, 'maintenance');
    maintenancePool = maint;
    const { ledger, report: schemaReport } = await applySchema(maint);
    // The repositories' own tables go through the same ledger.
    const ddl = (sql: string): Promise<unknown> => ledger.run(sql);
    // Community stadium submissions — best-effort table init so a schema slip here
    // can never block server boot; on failure the feature is simply disabled.
    let stadiums: PgStadiumRepository | undefined;
    try {
      const s = new PgStadiumRepository(pool, maint);
      await s.init(ddl);
      stadiums = s;
    } catch (e) {
      console.error('[tifo] community_stadiums init failed: submissions disabled:', e);
    }
    // Traffic sources — best-effort table init, like community_stadiums above, so a
    // schema slip here can never block boot; on failure the feature simply stays off.
    let traffic: TrafficRepository | undefined;
    try {
      const t = new PgTrafficRepository(pool, maint);
      await t.init(ddl);
      afterListen.push(() => t.purge());
      // Daily minimisation: strip visitor keys past the anonymisation window and drop
      // rows past retention. unref() so this timer never holds the process open.
      setInterval(() => void t.purge(), 24 * 60 * 60 * 1000).unref();
      visitBuffer = new BatchedTrafficRepository(t).start();
      traffic = visitBuffer;
    } catch (e) {
      console.error('[tifo] visits init failed: traffic sources disabled:', e);
    }
    let feedback: FeedbackRepository | undefined;
    try {
      const fb = new PgFeedbackRepository(pool, maint);
      await fb.init(ddl);
      feedback = fb;
    } catch (e) {
      console.error('[tifo] feedback init failed: in-product reports disabled:', e);
    }
    // Tifo of the day — same best-effort init. Without the table the home page
    // simply has no featured section; it is never a reason to fail a deploy.
    let featured: DailyFeatureRepository | undefined;
    try {
      const df = new PgDailyFeatureRepository(pool, maint);
      await df.init(ddl);
      featured = df;
    } catch (e) {
      console.error('[tifo] daily_features init failed: tifo of the day disabled:', e);
    }
    // Security monitor. Best-effort like the tables above: if its tables cannot
    // be created, alerts and recent events still work from memory, history is
    // not kept, and the Security tab shows the storage error.
    const socRepo = new PgSocRepository(pool, maint);
    try {
      await socRepo.init(ddl);
      afterListen.push(() => socRepo.purge());
      // Thirty days, then gone. unref() so the timer never holds the process open.
      setInterval(() => void socRepo.purge().catch(() => {}), 6 * 60 * 60 * 1000).unref();
    } catch (e) {
      console.error('[tifo] security log init failed: history will not be kept:', e);
    }
    const soc = new SocMonitor({ ...socOptions, repo: socRepo });
    // Funnel events are kept for EVENTS_RETENTION_DAYS (repo.ts), then deleted,
    // once at boot and daily, like the visits and the security log.
    const events = new PgEventsRepository(pool, maint);
    const pruneEvents = (): Promise<unknown> => {
      const started = Date.now();
      return events.purge(new Date(Date.now() - EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000)).then(
        (n) => console.log(`[tifo] retention: events (funnel, after ${EVENTS_RETENTION_DAYS} days): ${n} removed in ${Date.now() - started} ms`),
        (e) => console.error('[tifo] events purge failed:', e),
      );
    };
    afterListen.push(pruneEvents);
    setInterval(() => void pruneEvents(), 24 * 60 * 60 * 1000).unref();
    // Pro's allowance counters: a row is a week's or a month's count, so one
    // untouched for 45 days is history nobody reads.
    const proRepo = new PgProRepository(pool);
    const pruneAllowances = (): Promise<unknown> =>
      proRepo.purgeAllowances(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)).then(
        (n) => { if (n) console.log(`[tifo] retention: Pro allowance counters: ${n} removed`); },
        (e) => console.error('[tifo] Pro allowance purge failed:', e),
      );
    afterListen.push(pruneAllowances);
    setInterval(() => void pruneAllowances(), 24 * 60 * 60 * 1000).unref();
    const pgDesigns = new PgDesignRepository(pool, maint);
    // The stored content hashes decide the thumbnail 304 and the anonymous
    // scene's kept strip (P2.4, P2.5). They are trusted only while the
    // database's own hash triggers are in force and every hash stored before
    // them has been recomputed from its bytes (stage 2 review): until then the
    // routes hash the bytes they read instead. A boot that had to make or
    // re-enable a trigger recomputes again (hashTrustAfterBoot). The recompute
    // runs after listen, and is recorded in the schema ledger when done, so a
    // boot that stops halfway does it again.
    const hashTrust = await hashTrustAfterBoot(ledger, schemaReport);
    let hashesTrusted = hashTrust.trusted;
    if (!hashTrust.inForce) {
      console.error('[tifo] SECURITY: the content-hash triggers are not in force; stored hashes are not trusted until a boot applies them.');
    }
    afterListen.push(async () => {
      if (!hashTrust.recompute) return;
      const n = await pgDesigns.backfillHashes();
      await ledger.mark(HASH_RECOMPUTE_TASK);
      hashesTrusted = true;
      console.log(`[tifo] content hashes: recomputed from the stored bytes (${n} corrected); trusted from now on`);
    });
    const pgAuth = new PgAuthRepository(pool, maint);
    seedRepos = { designs: pgDesigns, auth: pgAuth };
    // The feed cursor's key (P3.4), kept in the database so a cursor handed
    // out before a deploy, or by the other instance, is still good. Without
    // it, one for this process: a client mid-scroll at the next deploy is
    // told to start again from the top.
    let feedCursorKey: Buffer;
    try {
      feedCursorKey = await storedCursorKey(maint);
    } catch (e) {
      console.error(`[tifo] feed cursor key not read from the database (cursors last until the next boot): ${(e as Error).message}`);
      feedCursorKey = randomCursorKey();
    }
    app = await buildApp(pgDesigns, pgAuth, templates, {
      staticDir,
      rateLimit: true,
      logger: isProd,
      events,
      adminUsernames: adminUsernames,
      social: new PgSocialRepository(pool),
      leads: new PgLeadsRepository(pool),
      aiUsage: new PgAiUsageRepository(pool),
      aiEvents: new PgAiEventsRepository(pool, maint),
      aiBudget: new PgAiBudgetRepository(pool),
      aiFreeLimit: envNum('AI_FREE_LIMIT', 10, 0), // premium designs per hour
      pro: proRepo,
      stadiums,
      stats: new PgAdminStatsRepository(maint), // the dashboard's aggregates, admin only
      traffic,
      feedback,
      featured,
      feedbackTo: process.env.FEEDBACK_TO,
      aiAlertTo: process.env.AI_ALERT_TO || process.env.SECURITY_ALERT_TO,
      emailSender,
      publicUrl: process.env.PUBLIC_URL,
      verifyResendCooldownMs: envNum('VERIFY_RESEND_COOLDOWN_MS', 60_000, 0, 3_600_000),
      soc,
      database: 'postgres',
      schemaStatus: () => ({ pendingSecurity: schemaReport.pendingSecurity, failed: schemaReport.failed.length }),
      storedHashesTrusted: () => hashesTrusted,
      feedCursorKey,
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
      aiBudget: new MemoryAiBudgetRepository(),
      aiFreeLimit: envNum('AI_FREE_LIMIT', 10, 0), // premium designs per hour
      pro: new MemoryProRepository(),
      stadiums: new MemoryStadiumRepository(),
      stats: new MemoryAdminStatsRepository(designs),
      traffic: (visitBuffer = new BatchedTrafficRepository(new MemoryTrafficRepository()).start()),
      feedback: new MemoryFeedbackRepository(),
      featured: new MemoryDailyFeatureRepository(),
      feedbackTo: process.env.FEEDBACK_TO,
      aiAlertTo: process.env.AI_ALERT_TO || process.env.SECURITY_ALERT_TO,
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
      console.log(`[tifo] ${signal}: closing (in-flight requests, queued email, security log, page views)`);
      setTimeout(() => process.exit(0), 10_000).unref();
      // The requests first (their page views join the buffer as they finish),
      // then one last write of the buffered page views, at most 2 s of it.
      const lastVisits = (): Promise<void> => visitBuffer?.close(2_000) ?? Promise.resolve();
      app.close().then(lastVisits, lastVisits).then(() => process.exit(0), () => process.exit(0));
    });
  }
  console.log(
    `tifo-maker on :${port} (${process.env.DATABASE_URL ? 'postgres' : 'memory'} repos, ` +
      `${staticDir ? 'serving app + api' : 'api only'}, ` +
      `${templates.map((t) => `${t.id}=${t.seatCount}`).join(', ')})`,
  );

  // The boot purges and backfills: after listen, one after another, on the
  // maintenance pool, never awaited (P2.15). Each is best-effort and runs again
  // on its own timer or at the next boot.
  void (async () => {
    for (const task of afterListen) await task().catch((e) => console.error('[tifo] boot task failed:', (e as Error).message));
  })();

  // The foreign-key indexes (schema.ts, performance plan P1.25), then the
  // feed's and the retention sweeps' (P3.4, P3.5): after listen, not awaited,
  // on the maintenance pool. Built CONCURRENTLY, so the site keeps answering
  // while one builds; a failure is logged and retried at the next boot, and
  // is never a reason not to serve.
  //
  // Then the retention sweeps (retention.ts, P3.5), and every six hours: on
  // the maintenance pool, in batches, each with a time budget, one log line
  // each. One run at a time.
  if (maintenancePool) {
    const maint = maintenancePool;
    let sweeping = false;
    const sweep = async (): Promise<void> => {
      if (sweeping) return;
      sweeping = true;
      try {
        await runRetention(maint);
      } catch (e) {
        console.error('[tifo] retention sweep failed:', (e as Error).message);
      } finally {
        sweeping = false;
      }
    };
    void (async () => {
      try {
        const fk = await applyForeignKeyIndexes(maint);
        if (fk.built.length) console.log(`[tifo] foreign-key indexes built: ${fk.built.join(', ')}`);
        const more = await applyMaintenanceIndexes(maint);
        if (more.built.length) console.log(`[tifo] feed and retention indexes built: ${more.built.join(', ')}`);
        if (more.dropped.length) console.log(`[tifo] superseded indexes dropped: ${more.dropped.join(', ')}`);
      } catch (e) {
        console.error('[tifo] indexes skipped:', (e as Error).message);
      }
      await sweep();
    })();
    setInterval(() => void sweep(), 6 * 60 * 60 * 1000).unref();
  }

  // Empty the Trash of anything that has sat there for TRASH_DAYS. After
  // listen, not awaited, and best-effort: a slow delete must never hold the
  // port shut, and one that fails simply runs again at the next sweep.
  if (seedRepos) {
    const { designs } = seedRepos;
    const sweep = async (): Promise<void> => {
      try {
        const n = await designs.purgeTrashed(new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000));
        if (n) console.log(`[tifo] trash: deleted ${n} project(s) past ${TRASH_DAYS} days`);
      } catch (e) {
        console.warn('[tifo] trash sweep failed:', (e as Error).message);
      }
    };
    void sweep();
    setInterval(() => void sweep(), 6 * 60 * 60 * 1000).unref();
  }

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
          // Every design's facets checked against this build's rules, not only
          // the ones never computed: the feed's counts are read from them now.
          const n = await designs.resyncFacets();
          if (n) console.log(`[tifo] filter facets: brought ${n} design(s) up to date`);
        }
        // The feed's facet counts are remembered for a minute (P1.12); what
        // just landed should be counted now, not after it.
        app.forgetPublicCounts();
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
