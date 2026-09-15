-- PostgreSQL 18 constraint checks for the six-table member/team design draft.
-- Run after database/drafts/001_members_teams.sql IN THE SAME TRANSACTION.
-- The caller MUST ROLLBACK the entire transaction, including the draft DDL.
-- This file does not BEGIN, COMMIT, or apply a migration to a live schema.
-- These are database state/constraint checks, not API authorization, OAuth,
-- multi-session concurrency, or approval-service transaction tests.

DO $test$
DECLARE
  owner_id uuid := gen_random_uuid();
  next_owner_id uuid := gen_random_uuid();
  applicant_id uuid := gen_random_uuid();
  other_owner_id uuid := gen_random_uuid();
  retry_applicant_id uuid := gen_random_uuid();
  team_id_1 uuid := gen_random_uuid();
  team_id_2 uuid := gen_random_uuid();
  request_id_1 uuid := gen_random_uuid();
  request_id_2 uuid := gen_random_uuid();
  rejected_request_id uuid := gen_random_uuid();
  retry_request_id uuid := gen_random_uuid();
  subject_1 text := 'sql-test-' || gen_random_uuid()::text;
  shared_email text := 'sql-test-' || gen_random_uuid()::text || '@example.invalid';
  checks_passed integer := 0;
  violated_constraint text;
