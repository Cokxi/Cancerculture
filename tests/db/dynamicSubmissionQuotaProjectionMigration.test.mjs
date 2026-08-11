import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260811000200_fix_dynamic_submission_quota_projection.sql",
    import.meta.url
  ),
  "utf8"
);

test("quota follow-up is additive and suppresses irrelevant exhausted cooldown", () => {
  assert.match(migration, /^begin;/u);
  assert.match(
    migration,
    /create or replace function public\.get_submission_upload_quota/
  );
  assert.match(
    migration,
    /if v_used >= v_cycle\.submissions_per_user then[\s\S]*?v_cooldown_remaining := 0;[\s\S]*?v_next_allowed_at := null;/
  );
  assert.doesNotMatch(migration, /alter table|delete from|update public\./iu);
  assert.match(migration, /DYNAMIC_QUOTA_PROJECTION_STARTING_SCHEMA_MISMATCH/);
  assert.match(migration, /DYNAMIC_QUOTA_PROJECTION_STARTING_FUNCTION_MISMATCH/);
});

test("quota follow-up preserves the privileged function boundary", () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = public, pg_temp/);
  assert.match(migration, /owner to postgres/);
  assert.match(migration, /revoke all[\s\S]*service_role, discord_bot/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
  assert.match(migration, /DYNAMIC_QUOTA_PROJECTION_POSTFLIGHT_FAILED/);
  assert.match(migration, /DYNAMIC_QUOTA_PROJECTION_OVERLOAD_POSTFLIGHT_FAILED/);
});
