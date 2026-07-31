import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const migrationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260731000200_team_authorization_batches.sql"
);
const migration = await readFile(migrationPath, "utf8");
const expectedMigrationHash =
  "05c0a51d469463991c675a2c031c7a0667f0d4b20698e2e44f305b3667a6b5b1";
const historicalMigrations = [
  [
    "20260730000300_team_role_capability_foundation.sql",
    "f3a1f2ee24abbbad98aaf8eb9a53a0931c957791d0427344105dd74aa0693bc9",
  ],
  [
    "20260730000400_team_authorization_mutations.sql",
    "6f4beb015b80756413c3dd1df4d7dc1f51cb90dc902cc937b937f6c7d1cee582",
  ],
  [
    "20260731000100_team_member_mutations.sql",
    "c0e4994e85c3d65ac27898f31a71b363f62e1cd13cb68be88eadac8ec79442a5",
  ],
];

test("the migration is additive, bounded, and history-pinned", async () => {
  assert.equal(
    createHash("sha256").update(migration).digest("hex"),
    expectedMigrationHash
  );
  for (const [filename, expectedHash] of historicalMigrations) {
    const contents = await readFile(
      path.join(repoRoot, "supabase", "migrations", filename)
    );
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expectedHash
    );
  }

  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(
    migration,
    /set local statement_timeout = '45s'/u
  );
  assert.equal(
    migration.match(
      /create table public\.team_authorization_batches/gu
    )?.length,
    1
  );
  assert.equal(
    migration.match(
      /create function public\.apply_team_role_capability_changes/gu
    )?.length,
    1
  );
  assert.doesNotMatch(
    migration,
    /\b(drop|truncate)\s+table\b/iu
  );
  assert.doesNotMatch(
    migration,
    /\b(update|delete from|insert into)\s+public\.capability_catalog\b/iu
  );
});

test("the ledger is append-only, constrained, and read-only to service_role", () => {
  for (const column of [
    "batch_id uuid primary key",
    "idempotency_key uuid not null unique",
    "actor_discord_user_id text not null",
    "request_hash text not null",
    "request_payload jsonb not null",
    "result jsonb not null",
    "reason text not null",
    "operation_version integer not null",
    "submitted_pair_count integer not null",
    "changed_pair_count integer not null",
    "noop_pair_count integer not null",
    "grant_count integer not null",
    "revoke_count integer not null",
    "affected_role_count integer not null",
    "created_at timestamptz not null",
  ]) {
    assert.match(migration, new RegExp(column, "u"));
  }

  assert.match(
    migration,
    /create function public\.protect_team_authorization_batches\(\)[\s\S]*TEAM_AUTHORIZATION_BATCH_IMMUTABLE/u
  );
  assert.match(
    migration,
    /create trigger protect_team_authorization_batches\s+before update or delete on public\.team_authorization_batches/u
  );
  assert.match(
    migration,
    /alter table public\.team_authorization_batches enable row level security/u
  );
  assert.match(
    migration,
    /revoke all on table public\.team_authorization_batches[\s\S]*from public, anon, authenticated, discord_bot, service_role/u
  );
  assert.match(
    migration,
    /grant select on table public\.team_authorization_batches\s+to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(insert|update|delete|all)[\s\S]{0,100}team_authorization_batches[\s\S]{0,100}service_role/iu
  );
  assert.equal(
    migration.match(
      /insert into public\.team_authorization_batches/gu
    )?.length,
    1
  );
  assert.doesNotMatch(
    migration,
    /(update|delete from) public\.team_authorization_batches/iu
  );
});

