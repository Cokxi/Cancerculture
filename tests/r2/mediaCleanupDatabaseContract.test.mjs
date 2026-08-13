import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [worker, targeted, upload, reset] = await Promise.all([
  read("supabase/migrations/20260715000300_lease_based_media_cleanup_worker.sql"),
  read("supabase/migrations/20260802000200_delegable_cycle_management_capability.sql"),
  read("supabase/migrations/20260717000400_live_catchup_upload_media.sql"),
  read("supabase/migrations/20260811000100_dynamic_submissions_per_cycle.sql"),
]);

test("canonical queue claims retain due, lease, concurrency, and idempotency boundaries", () => {
  assert.match(worker, /p_limit > 20/u);
  assert.match(worker, /for update skip locked/u);
  assert.match(worker, /status = 'processing'/u);
  assert.match(worker, /attempts = queue\.attempts \+ 1/u);
  assert.match(worker, /lease_token = gen_random_uuid\(\)/u);
  assert.match(worker, /queue\.locked_until <= v_now/u);
  assert.match(worker, /queue\.locked_until > v_now/u);
  assert.match(worker, /queue\.lease_token = p_lease_token/u);
  assert.match(worker, /'outcome', 'stale_lease'/u);
  assert.match(worker, /'outcome', 'not_found'/u);
});

test("retry backoff becomes due again and attempt seven is terminal", () => {
  for (const delay of [
    "1 minute",
    "5 minutes",
    "15 minutes",
    "1 hour",
    "6 hours",
    "24 hours",
  ]) {
    assert.match(worker, new RegExp(`interval '${delay}'`, "u"));
  }
  assert.match(worker, /queue\.next_attempt_at <= v_now/u);
  assert.match(worker, /v_job\.attempts >= 7/u);
  assert.match(worker, /when v_terminal then 'dead'/u);
  assert.match(worker, /when v_terminal then 'terminal_failure'/u);
});

test("targeted claims stay scoped to exact reset IDs and preserve lease semantics", () => {
  const claim = targeted.match(
    /create or replace function public\.claim_media_cleanup_jobs_by_ids\([\s\S]*?\$function\$;/u,
  )?.[0] ?? "";
  assert.match(claim, /cardinality\(p_job_ids\) > 20/u);
  assert.match(claim, /queue\.id = any\(p_job_ids\)/u);
  assert.match(claim, /for update skip locked/u);
  assert.match(claim, /queue\.attempts \+ 1/u);
  assert.doesNotMatch(claim, /recover_stale_submission_uploads/u);
});

test("all current queue producers remain canonical and deduplicated", () => {
  assert.match(upload, /submission_upload_compensation:/u);
  assert.match(upload, /submission_upload_recovery:/u);
  assert.match(upload, /submission_deleted:/u);
  assert.match(upload, /on conflict \(storage_provider, storage_key\) do nothing/gu);
  assert.match(upload, /operation\.status in \('reserved', 'r2_uploaded'\)/u);
  assert.match(upload, /for update skip locked[\s\S]*limit p_limit/u);
  assert.match(upload, /STALE_UPLOAD_RECOVERED/u);
  assert.match(upload, /before delete on public\.submissions/u);
  assert.match(reset, /'cycle_reset:' \|\| p_cycle_id::text/u);
  assert.match(reset, /operation\.status in \('reserved', 'r2_uploaded'\)/u);
  assert.match(reset, /status = 'cleanup_pending'/u);
});
