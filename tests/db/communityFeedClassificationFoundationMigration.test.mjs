import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, uploadRoute, uploadSaga] = await Promise.all([
  read(
    "supabase/migrations/20260812000500_community_feed_classification_foundation.sql",
  ),
  read("app/api/upload/route.ts"),
  read("lib/upload/submissionUploadSaga.ts"),
]);

const finalizer = migration.slice(
  migration.indexOf("create or replace function public.finalize_cycle"),
  migration.indexOf("drop function public.commit_submission_upload"),
);
const commitUpload = migration.slice(
  migration.indexOf("create function public.commit_submission_upload"),
  migration.indexOf("do $postflight$"),
);
const backfill = migration.slice(
  migration.indexOf("with positive_tier_sizes as"),
  migration.indexOf("alter table public.cycle_results\n  alter column"),
);

test("migration is additive, fact-preserving, and introduces no Feed content silo or capability", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.doesNotMatch(migration, /create table public\.feed_items/iu);
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.capability_catalog/iu,
  );
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.team_role_capabilities/iu,
  );
  assert.doesNotMatch(migration, /public_number\s*=/u);
  assert.match(migration, /COMMUNITY_FEED_FACT_OR_GRANT_POSTFLIGHT_FAILED/u);
});

test("backfill uses stored final snapshots and the exact positive-only tie-safe capacity", () => {
  assert.match(backfill, /result_row\.final_vote_count > 0/u);
  assert.match(
    backfill,
    /partition by tier\.cycle_id[\s\S]*order by tier\.final_vote_count asc/u,
  );
  assert.match(
    backfill,
    /cumulative_size <=[\s\S]*floor\(positive_tier\.positive_submission_count \* 0\.10\)/u,
  );
  assert.match(backfill, /feed_eligible = result_row\.final_vote_count > 0/u);
  assert.match(backfill, /feed_classification_version = 1/u);
  assert.match(backfill, /is_disqualified_at_finalization = false/u);
  assert.doesNotMatch(backfill, /from public\.submissions|join public\.submissions/u);
  assert.doesNotMatch(backfill, /public_visibility_status = 'visible'/u);
});

test("canonical finalization freezes positive eligibility, complete Trash tiers, ranks, and snapshots", () => {
  assert.match(finalizer, /dense_rank\(\) over/u);
  assert.match(finalizer, /where final_vote_count > 0/u);
  assert.match(finalizer, /order by final_vote_count asc/u);
  assert.match(
    finalizer,
    /positive_tier\.cumulative_size <=[\s\S]*floor\(positive_tier\.positive_submission_count \* 0\.10\)/u,
  );
  assert.match(finalizer, /ranked\.final_vote_count > 0/u);
  assert.match(finalizer, /feed_classification_version/u);
  assert.match(finalizer, /is_disqualified_at_finalization/u);
  assert.match(finalizer, /ranked\.visibility_status/u);
  assert.doesNotMatch(finalizer, /views|reports|comments|sponsor_status/iu);
  assert.match(migration, /CYCLE_RESULT_SNAPSHOT_IS_IMMUTABLE/u);
  assert.match(migration, /create trigger cycle_results_snapshot_immutable/u);
  assert.match(migration, /COMMUNITY_FEED_IMMUTABILITY_POSTFLIGHT_FAILED/u);
});

test("finished replay and parallel finalization retain one atomic classification", () => {
  const advisory = finalizer.indexOf("cycle-finalization:");
  const rowLock = finalizer.indexOf("for update", advisory);
  const finishedReplay = finalizer.indexOf("v_initial_status = 'finished'", rowLock);
  const resultDelete = finalizer.indexOf(
    "delete from public.cycle_results",
    finishedReplay,
  );
  const finishedWrite = finalizer.indexOf("status = 'finished'", resultDelete);

  assert.ok(advisory > -1 && advisory < rowLock);
  assert.ok(rowLock < finishedReplay && finishedReplay < resultDelete);
  assert.ok(resultDelete < finishedWrite);
  assert.match(finalizer, /'alreadyFinalized', true/u);
  assert.match(finalizer, /feed_classification_version <> 1/u);
  assert.match(finalizer, /FINALIZED_RESULT_SNAPSHOT_INCOMPLETE/u);
  assert.equal(
    (finalizer.match(/delete from public\.cycle_results/gu) ?? []).length,
    1,
  );
});