BEGIN
  INSERT INTO mefoot.users
    (id, display_name, terms_version, privacy_notice_version, consented_at)
  VALUES
    (owner_id, 'SQL test owner', 'test-v1', 'test-v1', now()),
    (next_owner_id, 'SQL test next owner', 'test-v1', 'test-v1', now()),
    (applicant_id, 'SQL test applicant', 'test-v1', 'test-v1', now()),
    (other_owner_id, 'SQL test other owner', 'test-v1', 'test-v1', now()),
    (retry_applicant_id, 'SQL test retry applicant', 'test-v1', 'test-v1', now());

  BEGIN
    INSERT INTO mefoot.users (display_name, privacy_notice_version, consented_at)
    VALUES ('SQL test missing terms', 'test-v1', now());
    RAISE EXCEPTION 'FAIL: missing terms_version was accepted';
  EXCEPTION WHEN not_null_violation THEN
    checks_passed := checks_passed + 1;
  END;

  BEGIN
    INSERT INTO mefoot.users (display_name, terms_version, consented_at)
    VALUES ('SQL test missing privacy', 'test-v1', now());
    RAISE EXCEPTION 'FAIL: missing privacy_notice_version was accepted';
  EXCEPTION WHEN not_null_violation THEN
    checks_passed := checks_passed + 1;
  END;

  -- An owner FK may be temporarily unresolved while a team and its first
  -- membership are created, but must be satisfied when constraints are checked.
  SET CONSTRAINTS mefoot.teams_owner_membership_fk DEFERRED;
  INSERT INTO mefoot.teams (id, owner_user_id, name, sport)
  VALUES
    (team_id_1, owner_id, 'SQL test team ' || team_id_1::text, 'futsal'),
    (team_id_2, other_owner_id, 'SQL test team ' || team_id_2::text, 'football');
  INSERT INTO mefoot.team_memberships (team_id, user_id)
  VALUES (team_id_1, owner_id), (team_id_2, other_owner_id);
  SET CONSTRAINTS mefoot.teams_owner_membership_fk IMMEDIATE;
  SET CONSTRAINTS mefoot.teams_owner_membership_fk DEFERRED;
  checks_passed := checks_passed + 1;

  INSERT INTO mefoot.auth_identities
    (user_id, provider, provider_subject, email, email_verified)
  VALUES (applicant_id, 'google', subject_1, shared_email, true);
  BEGIN
    INSERT INTO mefoot.auth_identities (user_id, provider, provider_subject)
    VALUES (retry_applicant_id, 'google', subject_1);
    RAISE EXCEPTION 'FAIL: duplicate provider/subject was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'auth_identities_provider_provider_subject_key' THEN
      RAISE EXCEPTION 'FAIL: wrong identity uniqueness constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;

  -- Equal email addresses must not silently merge or reject separate subjects.
  INSERT INTO mefoot.auth_identities
    (user_id, provider, provider_subject, email, email_verified)
  VALUES (retry_applicant_id, 'google', 'sql-test-' || gen_random_uuid()::text, shared_email, true);
  IF (SELECT count(DISTINCT user_id) FROM mefoot.auth_identities WHERE email = shared_email) <> 2 THEN
    RAISE EXCEPTION 'FAIL: identities with the same email were not kept separate';
  END IF;
  checks_passed := checks_passed + 1;

  -- Subject strings are namespaced by provider, not globally unique.
  INSERT INTO mefoot.auth_identities (user_id, provider, provider_subject)
  VALUES (applicant_id, 'kakao', subject_1);
  checks_passed := checks_passed + 1;

  BEGIN
    INSERT INTO mefoot.auth_identities (user_id, provider, provider_subject)
    VALUES (applicant_id, 'google', 'sql-test-' || gen_random_uuid()::text);
    RAISE EXCEPTION 'FAIL: a second identity for the same user/provider was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'auth_identities_user_id_provider_key' THEN
      RAISE EXCEPTION 'FAIL: wrong user/provider constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;

  INSERT INTO mefoot.team_follows (team_id, user_id) VALUES (team_id_1, applicant_id);
  BEGIN
    INSERT INTO mefoot.team_follows (team_id, user_id) VALUES (team_id_1, applicant_id);
    RAISE EXCEPTION 'FAIL: duplicate team follow was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'team_follows_pkey' THEN
      RAISE EXCEPTION 'FAIL: wrong follow constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;
  IF EXISTS (SELECT 1 FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = applicant_id) THEN
    RAISE EXCEPTION 'FAIL: following a team created a membership';
  END IF;
  checks_passed := checks_passed + 1;

  INSERT INTO mefoot.team_join_requests (id, team_id, user_id)
  VALUES (request_id_1, team_id_1, applicant_id);
  BEGIN
    INSERT INTO mefoot.team_join_requests (team_id, user_id)
    VALUES (team_id_1, applicant_id);
    RAISE EXCEPTION 'FAIL: duplicate pending request was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'team_join_requests_one_pending' THEN
      RAISE EXCEPTION 'FAIL: wrong pending-request constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;

  BEGIN
    UPDATE mefoot.team_join_requests SET status = 'approved' WHERE id = request_id_1;
    RAISE EXCEPTION 'FAIL: approval without resolution metadata was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'team_join_requests_resolution_check' THEN
      RAISE EXCEPTION 'FAIL: wrong resolution metadata constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;

  BEGIN
    UPDATE mefoot.team_join_requests
    SET status = 'approved', resolved_at = now(), resolved_by_user_id = applicant_id
    WHERE id = request_id_1;
    RAISE EXCEPTION 'FAIL: self-approval was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'team_join_requests_resolution_check' THEN
      RAISE EXCEPTION 'FAIL: wrong self-approval constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;

  BEGIN
    INSERT INTO mefoot.team_join_requests
      (team_id, user_id, status, resolved_at, resolved_by_user_id)
    VALUES (team_id_2, applicant_id, 'approved', now(), other_owner_id);
    RAISE EXCEPTION 'FAIL: an already-approved request could be inserted';
  EXCEPTION WHEN check_violation THEN
    checks_passed := checks_passed + 1;
  END;

  -- Successful approval and member insertion are deliberately explicit here.
  -- This does NOT establish that the future service performs both atomically.
  UPDATE mefoot.team_join_requests
  SET status = 'approved', resolved_at = now(), resolved_by_user_id = owner_id
  WHERE id = request_id_1;
  INSERT INTO mefoot.team_memberships (team_id, user_id) VALUES (team_id_1, applicant_id);
  IF NOT EXISTS (SELECT 1 FROM mefoot.team_follows WHERE team_id = team_id_1 AND user_id = applicant_id) THEN
    RAISE EXCEPTION 'FAIL: membership unexpectedly removed the independent follow';
  END IF;
  checks_passed := checks_passed + 1;

  BEGIN
    INSERT INTO mefoot.team_memberships (team_id, user_id) VALUES (team_id_1, applicant_id);
    RAISE EXCEPTION 'FAIL: duplicate membership was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'team_memberships_pkey' THEN
      RAISE EXCEPTION 'FAIL: wrong membership constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;

  BEGIN
    UPDATE mefoot.team_join_requests
    SET status = 'pending', resolved_at = NULL, resolved_by_user_id = NULL
    WHERE id = request_id_1;
    RAISE EXCEPTION 'FAIL: an approved request was reopened';
  EXCEPTION WHEN check_violation THEN
    checks_passed := checks_passed + 1;
  END;

  BEGIN
    UPDATE mefoot.team_join_requests SET message = 'rewritten history' WHERE id = request_id_1;
    RAISE EXCEPTION 'FAIL: resolved request history could be rewritten';
  EXCEPTION WHEN check_violation THEN
    checks_passed := checks_passed + 1;
  END;

  INSERT INTO mefoot.team_join_requests (id, team_id, user_id)
  VALUES (rejected_request_id, team_id_1, retry_applicant_id);
  BEGIN
    UPDATE mefoot.team_join_requests SET user_id = next_owner_id WHERE id = rejected_request_id;
    RAISE EXCEPTION 'FAIL: a request could be reassigned to a different applicant';
  EXCEPTION WHEN check_violation THEN
    checks_passed := checks_passed + 1;
  END;
  UPDATE mefoot.team_join_requests
  SET status = 'rejected', resolved_at = now(), resolved_by_user_id = owner_id,
      resolution_note = 'SQL constraint test only'
  WHERE id = rejected_request_id;
  INSERT INTO mefoot.team_join_requests (id, team_id, user_id)
  VALUES (retry_request_id, team_id_1, retry_applicant_id);
  IF (SELECT count(*) FROM mefoot.team_join_requests
      WHERE team_id = team_id_1 AND user_id = retry_applicant_id) <> 2
     OR NOT EXISTS (SELECT 1 FROM mefoot.team_join_requests
                    WHERE id = rejected_request_id AND status = 'rejected')
     OR NOT EXISTS (SELECT 1 FROM mefoot.team_join_requests
                    WHERE id = retry_request_id AND status = 'pending') THEN
    RAISE EXCEPTION 'FAIL: retry did not preserve the rejected request';
  END IF;
  checks_passed := checks_passed + 1;

  BEGIN
    UPDATE mefoot.team_join_requests
    SET status = 'withdrawn', resolved_at = now(), resolved_by_user_id = owner_id
    WHERE id = retry_request_id;
    RAISE EXCEPTION 'FAIL: another user was recorded as the applicant withdrawing';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'team_join_requests_resolution_check' THEN
      RAISE EXCEPTION 'FAIL: wrong withdrawal constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;
  UPDATE mefoot.team_join_requests
  SET status = 'withdrawn', resolved_at = now(), resolved_by_user_id = retry_applicant_id
  WHERE id = retry_request_id;
  checks_passed := checks_passed + 1;

  -- Force the deferred owner FK now; merely issuing DELETE is not a test.
  BEGIN
    DELETE FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = owner_id;
    SET CONSTRAINTS mefoot.teams_owner_membership_fk IMMEDIATE;
    RAISE EXCEPTION 'FAIL: a team could lose its owner membership';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'teams_owner_membership_fk' THEN
      RAISE EXCEPTION 'FAIL: wrong owner-membership constraint: %', violated_constraint;
    END IF;
    checks_passed := checks_passed + 1;
  END;
  IF NOT EXISTS (SELECT 1 FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = owner_id) THEN
    RAISE EXCEPTION 'FAIL: expected-failure subtransaction did not restore the owner';
  END IF;

  -- A transfer may temporarily reference the incoming owner before that
  -- membership is inserted, but must satisfy the FK at the transaction boundary.
  SET CONSTRAINTS mefoot.teams_owner_membership_fk DEFERRED;
  UPDATE mefoot.teams SET owner_user_id = next_owner_id WHERE id = team_id_1;
  DELETE FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = owner_id;
  INSERT INTO mefoot.team_memberships (team_id, user_id) VALUES (team_id_1, next_owner_id);
  SET CONSTRAINTS mefoot.teams_owner_membership_fk IMMEDIATE;
  SET CONSTRAINTS mefoot.teams_owner_membership_fk DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM mefoot.teams WHERE id = team_id_1 AND owner_user_id = next_owner_id)
     OR EXISTS (SELECT 1 FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = owner_id)
     OR NOT EXISTS (SELECT 1 FROM mefoot.team_join_requests
                    WHERE id = request_id_1 AND resolved_by_user_id = owner_id AND status = 'approved') THEN
    RAISE EXCEPTION 'FAIL: owner transfer/leave damaged historical approval';
  END IF;
  checks_passed := checks_passed + 1;

  INSERT INTO mefoot.team_join_requests (id, team_id, user_id)
  VALUES (request_id_2, team_id_2, applicant_id);
  UPDATE mefoot.team_join_requests
  SET status = 'approved', resolved_at = now(), resolved_by_user_id = other_owner_id
  WHERE id = request_id_2;
  INSERT INTO mefoot.team_memberships (team_id, user_id) VALUES (team_id_2, applicant_id);
  IF (SELECT count(*) FROM mefoot.team_memberships WHERE user_id = applicant_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: one user could not join two teams';
  END IF;
  checks_passed := checks_passed + 1;

  DELETE FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = applicant_id;
  IF EXISTS (SELECT 1 FROM mefoot.team_memberships WHERE team_id = team_id_1 AND user_id = applicant_id)
     OR NOT EXISTS (SELECT 1 FROM mefoot.team_memberships WHERE team_id = team_id_2 AND user_id = applicant_id)
     OR NOT EXISTS (SELECT 1 FROM mefoot.team_join_requests
                    WHERE id = request_id_1 AND status = 'approved' AND user_id = applicant_id) THEN
    RAISE EXCEPTION 'FAIL: leaving one team damaged membership or approval history';
  END IF;
  checks_passed := checks_passed + 1;

  SET CONSTRAINTS mefoot.teams_owner_membership_fk IMMEDIATE;
  SET CONSTRAINTS mefoot.teams_owner_membership_fk DEFERRED;
  RAISE NOTICE 'PASS: % member/team database constraint checks. Caller must ROLLBACK.', checks_passed;
END;
$test$;

SELECT 'PASS: member/team database constraint checks; API authorization and concurrency not tested; caller must ROLLBACK' AS result;
