import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../supabase/migrations/20260825000200_my_mentions_self_suppression.sql", import.meta.url),
  "utf8",
);

test("Self-Mention hardening is additive, release-closed, and reapply-guarded", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /get_community_comment_release_state\(\) <> 'off'/u);
  assert.match(migration, /MY_MENTIONS_SELF_SUPPRESSION_BASELINE_MISMATCH/u);
  assert.match(migration, /MY_MENTIONS_SELF_SUPPRESSION_POSTFLIGHT_MISMATCH/u);
  assert.doesNotMatch(migration, /drop table|drop column|truncate|delete from/iu);
  assert.match(migration, /commit;\s*$/u);
});

test("lists, snapshot mark-all, single mutations, and destinations exclude Self-Mentions", () => {
  assert.ok((migration.match(/author_discord_user_id <> v_owner/gu) ?? []).length >= 5);
  assert.match(migration, /get_own_community_mentions/u);
  assert.match(migration, /mark_all_own_community_mentions_viewed/u);
  assert.match(migration, /mark_own_community_mention_viewed/u);
  assert.match(migration, /dismiss_own_community_mention/u);
  assert.match(migration, /get_own_community_mention_destination/u);
});

test("legacy helpers are private and public signatures stay service-only and exact", () => {
  assert.match(migration, /rename to mark_own_community_mention_viewed_v1/u);
  assert.match(migration, /revoke all on function public\.mark_own_community_mention_viewed_v1[\s\S]*service_role/u);
  assert.match(migration, /grant execute on function public\.get_own_community_mentions[\s\S]*to service_role/u);
  assert.match(migration, /function_row\.proname in[\s\S]*\)\) <> 5/u);
});
