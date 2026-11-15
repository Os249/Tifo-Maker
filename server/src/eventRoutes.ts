/**
 * Tifo events: what a fan reads and does (/api/events...), and what the admin
 * does on /admin (/api/admin/events...). The rules are in tifoEvents.ts and
 * the rows in eventRepo.ts.
 *
 * Nothing a browser sends decides a stage, a count or a winner: the stage is
 * the server's clock against the event's times, votes are hidden until the
 * admin confirms the result, and the result is ranked here from the votes
 * that count. Entering and voting are free for every account; Pro is the
 * prize, never the ticket.
 *
 * With no event made, every public route answers "none" and nothing on the
 * site changes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventEntry, EventRepository, TifoEvent } from './eventRepo';
import type { DesignRepository, GalleryItem, UserRow } from './repo';
import {
  MAX_ENTRIES_SHOWN, PUBLIC_STAGES, currentEvent, prizeTooSoon, rankEntries, readEventFields, readReason, shuffledFor, stageEnds, stageOf,
  voteCounts, type EventStage,
} from './tifoEvents';

export interface EventRouteDeps {
  events: EventRepository;
  designs: Pick<DesignRepository, 'getPublicItem' | 'listByOwner'>;
  userOf: (req: FastifyRequest) => Promise<string | null>;
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  accountOf: (req: FastifyRequest, userId: string) => Promise<UserRow | null>;
  adminAccess: (req: FastifyRequest) => Promise<boolean>;
  /**
   * Give the winner their days of Pro, after any Pro they hold; the pass's id.
   * Absent when the server has no Pro to give: the result is confirmed with
   * the title alone.
   */
  grantPrize?: (userId: string, days: number, actorId: string | null) => Promise<string | null>;
  /** Pro's mode, for the admin's page ("the prize shows to nobody while Pro is off"). */
  proMode?: () => string;
  now?: () => Date;
  readConfig?: object;
  writeConfig?: object;
  adminConfig?: object;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** How long the list of events is remembered between reads: the home page asks on every visit. */
const LIST_FOR_MS = 15_000;

interface Card {
  designId: string;
  title: string;
  titleAr: string | null;
  ownerId: string | null;
  ownerName: string;
  hasThumbnail: boolean;
  remixedFromName: string | null;
}

