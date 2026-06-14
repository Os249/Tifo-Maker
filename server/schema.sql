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

-- Opaque bearer tokens, stored hashed. A leaked DB row cannot be replayed.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,                -- sha256(token) hex
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

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
