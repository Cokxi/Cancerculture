import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [migration, correction, registry, turnstile, reportService, reviewService, dto, thread, inboxService] =
  await Promise.all([
    read("supabase/migrations/20260824000300_comment_reports_moderation_spam_review.sql"),
    read("supabase/migrations/20260824000400_comment_team_removal_projection_corrections.sql"),
    read("lib/auth/teamCapabilityRegistry.ts"),
    read("lib/turnstile/shared.ts"),
    read("lib/comments/commentReport.server.ts"),
    read("lib/comments/commentModeration.server.ts"),
    read("lib/comments/commentDto.ts"),
    read("app/components/comments/CommunityCommentThread.tsx"),
    read("lib/teamInbox/teamInbox.server.ts"),
  ]);

const capabilities = [
  "community.comment_reports.view",
  "community.comment_reports.review",
  "community.comments.moderate",
  "community.comment_spam.view",
  "community.comment_spam.review",
  "logs.community_comment_moderation.view",
];

test("six exact Comment review capabilities are real, active, and zero-grant", () => {
  for (const capability of capabilities) {
    assert.match(registry, new RegExp(capability.replaceAll(".", "[.]"), "u"));
    assert.match(migration, new RegExp(capability.replaceAll(".", "[.]"), "u"));
  }
  assert.match(migration, /count\(\*\) from public[.]capability_catalog\) <> 49/u);
  assert.match(migration, /grant_row[.]capability_key = any/u);
  assert.doesNotMatch(migration, /insert into public[.]team_role_capabilities/u);
});

test("Report intake is one-per-user, Turnstile-bound, immutable, and reporter-private", () => {
  assert.match(turnstile, /communityCommentReport: "community_comment_report"/u);
  assert.match(reportService, /verifyTurnstileRequest[\s\S]*TURNSTILE_ACTIONS[.]communityCommentReport/u);
  assert.match(reportService, /supabaseAdmin[.]rpc\("submit_community_comment_report"/u);
  assert.doesNotMatch(reportService, /[.]from\("community_comment_reports"\)/u);
  assert.match(migration, /unique \(comment_id, reporter_discord_user_id\)/u);
  assert.match(migration, /community_comment_reports_no_update/u);
  assert.doesNotMatch(migration, /'reporterDiscordUserId'/u);
});

test("Team Inbox review stays conjunctive, assigned, versioned, and atomic", () => {
  assert.match(migration, /'comment_reports'[\s\S]*community[.]comment_reports[.]view[\s\S]*community[.]comment_reports[.]review/u);
  assert.match(migration, /'comment_spam'[\s\S]*community[.]comment_spam[.]view[\s\S]*community[.]comment_spam[.]review/u);
  assert.match(migration, /TEAM_INBOX_RETURN_NOTE_REQUIRED/u);
  assert.match(migration, /COMMENT_REVIEW_ATOMIC_SOLVE_REQUIRED/u);
  assert.match(migration, /v_case[.]assignee_discord_user_id <> p_actor_discord_user_id/u);
  assert.match(migration, /v_case[.]row_version <> p_expected_row_version/u);
  assert.match(migration, /v_case[.]source_version <> p_expected_source_version/u);
  assert.match(reviewService, /requireDynamicTeamCapability\(reviewCapability\)/u);
  assert.match(reviewService, /community[.]comments[.]moderate/u);
  assert.match(inboxService, /loadCommunityCommentReviewCaseDetail/u);
});

test("team removal is a public tombstone and closes edit, reply, vote, and replay paths", () => {
  assert.match(dto, /"team_removed"/u);
  assert.match(thread, /Comment removed by the team/u);
  assert.match(migration, /community_comments_reply_target_guard/u);
  assert.match(migration, /community_comment_votes_team_removed_guard/u);
  assert.match(migration, /community_comment_vote_transitions_team_removed_guard/u);
  assert.match(migration, /v_comment[.]team_removed_at is not null/u);
  assert.match(migration, /when comment_row[.]team_removed_at is not null then 'team_removed'/u);
  assert.match(correction, /'branchOpen', v_root[.]author_deleted_at is null and v_root[.]team_removed_at is null/u);
  assert.match(correction, /return jsonb_build_object\('outcome', 'comment_unavailable'\)/u);
});

test("Spam Review is user-centered, bounded, and never automatically sanctions", () => {
  assert.match(migration, /community_comment_spam_one_open_case_idx/u);
  assert.match(migration, /subject_discord_user_id, generation/u);
  assert.match(migration, /limit 20/u);
  assert.match(migration, /Raw signals and thresholds are not exposed|signalCount/u);
  assert.doesNotMatch(migration, /update public[.]user_logs[\s\S]*is_banned/u);
  assert.doesNotMatch(migration, /insert into public[.]user_flag/u);
});

test("moderation log is bounded and excludes reasons and Discord IDs from its DTO", () => {
  const logFunction = migration.slice(
    migration.indexOf("create function public.get_community_comment_moderation_log"),
    migration.indexOf("alter table public.community_comment_report_cases owner"),
  );
  assert.match(logFunction, /p_limit not between 1 and 50/u);
  assert.match(logFunction, /'actorDisplayName'/u);
  assert.doesNotMatch(logFunction, /'internalReason'|'actorDiscordUserId'|'reporter'/u);
});
