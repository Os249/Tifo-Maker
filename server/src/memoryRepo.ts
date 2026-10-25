import { randomUUID } from 'node:crypto';
import type {
  AuthRepository,
  AiUsage,
  AiUsageRepository,
  DesignMeta,
  ProjectItem,
  DesignRecord,
  DesignRepository,
  DiffBytes,
  FacetBase,
  FacetScope,
  GalleryItem,
  GalleryQuery,
  FeedPage,
  Lead,
  LeadsRepository,
  NewDesign,
  AiEventInput,
  AiEventsRepository,
  AiBudgetRepository,
  AiFailReason,
  AiFailureRow,
  AiMode,
  AiOutcome,
  AiStats,
  RevisionRow,
  SeedDesign,
  ShareStats,
  UserRow,
  EventsRepository,
  PhotoMeta,
  ReportItem,
  PhotoReviewItem,
  FunnelStep,
  SceneMeta,
  ThumbnailMeta,
} from './repo';
import { aiPeriod, contentHash, REVISIONS_KEPT } from './repo';
import type { FeedPosition } from './feedCursor';
import { costStats, DESIGN_MODES, isLimitReason, modeOutcomes, type AiGroup } from './aiStats';
import { designFacets, paletteColours } from '../../src/core/facets';

interface Row extends DesignRecord {
  thumbnail: Buffer | null;
  /** sha-256 of `thumbnail`, set wherever it is (P2.4); null when there is none. */
  thumbnailHash: string | null;
  revisions: { seq: number; diff: DiffBytes; snapshot: Buffer | null; createdAt: string }[];
  /** userId → vote value (+1/-1). */
  votes: Map<string, number>;
  votedAt: Map<string, number>;
  isTemplate: boolean;
  tags: string[];
  views: number;
  shareLog: { platform: string; kind: string; at: number }[];
  ogImage: Buffer | null;
  /** Whether it was published when it went into the Trash. */
  trashedPublic?: boolean;
  /** Taken down by a moderator: stays private for good. */
  takenDown?: boolean;
}

/** In-memory AI quota store: dev mode and route tests. Same contract as Postgres. */
export class MemoryAiUsageRepository implements AiUsageRepository {
  private rows = new Map<string, { used: number; period: string }>();

  private currentUsed(userId: string): number {
    const r = this.rows.get(userId);
    return r && r.period === aiPeriod() ? r.used : 0;
  }

  async get(userId: string, limit: number): Promise<AiUsage> {
    const u = this.currentUsed(userId);
    return { used: u, limit, remaining: Math.max(0, limit - u) };
  }

  async consume(userId: string, limit: number): Promise<{ allowed: boolean } & AiUsage> {
    const u = this.currentUsed(userId);
    if (u >= limit) return { allowed: false, used: u, limit, remaining: 0 };
    const n = u + 1;
    this.rows.set(userId, { used: n, period: aiPeriod() });
    return { allowed: true, used: n, limit, remaining: Math.max(0, limit - n) };
  }
}

const zeroOutcomes = (): Record<AiOutcome, number> & { all: number } => ({
  model: 0, cache: 0, quick: 0, quota: 0, busy: 0, blocked: 0, invalid: 0, all: 0,
});

/** A delivered DESIGN: Polish and photo successes are requests, not designs. */
const isDesign = (r: { mode: AiMode; outcome: AiOutcome }): boolean => r.outcome === 'model' && DESIGN_MODES.includes(r.mode);

/** In-memory daily budget: dev mode and tests. Same contract as Postgres. */
export class MemoryAiBudgetRepository implements AiBudgetRepository {
  private days = new Map<string, { calls: number; pictures: number }>();
  async load(day: string): Promise<{ calls: number; pictures: number }> {
    return { ...(this.days.get(day) ?? { calls: 0, pictures: 0 }) };
  }
  async add(day: string, calls: number, pictures: number): Promise<void> {
    const d = this.days.get(day) ?? { calls: 0, pictures: 0 };
    this.days.set(day, { calls: d.calls + calls, pictures: d.pictures + pictures });
  }
}

/** In-memory AI history. Same shape as Postgres, so the dashboard behaves in dev. */
export class MemoryAiEventsRepository implements AiEventsRepository {
  private rows: {
    userId: string | null; at: number; mode: AiMode; outcome: AiOutcome;
    reason: AiFailReason | null; detail: string | null; via: 'password' | null;
    model: string | null; latencyMs: number | null; calls: number | null; costMicros: number | null;
    tokensIn: number; tokensOut: number; tokensThought: number; tokensCached: number; pictures: number;
  }[] = [];
  constructor(private readonly usernames: (id: string | null) => string = () => 'unknown') {}

  async record(e: AiEventInput): Promise<void> {
    this.rows.push({
      userId: e.userId, mode: e.mode, outcome: e.outcome,
      reason: e.reason ?? null, detail: e.detail ? e.detail.slice(0, 400) : null, via: e.via ?? null,
      model: e.model ? e.model.slice(0, 80) : null,
      latencyMs: e.latencyMs ?? null,
      // A row with calls is a MEASURED row; older rows and free outcomes have none.
      calls: e.calls ?? null,
      costMicros: e.costMicros ?? null,
      tokensIn: e.tokensIn ?? 0, tokensOut: e.tokensOut ?? 0, tokensThought: e.tokensThought ?? 0, tokensCached: e.tokensCached ?? 0,
      pictures: e.pictures ?? 0,
      at: Date.now(),
    });
    if (this.rows.length > 20000) this.rows.splice(0, this.rows.length - 20000);
  }

