import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, activation, followUp, correction, cutover, simplification, authorizationFix, route, panel, teamModule, ownModule, myReports, profileSections, accountNavigation, navigation, devTest] = await Promise.all([
  read("supabase/migrations/20260809000100_submission_report_system.sql"),
  read("supabase/migrations/20260809000200_activate_submission_report_capabilities.sql"),
  read("supabase/migrations/20260809000300_submission_report_taxonomy_v2_and_my_reports.sql"),
  read("supabase/migrations/20260809000400_fix_submission_report_v2_append_only_creation.sql"),
  read("supabase/migrations/20260809000600_submission_report_team_workflow_cutover.sql"),
  read("supabase/migrations/20260809000800_simplify_submission_report_release_workflow.sql"),
  read("supabase/migrations/20260809000900_fix_submission_report_review_authorization_v3.sql"),
  read("app/api/submission-reports/route.ts"),
  read("app/components/SubmissionReportPanel.tsx"),
  read("lib/reports/submissionReportTeam.server.ts"),
  read("lib/reports/submissionReportOwn.server.ts"),
  read("app/my-reports/page.tsx"),
  read("app/my-profile/ProfileSections.tsx"),
  read("lib/auth/accountNavigation.ts"),
  read("lib/admin/teamAreaNavigation.ts"),
  read("tests/db/submissionReportSystem.dev.sql"),
]);

function canonical(definition) {
  return {
    key: definition.key,
    display_name: definition.displayName,
    description: definition.description,
    category: definition.category,
    included_actions: definition.includedActions,
    excluded_actions: definition.excludedActions,
    risk_level: definition.riskLevel,
    assignable_to_non_admin: definition.assignableToNonAdmin,
    implementation_version: definition.implementationVersion,
  };
}

test("legacy combined Report access is deprecated and exact V2 capabilities are active", () => {
  const activeKeys = [
    "submissions.reports.review",
    "submissions.reports.live.view",
    "submissions.reports.finalized.view",
    "logs.submission_reporters.view",
    "logs.submission_report_moderation.view",
  ];
  for (const key of activeKeys) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
    assert.equal(definition.definitionHash, hash);
    assert.equal(definition.lifecycle, "active");
    assert.equal(definition.assignableToNonAdmin, true);
    assert.match(
      key === "submissions.reports.review" ? simplification : cutover,
      new RegExp(hash, "u")
    );
  }
  const legacy = TEAM_CAPABILITY_REGISTRY["submissions.reports.view"];
  assert.equal(legacy.lifecycle, "deprecated");
  assert.equal(legacy.assignableToNonAdmin, false);
  assert.match(cutover, new RegExp(legacy.definitionHash, "u"));
  const legacyAssign = TEAM_CAPABILITY_REGISTRY["submissions.reports.assign"];
  assert.equal(legacyAssign.lifecycle, "deprecated");
  assert.equal(legacyAssign.assignableToNonAdmin, false);
  assert.match(simplification, new RegExp(legacyAssign.definitionHash, "u"));
  assert.match(authorizationFix, /submissions\.reports\.review'[\s\S]*490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a/u);
  assert.match(migration, /0f8bdec2e69427665a49067e4a2d2da7d4f81053b6f6e1f427cc262f26b7ef0e/u);
  assert.match(activation, /a9c1de7076eac2fd58052833930038f01e48e1ea37da51fb1f696508b11575f1/u);
  assert.match(migration, /'high', false, false, 1/u);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) public\.team_role_capabilities/iu);
  assert.match(activation, /count\(\*\) from public\.capability_catalog\) <> 33/u);
  assert.match(activation, /where capability_key in \('submissions\.reports\.view', 'submissions\.reports\.review'\)/u);
});

