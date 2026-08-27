import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [migration, registry, service, page, navigation] = await Promise.all([
  read("supabase/migrations/20260827000500_comment_moderation_audit_explorer.sql"),
  read("lib/auth/teamCapabilityRegistry.ts"),
  read("lib/comments/commentModeration.server.ts"),
  read("app/admin/logs/comment-moderation/page.tsx"),
  read("lib/admin/teamAreaNavigation.ts"),
]);

test("the explorer upgrades the redacted right and adds one zero-grant sensitive-evidence right", () => {
  assert.match(migration, /logs[.]community_comment_moderation[.]view'[\s\S]*implementation_version = 2/u);
  assert.match(migration, /logs[.]community_comment_moderation[.]details[.]view/u);
  assert.match(migration, /where grant_row[.]capability_key = 'logs[.]community_comment_moderation[.]details[.]view'/u);
  assert.doesNotMatch(migration, /insert into public[.]team_role_capabilities/u);
  assert.match(registry, /"logs[.]community_comment_moderation[.]details[.]view"[\s\S]*riskLevel: "critical"/u);
  assert.match(registry, /"logs[.]community_comment_moderation[.]view"[\s\S]*implementationVersion: 2/u);
});

test("new moderation events bind the exact reviewed immutable text version without rewriting legacy events", () => {
  assert.match(migration, /add column reviewed_text_version bigint/u);
  assert.match(migration, /foreign key \(comment_id, reviewed_text_version\)[\s\S]*community_comment_text_versions/u);
  assert.match(migration, /v_reviewed_text_version := v_comment[.]current_text_version/u);
  assert.match(migration, /reviewed_text_version[\s\S]*v_reviewed_text_version/u);
  assert.doesNotMatch(migration, /update public[.]community_comment_moderation_events[\s\S]*set reviewed_text_version/u);
  assert.match(migration, /legacy evidence cannot be proven and must not be inferred/u);
});

test("the database explorer is bounded, exact-filtered, capability-conjunctive, and service-only", () => {
  const explorer = migration.slice(
    migration.indexOf("create function public.get_community_comment_moderation_explorer"),
    migration.indexOf("alter function public.assert_community_comment_capabilities"),
  );
  assert.match(explorer, /p_limit not between 1 and 50/u);
  assert.match(explorer, /event[.]public_comment_id = p_public_comment_id/u);
  assert.match(explorer, /event[.]submission_id = p_submission_id/u);
  assert.match(explorer, /logs[.]community_comment_moderation[.]view'[\s\S]*logs[.]community_comment_moderation[.]details[.]view/u);
  assert.match(explorer, /reviewedTextVersionState/u);
  assert.match(explorer, /case when p_include_sensitive then item[.]reviewed_text else null end/u);
  assert.match(explorer, /case when p_include_sensitive then item[.]internal_reason else null end/u);
  assert.doesNotMatch(explorer, /actorDiscordUserId|reporterDiscordUserId|rawSpam/u);
  assert.match(migration, /revoke all on function public[.]get_community_comment_moderation_explorer[\s\S]*from public, anon, authenticated, service_role, discord_bot/u);
  assert.match(migration, /grant execute on function public[.]get_community_comment_moderation_explorer[\s\S]*to service_role/u);
});

test("source Case links require the matching Case-view right and never invent a Case for direct moderation", () => {
  assert.match(migration, /community[.]comment_reports[.]view'[\s\S]*v_can_view_report_case/u);
  assert.match(migration, /community[.]comment_spam[.]view'[\s\S]*v_can_view_spam_case/u);
  assert.match(migration, /sourceCaseId'[\s\S]*v_can_view_report_case[\s\S]*v_can_view_spam_case/u);
  assert.match(page, /sourceCaseLinkAvailable[\s\S]*Open source/u);
  assert.match(page, /Source: standalone moderation/u);
});

test("the server and page fail closed while presenting grouped, searchable, legacy-honest history", () => {
  assert.match(service, /requireDynamicTeamCapability\("logs[.]community_comment_moderation[.]view"\)/u);
  assert.match(service, /hasResolvedTeamCapability[\s\S]*logs[.]community_comment_moderation[.]details[.]view/u);
  assert.match(service, /includeSensitive && !canViewSensitiveDetails/u);
  assert.match(service, /EXPLORER_ITEM_KEYS[\s\S]*itemKeys[.]length !== EXPLORER_ITEM_KEYS[.]size/u);
  assert.match(service, /Object[.]keys\(data\)[.]length !== 2/u);
  assert.match(service, /items[.]length !== data[.]items[.]length/u);
  assert.match(page, /Exact public Comment ID/u);
  assert.match(page, /Exact Submission ID/u);
  assert.match(page, /groupItems\(data[.]items\)/u);
  assert.match(page, /Legacy event: the exact reviewed text version cannot be proven/u);
  assert.match(page, /Protected evidence is hidden by default/u);
  assert.match(page, /const data = filterError[\s\S]*items: \[\]/u);
  assert.doesNotMatch(page, /filterError \? \{\} :/u);
  assert.match(navigation, /title: "Comment Moderation Explorer"/u);
});