  async stats(days: number): Promise<AiStats> {
    const from = Date.now() - days * 86400_000;
    const win = this.rows.filter((r) => r.at > from);
    const fold = (rows: typeof this.rows) => {
      const out = zeroOutcomes();
      for (const r of rows) {
        // 'model' counts DESIGNS; a successful Polish or photo reading is in `all`.
        if (r.outcome !== 'model' || isDesign(r)) out[r.outcome]++;
        out.all++;
      }
      return out;
    };
    const name = (id: string | null): string => (id ? this.usernames(id) : 'admin / unlocked');

    const byDay = new Map<string, { model: number; quick: number; blocked: number }>();
    for (const r of win) {
      const day = new Date(r.at).toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { model: 0, quick: 0, blocked: 0 };
      if (isDesign(r)) d.model++;
      else if (r.outcome === 'quick') d.quick++;
      else if (r.outcome === 'blocked') d.blocked++;
      byDay.set(day, d);
    }

    const byUser = new Map<string, { model: number; quick: number; quota: number; total: number; last: number }>();
    for (const r of win) {
      const k = name(r.userId);
      const u = byUser.get(k) ?? { model: 0, quick: 0, quota: 0, total: 0, last: 0 };
      if (isDesign(r)) u.model++;
      if (r.outcome === 'quick') u.quick++;
      if (r.outcome === 'quota') u.quota++;
      u.total++;
      u.last = Math.max(u.last, r.at);
      byUser.set(k, u);
    }

    // Signed out behind the admin password is still somebody: say which door.
    const failName = (id: string | null, via: 'password' | null): string =>
      id ? this.usernames(id) : via === 'password' ? 'admin password (signed out)' : 'deleted account';
    const failed = new Map<AiFailReason, { count: number; last: number }>();
    for (const r of win) {
      if (!r.reason) continue;
      const f = failed.get(r.reason) ?? { count: 0, last: 0 };
      f.count++; f.last = Math.max(f.last, r.at);
      failed.set(r.reason, f);
    }

    const caps = new Map<string, { times: number; last: number }>();
    for (const r of this.rows.filter((x) => x.outcome === 'quota')) {
      const k = name(r.userId);
      const c = caps.get(k) ?? { times: 0, last: 0 };
      c.times++; c.last = Math.max(c.last, r.at);
      caps.set(k, c);
    }

    const groups = this.groups(win);
    const measuredFirst = this.rows.find((r) => r.calls !== null)?.at;
    return {
      days,
      since: this.rows.length ? new Date(Math.min(...this.rows.map((r) => r.at))).toISOString() : null,
      totals: fold(this.rows),
      window: fold(win),
      perDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, d]) => ({ day, ...d })),
      topUsers: [...byUser.entries()]
        .map(([username, u]) => ({ username, model: u.model, quick: u.quick, quota: u.quota, total: u.total, last: new Date(u.last).toISOString() }))
        .sort((a, b) => b.model - a.model || b.total - a.total).slice(0, 20),
      hitCap: [...caps.entries()]
        .map(([username, c]) => ({ username, times: c.times, last: new Date(c.last).toISOString() }))
        .sort((a, b) => b.times - a.times).slice(0, 20),
      modes: {
        std: win.filter((r) => r.mode === 'std').length,
        super: win.filter((r) => r.mode === 'super').length,
        polish: win.filter((r) => r.mode === 'polish').length,
        photo: win.filter((r) => r.mode === 'photo').length,
      },
      meteredAccounts: 0,
      failures: [...failed.entries()]
        .map(([reason, f]) => ({ reason, count: f.count, last: new Date(f.last).toISOString() }))
        .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)),
      recentFailures: win
        .filter((r) => r.reason)
        .slice(-50)
        .reverse()
        .map((r): AiFailureRow => ({
          at: new Date(r.at).toISOString(),
          username: failName(r.userId, r.via),
          via: r.via,
          mode: r.mode,
          outcome: r.outcome,
          reason: r.reason as AiFailReason,
          detail: r.detail ?? '',
        })),
      modeOutcomes: modeOutcomes(groups),
      cost: costStats(groups, measuredFirst ? new Date(measuredFirst).toISOString() : null),
    };
  }

  /** The rows reduced to day × mode × outcome × model, as Postgres does in SQL. */
  private groups(rows: typeof this.rows): AiGroup[] {
    const out = new Map<string, AiGroup>();
    for (const r of rows) {
      const day = new Date(r.at).toISOString().slice(0, 10);
      const key = `${day}|${r.mode}|${r.outcome}|${r.model ?? ''}`;
      const g = out.get(key) ?? {
        day, mode: r.mode, outcome: r.outcome, model: r.model, n: 0, limited: 0, measured: 0, unpriced: 0, costMicros: 0,
        tokensIn: 0, tokensOut: 0, tokensThought: 0, tokensCached: 0, pictures: 0, latencySum: 0, latencyN: 0,
      };
      g.n++;
      if (isLimitReason(r.reason)) g.limited++;
      if (r.calls !== null) {
        g.measured++;
        if (r.costMicros === null) g.unpriced++; else g.costMicros += r.costMicros;
        g.tokensIn += r.tokensIn; g.tokensOut += r.tokensOut; g.tokensThought += r.tokensThought; g.tokensCached += r.tokensCached;
        g.pictures += r.pictures;
        if (r.latencyMs !== null) { g.latencySum += r.latencyMs; g.latencyN++; }
      }
      out.set(key, g);
    }
    return [...out.values()];
  }
}

/** In-memory repositories: dev mode and route tests. Same contracts as Postgres. */
/**
 * Feed order over sort keys (P3.4): each value descending, the first that
 * differs decides. Negative when `a` comes first. Numbers compare as numbers,
 * ids as plain text (never localeCompare, which is not Postgres's order).
 */
function compareFeedKeys(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] > b[i] ? -1 : 1;
  }
  return 0;
}

export class MemoryDesignRepository implements DesignRepository {
  private rows = new Map<string, Row>();
  /** design id -> gzipped scene JSON and its sha-256 (P2.5). Separate from the row, like the table. */
  private scenes = new Map<string, { gz: Buffer; hash: string }>();
  constructor(private readonly usernames: (id: string | null) => string = () => 'unknown') {}

  /**
   * How many comments a design's thread holds. The comments live in
   * MemorySocialRepository, which installs the counter when it is built on
   * this repository; without a social layer there are none.
   */
  private commentsOf: (designId: string) => number = () => 0;
  countCommentsWith(count: (designId: string) => number): void {
    this.commentsOf = count;
  }

