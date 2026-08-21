\set ON_ERROR_STOP on

-- Canonical rollback-only prize-pool lifecycle proof after migration 00500.
-- It intentionally creates no persistent Cycle or prize-pool data.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

\ir cyclePrizePoolDeadline.dev.sql

rollback;
