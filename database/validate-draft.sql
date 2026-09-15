-- psql -X -v ON_ERROR_STOP=1 -f database/validate-draft.sql
-- Supply connection settings externally. Never put a password in this file.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
\ir drafts/001_members_teams.sql
\ir tests/001_members_teams.sql
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;

SELECT count(*) AS remaining_service_tables
FROM pg_tables WHERE schemaname = 'mefoot';
