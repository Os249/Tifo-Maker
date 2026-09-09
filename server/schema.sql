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

-- Notifications feed. kind = follow_post|new_follower|comment|remix|like.
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
-- Monthly metering: usage counts reset when the period (YYYY-MM) changes.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS period TEXT;

-- Sharing system: a public view counter on each design, a branded social-card
-- image, and a per-platform share/open log for analytics.
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