  private meta(r: Row): DesignMeta {
    const { id, title, titleAr, templateId, templateVersion, palette, revisionCount, isPublic, ownerId, createdAt, updatedAt, description, allowRemix, remixedFrom } = r;
    return { id, title, titleAr: titleAr ?? null, templateId, templateVersion, palette: [...palette], revisionCount, isPublic, ownerId, createdAt, updatedAt, description: description ?? null, allowRemix: allowRemix !== false, remixedFrom: remixedFrom ?? null, viewCount: r.views, pinned: r.pinned === true, deletedAt: r.deletedAt ?? null, origin: r.origin ?? null, takenDown: r.takenDown === true };
  }

  async create(d: NewDesign): Promise<DesignMeta> {
    const now = new Date().toISOString();
    const row: Row = {
      id: randomUUID(),
      title: d.title,
      titleAr: d.titleAr ?? null,
      templateId: d.templateId,
      templateVersion: d.templateVersion,
      palette: [...d.palette],
      cellsGz: d.cellsGz,
      ownerId: d.ownerId,
      isPublic: false,
      thumbnail: d.thumbnailPng,
      thumbnailHash: d.thumbnailPng ? contentHash(d.thumbnailPng) : null,
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
      revisions: [],
      votes: new Map(),
      votedAt: new Map(),
      isTemplate: false,
      tags: [],
      views: 0,
      shareLog: [],
      ogImage: null,
      pinned: false,
      deletedAt: null,
      origin: d.origin ?? null,
    };
    this.rows.set(row.id, row);
    return this.meta(row);
  }

  async listByOwner(ownerId: string): Promise<DesignMeta[]> {
    return [...this.rows.values()]
      .filter((r) => r.ownerId === ownerId && !r.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => this.meta(r));
  }

  async listTitlesByOwner(ownerId: string): Promise<string[]> {
    return [...this.rows.values()].filter((r) => r.ownerId === ownerId).map((r) => r.title);
  }

  async seedDesigns(ownerId: string, items: SeedDesign[]): Promise<number> {
    for (const d of items) {
      const meta = await this.create({
        title: d.title, titleAr: d.titleAr, templateId: d.templateId,
        templateVersion: d.templateVersion, palette: d.palette, cellsGz: d.cellsGz,
        ownerId, thumbnailPng: d.thumbnailPng,
      });
      const row = this.rows.get(meta.id)!;
      row.isPublic = true;
      row.isTemplate = true;
      row.tags = normalizeTags(d.tags);
    }
    return items.length;
  }

  async listProjects(ownerId: string): Promise<ProjectItem[]> {
    return [...this.rows.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map((r) => ({ ...this.meta(r), hasThumbnail: r.thumbnail !== null }));
  }

  async setPinned(id: string, pinned: boolean): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.pinned = pinned;
    return this.meta(r);
  }

