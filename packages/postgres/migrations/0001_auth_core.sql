-- Better Auth core: users, sessions, accounts, verifications.
--
-- Rollout note: additive creation of the auth core on an empty database, no
-- backfill. The Better Auth sub-part configures the library against exactly this
-- shape — uuid ids via a custom generateId, and Better Auth's camelCase model
-- fields mapped onto these snake_case columns. Ids are application-generated
-- UUIDv7 with no database default, and every timestamp is timestamptz (ADR-0006).

CREATE TABLE users (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Better Auth looks accounts up by (provider_id, account_id) and users up by
-- email; email uniqueness is the account-takeover guard the legacy app lacked.
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token      text NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_token_key ON sessions (token);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE accounts (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_provider_account_key ON accounts (provider_id, account_id);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE verifications (
  id         uuid PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verifications_identifier_idx ON verifications (identifier);
