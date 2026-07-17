# Git / DEV / LIVE schema comparison

Observed on 2026-07-17 after the controlled LIVE application-data reset and
six-package catch-up.

## Connection and execution status

- DEV and LIVE were loaded only from their explicitly named variables in
  `.env.codex.local` and verified as different project references.
- Both schema captures used schema-only `pg_dump` with
  `default_transaction_read_only=on`.
- LIVE was changed only through the six new, reviewed `20260717` packages and
  one explicit 30-table application-data TRUNCATE.
- No Supabase system schema, Auth row, Storage row, or Storage object was
  modified.

## Final structural parity

DEV and LIVE each contain:

- 41 public tables;
- 3 views;
- 42 functions/RPCs;
- 7 non-internal triggers;
- 6 RLS policies.

Canonical catalog fingerprints match for column definitions, constraints,
indexes, views, trigger definitions, policies, RLS flags, and all 309 relevant
table/view grant rows.

All 11 tables and the one view absent from pre-catch-up LIVE are now present.
All 39 migration-defined functions absent from pre-catch-up LIVE are present.

## Intentional differences

1. Thirty-five columns on pre-existing LIVE tables have different ordinal
   positions because they were added through `ALTER TABLE`. Names, types,
   nullability, defaults, generated/identity state, constraints, and code-facing
   behavior match DEV.
2. `sync_discord_user_context(text,text,text,text)` is deliberately stricter on
   LIVE: `search_path=public,pg_temp`, no PUBLIC/anon/authenticated execute, and
   explicit execute only for `service_role` and `discord_bot`. Catch-up package
   F records this hardening for later application to other environments.

## Git reproducibility

The 13 historical migrations remain unchanged. Six new packages record the
exact reviewed catch-up:

1. public Website boot;
2. Discord, sessions, and Ban enforcement;
3. Cycle infrastructure;
4. Upload and media infrastructure;
5. fail-closed retained-Legacy verification;
6. security and grants.

The 25 tables, 2 views, and 3 functions that predate the historical migration
chain are explicitly retained and verified by package E. They are also fully
defined in the normalized DEV/LIVE schema baselines.

## Data and migration ledger

- All 41 public tables are empty except the required singleton row in
  `discord_sync_health`.
- There is no active Cycle, application user, Submission, Vote, result, sponsor
  state, Coin Launch, Auth user, or Storage object.
- Neither DEV nor LIVE exposes `supabase_migrations.schema_migrations`.
  Therefore direct package application is evidenced by the package files,
  execution report, schema fingerprints, and final catalog comparison rather
  than by a Supabase migration ledger.

## Remaining review item

Apply package F to DEV in a separately approved DEV maintenance step if exact
function ACL/search-path parity is required. Do not mark any migration as
applied in a Supabase system schema without an independently reviewed ledger
recovery plan.