test("Report facts, events, and requests are server-only and append-only", () => {
  for (const table of ["submission_reports", "submission_report_case_events", "submission_report_requests"]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, "u"));
  }
  assert.match(migration, /unique \(submission_id, reporter_dedupe_version, reporter_dedupe_hash\)/u);
  assert.match(migration, /SUBMISSION_REPORT_APPEND_ONLY_VIOLATION/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /revoke all on table public\.submission_reports from public, anon, authenticated, discord_bot, service_role/u);
  assert.doesNotMatch(migration, /remoteip|remote_ip|turnstile_token|device_identifier/iu);
  assert.doesNotMatch(migration, /references public\.submissions\(id\)[\s\S]{0,80}on delete cascade/iu);
});

test("atomic creation covers replay, locks, visibility, uniqueness, and safe snapshots", () => {
  assert.match(migration, /create function public\.create_submission_report\(/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /submission-report-reporter:/u);
  assert.match(migration, /SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /from public\.voting_cycles where id = v_cycle_id for update/u);
  assert.match(migration, /from public\.submissions where id = p_submission_id for update/u);
  assert.match(
    migration,
    /coalesce\(v_submission\.public_visibility_status, ''\) not in \('visible', 'legal_review'\)/u,
  );
  assert.match(migration, /'voting_closed'/u);
  assert.match(migration, /content_sha256/u);
  assert.doesNotMatch(migration, /storage_key|r2_key/u);
});

test("taxonomy V2 is additive, phase-bound, and preserves immutable V1 facts", () => {
  const correctedCreate = correction.match(
    /create or replace function public\.create_submission_report_v2\([\s\S]*?\$function\$;/u,
  )?.[0] ?? "";

  assert.match(followUp, /reason_taxonomy_version in \(1, 2\)/u);
  assert.match(followUp, /create function public\.create_submission_report_v2\(/u);
  assert.match(followUp, /from public\.voting_cycles[\s\S]*for update/u);
  assert.match(followUp, /v_phase = 'history'[\s\S]*fair_play_manipulation/u);
  assert.match(followUp, /v_phase <> 'history'[\s\S]*rights_or_ownership/u);
  assert.match(followUp, /v_comment is null or char_length\(v_comment\) < 20/u);
  assert.doesNotMatch(followUp, /drop table|delete from public\.submission_reports/iu);
  assert.match(followUp, /public\.create_submission_report\([\s\S]*\n\s*1,/u);
  assert.ok(
    followUp.indexOf("v_result := public.create_submission_report(") <
      followUp.indexOf("v_phase := case"),
    "idempotent replay must be resolved before the current phase is re-evaluated"
  );
  assert.match(followUp, /if \(v_result ->> 'replayed'\)::boolean then/u);
  assert.match(followUp, /SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT/u);
  assert.match(correction, /SUBMISSION_REPORT_V2_FIX_PREFLIGHT_FAILED/u);
  assert.match(correctedCreate, /insert into public\.submission_reports/u);
  assert.match(correctedCreate, /reason_taxonomy_version[\s\S]*2, v_reason, v_subcategory/u);
  assert.match(correctedCreate, /insert into public\.submission_report_requests/u);
  assert.match(correctedCreate, /pg_advisory_xact_lock/u);
  assert.doesNotMatch(correctedCreate, /update public\.submission_reports/u);
  assert.doesNotMatch(correctedCreate, /public\.create_submission_report\(/u);
  assert.ok(
    correctedCreate.indexOf("from public.submission_report_requests") <
      correctedCreate.indexOf("v_phase := case"),
    "corrected V2 replay must be resolved before the current phase is re-evaluated",
  );
});

test("Report HTTP creation is fail-closed and validates before the RPC", () => {
  assert.match(route, /requireSession/u);
  assert.match(route, /TURNSTILE_ACTIONS\.submissionReport/u);
  assert.match(route, /provider_unavailable/u);
  assert.match(route, /status: 503/u);
  assert.match(route, /parseSubmissionReportCreateInput/u);
  assert.match(route, /createSubmissionReport/u);
});

test("the accessible rules confirmation and generic multiple-report hint are present", () => {
  assert.match(panel, /Review report/u);
  assert.match(panel, /\/rules#report-system/u);
  assert.match(panel, /agree to use the report system in good faith/u);
  assert.match(panel, /Knowingly false, retaliatory, or/u);
  assert.match(panel, /helping keep this project safe/u);
  assert.match(panel, /cursor-pointer/u);
  assert.doesNotMatch(panel, /No subcategory|cannot be withdrawn/u);
  assert.match(panel, /already been reported multiple times/u);
  assert.doesNotMatch(panel, /existingReportCount|exactReportCount/u);
  assert.match(panel, /TurnstileWidget/u);
  assert.ok(
    panel.indexOf('step === "success" ? (') <
      panel.indexOf("eligibility?.alreadyReported ? ("),
    "a successful create must render the receipt before the derived already-reported state",
  );
});

test("My Reports is session-derived and returns only privacy-safe outcomes", () => {
  assert.match(followUp, /create function public\.get_own_submission_reports\(/u);
  assert.match(followUp, /p_before_created_at timestamptz default null/u);
  assert.match(followUp, /\(report\.created_at, report\.report_id\) </u);
  assert.match(followUp, /limit p_limit \+ 1/u);
  assert.match(followUp, /'nextCursor'/u);
  assert.match(followUp, /grant execute on function public\.get_own_submission_reports[\s\S]*to service_role/u);
  assert.match(ownModule, /getSubmissionReportReporterDedupeKey/u);
  assert.match(ownModule, /get_own_submission_reports/u);
  assert.match(myReports, /getSessionState/u);
  assert.match(myReports, /does not claim that your individual report/u);
  assert.match(myReports, /View older reports/u);
  assert.doesNotMatch(myReports, /closeNote|moderator|reportCount|other reporter/iu);
  assert.match(profileSections, /<Section title="My Reports">/u);
  assert.match(profileSections, /href="\/my-reports"/u);
  assert.doesNotMatch(accountNavigation, /my_reports|\/my-reports/u);
});

test("Reporter User Logs show neutral action-case context without a score", () => {
  assert.match(followUp, /'actionTakenCaseCount'/u);
  assert.match(followUp, /case_row\.close_disposition = 'action_taken'/u);
  assert.doesNotMatch(followUp, /reporter_score|success_rate|rank/iu);
});

test("Team queues, Reporter Logs, and workflow logs use separate exact capabilities", () => {
  assert.match(teamModule, /submissions\.reports\.live\.view/u);
  assert.match(teamModule, /submissions\.reports\.finalized\.view/u);
  assert.match(teamModule, /"submissions\.reports\.review"/u);
  assert.match(teamModule, /"logs\.submission_reporters\.view"/u);
  assert.match(teamModule, /"logs\.submission_report_moderation\.view"/u);
  assert.doesNotMatch(teamModule, /users\.directory\.|logs\.submission_moderation\.view/u);
  assert.match(navigation, /href: "\/admin\/reports\/live"/u);
  assert.match(navigation, /href: "\/admin\/reports\/finalized"/u);
  assert.match(navigation, /href: "\/admin\/reports\/users"/u);
  assert.match(navigation, /href: "\/admin\/logs\/submission-reports"/u);
});

test("the rollback-only DEV contract covers replay, duplicates, stale review, reopen, retention, and removal", () => {
  assert.match(devTest, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devTest, /rollback;\s*$/u);
  assert.match(devTest, /SUBMISSION_REPORT_DEV_REPLAY_MISMATCH/u);
  assert.match(devTest, /SUBMISSION_REPORT_DEV_DUPLICATE_ACCEPTED/u);
  assert.match(devTest, /SUBMISSION_REPORT_DEV_STALE_ACCEPTED/u);
  assert.match(devTest, /SUBMISSION_REPORT_DEV_REOPEN_MISMATCH/u);
  assert.match(devTest, /SUBMISSION_REPORT_DEV_RETENTION_DUE_MISSING/u);
  assert.match(devTest, /SUBMISSION_REPORT_DEV_REMOVED_ACCEPTED/u);
});
