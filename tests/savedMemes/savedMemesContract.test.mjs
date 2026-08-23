import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [migration, service, statusRoute, mutationRoute, page, client, profile] =
  await Promise.all([
    readFile(
      new URL(
        "supabase/migrations/20260823000100_account_saved_memes.sql",
        root,
      ),
      "utf8",
    ),
    readFile(new URL("lib/savedMemes/service.server.ts", root), "utf8"),
    readFile(
      new URL("app/api/account/saved-memes/status/route.ts", root),
      "utf8",
    ),
    readFile(
      new URL(
        "app/api/account/saved-memes/[submissionId]/route.ts",
        root,
      ),
      "utf8",
    ),
    readFile(new URL("app/my-profile/saved-memes/page.tsx", root), "utf8"),
    readFile(
      new URL("app/my-profile/saved-memes/SavedMemesClient.tsx", root),
      "utf8",
    ),
    readFile(new URL("app/my-profile/ProfileSections.tsx", root), "utf8"),
  ]);

test("saved memes are owner-private references rather than copied media", () => {
  assert.match(migration, /create table public\.account_saved_memes/u);
  assert.match(migration, /discord_user_id text not null/u);
  assert.match(migration, /submission_id bigint[\s\S]*on delete set null/u);
  assert.match(migration, /original_submission_id bigint not null/u);
  assert.match(migration, /unique \(discord_user_id, original_submission_id\)/u);
  assert.doesNotMatch(
    migration,
    /image_blob|media_copy|r2_key text|moderation_reason|legal_reason|dq_reason/iu,
  );
});

test("saving rechecks current public Feed eligibility and removal remains possible", () => {
  assert.match(migration, /create function public\.is_saved_meme_publicly_available/u);
  assert.match(migration, /public_visibility_status = 'visible'/u);
  assert.match(migration, /coalesce\(submission\.is_disqualified, false\) = false/u);
  assert.match(migration, /feed_eligible = true/u);
  assert.match(migration, /feed_classification_version = 1/u);
  assert.match(migration, /final_vote_count > 0/u);
  assert.match(migration, /v_outcome := 'not_public'/u);
  const mutation = migration.slice(
    migration.indexOf("create function public.set_account_saved_meme"),
    migration.indexOf("create function public.get_account_saved_meme_status"),
  );
  assert.ok(
    mutation.indexOf("if not p_saved") <
      mutation.indexOf("is_saved_meme_publicly_available"),
  );
  assert.match(mutation, /pg_advisory_xact_lock/u);
});

test("owner RPCs are bounded, session-authoritative, RLS-closed and service-only", () => {
  for (const signature of [
    "set_account_saved_meme(uuid,bigint,boolean)",
    "get_account_saved_meme_status(uuid,bigint[])",
    "list_account_saved_memes(uuid,timestamptz,bigint,integer)",
  ]) {
    assert.ok(migration.includes(`alter function public.${signature} owner to postgres`));
    assert.match(
      migration,
      new RegExp(
        `grant execute on function public\\.${signature.replace(/[()[\].]/gu, "\\$&")}\\s+to service_role`,
        "u",
      ),
    );
  }
  assert.match(migration, /require_account_session\(p_session_id\)/u);
  assert.match(migration, /cardinality\(p_submission_ids\) > 100/u);
  assert.match(migration, /p_limit not between 1 and 48/u);
  assert.match(migration, /alter table public\.account_saved_memes enable row level security/u);
  assert.match(migration, /revoke all on table public\.account_saved_memes/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(migration, /ACCOUNT_SAVED_MEMES_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(migration, /ACCOUNT_SAVED_MEMES_TABLE_ACL_MISMATCH/u);
});

test("private APIs are no-store, one-RPC mutations with strict outcomes", () => {
  assert.match(statusRoute, /requireSession\(\)/u);
  assert.match(statusRoute, /getSavedMemeStatus/u);
  assert.match(statusRoute, /Cache-Control": "no-store/u);
  assert.match(mutationRoute, /export async function PUT/u);
  assert.match(mutationRoute, /export async function DELETE/u);
  assert.match(mutationRoute, /setSavedMeme/u);
  assert.match(service, /supabaseAdmin\.rpc/u);
  assert.match(service, /SAVED_MEMES_RESPONSE_INVALID/u);
  assert.doesNotMatch(mutationRoute, /\.from\(|\.insert\(|\.delete\(/u);
});

test("My Saved Memes keeps neutral tombstones and links only public originals", () => {
  assert.match(profile, /href="\/my-profile\/saved-memes"/u);
  assert.match(profile, /My Saved Memes/u);
  assert.match(page, /getOwnSavedMemes/u);
  assert.match(client, /Meme no longer publicly available/u);
  assert.match(client, /getCommunityFeedDetailHref/u);
  assert.match(client, /getCommunityFeedDetailMediaPath/u);
  assert.match(client, /Remove from saved/u);
  assert.doesNotMatch(
    `${page}\n${client}`,
    /disqualification reason|legal review reason|moderation reason|r2_key|discord_user_id/iu,
  );
});