  async trash(id: string): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (!r.deletedAt) {
      r.trashedPublic = r.isPublic;
      r.isPublic = false;
      r.deletedAt = new Date().toISOString();
    }
    return this.meta(r);
  }

  async restore(id: string): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (r.deletedAt) {
      r.isPublic = r.trashedPublic === true && r.takenDown !== true;
      r.trashedPublic = false;
      r.deletedAt = null;
    }
    return this.meta(r);
  }

  async purge(id: string): Promise<boolean> {
    this.scenes.delete(id);
    return this.rows.delete(id);
  }

  async purgeTrashed(cutoff: Date): Promise<number> {
    let n = 0;
    const at = cutoff.toISOString();
    for (const [id, r] of this.rows) {
      if (r.deletedAt && r.deletedAt < at) {
        this.rows.delete(id);
        this.scenes.delete(id);
        n++;
      }
    }
    return n;
  }

  async deleteByOwner(ownerId: string): Promise<void> {
    for (const [id, r] of this.rows) if (r.ownerId === ownerId) this.rows.delete(id);
  }

  private score(r: Row): number {
    let s = 0;
    for (const v of r.votes.values()) s += v;
    return s;
  }

  private galleryItem(r: Row, viewerId?: string | null): GalleryItem {
    // Only a public source is named (see GALLERY_JOINS in pgRepo).
    const found = r.remixedFrom ? this.rows.get(r.remixedFrom) : null;
    const source = found?.isPublic ? found : null;
    // A gallery card is public: no owner-only fields (pinned, Trash, takedown,
    // origin), as the Postgres gallery query never selects them.
    const { pinned: _p, deletedAt: _d, origin: _o, takenDown: _t, ...shared } = this.meta(r);
    return {
      ...shared,
      ownerName: this.usernames(r.ownerId),
      hasThumbnail: r.thumbnail !== null,
      likeScore: this.score(r),
      myVote: viewerId ? (r.votes.get(viewerId) ?? 0) : 0,
      isTemplate: r.isTemplate,
      tags: [...r.tags],
      hasPhoto: this.photos.some((p) => p.designId === r.id),
      remixedFromName: source ? this.usernames(source.ownerId) : null,
      remixedFromTitle: source ? source.title : null,
      commentCount: this.commentsOf(r.id),
    };
  }

  async listPublic(query: GalleryQuery): Promise<GalleryItem[]> {
    const rows = this.publicRows(query);
    const from = Math.max(0, query.offset ?? 0);
    const page = query.limit == null ? rows.slice(from) : rows.slice(from, from + query.limit);
    return page.map((r) => this.galleryItem(r, query.viewerId));
  }

  async listPublicPage(query: GalleryQuery & { after?: FeedPosition | null }): Promise<FeedPage> {
    let rows = this.publicRows(query);
    const after = query.after;
    if (after) {
      if (after.sort !== query.sort) throw new Error('feed position from another sort');
      // Strictly after the named row in the feed's own order (feedOrder), so a
      // row is on exactly one page whatever was added above it meanwhile.
      const key = this.feedKey(query.sort, { likeScore: after.likeScore ?? 0, updatedUs: after.updatedUs, id: after.id });
      rows = rows.filter((r) => compareFeedKeys(this.feedKey(query.sort, this.positionOf(r)), key) > 0);
    }
    const from = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.min(1000, Math.max(1, Math.floor(query.limit ?? 60)));
    const page = rows.slice(from, from + limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.galleryItem(r, query.viewerId)),
      next: rows.length > from + limit && last
        ? { sort: query.sort, likeScore: query.sort === 'likes' ? this.score(last) : null, updatedUs: this.positionOf(last).updatedUs, id: last.id }
        : null,
    };
  }

  /** A row's like score, last edit (µs, as Postgres keeps it) and id. */
  private positionOf(r: Row): { likeScore: number; updatedUs: number; id: string } {
    return { likeScore: this.score(r), updatedUs: Date.parse(r.updatedAt) * 1000, id: r.id };
  }

  /** The values the feed sorts by, most significant first, all descending. */
  private feedKey(sort: GalleryQuery['sort'], p: { likeScore: number; updatedUs: number; id: string }): (number | string)[] {
    return sort === 'likes' ? [p.likeScore, p.updatedUs, p.id] : [p.updatedUs, p.id];
  }

  async countPublic(query: Omit<GalleryQuery, 'limit' | 'offset' | 'viewerId' | 'sort'>): Promise<number> {
    return this.publicRows({ sort: 'recent', ...query }).length;
  }

  async facetBase(scope: FacetScope): Promise<FacetBase> {
    const out: FacetBase = { total: 0, colors: {}, clubs: {} };
    for (const r of this.publicRows({ sort: 'recent', ...scope })) {
      out.total++;
      const f = designFacets({ title: r.title, titleAr: r.titleAr, palette: r.palette });
      for (const c of f.colors) out.colors[c] = (out.colors[c] ?? 0) + 1;
      if (f.clubId) out.clubs[f.clubId] = (out.clubs[f.clubId] ?? 0) + 1;
    }
    return out;
  }

  async listPublicByOwner(ownerId: string, opts: { viewerId?: string | null; limit: number }): Promise<GalleryItem[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit)));
    return this.publicRows({ sort: 'recent' })
      .filter((r) => r.ownerId !== null && r.ownerId === ownerId)
      .slice(0, limit)
      .map((r) => this.galleryItem(r, opts.viewerId));
  }

  async listPublicIds(limit: number): Promise<{ id: string; updatedAt: string }[]> {
    return this.publicRows({ sort: 'recent' }).slice(0, Math.max(0, Math.floor(limit))).map((r) => ({ id: r.id, updatedAt: r.updatedAt }));
  }

  /** Public rows a feed query matches, in feed order. Public only, whatever the query. */
  private publicRows(query: Omit<GalleryQuery, 'limit' | 'offset' | 'viewerId'>): Row[] {
    let rows = [...this.rows.values()].filter((r) => r.isPublic);
    if (query.templatesOnly) rows = rows.filter((r) => r.isTemplate);
    if (query.excludeTemplates) rows = rows.filter((r) => !r.isTemplate);
    // Derived on the fly here. The Postgres repo stores them in a column because
    // it has to filter before paging; in memory the whole set is already loaded,
    // so computing is cheaper than keeping a second copy in sync.
    if (query.colors && query.colors.length > 0) {
      const want = new Set(query.colors);
      rows = rows.filter((r) => paletteColours(r.palette).some((c) => want.has(c)));
    }
    if (query.clubId) {
      rows = rows.filter((r) => designFacets({ title: r.title, titleAr: r.titleAr, palette: r.palette }).clubId === query.clubId);
    }
    if (query.search && query.search.trim()) {
      const q = query.search.trim().toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(q));
    }
    if (query.tags && query.tags.length > 0) {
      const want = query.tags.map((t) => t.toLowerCase());
      rows = rows.filter((r) => want.every((t) => r.tags.includes(t)));
    }
    // The id breaks ties. Without it paging is undefined whenever timestamps
    // match, which is not a corner case: the whole template library is written
    // in one boot and shares an updatedAt to the millisecond. Descending, with
    // a plain comparison, exactly as Postgres orders `d.id DESC` (a uuid
    // compares as its bytes, which is its lower-case hex compared as text):
    // the keyset cursor (P3.4) relies on both stores agreeing.
    const sort = query.sort;
    rows.sort((a, b) => compareFeedKeys(this.feedKey(sort, this.positionOf(a)), this.feedKey(sort, this.positionOf(b))));
    return rows;
  }

  async getPublicItem(id: string, viewerId?: string | null): Promise<GalleryItem | null> {
    const r = this.rows.get(id);
    return r && r.isPublic ? this.galleryItem(r, viewerId) : null;
  }

  async vote(
    designId: string,
    userId: string,
    value: -1 | 0 | 1,
  ): Promise<{ likeScore: number; myVote: number } | null> {
    const r = this.rows.get(designId);
    if (!r || !r.isPublic) return null;
    if (value === 0) {
      r.votes.delete(userId);
      r.votedAt.delete(userId);
    } else {
      r.votes.set(userId, value);
      r.votedAt.set(userId, Date.now());
    }
    return { likeScore: this.score(r), myVote: value };
  }

  async listLikedBy(userId: string): Promise<GalleryItem[]> {
    return [...this.rows.values()]
      .filter((r) => r.isPublic && r.votes.get(userId) === 1)
      .sort((a, b) => (b.votedAt.get(userId) ?? 0) - (a.votedAt.get(userId) ?? 0))
      .map((r) => this.galleryItem(r, userId));
  }

  async get(id: string): Promise<DesignRecord | null> {
    const r = this.rows.get(id);
    return r ? { ...this.meta(r), cellsGz: r.cellsGz } : null;
  }

  async updateCells(id: string, cellsGz: Buffer, palette: string[], thumbnailPng: Buffer | null): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.cellsGz = cellsGz;
    r.palette = [...palette];
    if (thumbnailPng) {
      r.thumbnail = thumbnailPng;
      r.thumbnailHash = contentHash(thumbnailPng);
    }
    r.updatedAt = new Date().toISOString();
    return this.meta(r);
  }

  async patchMeta(id: string, patch: { title?: string; isPublic?: boolean }): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (patch.title !== undefined) r.title = patch.title;
    if (patch.isPublic !== undefined) r.isPublic = patch.isPublic && r.takenDown !== true;
    r.updatedAt = new Date().toISOString();
    return this.meta(r);
  }

  async getThumbnail(id: string): Promise<Buffer | null> {
    return this.rows.get(id)?.thumbnail ?? null;
  }

  async getScene(id: string): Promise<Buffer | null> {
    return this.scenes.get(id)?.gz ?? null;
  }

  async putScene(id: string, sceneGz: Buffer): Promise<boolean> {
    if (!this.rows.has(id)) return false;
    this.scenes.set(id, { gz: sceneGz, hash: contentHash(sceneGz) });
    return true;
  }

  async getSceneMeta(id: string): Promise<SceneMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    const s = this.scenes.get(id);
    return { isPublic: r.isPublic, ownerId: r.ownerId, hash: s?.hash ?? null, hasScene: !!s };
  }

  async getSceneRow(id: string): Promise<{ gz: Buffer; hash: string | null } | null> {
    const s = this.scenes.get(id);
    return s ? { gz: s.gz, hash: s.hash } : null;
  }

  async getThumbnailMeta(id: string): Promise<ThumbnailMeta | null> {
    const r = this.rows.get(id);
    return r ? { isPublic: r.isPublic, ownerId: r.ownerId, hash: r.thumbnailHash, hasThumbnail: r.thumbnail !== null } : null;
  }

  async getThumbnailRow(id: string): Promise<(ThumbnailMeta & { png: Buffer | null }) | null> {
    const r = this.rows.get(id);
    return r ? { isPublic: r.isPublic, ownerId: r.ownerId, hash: r.thumbnailHash, hasThumbnail: r.thumbnail !== null, png: r.thumbnail } : null;
  }

  async backfillHashes(): Promise<number> {
    return 0; // every write here hashes as it stores
  }

  async appendRevision(id: string, diff: DiffBytes, newCellsGz: Buffer, snapshot: Buffer | null): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.revisionCount += 1;
    r.revisions.push({ seq: r.revisionCount, diff, snapshot, createdAt: new Date().toISOString() });
    if (r.revisions.length > REVISIONS_KEPT) r.revisions.splice(0, r.revisions.length - REVISIONS_KEPT);
    r.cellsGz = newCellsGz;
    r.updatedAt = new Date().toISOString();
    return this.meta(r);
  }

  async listRevisions(id: string, limit: number): Promise<RevisionRow[]> {
    const r = this.rows.get(id);
    if (!r) return [];
    return r.revisions.slice(-limit).reverse().map((v) => ({
      seq: v.seq,
      changed: v.diff.indices.byteLength / 4,
      hasSnapshot: v.snapshot !== null,
      createdAt: v.createdAt,
    }));
  }

  async fork(id: string, title: string, ownerId: string): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    const meta = await this.create({
      title,
      templateId: r.templateId,
      templateVersion: r.templateVersion,
      palette: r.palette,
      cellsGz: r.cellsGz,
      ownerId,
      thumbnailPng: r.thumbnail,
    });
    // A taken-down source's copy is born taken down, as on Postgres.
    if (r.takenDown) {
      const copy = this.rows.get(meta.id);
      if (copy) copy.takenDown = true;
      return { ...meta, takenDown: true };
    }
    return meta;
  }

  // ---- social helpers (used by MemorySocialRepository) ----
  ownerOf(id: string): string | null {
    return this.rows.get(id)?.ownerId ?? null;
  }
  publicCountOf(ownerId: string): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.ownerId === ownerId && r.isPublic) n++;
    return n;
  }
  async getMeta(id: string): Promise<DesignMeta | null> {
    const r = this.rows.get(id);
    return r ? this.meta(r) : null;
  }
  setPublishMetaMem(designId: string, ownerId: string, description: string | null, allowRemix: boolean): boolean {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return false;
    r.description = description?.slice(0, 2000) ?? null;
    r.allowRemix = allowRemix;
    return true;
  }
  async remixMem(sourceId: string, newOwnerId: string, title: string): Promise<DesignMeta | null> {
    const r = this.rows.get(sourceId);
    if (!r || !r.isPublic || r.allowRemix === false) return null;
    const meta = await this.create({
      title,
      templateId: r.templateId,
      templateVersion: r.templateVersion,
      palette: r.palette,
      cellsGz: r.cellsGz,
      ownerId: newOwnerId,
      thumbnailPng: r.thumbnail,
    });
    const row = this.rows.get(meta.id);
    if (row) row.remixedFrom = sourceId;
    return { ...meta, remixedFrom: sourceId };
  }

  async setTags(designId: string, ownerId: string, slugs: string[]): Promise<string[] | null> {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return null;
    r.tags = normalizeTags(slugs);
    return [...r.tags];
  }

  async setTemplate(designId: string, ownerId: string, isTemplate: boolean): Promise<boolean | null> {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return null;
    r.isTemplate = isTemplate;
    return r.isTemplate;
  }

  async popularTags(limit: number): Promise<{ slug: string; kind: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (!r.isPublic) continue;
      for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([slug, count]) => ({ slug, kind: 'topic', count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  private reports: { id: string; targetType: string; targetId: string; reporterId: string | null; reason: string; status: string; createdAt: string }[] = [];
  async report(targetType: 'design' | 'comment', targetId: string, reporterId: string | null, reason: string): Promise<string> {
    const id = randomUUID();
    this.reports.push({ id, targetType, targetId, reporterId, reason, status: 'open', createdAt: new Date().toISOString() });
    return id;
  }

  private photos: (PhotoMeta & { image: Buffer })[] = [];
  async addPhoto(designId: string, ownerId: string, image: Buffer, width: number, height: number, caption: string | null): Promise<string | null> {
    const r = this.rows.get(designId);
    if (!r || r.ownerId !== ownerId) return null;
    const id = randomUUID();
    this.photos.push({ id, designId, image, width, height, caption, isVerified: false, createdAt: new Date().toISOString() });
    return id;
  }
  async listPhotos(designId: string): Promise<PhotoMeta[]> {
    return this.photos
      .filter((p) => p.designId === designId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ image: _image, ...meta }) => meta);
  }
  async getPhoto(photoId: string): Promise<{ image: Buffer; designId: string } | null> {
    const p = this.photos.find((x) => x.id === photoId);
    return p ? { image: p.image, designId: p.designId } : null;
  }
  async deletePhoto(photoId: string, ownerId: string): Promise<boolean> {
    const p = this.photos.find((x) => x.id === photoId);
    if (!p) return false;
    const r = this.rows.get(p.designId);
    if (!r || r.ownerId !== ownerId) return false;
    this.photos = this.photos.filter((x) => x.id !== photoId);
    return true;
  }

  async listReports(status: string, limit: number): Promise<ReportItem[]> {
    return this.reports
      .filter((r) => r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => {
        const d = r.targetType === 'design' ? this.rows.get(r.targetId) : undefined;
        return {
          id: r.id,
          targetType: r.targetType,
          targetId: r.targetId,
          reason: r.reason,
          status: r.status,
          createdAt: r.createdAt,
          targetTitle: d?.title ?? null,
          targetOwner: d ? this.usernames(d.ownerId) : null,
          targetIsPublic: d ? d.isPublic : null,
          targetHasThumbnail: d?.thumbnail != null,
        };
      });
  }

  async setReportStatus(reportId: string, status: string): Promise<boolean> {
    const r = this.reports.find((x) => x.id === reportId);
    if (!r) return false;
    r.status = status;
    return true;
  }

  async takedownDesign(designId: string): Promise<boolean> {
    const d = this.rows.get(designId);
    if (!d) return false;
    d.isPublic = false;
    d.trashedPublic = false;
    d.takenDown = true;
    for (const r of this.reports) {
      if (r.targetType === 'design' && r.targetId === designId && r.status === 'open') r.status = 'actioned';
    }
    return true;
  }

  async listUnverifiedPhotos(limit: number): Promise<PhotoReviewItem[]> {
    return this.photos
      .filter((p) => !p.isVerified)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        designId: p.designId,
        designTitle: this.rows.get(p.designId)?.title ?? null,
        caption: p.caption,
        createdAt: p.createdAt,
      }));
  }

  async setPhotoVerified(photoId: string, verified: boolean): Promise<boolean> {
    const p = this.photos.find((x) => x.id === photoId);
    if (!p) return false;
    p.isVerified = verified;
    return true;
  }

  async deletePhotoAsModerator(photoId: string): Promise<boolean> {
    const before = this.photos.length;
    this.photos = this.photos.filter((x) => x.id !== photoId);
    return this.photos.length < before;
  }

  // ---- sharing system ----
  async incrementView(id: string): Promise<number> {
    const r = this.rows.get(id);
    if (!r) return 0;
    r.views += 1;
    return r.views;
  }

  async recordShare(designId: string, platform: string, kind: 'share' | 'open'): Promise<void> {
    const r = this.rows.get(designId);
    if (r) r.shareLog.push({ platform, kind, at: Date.now() });
  }

  /**
   * Every share row, flattened, for the site-wide dashboard aggregate. The
   * Postgres side reads design_shares directly; in memory this is the closest
   * equivalent, so /admin behaves the same in dev as it does in production.
   */
  shareLogAll(): { designId: string; title: string; owner: string | null; platform: string; kind: string; at: number }[] {
    const out: { designId: string; title: string; owner: string | null; platform: string; kind: string; at: number }[] = [];
    for (const [id, r] of this.rows) {
      // Resolve to a username here, the way the Postgres side joins users:
      // an owner id on the dashboard is unreadable.
      const owner = r.ownerId ? this.usernames(r.ownerId) : null;
      for (const e of r.shareLog) {
        out.push({ designId: id, title: r.title, owner, platform: e.platform, kind: e.kind, at: e.at });
      }
    }
    return out;
  }

  async shareStats(id: string): Promise<ShareStats> {
    const r = this.rows.get(id);
    if (!r) return { views: 0, shares: 0, opens: 0, byPlatform: {} };
    const byPlatform: Record<string, number> = {};
    let shares = 0;
    let opens = 0;
    for (const e of r.shareLog) {
      if (e.kind === 'open') opens += 1;
      else {
        shares += 1;
        byPlatform[e.platform] = (byPlatform[e.platform] ?? 0) + 1;
      }
    }
    return { views: r.views, shares, opens, byPlatform };
  }

  async setOgImage(id: string, ownerId: string, image: Buffer): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.ownerId !== ownerId) return false;
    r.ogImage = image;
    return true;
  }

  async getOgImage(id: string): Promise<Buffer | null> {
    return this.rows.get(id)?.ogImage ?? null;
  }
}