test("the public RPC has one exact hardened surface", () => {
  assert.match(
    migration,
    /create function public\.apply_team_role_capability_changes\(\s*p_actor_discord_user_id text,\s*p_role_snapshots jsonb,\s*p_capability_snapshots jsonb,\s*p_changes jsonb,\s*p_reason text,\s*p_idempotency_key uuid\s*\)\s*returns jsonb\s*language plpgsql\s*security definer\s*set search_path = public, pg_temp/u
  );
  assert.match(
    migration,
    /alter function public\.apply_team_role_capability_changes\(\s*text, jsonb, jsonb, jsonb, text, uuid\s*\) owner to postgres/u
  );
  assert.match(
    migration,
    /revoke all on function public\.apply_team_role_capability_changes\([\s\S]*?\) from public, anon, authenticated, discord_bot, service_role/u
  );
  assert.match(
    migration,
    /grant execute on function public\.apply_team_role_capability_changes\([\s\S]*?\) to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /\bexecute\s+format\s*\(/iu
  );
});

test("input shape, set equality, duplicates, and maximum size are explicit", () => {
  for (const field of [
    "role_key",
    "expected_row_version",
    "capability_key",
    "expected_implementation_version",
    "expected_definition_hash",
    "desired_granted",
  ]) {
    assert.match(migration, new RegExp(`'${field}'`, "u"));
  }
  for (const error of [
    "INVALID_CAPABILITY_BATCH_SHAPE",
    "CAPABILITY_BATCH_EMPTY",
    "CAPABILITY_BATCH_TOO_LARGE",
    "DUPLICATE_ROLE_SNAPSHOT",
    "DUPLICATE_CAPABILITY_SNAPSHOT",
    "DUPLICATE_CAPABILITY_CHANGE",
    "CAPABILITY_BATCH_ROLE_SNAPSHOT_MISMATCH",
    "CAPABILITY_BATCH_CAPABILITY_SNAPSHOT_MISMATCH",
  ]) {
    assert.match(migration, new RegExp(error, "u"));
  }
  assert.match(migration, /v_submitted_count > 500/u);
  assert.match(
    migration,
    /count\(\s*distinct \(change_row\.role_key, change_row\.capability_key\)\s*\)/u
  );
});

test("authorization and all snapshot checks precede domain mutation", () => {
  for (const error of [
    "ACTOR_NOT_ADMIN",
    "ADMIN_CAPABILITY_GRANT_FORBIDDEN",
    "TEAM_ROLE_NOT_FOUND",
    "TEAM_ROLE_INACTIVE",
    "TEAM_ROLE_VERSION_CONFLICT",
    "CAPABILITY_NOT_FOUND",
    "CAPABILITY_INACTIVE",
    "CAPABILITY_NOT_ASSIGNABLE",
    "CAPABILITY_IMPLEMENTATION_VERSION_CONFLICT",
    "CAPABILITY_DEFINITION_CONFLICT",
  ]) {
    assert.match(migration, new RegExp(error, "u"));
  }

  const firstDomainMutation = migration.indexOf(
    "update public.team_roles as role_row"
  );
  assert.ok(firstDomainMutation > 0);
  for (const validationMarker of [
    "CAPABILITY_BATCH_CAPABILITY_SNAPSHOT_MISMATCH",
    "ACTOR_NOT_ADMIN",
    "TEAM_ROLE_VERSION_CONFLICT",
    "CAPABILITY_DEFINITION_CONFLICT",
    "into v_change_plan",
  ]) {
    assert.ok(
      migration.indexOf(validationMarker) < firstDomainMutation
    );
  }
});

test("locking and order-independent idempotency follow the shared contract", () => {
  const idempotencyLock = migration.indexOf(
    "hashtextextended(p_idempotency_key::text, 0)"
  );
  const replayLookup = migration.indexOf(
    "from public.team_authorization_batches"
  );
  const globalLock = migration.indexOf(
    "'public.team_authorization.mutations'"
  );
  const actorLock = migration.indexOf(
    "from public.team_members"
  );
  const roleLock = migration.indexOf(
    "for update of role_row"
  );
  const capabilityLock = migration.indexOf(
    "for share of capability_row"
  );
  const grantLock = migration.indexOf(
    "for update of grant_row"
  );

  assert.ok(idempotencyLock < replayLookup);
  assert.ok(replayLookup < globalLock);
  assert.ok(globalLock < actorLock);
  assert.ok(actorLock < roleLock);
  assert.ok(roleLock < capabilityLock);
  assert.ok(capabilityLock < grantLock);
  assert.match(
    migration,
    /order by btrim\(item\.value ->> 'role_key'\)/u
  );
  assert.match(
    migration,
    /order by\s+btrim\(item\.value ->> 'role_key'\),\s+btrim\(item\.value ->> 'capability_key'\)/u
  );
  assert.match(
    migration,
    /jsonb_set\(\s*v_existing_result,\s*'\{replayed\}',\s*'true'::jsonb/u
  );
  assert.match(migration, /TEAM_AUTH_IDEMPOTENCY_CONFLICT/u);
});

test("true changes version each affected role once and no-ops do not audit", () => {
  assert.equal(
    migration.match(/update public\.team_roles as role_row/gu)
      ?.length,
    1
  );
  assert.match(
    migration,
    /where plan\.had_grant is distinct from plan\.desired_granted/u
  );
  assert.equal(
    migration.match(
      /insert into public\.team_authorization_audit/gu
    )?.length,
    1
  );
  assert.match(
    migration,
    /where \(item\.value ->> 'had_grant'\)::boolean\s+is distinct from\s+\(item\.value ->> 'desired_granted'\)::boolean/u
  );
  assert.match(
    migration,
    /when v_desired_granted then 'capability_granted'\s+else 'capability_revoked'/u
  );
});

test("audit rows correlate through existing request_id and result stays minimal", () => {
  assert.doesNotMatch(migration, /add column (batch_id|batch_request_id)/iu);
  assert.match(
    migration,
    /request_id[\s\S]*v_batch_id::text/u
  );
  assert.match(
    migration,
    /create index team_authorization_audit_request_id_idx/u
  );
  for (const key of [
    "operation",
    "batchId",
    "replayed",
    "submittedCount",
    "changedCount",
    "noopCount",
    "grantCount",
    "revokeCount",
    "affectedRoles",
  ]) {
    assert.match(migration, new RegExp(`'${key}'`, "u"));
  }
  assert.doesNotMatch(
    migration,
    /'sessions'|'username'|'social'|'banInformation'/iu
  );
});

test("no capabilities, UI, API, resolver, or member grants are added", () => {
  for (const capabilityKey of [
    "submissions.submission_phase.moderate",
    "users.flag",
    "users.directory.basic.view",
  ]) {
    assert.doesNotMatch(migration, new RegExp(capabilityKey, "u"));
  }
  assert.doesNotMatch(
    migration,
    /member_capabilit|server action|\/admin\/|resolver|invitation|invite/iu
  );
});
