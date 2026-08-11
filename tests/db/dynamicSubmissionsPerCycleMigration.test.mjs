import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const migration = await readRepoFile(
  "supabase/migrations/20260811000100_dynamic_submissions_per_cycle.sql"
);

test("migration preserves legacy quota before assigning future defaults and bounds", () => {
  const historicalBackfill = migration.indexOf("submissions_per_user = 1");
  const futureDefault = migration.indexOf(
    "alter column submissions_per_user set default 2"
  );

  assert.ok(historicalBackfill > -1);
  assert.ok(historicalBackfill < futureDefault);
  assert.match(migration, /submissions_per_user between 1 and 20/);
  assert.match(
    migration,
    /upload_success_cooldown_seconds between 30 and 300/
  );
  assert.match(migration, /votes_per_user between 1 and 50/);
  assert.match(
    migration,
    /p_expected_votes_per_user not between 1 and 50/
  );
});

test("only the hard submission uniqueness is replaced and active intent uniqueness is retained", () => {
  assert.match(
    migration,
    /drop index public\.submissions_cycle_id_discord_user_id_uidx/
  );
  assert.match(
    migration,
    /create index submissions_cycle_user_id_idx[\s\S]*?\(cycle_id, discord_user_id, id\)/
  );
  assert.doesNotMatch(
    migration,
    /drop index public\.submission_upload_operations_one_active_user_cycle_idx/
  );
  assert.match(
    migration,
    /ACTIVE_UPLOAD_OPERATION_INDEX_POSTFLIGHT_FAILED/
  );
  assert.match(
    migration,
    /v_active_operation_predicate is distinct from[\s\S]*?'reserved'[\s\S]*?'r2_uploaded'/
  );
});

test("quota and cooldown are rechecked under the canonical lock in reserve and commit", () => {
  const lockMatches = migration.match(
    /submission-upload-user-cycle:/g
  );
  assert.ok((lockMatches?.length ?? 0) >= 2);
  assert.match(
    migration,
    /select count\(\*\)::integer[\s\S]*?v_used >= v_cycle\.submissions_per_user/g
  );
  assert.match(
    migration,
    /operation\.status = 'completed'[\s\S]*?max\(operation\.completed_at\)/
  );
  assert.match(migration, /'outcome', 'cooldown_active'/);
  assert.match(migration, /ceil\(extract\(epoch from/);
  assert.match(
    migration,
    /v_cooldown_remaining = 0[\s\S]*?v_next_allowed_at := null/
  );
  for (const functionName of [
    "reserve_submission_upload",
    "commit_submission_upload",
  ]) {
    const functionStart = migration.indexOf(
      `create or replace function public.${functionName}`
    );
    const functionEnd = migration.indexOf(
      "$function$;",
      functionStart
    );
    const functionSql = migration.slice(functionStart, functionEnd);
    const userCycleLock = functionSql.indexOf(
      "submission-upload-user-cycle:"
    );
    const cycleRowLock = functionSql.indexOf("for update", userCycleLock);
    const authoritativeNow = functionSql.indexOf(
      "v_now := clock_timestamp()",
      userCycleLock
    );
    assert.ok(userCycleLock > -1 && userCycleLock < cycleRowLock);
    assert.ok(cycleRowLock < authoritativeNow);
  }
});

test("completed replay remains ahead of cooldown and quota checks", () => {
  const reserve = migration.slice(
    migration.indexOf("create or replace function public.reserve_submission_upload"),
    migration.indexOf("create or replace function public.commit_submission_upload")
  );
  const commit = migration.slice(
    migration.indexOf("create or replace function public.commit_submission_upload")
  );

  assert.ok(reserve.indexOf("v_operation.status = 'completed'") < reserve.indexOf("v_used >="));
  assert.ok(commit.indexOf("v_operation.status = 'completed'") < commit.indexOf("v_used >="));
});

test("cycle settings are immutable after start and reset deliberately restores defaults", () => {
  assert.match(migration, /CYCLE_SUBMISSION_SETTINGS_IMMUTABLE/);
  assert.match(migration, /new\.submissions_per_user := 2/);
  assert.match(
    migration,
    /new\.upload_success_cooldown_seconds := 120/
  );
  assert.match(migration, /'submissions_per_user', v_cycle\.submissions_per_user/);
  assert.match(
    migration,
    /'upload_success_cooldown_seconds',[\s\S]*?v_cycle\.upload_success_cooldown_seconds/
  );
  assert.match(migration, /reset_submissions_per_user/);
  assert.match(migration, /CYCLE_SUBMISSION_SETTINGS_RESET_REQUIRED/);
  assert.match(
    migration,
    /operation\.status in \('reserved', 'r2_uploaded'\)[\s\S]*?status = 'cleanup_pending'/
  );
  assert.match(migration, /previous_submissions_per_user/);
  assert.match(migration, /previous_upload_success_cooldown_seconds/);
});

test("published Rules, FAQ and Homepage copy is revised without rewriting history", () => {
  assert.match(migration, /insert into public\.content_revisions/);
  assert.match(migration, /current_version = current_version \+ 1/);
  assert.match(migration, /'material_change', true/);
  assert.match(migration, /cycle-specific Submission quota/);
  assert.match(migration, /cycle-specific Vote limit/);
  assert.match(migration, /current-cycle Submissions in My Profile/);
  assert.match(migration, /DYNAMIC_LIMIT_COPY_POSTFLIGHT_FAILED/);
  assert.doesNotMatch(
    migration.slice(migration.indexOf("v_rules_content := jsonb_set")),
    /Each user may submit one \(1\) meme and cast one \(1\) vote per cycle\./
  );
});

test("new and replaced privileged functions keep owner, fixed search path, ACL and overload postflights", () => {
  assert.match(migration, /security definer/g);
  assert.match(migration, /set search_path = public, pg_temp/g);
  assert.match(migration, /owner to postgres/g);
  assert.match(migration, /to service_role/g);
  assert.match(migration, /DYNAMIC_SUBMISSIONS_OVERLOAD_POSTFLIGHT_FAILED/);
  assert.match(migration, /DYNAMIC_SUBMISSIONS_FUNCTION_ACL_FAILED/);
  assert.match(migration, /has_function_privilege\('discord_bot'/);
  assert.match(migration, /'public\.reset_cycle\(bigint,text,text\)'/);
});

test("finalization remains per winning submission even for repeated owners", async () => {
  const [finalization, devContract] = await Promise.all([
    readRepoFile(
      "supabase/migrations/20260717000300_live_catchup_cycle_infrastructure.sql"
    ),
    readRepoFile("tests/db/resetCycle.dev.sql"),
  ]);

  assert.match(
    finalization,
    /count\(\*\) filter \(where rank_in_cycle = 1\)::integer/
  );
  assert.match(finalization, /1\.0 \/ v_winner_count/);
  assert.doesNotMatch(
    finalization,
    /count\(distinct[\s\S]*?discord_user_id[\s\S]*?rank_in_cycle = 1/i
  );
  assert.match(devContract, /winnerCount'\)::integer <> 3/);
  assert.match(
    devContract,
    /reset-test-finalization-submitter-a[\s\S]*reset-test-finalization-submitter-a/
  );
  assert.match(devContract, /\(2\.0 \/ 3\.0\)/);
});
