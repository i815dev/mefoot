-- Application authentication state. Provider access/refresh tokens are not stored.
-- The migration runner supplies the transaction and migration history.
CREATE TABLE mefoot.oauth_flows (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('google','kakao','apple')),
  nonce text NOT NULL CHECK (char_length(nonce) = 43),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) = 43),
  team_id uuid REFERENCES mefoot.teams(id) ON DELETE SET NULL,
  intent text NOT NULL CHECK (intent IN ('view','follow','join')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX oauth_flows_expiry_idx ON mefoot.oauth_flows(expires_at);

CREATE TABLE mefoot.auth_registrations (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('google','kakao','apple')),
  provider_subject text NOT NULL CHECK (char_length(provider_subject) BETWEEN 1 AND 255),
  email text CHECK (char_length(email) <= 320),
  email_verified boolean NOT NULL DEFAULT false,
  suggested_name text CHECK (char_length(suggested_name) <= 30),
  team_id uuid REFERENCES mefoot.teams(id) ON DELETE SET NULL,
  intent text NOT NULL CHECK (intent IN ('view','follow','join')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (NOT email_verified OR email IS NOT NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX auth_registrations_expiry_idx ON mefoot.auth_registrations(expires_at);

CREATE TABLE mefoot.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES mefoot.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE INDEX sessions_user_idx ON mefoot.sessions(user_id);
CREATE INDEX sessions_expiry_idx ON mefoot.sessions(expires_at);
