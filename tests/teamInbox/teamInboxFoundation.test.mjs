import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Team Inbox is topic-based, owner-visible while empty, and separate from Reports", async () => {
  const [migration, navigation, overview] = await Promise.all([
    source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql"),
    source("lib/admin/teamAreaNavigation.server.ts"),
    source("app/admin/inbox/page.tsx"),
  ]);
  assert.match(migration, /'wallet_issues',[\s\S]*false,/u);
  assert.match(migration, /required_read_capabilities[\s\S]*required_action_capabilities/u);
  assert.doesNotMatch(migration, /insert into public\.capability_catalog[\s\S]*team.?inbox/iu);
  assert.match(navigation, /if \(topics\.length === 0 && !authorization\.isAdmin\) return navigation/u);
  assert.match(navigation, /title: "Team Inbox",\s+direct: true,/u);
  assert.match(navigation, /return Object\.freeze\(\[\s*Object\.freeze\(\{[\s\S]*\.\.\.navigation/u);
  assert.match(overview, /if \(topics\.length === 0 && !authorization\.isAdmin\) notFound\(\)/u);
  assert.match(overview, /No Team Inbox topics are available yet/u);
  assert.doesNotMatch(`${migration}\n${navigation}\n${overview}`, /submission_report_cases|loadSubmissionReportUnreadCounts\(authorization\).*team.?inbox/iu);
});

test("Team Inbox is one direct navigation entry while topics stay inside the Inbox", async () => {
  const [shell, state] = await Promise.all([
    source("app/admin/TeamAreaShell.tsx"),
    source("lib/admin/teamAreaNavigationState.ts"),
  ]);

  assert.match(shell, /const directEntry = category\.direct && category\.items\.length === 1/u);
  assert.match(shell, /href=\{directEntry\.href\}/u);
  assert.match(shell, /!breadcrumb\.category\.direct/u);
  assert.match(state, /active\.category\.direct[\s\S]*\["Team Area", active\.entry\.title\]/u);
});

test("New state follows open-unassigned receipts and regenerates only on queue return or reopen", async () => {
  const migration = await source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql");
  assert.match(migration, /case_row\.status = 'open'[\s\S]*case_row\.assignee_discord_user_id is null[\s\S]*last_seen_attention_version, 0\) < case_row\.work_version/u);
  assert.match(migration, /insert into public\.team_inbox_attention_receipts[\s\S]*last_seen_attention_version[\s\S]*v_case\.work_version/u);
  assert.match(migration, /p_action = 'claim'[\s\S]*status = 'in_progress'/u);
  assert.match(migration, /p_action = 'return'[\s\S]*work_version = work_version \+ 1/u);
  assert.match(migration, /'admin_forced_release'[\s\S]*work_version/u);
  assert.match(migration, /v_case\.status = 'solved'[\s\S]*'reopened'[\s\S]*work_version/u);
  assert.doesNotMatch(migration, /status in \('open', 'claimed'|reassigned|reviewer_takeover/iu);
});

test("case claims are atomic, replay-safe, expected-state guarded, and assignee-only", async () => {
  const migration = await source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql");
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*team-inbox-request/u);
  assert.match(migration, /where id = p_case_id for update/u);
  assert.match(migration, /v_case\.status <> p_expected_state/u);
  assert.match(migration, /v_case\.row_version <> p_expected_row_version/u);
  assert.match(migration, /v_case\.work_version <> p_expected_work_version/u);
  assert.match(migration, /TEAM_INBOX_IDEMPOTENCY_MISMATCH/u);
  assert.match(migration, /v_case\.assignee_discord_user_id <> p_actor_discord_user_id/u);
  assert.match(migration, /TEAM_INBOX_ADMIN_REQUIRED/u);
  assert.match(migration, /p_action = 'force_release' and v_note is null/u);
});

test("every Inbox surface rechecks topic capabilities and exact ID search never enters URLs", async () => {
  const [migration, service, topicPage, searchClient, detailPage] = await Promise.all([
    source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql"),
    source("lib/teamInbox/teamInbox.server.ts"),
    source("app/admin/inbox/[topicKey]/page.tsx"),
    source("app/components/teamInbox/ExactDiscordIdSearch.tsx"),
    source("app/admin/inbox/[topicKey]/[caseId]/page.tsx"),
  ]);
  assert.match(migration, /assert_team_inbox_topic_access/g);
  assert.match(migration, /v_role <> 'admin'[\s\S]*team_role_capabilities/u);
  assert.match(migration, /winners\.payouts\.view'[\s\S]*implementation_version/u);
  assert.match(migration, /winners\.recipient_corrections\.manage/u);
  assert.match(service, /search_team_inbox_by_exact_discord_id/u);
  assert.match(searchClient, /method: "POST"/u);
  assert.match(searchClient, /body: JSON\.stringify\(\{ topicKey, exactDiscordId, cursor \}\)/u);
  assert.match(searchClient, /More exact matches/u);
  assert.doesNotMatch(searchClient, /URLSearchParams|searchParams|\?discord|\?id=/u);
  assert.match(topicPage, /prefetch=\{false\}/u);
  assert.match(detailPage, /<TeamInboxCaseDetail/u);
  assert.doesNotMatch(detailPage, /loadTeamInboxCaseDetail/u);
});

test("Inbox history and private tables are permanent, append-only, paginated, and closed", async () => {
  const [foundation, followUp, historyVisibility] = await Promise.all([
    source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql"),
    source("supabase/migrations/20260818000300_notification_follow_up_hardening.sql"),
    source("supabase/migrations/20260818000600_team_inbox_history_visibility.sql"),
  ]);
  const migration = `${foundation}\n${followUp}\n${historyVisibility}`;
  for (const table of [
    "team_inbox_topic_catalog", "team_inbox_cases", "team_inbox_attention_receipts",
    "team_inbox_timeline_events", "team_inbox_mutation_requests",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table}`, "u"));
  }
  assert.match(migration, /before update or delete on public\.team_inbox_timeline_events/u);
  assert.match(migration, /before update or delete on public\.team_inbox_mutation_requests/u);
  assert.match(followUp, /before delete on public\.team_inbox_cases/u);
  assert.match(followUp, /TEAM_INBOX_CASE_IS_PERMANENT/u);
  assert.match(historyVisibility, /accepts_new_cases boolean not null default false/u);
  assert.match(historyVisibility, /TEAM_INBOX_TOPIC_HISTORY_MUST_REMAIN_VISIBLE/u);
  assert.match(historyVisibility, /and accepts_new_cases/u);
  assert.match(followUp, /search_team_inbox_by_exact_discord_id\([\s\S]*p_before_updated_at timestamptz[\s\S]*limit p_limit \+ 1/u);
  assert.match(migration, /limit p_limit \+ 1/u);
  assert.doesNotMatch(migration, /delete from public\.team_inbox_(cases|timeline_events)/u);
});
