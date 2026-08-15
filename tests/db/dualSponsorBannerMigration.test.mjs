import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260815000100_dual_sponsor_banner_formats_and_upload_operations.sql",
    import.meta.url
  ),
  "utf8"
);

test("Dual Sponsor migration is additive and keeps media roles non-interchangeable", () => {
  assert.match(migration, /add column feed_banner_r2_key text/u);
  assert.match(migration, /create table public\.sponsor_media_upload_operations/u);
  assert.match(migration, /drafts\/detail\//u);
  assert.match(migration, /drafts\/feed\//u);
  assert.doesNotMatch(migration, /drop table|truncate table/iu);
  assert.match(
    migration,
    /alter table public\.sponsor_media_upload_operations enable row level security/u
  );
  assert.match(
    migration,
    /revoke all on table public\.sponsor_media_upload_operations[\s\S]*service_role/u
  );
});

test("Sponsor upload saga is revisioned, idempotent, recoverable, and complete on activation", () => {
  assert.match(migration, /reserve_sponsor_media_upload/u);
  assert.match(migration, /commit_sponsor_media_upload/u);
  assert.match(migration, /abort_sponsor_media_upload/u);
  assert.match(migration, /recover_stale_sponsor_media_uploads/u);
  assert.match(migration, /SPONSOR_UPLOAD_IDEMPOTENCY_MISMATCH/u);
  assert.match(migration, /SPONSOR_DRAFT_STALE/u);
  assert.match(
    migration,
    /p_enabled[\s\S]*v_detail_key is null[\s\S]*v_feed_key is null/u
  );
  assert.match(migration, /queue_sponsor_media_key_if_unreferenced/u);
});

test("Feed placement is every Live meme and ordinal 1 plus 7n in finalized contexts", () => {
  const resolver = migration.slice(
    migration.indexOf(
      "create or replace function public.resolve_community_feed_sponsor_placement"
    ),
    migration.indexOf(
      "create or replace function public.start_cycle_managed"
    )
  );
  assert.match(resolver, /if p_feed_kind = 'live'/u);
  assert.match(resolver, /1::bigint/u);
  assert.match(resolver, /row_number\(\) over/u);
  assert.match(
    resolver,
    /result\.finalized_at desc,[\s\S]*result\.cycle_id desc,[\s\S]*result\.rank_in_cycle asc,[\s\S]*result\.submission_id asc/u
  );
  assert.match(resolver, /mod\(eligible\.placement_ordinal - 1, 7\) = 0/u);
  assert.match(resolver, /p_cycle_number is null or cycle\.public_number = p_cycle_number/u);
  const cadence = Number(
    resolver.match(/mod\(eligible\.placement_ordinal - 1, (\d+)\) = 0/u)?.[1]
  );
  assert.deepEqual(
    Array.from({ length: 58 }, (_, index) => index + 1).filter(
      (ordinal) => (ordinal - 1) % cadence === 0
    ),
    [1, 8, 15, 22, 29, 36, 43, 50, 57]
  );
});

test("canonical Spread detail has its own non-Feed measurement surface", () => {
  assert.match(migration, /'spread_detail'::text/u);
  assert.match(
    migration,
    /p_surface not in \([\s\S]*'spread_detail'[\s\S]*'spread'/u
  );
  assert.match(
    migration,
    /p_surface <> 'spread' and p_feed_kind is not null/u
  );
});

test("Start, Reset, cleanup recovery, and RPC ACLs include both Sponsor media roles", () => {
  assert.match(migration, /feedBannerR2Key/u);
  assert.match(migration, /SPONSOR_DRAFT_UPLOAD_IN_PROGRESS/u);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('sponsor-draft', 0\)\)/u);
  assert.match(migration, /SPONSOR_UPLOAD_IDEMPOTENCY_MISMATCH/u);
  assert.match(migration, /for update skip locked/u);
  assert.match(migration, /v_detail_key[\s\S]*v_feed_key[\s\S]*cycle_reset/u);
  assert.match(
    migration,
    /revoke insert, update, delete on table public\.cycle_sponsorships from service_role/u
  );
  for (const name of [
    "reserve_sponsor_media_upload",
    "commit_sponsor_media_upload",
    "abort_sponsor_media_upload",
    "recover_stale_sponsor_media_uploads",
    "resolve_community_feed_sponsor_placement",
  ]) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}`));
  }
});