/** Lowercase, hyphenate, dedupe, cap to a sane count + length. */
export function normalizeTags(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of slugs) {
    const slug = String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
    if (out.length >= 8) break;
  }
  return out;
}

export class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, UserRow>(); // by username
  private tokens = new Map<string, { userId: string; expiresAt: number }>();
  private emailTokens = new Map<string, { userId: string; purpose: string; expiresAt: number; used: boolean }>();

  async createUser(
    username: string,
    passwordHash: string | null,
    opts: { email?: string | null; acceptedVersion?: string | null; emailVerified?: boolean; usernameChosen?: boolean } = {},
  ): Promise<UserRow | null> {
    // Unique ignoring case, as Postgres enforces it: the memory store let
    // "Alice" in next to "alice", so the suites that run on memory could not
    // see a regression of the round-four fix (audit round five).
    const lower = username.toLowerCase();
    for (const name of this.users.keys()) if (name.toLowerCase() === lower) return null;
    const email = opts.email ?? null;
    if (email && this.emailTaken(email)) return null;
    const row: UserRow = {
      id: randomUUID(),
      username,
      passwordHash,
      email,
      // Only a provider that says it verified the address gets to skip the
      // code-in-your-inbox step; everyone else starts unverified.
      emailVerifiedAt: email && opts.emailVerified ? new Date().toISOString() : null,
      isPro: false,
      usernameChosen: opts.usernameChosen !== false,
    };
    this.users.set(username, row);
    return row;
  }

  async getUserByName(username: string): Promise<UserRow | null> {
    return this.users.get(username) ?? null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    for (const u of this.users.values()) if (u.id === id) return u;
    return null;
  }

  private emailTaken(email: string): boolean {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email && u.email.toLowerCase() === e) return true;
    return false;
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email && u.email.toLowerCase() === e) return u;
    return null;
  }

  async setEmail(userId: string, email: string, _acceptedVersion?: string | null, expectedHash?: string | null): Promise<boolean> {
    const u = await this.getUserById(userId);
    if (!u) return false;
    if (expectedHash !== undefined && (u.passwordHash ?? null) !== expectedHash) return false;
    const mine = u.email && u.email.toLowerCase() === email.toLowerCase();
    if (!mine && this.emailTaken(email)) return false;
    u.email = email;
    u.emailVerifiedAt = null; // re-verify whenever the address changes
    // And the old address's reset links end with the move (as on Postgres).
    for (const [hash, t] of this.emailTokens) {
      if (t.userId === userId && t.purpose === 'reset_password') this.emailTokens.delete(hash);
    }
    return true;
  }

  async markEmailVerified(userId: string, email?: string): Promise<boolean> {
    const u = await this.getUserById(userId);
    if (!u) return false;
    if (email !== undefined && (u.email ?? '').toLowerCase() !== email.toLowerCase()) return false;
    u.emailVerifiedAt = new Date().toISOString();
    return true;
  }

  async setUsername(userId: string, username: string): Promise<boolean> {
    const u = await this.getUserById(userId);
    if (!u) return false;
    const lower = username.toLowerCase();
    // Any successful trip through here means the owner has settled on a name —
    // including confirming the one we suggested, which is a choice too.
    if (u.username.toLowerCase() === lower && u.username !== username) {
      // Same name, different case: re-key without a uniqueness check.
      this.users.delete(u.username);
      u.username = username;
      u.usernameChosen = true;
      this.users.set(username, u);
      return true;
    }
    if (u.username === username) {
      u.usernameChosen = true;
      return true; // no-op on the name, but it confirms it
    }
    for (const other of this.users.values()) {
      if (other.id !== userId && other.username.toLowerCase() === lower) return false;
    }
    // This map is keyed BY USERNAME, so a rename has to move the entry as well
    // as the field — leaving the old key would make getUserByName resolve the
    // old name forever and let someone else's rename collide with a ghost.
    this.users.delete(u.username);
    u.username = username;
    u.usernameChosen = true;
    this.users.set(username, u);
    return true;
  }

  async hasChosenUsername(userId: string): Promise<boolean> {
    return (await this.getUserById(userId))?.usernameChosen !== false;
  }

  async setPro(userId: string, isPro: boolean): Promise<void> {
    const u = await this.getUserById(userId);
    if (u) u.isPro = isPro;
  }

  async createToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.tokens.set(tokenHash, { userId, expiresAt: expiresAt.getTime() });
  }

  async getUserIdByToken(tokenHash: string): Promise<string | null> {
    const t = this.tokens.get(tokenHash);
    if (!t || t.expiresAt < Date.now()) return null;
    return t.userId;
  }

  async getSessionUser(tokenHash: string): Promise<UserRow | null> {
    // Same rule as getUserIdByToken: an expired token opens nothing.
    const t = this.tokens.get(tokenHash);
    if (!t || t.expiresAt < Date.now()) return null;
    return this.getUserById(t.userId);
  }

  async deleteToken(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash);
  }

  async createEmailTokenForAddress(
    userId: string,
    email: string,
    tokenHash: string,
    purpose: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const u = [...this.users.values()].find((x) => x.id === userId);
    if (!u?.email || u.email.toLowerCase() !== email.toLowerCase()) return false;
    this.emailTokens.set(tokenHash, { userId, purpose, expiresAt: expiresAt.getTime(), used: false });
    return true;
  }

  async createEmailToken(userId: string, tokenHash: string, purpose: string, expiresAt: Date): Promise<void> {
    this.emailTokens.set(tokenHash, { userId, purpose, expiresAt: expiresAt.getTime(), used: false });
  }

  async consumeEmailToken(tokenHash: string, purpose: string): Promise<string | null> {
    const t = this.emailTokens.get(tokenHash);
    if (!t || t.used || t.purpose !== purpose || t.expiresAt < Date.now()) return null;
    t.used = true;
    return t.userId;
  }

  async deleteEmailTokens(userId: string, purpose: string): Promise<void> {
    for (const [hash, t] of this.emailTokens) {
      if (t.userId === userId && t.purpose === purpose) this.emailTokens.delete(hash);
    }
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    const u = await this.getUserById(userId);
    if (u) u.passwordHash = passwordHash;
  }

  async deleteUserTokens(userId: string): Promise<void> {
    for (const [hash, t] of this.tokens) if (t.userId === userId) this.tokens.delete(hash);
  }

  async replacePassword(
    userId: string,
    passwordHash: string,
    opts: {
      dropIdentities?: boolean;
      keepResetLinks?: boolean;
      expectedHash?: string | null;
      newSession?: { tokenHash: string; expiresAt: Date };
    } = {},
  ): Promise<boolean> {
    // No await between the writes, so nothing else runs in the middle: the
    // memory store's version of one transaction.
    const u = [...this.users.values()].find((x) => x.id === userId);
    if (!u) return false;
    if (opts.expectedHash !== undefined && (u.passwordHash ?? null) !== opts.expectedHash) return false;
    u.passwordHash = passwordHash;
    for (const [hash, t] of this.tokens) if (t.userId === userId) this.tokens.delete(hash);
    for (const [hash, t] of this.emailTokens) {
      if (t.userId !== userId) continue;
      if (t.purpose === 'oauth_handoff' || (t.purpose === 'reset_password' && !opts.keepResetLinks)) this.emailTokens.delete(hash);
    }
    if (opts.dropIdentities) for (const [k, id] of this.identities) if (id === userId) this.identities.delete(k);
    if (opts.newSession) this.tokens.set(opts.newSession.tokenHash, { userId, expiresAt: opts.newSession.expiresAt.getTime() });
    return true;
  }

  // The conditional writes below read and write with no await in between, which
  // is the memory store's way of doing them in one statement.
  async upgradePasswordHash(userId: string, expected: string, next: string): Promise<boolean> {
    const u = [...this.users.values()].find((x) => x.id === userId);
    if (!u || u.passwordHash !== expected) return false;
    u.passwordHash = next;
    return true;
  }

  async createTokenIfPassword(userId: string, verifiedHash: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
    const u = [...this.users.values()].find((x) => x.id === userId);
    if (!u || u.passwordHash !== verifiedHash) return false;
    this.tokens.set(tokenHash, { userId, expiresAt: expiresAt.getTime() });
    return true;
  }

  async createHandoffIfLinked(
    userId: string,
    provider: string,
    providerUserId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    if (this.identities.get(`${provider}:${providerUserId}`) !== userId) return false;
    this.emailTokens.set(tokenHash, { userId, purpose: 'oauth_handoff', expiresAt: expiresAt.getTime(), used: false });
    return true;
  }

  async exchangeHandoff(ticketHash: string, tokenHash: string, expiresAt: Date): Promise<string | null> {
    const t = this.emailTokens.get(ticketHash);
    if (!t || t.used || t.purpose !== 'oauth_handoff' || t.expiresAt < Date.now()) return null;
    t.used = true;
    this.tokens.set(tokenHash, { userId: t.userId, expiresAt: expiresAt.getTime() });
    return t.userId;
  }

  async deleteUser(userId: string): Promise<void> {
    for (const [name, u] of this.users) if (u.id === userId) this.users.delete(name);
    for (const [hash, t] of this.tokens) if (t.userId === userId) this.tokens.delete(hash);
    for (const [hash, t] of this.emailTokens) if (t.userId === userId) this.emailTokens.delete(hash);
    for (const [k, id] of this.identities) if (id === userId) this.identities.delete(k);
  }

  // ---- federated identities ----
  /** Keyed `provider:providerUserId`, matching the table's primary key. */
  private identities = new Map<string, string>();

  async getUserIdByIdentity(provider: string, providerUserId: string): Promise<string | null> {
    return this.identities.get(`${provider}:${providerUserId}`) ?? null;
  }

  async linkIdentity(provider: string, providerUserId: string, userId: string): Promise<boolean> {
    const k = `${provider}:${providerUserId}`;
    const owner = this.identities.get(k);
    if (owner && owner !== userId) return false;
    this.identities.set(k, userId);
    return true;
  }

  async linkIdentityForSession(
    provider: string,
    providerUserId: string,
    userId: string,
    sessionTokenHash: string,
  ): Promise<boolean> {
    const t = this.tokens.get(sessionTokenHash);
    if (!t || t.userId !== userId || t.expiresAt < Date.now()) return false;
    const k = `${provider}:${providerUserId}`;
    if (this.identities.has(k)) return false;
    this.identities.set(k, userId);
    return true;
  }

  async unlinkIdentity(provider: string, userId: string): Promise<boolean> {
    for (const [k, id] of this.identities) {
      if (id === userId && k.startsWith(`${provider}:`)) {
        this.identities.delete(k);
        return true;
      }
    }
    return false;
  }

  async identitiesFor(userId: string): Promise<string[]> {
    const out: string[] = [];
    for (const [k, id] of this.identities) if (id === userId) out.push(k.slice(0, k.indexOf(':')));
    return out.sort();
  }

  usernameOf(id: string | null): string {
    for (const u of this.users.values()) if (u.id === id) return u.username;
    return 'unknown';
  }

  // ---- social helpers ----
  private handles = new Map<string, string>(); // userId → handle
  handleOf(id: string): string | null {
    return this.handles.get(id) ?? null;
  }
  setHandle(id: string, handle: string): void {
    this.handles.set(id, handle);
  }
  allUsers(): { id: string; username: string; usernameChosen: boolean }[] {
    return [...this.users.values()].map((u) => ({ id: u.id, username: u.username, usernameChosen: u.usernameChosen !== false }));
  }
}

/** In-memory events repo (dev + tests). Holds events in an array. */
export class MemoryEventsRepository implements EventsRepository {
  private events: { sessionId: string; name: string; signedIn: boolean; at: number }[] = [];

  async record(sessionId: string, name: string, signedIn: boolean): Promise<void> {
    this.events.push({ sessionId, name, signedIn, at: Date.now() });
  }

  async purge(before: Date): Promise<number> {
    const n = this.events.length;
    this.events = this.events.filter((e) => e.at >= before.getTime());
    return n - this.events.length;
  }

  async funnel(steps: string[], days: number): Promise<FunnelStep[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return steps.map((name) => {
      const sessions = new Set(
        this.events.filter((e) => e.name === name && e.at >= cutoff).map((e) => e.sessionId),
      );
      return { name, sessions: sessions.size };
    });
  }
}

/** In-memory B2B leads store (dev/tests). */
export class MemoryLeadsRepository implements LeadsRepository {
  readonly leads: (Lead & { id: string; createdAt: string })[] = [];
  async createLead(lead: Lead): Promise<{ id: string }> {
    const id = randomUUID();
    this.leads.push({ ...lead, id, createdAt: new Date().toISOString() });
    return { id };
  }
}
