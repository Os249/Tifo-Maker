-- Tifo Maker persistence schema (blueprint §2.2).
-- Designs store the gzipped cell buffer IN-ROW: a full 60k design compresses
-- to single-digit KB, so BYTEA in Postgres beats object storage on latency
-- and failure modes. Object storage enters later, for rendered exports only.

CREATE TABLE IF NOT EXISTS designs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  template_id      TEXT NOT NULL,
  template_version INT  NOT NULL,
  palette          JSONB NOT NULL,
  cells            BYTEA NOT NULL,              -- gzipped Uint8Array, one byte/seat
  revision_count   INT  NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only history. Each row is the SAME SparseDiff format used by the
-- client undo stack and (future) realtime sync; every Nth row also carries a
-- full snapshot so replay never walks more than N diffs.
CREATE TABLE IF NOT EXISTS design_revisions (
  design_id    UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  seq          INT  NOT NULL,
  diff_indices BYTEA NOT NULL,                  -- Uint32Array bytes
  diff_before  BYTEA NOT NULL,                  -- Uint8Array bytes
  diff_after   BYTEA NOT NULL,                  -- Uint8Array bytes
  snapshot     BYTEA,                           -- gzipped full cells, every Nth seq
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id, seq)
);

CREATE INDEX IF NOT EXISTS designs_updated_at_idx ON designs (updated_at DESC);

-- Phase 3 completion: accounts, ownership, gallery.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                -- scrypt, salt:hash hex
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Launch: email accounts. email is nullable so pre-launch accounts keep working
-- until they add one. AI Designer is gated on a verified email; every other tool
-- stays open. accepted_terms_* records which policy version the user agreed to.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email                  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_terms_at      TIMESTAMPTZ;
-- Paid entitlement (unlimited AI). No payment processor yet; flipped manually/admin for now.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro                 BOOLEAN NOT NULL DEFAULT false;
-- Case-insensitive uniqueness, but only across rows that actually have an email.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

-- Signing in with Google (and, later, another provider) means an account can
-- exist with no password at all, so the column stops being mandatory. Accounts
-- that have one are unaffected; the policy in src/core/password.ts still governs
-- every password that gets chosen.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- One row per (provider, their id for this person). A table rather than columns
-- on users, because one person may end up with Google, a password, and whatever
-- comes third — and because the primary key is then exactly the uniqueness rule
-- that matters: a provider identity belongs to at most one account.
--
-- provider_user_id is the provider's own stable id (Google's `sub`), never an
-- email address: an address can move between people, that id cannot.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS oauth_identities_user ON oauth_identities (user_id);

-- Has this person actually chosen their @name, or is it one we invented?
--
-- Signing in with Google gives us an email and no handle, and a handle is
-- public — it is what the community feed puts under every design. Rather than
-- quietly stamping `gfan1789865580969` on someone, provider-created accounts
-- start with this false and are asked to pick one before they can do anything.
-- DEFAULT true, so every account that already exists is untouched.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_chosen BOOLEAN NOT NULL DEFAULT true;

-- Opaque bearer tokens, stored hashed. A leaked DB row cannot be replayed.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,                -- sha256(token) hex
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Single-use, hashed, expiring tokens for email verification and password reset.
-- purpose is 'verify_email' or 'reset_password'. used_at marks consumption.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,                -- sha256(token) hex
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, purpose);

ALTER TABLE designs ADD COLUMN IF NOT EXISTS owner_id  UUID REFERENCES users(id);
ALTER TABLE designs ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS thumbnail BYTEA;  -- client-rendered PNG
CREATE INDEX IF NOT EXISTS designs_public_idx ON designs (is_public, updated_at DESC);

-- Likes / dislikes. One row per (user, design); value is +1 (like) or -1
-- (dislike). like_score on designs is the denormalized sum for cheap sorting.
CREATE TABLE IF NOT EXISTS design_votes (
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value     SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id, user_id)
);

ALTER TABLE designs ADD COLUMN IF NOT EXISTS like_score INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS designs_like_score_idx ON designs (is_public, like_score DESC, updated_at DESC);

-- Templates: a published design flagged as a starting point others can clone.
ALTER TABLE designs ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS designs_template_idx ON designs (is_template, updated_at DESC)
  WHERE is_template AND is_public;

-- Tags: curated facets (club, country, competition, color, size) + the
-- many-to-many link to designs. slug is the canonical lowercase key.
CREATE TABLE IF NOT EXISTS tags (
  id   SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'topic'   -- club|country|competition|color|size|topic
);
CREATE TABLE IF NOT EXISTS design_tags (
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  tag_id    INT  NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  PRIMARY KEY (design_id, tag_id)
);
CREATE INDEX IF NOT EXISTS design_tags_tag_idx ON design_tags (tag_id);

