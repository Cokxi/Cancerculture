import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [migration, readLockCorrection, triggerCorrection, abuseService, reportService, reportRoute, policyService, policyRoute, page, client, navigation, postflight, concurrency] =
  await Promise.all([
    read("supabase/migrations/20260824000500_comment_abuse_policy_management.sql"),
    read("supabase/migrations/20260824000600_comment_policy_management_read_lock_correction.sql"),
    read("supabase/migrations/20260824000700_separate_comment_report_spam_reference_trigger.sql"),
    read("lib/comments/commentAbuse.server.ts"),
    read("lib/comments/commentReport.server.ts"),
    read("app/api/comments/[publicCommentId]/report/route.ts"),
    read("lib/comments/commentPolicyManagement.server.ts"),
    read("app/api/admin/comments/policies/route.ts"),
    read("app/admin/comments/policies/page.tsx"),
    read("app/admin/comments/policies/CommentPolicyManager.tsx"),
    read("lib/admin/teamAreaNavigation.ts"),
    read("tests/db/commentAbusePolicyPostflight.dev.sql"),
    read("tests/db/commentAbusePolicyConcurrency.dev.mjs"),
  ]);

test("Report owns a distinct atomic budget and a reporter-bound HMAC boundary", () => {
  for (const table of ["community_comment_abuse_policies", "community_comment_abuse_buckets", "community_comment_abuse_events"]) {
    assert.match(migration, new RegExp(`${table}_action_check[\\s\\S]*'report'`, "u"));
  }
  assert.match(migration, /apply_community_comment_abuse_budget\([\s\S]*v_actor, 'report'/u);
  assert.match(migration, /community-comment-report-request:/u);
  assert.match(migration, /community-comment-report:' \|\| v_comment[.]id/u);
  assert.match(migration, /'rate_limited'[\s\S]*'retryAfter'/u);
  assert.match(reportRoute, /reporterDiscordUserId: session[.]discord_user_id/u);
  assert.match(reportService, /getCommunityCommentReportDigest/u);
  assert.match(abuseService, /createHmac[\s\S]*reporterDiscordUserId[\s\S]*publicCommentId/u);
  assert.doesNotMatch(reportService, /createHash/u);
});

test("Release and policy management are owner-session-only at every layer", () => {
  assert.match(page, /requireAdminPage/u);
  assert.match(policyRoute, /requireAdmin\(\)[\s\S]*requireSession\(\)/u);
  assert.match(policyRoute, /requireSameOrigin/u);
  assert.match(policyService, /assertServerMutationAllowed/u);
  assert.match(migration, /require_community_comment_owner_session\(p_session_id uuid\)/u);
  assert.match(migration, /require_account_session\(p_session_id\)/u);
  assert.match(migration, /member[.]role = 'admin'/u);
  assert.doesNotMatch(migration, /insert into public[.]capability_catalog/u);
  assert.match(navigation, /comment-safety-controls[\s\S]*requirement: adminOnly/u);
  assert.match(readLockCorrection, /get_community_comment_policy_management[\s\S]*volatile[\s\S]*security definer/u);
  assert.match(readLockCorrection, /COMMENT_POLICY_READ_LOCK_CORRECTION_BASELINE_MISMATCH/u);
  assert.match(readLockCorrection, /COMMENT_POLICY_READ_LOCK_CORRECTION_POSTFLIGHT_MISMATCH/u);
});

test("Policy versions are immutable while active pointers are separately versioned", () => {
  for (const table of [
    "community_comment_abuse_policy_states",
    "community_comment_spam_policy_state",
    "community_comment_policy_requests",
    "community_comment_policy_events",
    "community_comment_release_state_events",
  ]) assert.match(migration, new RegExp(`create table public\\.${table}`, "u"));
  assert.match(migration, /primary key \(action, policy_version\)/u);
  assert.match(migration, /community_comment_abuse_policy_versions_no_update/u);
  assert.match(migration, /community_comment_spam_policy_versions_no_update/u);
  assert.match(migration, /state_version = state_version \+ 1/u);
  assert.match(migration, /stale_version/u);
  assert.match(migration, /idempotency_conflict/u);
  assert.match(migration, /community-comment-policy-request:/u);
  assert.match(migration, /mark_community_comment_rejected_input[\s\S]*community_comment_abuse_policy_states/u);
  assert.doesNotMatch(migration, /right join \(select 1\) anchor/u);
  assert.doesNotMatch(migration, /insert into public[.]community_comment_abuse_policies[\s\S]*values\s*\(\s*'root'/iu);
  assert.doesNotMatch(migration, /insert into public[.]community_comment_spam_review_policies[\s\S]*values\s*\(\s*[0-9]/iu);
});

test("Spam scoring stays private, weighted, user-centered and non-sanctioning", () => {
  assert.match(migration, /signal_weights jsonb/u);
  assert.match(migration, /threshold_score bigint/u);
  assert.match(migration, /community_comment_spam_one_open_case_idx|status='open'/u);
  assert.match(migration, /limit 100/u);
  assert.match(migration, /attach_community_comment_report_spam_reference/u);
  assert.doesNotMatch(migration, /update public[.]user_logs[\s\S]*(is_banned|website_ban)/iu);
  assert.doesNotMatch(migration, /update public[.]community_comments[\s\S]*team_removed_at/iu);
  assert.match(client, /never ban, shadowban, remove, hide or rank content automatically/u);
  assert.match(triggerCorrection, /attach_community_comment_spam_reference[\s\S]*if tg_table_name = 'community_comment_vote_transitions'[\s\S]*new.voter_discord_user_id[\s\S]*elsif tg_table_name = 'community_comment_mutation_events'[\s\S]*new.actor_discord_user_id/u);
  assert.doesNotMatch(triggerCorrection, /v_actor := case when tg_table_name/u);
  assert.match(triggerCorrection, /attach_community_comment_report_spam_reference/u);
});

test("Owner UI has no embedded operational policy defaults", () => {
  assert.match(client, /initialState[.]actions/u);
  assert.match(client, /Activate new version/u);
  assert.match(client, /window[.]location[.]reload/u);
  assert.doesNotMatch(client, /useState\("[1-9][0-9]+"\)/u);
  assert.match(policyRoute, /exactKeys/u);
  assert.match(policyRoute, /Cache-Control.*private, no-store/u);
});

test("Migration remains one additive transaction and keeps LIVE values absent", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /COMMENT_ABUSE_POLICY_MANAGEMENT_BASELINE_MISMATCH/u);
  assert.match(migration, /COMMENT_ABUSE_POLICY_MANAGEMENT_POSTFLIGHT_MISMATCH/u);
  assert.doesNotMatch(migration, /drop table|drop column|truncate/iu);
  assert.match(migration, /commit;\s*$/u);
});

test("Postflight and concurrency contracts cover ACLs, release, action, and Report locks", () => {
  for (const boundary of [
    "COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_STATE_DRIFT",
    "COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_TABLE_MISMATCH",
    "COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_SERVICE_ACL_MISMATCH",
    "COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_INTERNAL_ACL_MISMATCH",
    "COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_CONSTRAINT_MISMATCH",
    "COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_DEFINITION_MISMATCH",
  ]) assert.match(postflight, new RegExp(boundary, "u"));
  assert.match(postflight, /begin read only;/u);
  assert.match(concurrency, /sameReleaseMs/u);
  assert.match(concurrency, /samePolicyMs/u);
  assert.match(concurrency, /independentPolicyMs/u);
  assert.match(concurrency, /sameBudgetMs/u);
  assert.match(concurrency, /Promise[.]all/u);
  assert.match(concurrency, /off\|0\|0/u);
});
