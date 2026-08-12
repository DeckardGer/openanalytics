-- Sites, domains, membership and invitations.
--
-- Rollout note: additive creation on an empty database, no backfill.
--
-- owner_user_id is the site's responsible person: the accepted owner member the
-- rest of the system treats as the site's principal (ownership transfer, the
-- deletion authority, the unattributed-usage recipient). It lands here as a
-- plain reference to a user; the stronger invariants — the owner must be an
-- *accepted owner member*, a site must keep at least one owner — are cross-row
-- predicates a plain FK cannot state; they arrive in a later migration
-- alongside the transaction service and the concurrency tests that prove them
-- (docs snapshot 02 §6). The status CHECK already carries the full site-state
-- vocabulary so later transitions need no widening. `suspended` is an
-- operator-set state: nothing in the product sets it on its own, but every
-- surface refuses a suspended site (do not ingest, do not serve).

CREATE TABLE sites (
  id            uuid PRIMARY KEY,
  slug          text NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'deleting', 'deleted')),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The public slug is the frontend's routing identifier and is distinct from the
-- internal site_id resource id (docs snapshot 03 §8).
CREATE UNIQUE INDEX sites_slug_key ON sites (slug);
CREATE INDEX sites_owner_idx ON sites (owner_user_id);

CREATE TABLE site_domains (
  id         uuid PRIMARY KEY,
  site_id    uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  domain     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX site_domains_site_domain_key ON site_domains (site_id, lower(domain));

CREATE TABLE site_members (
  id         uuid PRIMARY KEY,
  site_id    uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A named UNIQUE constraint, not just an index: (site_id, user_id) is the
  -- membership identity the ownership invariants reason about, and a named
  -- unique constraint keeps it available as a composite FK target should a
  -- later migration need to bind owner_user_id to a real membership.
  CONSTRAINT site_members_site_user_key UNIQUE (site_id, user_id)
);

CREATE TABLE site_invites (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  email              text NOT NULL,
  role               text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  -- Only the hash of the acceptance token is stored; the raw token is mailed and
  -- never persisted (ADR-0006).
  token_hash         text NOT NULL,
  invited_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz
);

CREATE UNIQUE INDEX site_invites_token_hash_key ON site_invites (token_hash);
-- At most one live invitation per email per site; accepted/revoked/expired rows
-- stay as history and do not block a fresh invite.
CREATE UNIQUE INDEX site_invites_pending_key
  ON site_invites (site_id, lower(email))
  WHERE status = 'pending';