-- Moderation: a report against any public item; an internal queue to review.
CREATE TABLE IF NOT EXISTS moderation_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL,                 -- design|comment
  target_id   UUID NOT NULL,
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open|reviewed|actioned
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_open_idx ON moderation_reports (status, created_at)
  WHERE status = 'open';

-- Anonymous funnel analytics. One row per event. No PII: session_id is a random
-- per-browser-session token (not tied to a user unless they sign in), used only
-- to measure conversion THROUGH the funnel. signed_in is a coarse flag, not an id.
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  name       TEXT NOT NULL,         -- e.g. landed|paint_first|view_3d|save_clicked|signed_up|published|exported
  signed_in  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_name_time_idx ON events (name, created_at);
CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id);

-- Real match-day photos attached to a published design — the Before/After
-- social proof. Stored as BYTEA (resized client-side before upload to stay
-- lean) to keep the Postgres-only stack; migrate to object storage if photos
-- grow large or numerous. is_verified lets a moderator confirm a genuine match.
CREATE TABLE IF NOT EXISTS design_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id   UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  image       BYTEA NOT NULL,                -- resized JPEG/PNG
  width       INT NOT NULL,
  height      INT NOT NULL,
  caption     TEXT,                          -- "Liverpool vs Madrid, 2026-05-01"
  is_verified BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_photos_design_idx ON design_photos (design_id, created_at);

-- ============ SOCIAL LAYER ============

-- Creator's explanation/backstory shown in the 3D preview, and remix lineage.
ALTER TABLE designs ADD COLUMN IF NOT EXISTS description  TEXT;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS allow_remix  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS remixed_from UUID REFERENCES designs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS designs_remixed_from_idx ON designs (remixed_from) WHERE remixed_from IS NOT NULL;

-- Username handle for the social graph (the @handle). Unique, case-insensitive.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_idx ON users (lower(handle)) WHERE handle IS NOT NULL;

-- Follow graph: follower_id follows followee_id. One row per directed edge.
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id);

