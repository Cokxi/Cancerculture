import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260731000600_resolve_stale_moderation_requests.sql",
    root
  ),
  "utf8"
);

test("the additive migration changes only the moderation RPC definition", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.equal(
    migration.match(
      /create or replace function public\.moderate_submission\(/gu
    )?.length,
    1
  );
  const afterFunction = migration.slice(
    migration.indexOf("$function$;") + "$function$;".length
  );
  assert.doesNotMatch(
    afterFunction,
    /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.(?:submissions|moderation_action_logs|team_role_capabilities|capability_catalog)/iu
  );
});

test("all seven semantic conflicts use an explicit non-retryable PostgREST 409", () => {
  assert.equal(migration.match(/errcode = 'PT409'/gu)?.length, 7);
  assert.doesNotMatch(migration, /errcode = '40001'/u);
  for (const code of [
    "SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT",
    "MODERATION_CYCLE_NOT_FOUND",
    "MODERATION_PHASE_CLOSED",
    "MODERATION_PHASE_CONFLICT",
    "MODERATION_SUBMISSION_NOT_FOUND",
    "MODERATION_SUBMISSION_CYCLE_CONFLICT",
    "MODERATION_EXPECTED_STATE_CONFLICT",
  ]) {
    assert.match(migration, new RegExp(code, "u"));
  }
});

test("replay and ordered locks remain ahead of expected-state and no-op handling", () => {
  const advisory = migration.indexOf("pg_advisory_xact_lock");
  const replay = migration.indexOf("return jsonb_set(");
  const cycleLock = migration.indexOf(
    "from public.voting_cycles as cycle_row"
  );
  const submissionLock = migration.indexOf(
    "from public.submissions as submission_row"
  );
  const expectedState = migration.indexOf(
    "MODERATION_EXPECTED_STATE_CONFLICT"
  );
  const mutationGate = migration.indexOf(
    "v_current_is_disqualified is distinct from\n    v_target_is_disqualified"
  );
  const audit = migration.indexOf(
    "insert into public.moderation_action_logs"
  );

  assert.ok(advisory < replay);
  assert.ok(replay < cycleLock);
  assert.ok(cycleLock < submissionLock);
  assert.ok(submissionLock < expectedState);
  assert.ok(expectedState < mutationGate);
  assert.ok(mutationGate < audit);
});

test("security, capability mapping and mutation/audit invariants remain in the RPC", () => {
  assert.match(migration, /security definer/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  for (const key of [
    "submissions.submission_phase.disqualify",
    "submissions.submission_phase.reinstate",
    "submissions.voting_phase.disqualify",
    "submissions.voting_phase.reinstate",
  ]) {
    assert.match(migration, new RegExp(key.replaceAll(".", "\\."), "u"));
  }
  assert.match(migration, /update public\.submissions/u);
  assert.match(migration, /insert into public\.moderation_action_logs/u);
  assert.match(
    migration,
    /insert into public\.submission_moderation_requests/u
  );
  assert.doesNotMatch(migration, /delete\s+from\s+public\.votes/iu);
});