const cardOf = (g: GalleryItem): Card => ({
  designId: g.id,
  title: g.title,
  titleAr: g.titleAr ?? null,
  ownerId: g.ownerId,
  ownerName: g.ownerName,
  hasThumbnail: g.hasThumbnail,
  remixedFromName: g.remixedFromName ?? null,
});

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  const { events, designs } = deps;
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const read = deps.readConfig ?? {};
  const write = deps.writeConfig ?? {};
  const admin = deps.adminConfig ?? {};

  let listed: { at: number; rows: TifoEvent[] } | null = null;
  const allEvents = async (): Promise<TifoEvent[]> => {
    if (listed && Date.now() - listed.at < LIST_FOR_MS) return listed.rows;
    const rows = await events.list();
    listed = { at: Date.now(), rows };
    return rows;
  };
  const forget = (): void => {
    listed = null;
  };

  /** An event as everyone may read it. */
  const pub = (e: TifoEvent, stage: EventStage) => ({
    slug: e.slug,
    titleEn: e.titleEn,
    titleAr: e.titleAr,
    lineEn: e.lineEn,
    lineAr: e.lineAr,
    announceAt: e.announceAt,
    openAt: e.openAt,
    voteAt: e.voteAt,
    closeAt: e.closeAt,
    prizeDays: e.prizeDays,
    stage,
    stageEnds: stageEnds(e, stage),
  });

  /** A public event by its address, or null: drafts and cancelled events are nobody's to read. */
  const publicBySlug = async (slug: string): Promise<{ e: TifoEvent; stage: EventStage } | null> => {
    if (!SLUG.test(slug)) return null;
    const e = await events.bySlug(slug);
    if (!e) return null;
    const stage = stageOf(e, now());
    return PUBLIC_STAGES.includes(stage) ? { e, stage } : null;
  };

  /** The entries' cards; an entry whose tifo is private or gone has none. */
  const cardsOf = async (rows: EventEntry[]): Promise<Map<string, Card>> => {
    const out = new Map<string, Card>();
    const got = await Promise.all(rows.slice(0, MAX_ENTRIES_SHOWN).map((x) => designs.getPublicItem(x.designId).catch(() => null)));
    for (const g of got) if (g) out.set(g.id, cardOf(g));
    return out;
  };

  // --------------------------------------------------------------- public ---

  /** The one event the home and community pages speak of, or none. */
  app.get('/api/events/current', read, async (_req, reply) => {
    void reply.header('cache-control', 'no-store');
    const e = currentEvent(await allEvents(), now());
    if (!e) return { event: null };
    const stage = stageOf(e, now());
    let winner: Card | null = null;
    if (stage === 'result' && e.winnerDesign) {
      const g = await designs.getPublicItem(e.winnerDesign).catch(() => null);
      winner = g ? cardOf(g) : null;
    }
    return { event: { ...pub(e, stage), winner } };
  });

  /** Every event a visitor can read, newest first. */
  app.get('/api/events', read, async (_req, reply) => {
    void reply.header('cache-control', 'no-store');
    const t = now();
    const out = [];
    for (const e of await allEvents()) {
      const stage = stageOf(e, t);
      if (PUBLIC_STAGES.includes(stage)) out.push(pub(e, stage));
    }
    return { events: out };
  });

  /**
   * One event: its theme and times, its entries once entries have opened, and
   * what the caller has done in it. Votes are not in the answer until the
   * result is confirmed, and while they are being taken the entries come in
   * an order of the caller's own.
   */
  app.get('/api/events/:slug', read, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const found = await publicBySlug((req.params as { slug: string }).slug);
    if (!found) return reply.code(404).send({ error: 'no such event' });
    const { e, stage } = found;
    const userId = await deps.userOf(req).catch(() => null);
    const user = userId ? await deps.accountOf(req, userId).catch(() => null) : null;
    const me = {
      signedIn: !!user,
      emailVerified: !!user?.emailVerifiedAt,
      entry: null as string | null,
      votes: [] as string[],
    };
    if (stage === 'announced') return { event: pub(e, stage), entries: [], out: [], podium: [], me };

    const rows = await events.entries(e.id);
    const cards = await cardsOf(rows);
    const live = rows.filter((x) => cards.has(x.designId));
    if (user) {
      me.entry = live.find((x) => x.userId === user.id)?.designId ?? null;
      if (stage !== 'open') me.votes = await events.votesBy(e.id, user.id);
    }
    const standing = live.filter((x) => !x.disqualifiedReason);
    const out = live.filter((x) => x.disqualifiedReason).map((x) => ({ ...cards.get(x.designId)!, reason: x.disqualifiedReason }));

    if (stage === 'result') {
      const tally = await events.tally(e.id);
      const ranked = rankEntries(rows, tally, (id) => cards.has(id));
      const place = (id: string | null): number => (id === null ? 0 : id === e.winnerDesign ? 1 : id === e.secondDesign ? 2 : id === e.thirdDesign ? 3 : 0);
      const entries = ranked.map((r) => ({ ...cards.get(r.designId)!, votes: r.votes, place: place(r.designId) }));
      // The podium is what was confirmed, whatever has happened to votes since.
      entries.sort((a, b) => (a.place || 9) - (b.place || 9));
      return { event: pub(e, stage), entries, out, podium: entries.filter((x) => x.place > 0), me };
    }

    const ordered = stage === 'open'
      ? [...standing].sort((a, b) => b.enteredAt.localeCompare(a.enteredAt))
      // Voting, or closed and waiting: the same shuffle for one visitor, a different one for the next.
      : shuffledFor(standing, `${e.id}:${user?.id ?? `day:${now().toISOString().slice(0, 10)}`}`);
    return { event: pub(e, stage), entries: ordered.map((x) => cards.get(x.designId)!), out, podium: [], me };
  });

  /** The caller's tifos that can be entered: published, and made since the event was announced. */
  app.get('/api/events/:slug/mine', read, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const found = await publicBySlug((req.params as { slug: string }).slug);
    if (!found) return reply.code(404).send({ error: 'no such event' });
    const mine = await designs.listByOwner(userId);
    const since = Date.parse(found.e.announceAt);
    return {
      designs: mine
        .filter((d) => d.isPublic && !d.deletedAt && Date.parse(d.createdAt) >= since)
        .slice(0, 100)
        .map((d) => ({ id: d.id, title: d.title })),
      // Published ones that are too old, so the page can say why they are not offered.
      older: mine.filter((d) => d.isPublic && !d.deletedAt && Date.parse(d.createdAt) < since).length,
    };
  });

  /** Enter one tifo, or change the entry, while entries are open. */
  app.post('/api/events/:slug/enter', write, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const found = await publicBySlug((req.params as { slug: string }).slug);
    if (!found) return reply.code(404).send({ error: 'no such event' });
    if (found.stage !== 'open') return reply.code(409).send({ error: 'entries are not open', code: 'closed' });
    const designId = (req.body as { designId?: unknown } | null)?.designId;
    if (typeof designId !== 'string' || !UUID.test(designId)) return reply.code(400).send({ error: 'a tifo is required' });
    const g = await designs.getPublicItem(designId).catch(() => null);
    if (!g) return reply.code(409).send({ error: 'publish the tifo first', code: 'not_public' });
    if (g.ownerId !== userId) return reply.code(403).send({ error: 'only your own tifo can be entered', code: 'not_yours' });
    if (g.isTemplate) return reply.code(409).send({ error: 'a library tifo cannot be entered', code: 'template' });
    if (Date.parse(g.createdAt) < Date.parse(found.e.announceAt)) {
      return reply.code(409).send({ error: 'the tifo must be made after the event was announced', code: 'too_old' });
    }
    const r = await events.putEntry(found.e.id, userId, designId, now());
    if (r === 'taken') return reply.code(409).send({ error: 'that tifo is entered already', code: 'taken' });
    return { ok: true, entry: designId };
  });

  /** Take the caller's entry out, while entries are open. */
  app.delete('/api/events/:slug/enter', write, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const found = await publicBySlug((req.params as { slug: string }).slug);
    if (!found) return reply.code(404).send({ error: 'no such event' });
    if (found.stage !== 'open') return reply.code(409).send({ error: 'entries are frozen', code: 'closed' });
    await events.removeEntry(found.e.id, userId);
    return { ok: true };
  });

  /**
   * Vote for an entry, or take the vote back, while voting is open. A vote
   * needs a verified email, as a like does; nobody votes for their own entry.
   * Whether it counts toward the result (an email verified before voting
   * opened) is decided here and never said: a ring made for the event votes
   * into the dark.
   */
  app.post('/api/events/:slug/vote', write, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const found = await publicBySlug((req.params as { slug: string }).slug);
    if (!found) return reply.code(404).send({ error: 'no such event' });
    if (found.stage !== 'voting') return reply.code(409).send({ error: 'voting is not open', code: 'closed' });
    const b = (req.body ?? {}) as { designId?: unknown; on?: unknown };
    if (typeof b.designId !== 'string' || !UUID.test(b.designId) || typeof b.on !== 'boolean') return reply.code(400).send({ error: 'a tifo and on (true or false) are required' });
    if (!b.on) {
      await events.unvote(found.e.id, b.designId, userId);
      return { ok: true, voted: false };
    }
    const voter = await deps.accountOf(req, userId).catch(() => null);
    if (!voter?.emailVerifiedAt) return reply.code(403).send({ error: 'verify your email to vote', code: 'verify_first' });
    const entry = (await events.entries(found.e.id)).find((x) => x.designId === b.designId);
    if (!entry || entry.disqualifiedReason) return reply.code(404).send({ error: 'no such entry' });
    if (entry.userId === userId) return reply.code(403).send({ error: 'you cannot vote for your own entry', code: 'own' });
    if (!(await designs.getPublicItem(entry.designId).catch(() => null))) return reply.code(404).send({ error: 'no such entry' });
    await events.vote(found.e.id, entry.designId, userId, voteCounts(voter.emailVerifiedAt, found.e.voteAt), now());
    return { ok: true, voted: true };
  });

  // ---------------------------------------------------------------- admin ---

  const adminOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (await deps.adminAccess(req)) return true;
    await reply.code(403).send({ error: 'admin access required' });
    return false;
  };
  const eventOf = async (req: FastifyRequest, reply: FastifyReply): Promise<TifoEvent | null> => {
    const id = (req.params as { id: string }).id;
    const e = UUID.test(id) ? await events.byId(id) : null;
    if (!e) await reply.code(404).send({ error: 'no such event' });
    return e;
  };

  /** Every event with its stage, its entries and their votes, and the three the result would name. */
  app.get('/api/admin/events', async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    void reply.header('cache-control', 'no-store');
    const t = now();
    const rows = await events.list();
    const out = [];
    for (const e of rows.slice(0, 40)) {
      const stage = stageOf(e, t);
      const entryRows = stage === 'draft' ? [] : await events.entries(e.id);
      const cards = await cardsOf(entryRows);
      const tally = entryRows.length ? await events.tally(e.id) : new Map<string, { counted: number; all: number }>();
      const ranked = rankEntries(entryRows, tally, (id) => cards.has(id));
      out.push({
        ...e,
        stage,
        stageEnds: stageEnds(e, stage),
        entries: entryRows.map((x) => ({
          designId: x.designId,
          title: cards.get(x.designId)?.title ?? null,
          owner: cards.get(x.designId)?.ownerName ?? null,
          enteredAt: x.enteredAt,
          reason: x.disqualifiedReason,
          // False: the tifo was unpublished or deleted, so it is out of the result.
          isPublic: cards.has(x.designId),
          votes: tally.get(x.designId)?.counted ?? 0,
          allVotes: tally.get(x.designId)?.all ?? 0,
        })),
        proposed: ranked.filter((r) => r.votes > 0).slice(0, 3).map((r) => r.designId),
      });
    }
    return { now: t.toISOString(), proMode: deps.proMode?.() ?? 'off', canGrant: !!deps.grantPrize, events: out };
  });

  app.post('/api/admin/events', admin, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    const f = readEventFields(req.body);
    if (!f.ok) return reply.code(400).send({ error: f.error });
    const e = await events.create(f.fields);
    if (!e) return reply.code(409).send({ error: 'that address is taken by another event' });
    forget();
    return { ok: true, event: e };
  });

  /** Change an event. Its address stays once it is public; nothing changes after the result. */
  app.post('/api/admin/events/:id', admin, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    const e = await eventOf(req, reply);
    if (!e) return;
    if (e.confirmedAt) return reply.code(409).send({ error: 'the result is confirmed: the event is a record now' });
    const f = readEventFields(req.body);
    if (!f.ok) return reply.code(400).send({ error: f.error });
    if (f.fields.slug !== e.slug && stageOf(e, now()) !== 'draft') return reply.code(409).send({ error: 'the address is public already and cannot change' });
    const saved = await events.update(e.id, f.fields);
    if (!saved) return reply.code(409).send({ error: 'that address is taken by another event' });
    forget();
    return { ok: true, event: saved };
  });

  /** Cancel an event (it leaves every public page), or bring it back. */
  app.post('/api/admin/events/:id/cancel', admin, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    const e = await eventOf(req, reply);
    if (!e) return;
    if (e.confirmedAt) return reply.code(409).send({ error: 'the result is confirmed: the event is a record now' });
    const cancelled = (req.body as { cancelled?: unknown } | null)?.cancelled !== false;
    await events.setCancelled(e.id, cancelled, now());
    forget();
    return { ok: true, cancelled };
  });

  /** Delete an event nobody has entered. One with entries is cancelled instead, so nothing a fan did is lost by a slip. */
  app.post('/api/admin/events/:id/delete', admin, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    const e = await eventOf(req, reply);
    if (!e) return;
    if ((await events.entries(e.id)).length) return reply.code(409).send({ error: 'it has entries: cancel it instead' });
    await events.remove(e.id);
    forget();
    return { ok: true };
  });

  /** Take an entry out with a reason the page shows, or (no reason) put it back. */
  app.post('/api/admin/events/:id/disqualify', admin, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    const e = await eventOf(req, reply);
    if (!e) return;
    if (e.confirmedAt) return reply.code(409).send({ error: 'the result is confirmed: the event is a record now' });
    const b = (req.body ?? {}) as { designId?: unknown; reason?: unknown };
    if (typeof b.designId !== 'string' || !UUID.test(b.designId)) return reply.code(400).send({ error: 'an entry is required' });
    const reason = readReason(b.reason);
    const ok = await events.disqualify(e.id, b.designId, reason || null);
    return ok ? { ok: true, reason: reason || null } : reply.code(404).send({ error: 'no such entry' });
  });

  /**
   * Confirm the result, once voting has closed: the three with the most
   * counted votes (the earlier entry between equals), and the winner's days
   * of Pro, unless they had an event prize in the last 90 days. An entry with
   * no counted vote takes no place. Done once; it cannot be undone here.
   */
  app.post('/api/admin/events/:id/confirm', admin, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return;
    const e = await eventOf(req, reply);
    if (!e) return;
    const t = now();
    const stage = stageOf(e, t);
    if (stage === 'result') return reply.code(409).send({ error: 'the result is confirmed already' });
    if (stage !== 'closed') return reply.code(409).send({ error: 'voting has not closed yet' });
    const rows = await events.entries(e.id);
    const cards = await cardsOf(rows);
    const top = rankEntries(rows, await events.tally(e.id), (id) => cards.has(id)).filter((r) => r.votes > 0).slice(0, 3);
    const winner = top[0] ?? null;
    let prizePass: string | null = null;
    let prize: 'given' | 'none' | 'too_soon' | 'no_winner' | 'failed' = winner ? 'none' : 'no_winner';
    if (winner && e.prizeDays > 0 && deps.grantPrize) {
      if (prizeTooSoon(await events.list(), winner.userId, t)) prize = 'too_soon';
      else {
        const actor = await deps.userOf(req).catch(() => null);
        prizePass = await deps.grantPrize(winner.userId, e.prizeDays, actor).catch(() => null);
        prize = prizePass ? 'given' : 'failed';
      }
    }
    await events.setResult(e.id, {
      confirmedAt: t.toISOString(),
      winnerDesign: winner?.designId ?? null,
      secondDesign: top[1]?.designId ?? null,
      thirdDesign: top[2]?.designId ?? null,
      winnerUser: winner?.userId ?? null,
      prizePass,
    });
    forget();
    return { ok: true, prize, winner: winner ? { designId: winner.designId, owner: cards.get(winner.designId)?.ownerName ?? null, votes: winner.votes } : null };
  });
}