-- Threaded comments on a design. parent_id null = top-level; otherwise a reply.
CREATE TABLE IF NOT EXISTS comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id  UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  author_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES comments(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_design_idx ON comments (design_id, created_at);

-- Tifo of the day: which published design was on the home page on which day.
-- One row per UTC day, which is what makes the pick stable across instances and
-- restarts, keeps the creator's notification to exactly one, and lets the picker
-- see who has already had a turn. `day` is TEXT because node-pg reads a DATE back
-- at LOCAL midnight, which can format as the day before. Also created at boot by
-- PgDailyFeatureRepository.init(), best-effort, so a fresh database works either way.
CREATE TABLE IF NOT EXISTS daily_features (
  day        TEXT PRIMARY KEY,                -- UTC 'YYYY-MM-DD'
  design_id  UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daily_features_design_idx ON daily_features (design_id);

-- Notifications feed. kind = follow_post|new_follower|comment|remix|like|featured.
-- actor_id did the thing; user_id receives it; design_id/comment_id give context.
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  design_id  UUID REFERENCES designs(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- B2B enterprise leads from the "For Clubs" page. No auth — public form submit,
-- rate-limited at the route. Stored for the team to follow up.
CREATE TABLE IF NOT EXISTS leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  organization TEXT,
  org_type     TEXT,           -- club | agency | ultras | other
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);

-- AI Tifo Designer: per-account free generation quota. One row per user; `used`
-- is incremented atomically by the route under a configurable ceiling.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  used       INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Metering resets when the period changes. The period is HOURLY
-- ("YYYY-MM-DDTHH", see aiPeriod) — this comment used to say monthly, which is
-- what everyone believed until someone read the code.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS period TEXT;

-- Every AI request, kept. ai_usage is a meter, not a record: it holds one row
-- per user carrying only the CURRENT hour's count, and a new hour resets it to
-- 1 — so "how much has this person ever generated", "has anyone hit the cap"
-- and "how often does premium fail" were all unanswerable. The dashboard's
-- lifetime "AI generations" KPI was summing that meter and undercounting
-- accordingly.
--
-- The prompt is deliberately NOT stored. The outcome is what pricing and
-- capacity need; the text is the sensitive part and keeping it would put this
-- table at odds with what legal.html promises.
CREATE TABLE IF NOT EXISTS ai_events (
  id      BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = admin/unlocked
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode    TEXT NOT NULL,     -- 'std' | 'super'
  outcome TEXT NOT NULL      -- model | cache | quick | quota | busy | blocked | invalid
);
CREATE INDEX IF NOT EXISTS ai_events_at_idx      ON ai_events (at DESC);
CREATE INDEX IF NOT EXISTS ai_events_user_idx    ON ai_events (user_id, at DESC);
CREATE INDEX IF NOT EXISTS ai_events_outcome_idx ON ai_events (outcome, at DESC);

-- Sharing system: a public view counter on each design, a branded social-card
-- image, and a per-platform share/open log for analytics.
-- Arabic title. Only the starter library sets it (it ships bilingual names);
-- a design somebody saves keeps whatever single title they typed.
ALTER TABLE designs ADD COLUMN IF NOT EXISTS title_ar TEXT;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS og_image BYTEA;  -- client-rendered 1200x630 OG card

CREATE TABLE IF NOT EXISTS design_shares (
  id         BIGSERIAL PRIMARY KEY,
  design_id  UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL,                 -- whatsapp|x|facebook|telegram|... |copy|webshare
  kind       TEXT NOT NULL DEFAULT 'share', -- 'share' (button pressed) | 'open' (link visited)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_shares_design_idx ON design_shares (design_id, created_at);

-- ============ TRAFFIC SOURCES ============

-- Cookieless, server-side reach measurement — the answer to "where did they come
-- from", which the consent-gated client funnel above structurally cannot give.
--
-- Deliberately holds NO personal data, so it needs no cookie banner:
--   * no IP address is ever written here (used once, in memory, then discarded);
--   * no raw User-Agent — only coarse device / os / browser buckets;
--   * referrer_host is a HOSTNAME only, so a referring URL's path and query (which
--     can carry search terms or tokens) never reach this table;
--   * visitor_key is a SHA-256 of (ip + ua + date) salted with 32 random bytes that
--     live only in process memory and rotate every UTC day — irreversible, and not
--     linkable across days even by whoever holds this database. It is set to NULL
--     entirely after 2 days, leaving pure aggregates.
-- Used only to understand traffic: never advertising, retargeting or profiling.
CREATE TABLE IF NOT EXISTS visits (
  id            BIGSERIAL PRIMARY KEY,
  visitor_key   TEXT,                          -- daily-rotating salted hash; NULLed after 2 days
  source        TEXT NOT NULL,                 -- search|social|ai|referral|campaign|direct|internal
  referrer_host TEXT,                          -- hostname or friendly label, never a full URL
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  path          TEXT NOT NULL,
  device        TEXT,                          -- Desktop|Mobile|Tablet
  os            TEXT,
  browser       TEXT,
  lang          TEXT,                          -- primary subtag only, e.g. 'ar'
  country       TEXT,                          -- 2-letter, only when an edge provides it
  is_bot        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_created_idx ON visits (created_at DESC);
CREATE INDEX IF NOT EXISTS visits_source_idx ON visits (source, created_at DESC);
CREATE INDEX IF NOT EXISTS visits_human_idx ON visits (created_at DESC) WHERE NOT is_bot;

-- ---------------------------------------------------------------------------
-- Filter facets (see src/core/facets.ts).
--
-- Derived from a design's palette and title, not chosen by anyone, and written
-- by the repo rather than by a trigger because the rules are TypeScript: a hue
-- classification and a club-alias match. Stored rather than computed per query
-- because the community feed pages, and a filter that cannot run in the WHERE
-- clause cannot page.
--
-- An empty `colors` is the "not computed yet" marker: every real design carries
-- at least one colour, so the boot backfill can find the stragglers without a
-- separate timestamp to keep in step.
ALTER TABLE designs ADD COLUMN IF NOT EXISTS colors  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE designs ADD COLUMN IF NOT EXISTS club_id TEXT;
CREATE INDEX IF NOT EXISTS designs_colors_idx  ON designs USING GIN (colors);
CREATE INDEX IF NOT EXISTS designs_club_id_idx ON designs (club_id) WHERE club_id IS NOT NULL;

-- The scene that travels with a design: banners, and the older overlay assets.
--
-- Its own table rather than a column on `designs`, deliberately. The design row
-- is written by the hot save path that every existing design depends on, and
-- the one thing a new feature must not do is give that path a new way to fail.
-- A scene is optional, arrives on its own request, and a design with no row
-- here is simply a design with no banners.
CREATE TABLE IF NOT EXISTS design_scenes (
  design_id  UUID PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
  scene      BYTEA NOT NULL,              -- gzipped JSON: { banners, assets }
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
