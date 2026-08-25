import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL("supabase/migrations/20260825000100_my_comments_mentions_notifications.sql", root),
  "utf8",
);

test("the additive migration is release-closed, reapply-guarded, and contains no backfill", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /get_community_comment_release_state\(\) <> 'off'/u);
  assert.match(migration, /MY_COMMENTS_MENTIONS_NOTIFICATION_BASELINE_MISMATCH/u);
  assert.match(migration, /MY_COMMENTS_MENTIONS_NOTIFICATION_POSTFLIGHT_MISMATCH/u);
  assert.doesNotMatch(migration, /drop table|drop column|truncate/iu);
  assert.doesNotMatch(migration, /insert into public\.notification_events[\s\S]*select[\s\S]*community_comments/iu);
  assert.match(migration, /commit;\s*$/u);
});

test("My Comments and My Mentions are owner-only bounded keyset projections", () => {
  for (const functionName of ["get_own_community_comments", "get_own_community_mentions"]) {
    const start = migration.indexOf(`create function public.${functionName}`);
    const end = migration.indexOf("$function$;", start);
    const source = migration.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(source, /require_account_session/u);
    assert.match(source, /p_limit not between 1 and 20/u);
    assert.match(source, /limit p_limit \+ 1/u);
    assert.match(source, /created_at.*id\)|first_mentioned_at.*id\)/su);
  }
  assert.match(migration, /order by comment_row\.created_at desc, comment_row\.public_comment_id desc/u);
  assert.match(migration, /root_comment_id is not null/u);
  assert.match(migration, /first_mentioned_at desc, id desc/u);
  assert.doesNotMatch(migration, /'discordUserId'|'submissionId'|'commentId'/u);
});

test("owner Mention state is separate, snapshot-safe, idempotent, and stale-safe", () => {
  assert.match(migration, /create table public\.community_comment_mention_owner_states/u);
  assert.match(migration, /create table public\.community_comment_owner_mutation_requests/u);
  assert.match(migration, /viewed_at timestamptz/u);
  assert.match(migration, /dismissed_at timestamptz/u);
  assert.match(migration, /first_mentioned_at <= p_snapshot_at/u);
  assert.match(migration, /COMMENT_OWNER_REQUEST_REUSED/u);
  assert.match(migration, /'outcome', 'stale_state'/u);
  assert.match(migration, /community_comment_owner_mutation_requests_no_update/u);
  assert.doesNotMatch(migration, /delete from public\.community_comment_mention_lifecycle/u);
  assert.doesNotMatch(migration, /update public\.notification_events|update public\.account_notifications/u);
});

test("future Reply and Mention inserts enqueue exactly once inside the database transaction", () => {
  const reply = migration.slice(
    migration.indexOf("create function public.produce_community_comment_reply_notification"),
    migration.indexOf("create function public.produce_community_comment_mention_notification"),
  );
  const mention = migration.slice(
    migration.indexOf("create function public.produce_community_comment_mention_notification"),
    migration.indexOf("create trigger community_comment_reply_notification_after_insert"),
  );
  assert.match(reply, /reply_target_comment_id is null/u);
  assert.match(reply, /v_target_owner = new\.author_discord_user_id/u);
  assert.match(reply, /enqueue_account_notification_event/u);
  assert.match(reply, /'comment-reply:' \|\| new\.public_comment_id/u);
  assert.match(mention, /target_discord_user_id = v_comment\.author_discord_user_id/u);
  assert.match(mention, /target_discord_user_id = v_reply_target_owner/u);
  assert.match(mention, /'comment-mention:' \|\| new\.id/u);
  assert.equal((reply.match(/enqueue_account_notification_event/gu) ?? []).length, 1);
  assert.equal((mention.match(/enqueue_account_notification_event/gu) ?? []).length, 1);
});

test("new categories default in-app on and every existing device defaults Push off", () => {
  assert.match(migration, /'comment_replies', 'Comment replies'[\s\S]*true, true, true/u);
  assert.match(migration, /'comment_mentions', 'Comment mentions'[\s\S]*true, true, true/u);
  assert.match(migration, /insert into public\.push_subscription_preferences[\s\S]*false/u);
  assert.match(migration, /'comment_reply'.*'comment_replies'/u);
  assert.match(migration, /'comment_mention'.*'comment_mentions'/u);
});

test("new tables and owner RPCs are fail-closed behind RLS and service-only ACLs", () => {
  assert.match(migration, /community_comment_mention_owner_states enable row level security/u);
  assert.match(migration, /community_comment_owner_mutation_requests enable row level security/u);
  assert.match(migration, /revoke all on table public\.community_comment_mention_owner_states,[\s\S]*service_role/u);
  assert.match(migration, /grant execute on function public\.get_own_community_comments[\s\S]*to service_role/u);
  assert.match(migration, /proconfig is distinct from array\['search_path=public, pg_temp'\]/u);
  assert.match(migration, /owner_name <> 'postgres'/u);
});
