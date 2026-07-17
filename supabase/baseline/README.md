# CancerCulture Supabase schema baseline

This directory contains observed, schema-only database state and review
material. It is not an automatically executable migration.

Snapshot date: 2026-07-17

## Files

- `dev-schema.sql` is the normalized observed `public` schema from the approved
  DEV project.
- `live-schema.sql` is the normalized observed `public` schema after the
  controlled LIVE catch-up.
- `object-inventory.md` summarizes DEV/LIVE objects, RLS, grants, and
  security-sensitive functions.
- `migration-inventory.md` inventories the historical Git migrations without
  rewriting them.
- `schema-diff.md` records the final Git/DEV/LIVE comparison.
- `migration-review.md` records the reviewed and applied catch-up sequence.
- `export-schema.ps1` reproduces a schema-only dump with a read-only database
  session.

The SHA-256 hashes of the normalized snapshots are:

```text
DEV  F786AA25F2552985F193B8C3CEEECEE61F30D6359B9113A6FAD1F85D035677B5
LIVE CAA8FF402A51C3BA3896FA6F16928A757B31CD214DDD339685B74166614819A6
```

## Reproduce DEV

`SUPABASE_DEV_DATABASE_URL` must be present in `.env.codex.local` or in the
current process. Replace the project-ref placeholder locally; never commit a
connection string. PostgreSQL 18 `pg_dump` must be on PATH; alternatively set
the process-only `PG_DUMP_BIN` variable to the executable location.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\supabase\baseline\export-schema.ps1 `
  -Environment DEV `
  -ConnectionVariable SUPABASE_DEV_DATABASE_URL `
  -ExpectedProjectRef <DEV_PROJECT_REF> `
  -OutputPath supabase/baseline/dev-schema.sql
```

The helper:

- validates the project reference;
- uses PostgreSQL 18 `pg_dump`;
- sets `default_transaction_read_only=on`;
- exports only the `public` schema with `--schema-only`;
- retains functions, triggers, RLS, policies, ACLs, grants, and revokes;
- removes owners, tablespaces, version banners, and random `\restrict` markers;
- rejects a dump containing a `pg_dump` data section.

## Reproduce LIVE

`SUPABASE_LIVE_DATABASE_URL` must be explicitly present in
`.env.codex.local` or in the current process. Never reuse DEV or infer a LIVE
target from `.env.local`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\supabase\baseline\export-schema.ps1 `
  -Environment LIVE `
  -ConnectionVariable SUPABASE_LIVE_DATABASE_URL `
  -ExpectedProjectRef <LIVE_PROJECT_REF> `
  -OutputPath supabase/baseline/live-schema.sql
```

The expected LIVE project reference must be independently verified before that
command is run. A resulting `live-schema.sql` is an observed state, never a
proposed migration.

## Scope and limitations

- No table contents, users, sessions, votes, submissions, IDs, or storage
  objects are exported.
- `auth`, `storage`, `realtime`, `vault`, GraphQL, and extension schemas are
  inventoried but not dumped as application-owned schema.
- The historical migrations are not a standalone bootstrap: they assume
  pre-existing application tables and functions.
- DEV and LIVE have no `supabase_migrations.schema_migrations` relation, so
  migration application history cannot be proven from a standard Supabase
  ledger. The 2026-07-17 LIVE catch-up was applied directly with `psql` and
  `ON_ERROR_STOP`; its exact package files are retained in Git.
- The pre-catch-up LIVE schema/data backup is stored outside the repository as
  backup `20260717T080535-pre-catchup`; it must never be committed.
