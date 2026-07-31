import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260731000500_atomic_submission_moderation_cutover.sql",
    root
  ),
  "utf8"
);

test("cutover migration is atomic and requires the zero-grant baseline", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(
    migration,
    /ATOMIC_SUBMISSION_MODERATION_REQUIRES_ZERO_GRANTS/u
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("one hardened external moderation RPC owns the entire mutation", () => {
  assert.equal(
    migration.match(/create function public\.moderate_submission\(/gu)
      ?.length,
    1
  );
  assert.match(migration, /security definer/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(
    migration,
    /alter function public\.moderate_submission\([\s\S]*?\) owner to postgres/u
  );
  assert.match(
    migration,
    /revoke all on function public\.moderate_submission\([\s\S]*?from public, anon, authenticated, discord_bot, service_role/u
  );
  assert.match(
    migration,
    /grant execute on function public\.moderate_submission\([\s\S]*?to service_role/u
  );
});

test("the RPC serializes idempotency, cycle and submission in that order", () => {
  const idempotency = migration.indexOf("pg_advisory_xact_lock");
  const cycleLock = migration.indexOf(
    "from public.voting_cycles as cycle_row"
  );
  const submissionLock = migration.indexOf(
    "from public.submissions as submission_row"
  );
  const authorization = migration.indexOf(
    "from public.team_members as member_row"
  );
  const mutation = migration.indexOf("update public.submissions");
  const audit = migration.indexOf(
    "insert into public.moderation_action_logs"
  );
  const ledger = migration.lastIndexOf(
    "insert into public.submission_moderation_requests"
  );

  assert.ok(idempotency < cycleLock);
  assert.ok(cycleLock < submissionLock);
  assert.ok(submissionLock < authorization);
  assert.ok(authorization < mutation);
  assert.ok(mutation < audit);
  assert.ok(audit < ledger);
  assert.match(migration, /for update;/u);
  assert.match(migration, /MODERATION_EXPECTED_STATE_CONFLICT/u);
  assert.match(migration, /SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT/u);
});

test("all four phase-operation capability mappings are internal", () => {
  for (const key of [
    "submissions.submission_phase.disqualify",
    "submissions.submission_phase.reinstate",
    "submissions.voting_phase.disqualify",
    "submissions.voting_phase.reinstate",
  ]) {
    assert.match(migration, new RegExp(key.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(migration, /p_capability/u);
  assert.match(migration, /v_actor_role <> 'admin'/u);
  assert.match(migration, /team_role_capabilities/u);
});

test("audit and ledger are structured and browser-inaccessible", () => {
  for (const field of [
    "moderation_request_id",
    "moderation_phase",
    "moderation_operation",
    "before_state",
    "after_state",
  ]) {
    assert.match(migration, new RegExp(field, "u"));
  }
  assert.match(
    migration,
    /revoke all on table public\.submission_moderation_requests[\s\S]*?from public, anon, authenticated, discord_bot, service_role/u
  );
  assert.match(
    migration,
    /grant select on table public\.submission_moderation_requests[\s\S]*?to service_role/u
  );
});

test("legacy key is tombstoned without deleting grants", () => {
  assert.match(
    migration,
    /where key = 'submissions\.submission_phase\.moderate'/u
  );
  assert.match(migration, /assignable_to_non_admin = false/u);
  assert.match(migration, /is_active = false/u);
  assert.match(migration, /implementation_version = 2/u);
  assert.match(migration, /deprecated_at = transaction_timestamp\(\)/u);
  assert.match(
    migration,
    /ATOMIC_SUBMISSION_MODERATION_CATALOG_TOTALS_MISMATCH/u
  );
});