test("validated processed media dimensions cross the service-only atomic commit and Legacy rows stay nullable", () => {
  assert.match(
    migration,
    /\(media_width is null and media_height is null\)[\s\S]*media_width between 1 and 2400[\s\S]*media_height between 1 and 16383/u,
  );
  assert.match(commitUpload, /p_media_width integer/u);
  assert.match(commitUpload, /p_media_height integer/u);
  assert.match(commitUpload, /p_media_width::bigint \* p_media_height::bigint > 24000000/u);
  assert.match(
    commitUpload,
    /discord_username_at_upload,[\s\S]*media_width,[\s\S]*media_height[\s\S]*p_media_width,[\s\S]*p_media_height/u,
  );
  assert.match(uploadRoute, /mediaWidth: processedImage\.width/u);
  assert.match(uploadRoute, /mediaHeight: processedImage\.height/u);
  assert.match(uploadSaga, /p_media_width: mediaWidth/u);
  assert.match(uploadSaga, /p_media_height: mediaHeight/u);
  assert.match(migration, /Legacy rows may retain a null width\/height pair/u);
});

test("Feed and Live cursor indexes encode deterministic order and current visibility before LIMIT", () => {
  for (const index of [
    "cycle_results_feed_all_cursor_idx",
    "cycle_results_feed_trash_cursor_idx",
    "cycle_results_feed_top10_cursor_idx",
  ]) {
    assert.match(migration, new RegExp(`create index ${index}`, "u"));
  }
  assert.match(
    migration,
    /finalized_at desc,[\s\S]*cycle_id desc,[\s\S]*rank_in_cycle asc,[\s\S]*submission_id asc/u,
  );
  assert.match(
    migration,
    /create index submissions_live_feed_cursor_idx[\s\S]*cycle_id,[\s\S]*created_at desc,[\s\S]*id desc[\s\S]*where public_visibility_status = 'visible'[\s\S]*coalesce\(is_disqualified, false\) = false/u,
  );
});

test("privileged functions retain exact owner, SECURITY DEFINER, search path, ACL, and overload checks", () => {
  assert.match(finalizer, /security definer/u);
  assert.match(finalizer, /set search_path = public, pg_temp/u);
  assert.match(
    migration,
    /alter function public\.finalize_cycle\(bigint, text\) owner to postgres/u,
  );
  assert.match(commitUpload, /security definer/u);
  assert.match(commitUpload, /set search_path = public, pg_temp/u);
  assert.match(migration, /COMMUNITY_FEED_OVERLOAD_OR_SECURITY_POSTFLIGHT_FAILED/u);
  assert.match(migration, /COMMUNITY_FEED_FUNCTION_ACL_POSTFLIGHT_FAILED/u);
  assert.match(migration, /v_finalize_count <> 1/u);
  assert.match(migration, /v_managed_finalize_count <> 1/u);
  assert.match(migration, /v_commit_count <> 1/u);
  assert.match(migration, /COMMUNITY_FEED_EXACT_FUNCTION_ACL_POSTFLIGHT_FAILED/u);
  assert.match(migration, /array\['postgres', 'service_role'\]::text\[\]/u);
  assert.match(migration, /COMMUNITY_FEED_INDEX_DEFINITION_POSTFLIGHT_FAILED/u);
  assert.match(migration, /to service_role/u);
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.finalize_cycle\([\s\S]*to service_role/iu,
  );
});

test("cycle result snapshots retain service reads but no direct service writes", () => {
  assert.match(
    migration,
    /revoke all on table public\.cycle_results[\s\S]*from public, anon, authenticated, service_role, discord_bot/u,
  );
  assert.match(
    migration,
    /grant select on table public\.cycle_results to service_role/u,
  );
  assert.match(
    migration,
    /COMMUNITY_FEED_CYCLE_RESULTS_ACL_BASELINE_MISMATCH/u,
  );
  assert.match(
    migration,
    /v_cycle_results_nonselect_grantees is distinct from[\s\S]*array\['postgres'\]::text\[\]/u,
  );
  assert.match(
    migration,
    /v_cycle_results_select_grantees is distinct from[\s\S]*array\['postgres', 'service_role'\]::text\[\]/u,
  );
  assert.match(
    migration,
    /has_table_privilege\([\s\S]*'service_role', 'public\.cycle_results', 'INSERT,UPDATE,DELETE,TRUNCATE'/u,
  );
  assert.match(
    migration,
    /COMMUNITY_FEED_EXACT_TABLE_ACL_POSTFLIGHT_FAILED/u,
  );
});
