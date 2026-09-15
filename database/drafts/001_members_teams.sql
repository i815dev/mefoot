-- Mefoot member/team design, PostgreSQL 18. Not applied to the live database.
-- Run the entire file inside one transaction. The mefoot schema already exists.
-- No IF NOT EXISTS: a conflicting existing design must fail, not be skipped.

CREATE TABLE mefoot.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 30),
  avatar_url text CHECK (char_length(avatar_url) <= 2048),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'withdrawn')),
  terms_version text NOT NULL CHECK (char_length(terms_version) BETWEEN 1 AND 40),
  privacy_notice_version text NOT NULL CHECK (char_length(privacy_notice_version) BETWEEN 1 AND 40),
  consented_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
);

CREATE TABLE mefoot.auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES mefoot.users(id),
  provider text NOT NULL CHECK (provider IN ('kakao', 'google', 'apple')),
  provider_subject text NOT NULL CHECK (char_length(provider_subject) BETWEEN 1 AND 255),
  email text CHECK (char_length(email) <= 320),
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider),
  CHECK (NOT email_verified OR email IS NOT NULL)
);
CREATE TABLE mefoot.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  sport text NOT NULL CHECK (sport IN ('football', 'futsal', 'both')),
  region_label text CHECK (char_length(region_label) <= 100),
  logo_url text CHECK (char_length(logo_url) <= 2048),
  join_requests_open boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE mefoot.team_follows (
  team_id uuid NOT NULL REFERENCES mefoot.teams(id),
  user_id uuid NOT NULL REFERENCES mefoot.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_follows_user_idx ON mefoot.team_follows(user_id, created_at DESC);

-- Current membership only. An approved application remains history after leaving.
-- The owner is derived from teams.owner_user_id, never duplicated in role.
CREATE TABLE mefoot.team_memberships (
  team_id uuid NOT NULL REFERENCES mefoot.teams(id),
  user_id uuid NOT NULL REFERENCES mefoot.users(id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_memberships_user_idx ON mefoot.team_memberships(user_id, joined_at DESC);

-- Allows team + first owner membership in a single transaction; prevents an
-- ownerless team at commit and supports transfer + leaving in one transaction.
ALTER TABLE mefoot.teams ADD CONSTRAINT teams_owner_membership_fk
  FOREIGN KEY (id, owner_user_id)
  REFERENCES mefoot.team_memberships(team_id, user_id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE mefoot.team_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES mefoot.teams(id),
  user_id uuid NOT NULL REFERENCES mefoot.users(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES mefoot.users(id),
  resolution_note text CHECK (char_length(resolution_note) <= 300),
  CONSTRAINT team_join_requests_resolution_check CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolved_by_user_id IS NULL AND resolution_note IS NULL)
    OR
    (status IN ('approved', 'rejected', 'withdrawn') AND resolved_at IS NOT NULL
      AND resolved_by_user_id IS NOT NULL AND resolved_at >= created_at
      AND ((status = 'withdrawn' AND resolved_by_user_id = user_id)
        OR (status IN ('approved', 'rejected') AND resolved_by_user_id <> user_id)))
  )
);
CREATE UNIQUE INDEX team_join_requests_one_pending
  ON mefoot.team_join_requests(team_id, user_id) WHERE status = 'pending';
CREATE INDEX team_join_requests_queue_idx
  ON mefoot.team_join_requests(team_id, created_at, id) WHERE status = 'pending';
CREATE INDEX team_join_requests_user_history_idx
  ON mefoot.team_join_requests(user_id, team_id, created_at DESC);

CREATE FUNCTION mefoot.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON mefoot.users
  FOR EACH ROW EXECUTE FUNCTION mefoot.touch_updated_at();
CREATE TRIGGER teams_touch_updated_at BEFORE UPDATE ON mefoot.teams
  FOR EACH ROW EXECUTE FUNCTION mefoot.touch_updated_at();

-- State integrity only; actor authorization and membership creation require
-- the service transaction described in docs/member-team-data-model.md.
CREATE FUNCTION mefoot.guard_join_request_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'A new join request must be pending' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.team_id, NEW.user_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.team_id, OLD.user_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Join request identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'A resolved join request is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER team_join_requests_guard BEFORE INSERT OR UPDATE ON mefoot.team_join_requests
  FOR EACH ROW EXECUTE FUNCTION mefoot.guard_join_request_transition();

-- Functions are trigger helpers, not public API entry points.
REVOKE ALL ON FUNCTION mefoot.touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION mefoot.guard_join_request_transition() FROM PUBLIC;
