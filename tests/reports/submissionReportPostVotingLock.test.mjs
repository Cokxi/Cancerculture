import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  POST_VOTING_REPORT_BLOCK_REASON,
  POST_VOTING_REPORT_CLOSED_TEXT,
  POST_VOTING_WRAPPING_UP_TEXT,
} from "../../lib/cycles/postVoting.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [
  migration,
  route,
  eligibilityRoute,
  rpc,
  panel,
  submissionsPage,
  submissionsClient,
  cycleHud,
  cycleHistory,
  currentCycle,
  finalization,
  automation,
  teamReadModel,
  ownReadModel,
  devContract,
  raceContract,
] = await Promise.all([
  read("supabase/migrations/20260812000200_post_voting_submission_report_lock.sql"),
  read("app/api/submission-reports/route.ts"),
  read("app/api/submission-reports/eligibility/route.ts"),
  read("lib/reports/submissionReportRpc.server.ts"),
  read("app/components/SubmissionReportPanel.tsx"),
  read("app/submissions/page.tsx"),
  read("app/submissions/SubmissionsClient.tsx"),
  read("app/components/CycleHud.tsx"),
  read("app/cycle-history/CycleHistoryClient.tsx"),
  read("lib/cycles/currentCycle.ts"),
  read("supabase/migrations/20260714000100_transactional_cycle_finalization.sql"),
  read("supabase/migrations/20260715000200_transactional_cycle_start_and_phase_automation.sql"),
  read("lib/reports/submissionReportTeam.server.ts"),
  read("lib/reports/submissionReportOwn.server.ts"),
  read("tests/db/submissionReportPostVotingLock.dev.sql"),
  read("tests/db/submissionReportPostVotingRace.dev.mjs"),
]);

function functionBody(source, signature) {
  return (
    source.match(
      new RegExp(
        `create(?: or replace)? function public\\.${signature}\\([\\s\\S]*?\\$function\\$;`,
        "u",
      ),
    )?.[0] ?? ""
  );
}

test("cycle_ended maps to voting_closed before atomic finished history", () => {
  assert.match(
    automation,
    /v_previous_status = 'voting_open'[\s\S]*status = 'voting_closed'[\s\S]*voting_phase_closed/u,
  );
  assert.match(
    finalization,
    /v_initial_status not in \([\s\S]*'voting_closed'[\s\S]*'finalizing'[\s\S]*\)[\s\S]*set status = 'finalizing'/u,
  );
  assert.match(
    finalization,
    /set[\s\S]*status = 'finished'[\s\S]*'cycle_completed'/u,
  );
  assert.match(currentCycle, /"voting_closed"[\s\S]*"paused"[\s\S]*"active"/u);
  assert.doesNotMatch(currentCycle, /"cycle_ended"/u);
});

test("Eligibility closes wrapping-up while preserving open phases and finished history", () => {
  const eligibility = functionBody(
    migration,
    "get_submission_report_eligibility",
  );

  assert.equal(POST_VOTING_REPORT_BLOCK_REASON, "cycle_wrapping_up");
  assert.match(
    eligibility,
    /v_cycle_status in \('voting_closed', 'finalizing'\)[\s\S]*v_blocked_reason := 'cycle_wrapping_up'/u,
  );
  assert.match(
    eligibility,
    /'submission_open'[\s\S]*'voting_open'[\s\S]*'active'[\s\S]*'finished'/u,
  );
  assert.match(eligibility, /'canReport', v_reportable and not v_already/u);
  assert.match(eligibility, /'alreadyReported', v_already/u);
  assert.match(eligibilityRoute, /getSubmissionReportEligibility/u);
  assert.match(eligibilityRoute, /Cache-Control": "no-store/u);
});

test("the database guard serializes every Report insert with the Cycle row", () => {
  const guard = functionBody(
    migration,
    "enforce_submission_report_creation_phase",
  );

  assert.match(
    migration,
    /before insert on public\.submission_reports[\s\S]*execute function public\.enforce_submission_report_creation_phase/u,
  );
  assert.match(
    guard,
    /from public\.voting_cycles cycle[\s\S]*where cycle\.id = new\.cycle_id[\s\S]*for update/u,
  );
  assert.match(
    guard,
    /v_cycle_status in \('voting_closed', 'finalizing'\)[\s\S]*SUBMISSION_REPORT_PHASE_CLOSED/u,
  );
  assert.match(guard, /'finished'/u);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /owner to postgres/u);
  assert.match(
    migration,
    /revoke all on function public\.enforce_submission_report_creation_phase\(\)[\s\S]*service_role/u,
  );
  assert.doesNotMatch(
    migration,
    /(?:delete from|update) public\.submission_report_(?:cases|reports|payloads|case_events|requests|reads)/iu,
  );
  assert.doesNotMatch(migration, /team_role_capabilities|capability_catalog/iu);
});

test("the HTTP path rejects known phase closure before Turnstile and keeps the DB race boundary", () => {
  assert.match(rpc, /SUBMISSION_REPORT_PHASE_CLOSED/u);
  assert.match(rpc, /REPORTING_CLOSED/u);
  assert.match(rpc, /assertSubmissionReportCreationOpen/u);
  assert.ok(
    route.indexOf("const input = parseSubmissionReportCreateInput") <
      route.indexOf("await assertSubmissionReportCreationOpen") &&
      route.indexOf("await assertSubmissionReportCreationOpen") <
        route.indexOf("const turnstile = await verifyTurnstileRequest") &&
      route.indexOf("const turnstile = await verifyTurnstileRequest") <
        route.indexOf("const result = await createSubmissionReport"),
    "known phase rejection must happen before Turnstile while the RPC remains final",
  );
});

test("wrapping-up uses the exact canonical public copy without hiding Submissions", () => {
  assert.equal(
    POST_VOTING_WRAPPING_UP_TEXT,
    "VOTING CLOSED — CYCLE IS WRAPPING UP",
  );
  assert.equal(
    POST_VOTING_REPORT_CLOSED_TEXT,
    "New reports are closed while this cycle is wrapping up.",
  );
  assert.match(cycleHud, /case "voting_closed"[\s\S]*POST_VOTING_WRAPPING_UP_TEXT/u);
  assert.match(
    submissionsClient,
    /isVotingClosed[\s\S]*POST_VOTING_WRAPPING_UP_TEXT/u,
  );
  assert.doesNotMatch(submissionsClient, /REPORTS REMAIN OPEN/u);
  assert.match(submissionsPage, /getCurrentPublicCycle/u);
  assert.match(submissionsPage, /isVotingClosed=\{currentCycle\.status === "voting_closed"\}/u);
  assert.match(submissionsClient, /submissions\.map/u);
});

test("Report controls close in-place and refresh an already open panel", () => {
  assert.match(panel, /reportingOpen: boolean/u);
  assert.match(panel, /POST_VOTING_REPORT_CLOSED_TEXT/u);
  assert.match(panel, /REPORTING_CLOSED/u);
  assert.match(panel, /setInterval\(refreshEligibility, 15_000\)/u);
  assert.match(panel, /visibilitychange/u);
  assert.match(panel, /role="status"/u);
  assert.doesNotMatch(panel, /Troll|reporter score|automatic sanction/iu);
  assert.match(
    submissionsClient,
    /surface="active"[\s\S]*reportingOpen=\{!isVotingClosed\}/u,
  );
  assert.match(
    cycleHistory,
    /surface="history"[\s\S]*reportingOpen/u,
  );
});

test("existing Report reads, queues, logs, and history contracts are outside the write lock migration", () => {
  assert.match(teamReadModel, /submissions\.reports\.live\.view/u);
  assert.match(teamReadModel, /submissions\.reports\.finalized\.view/u);
  assert.match(teamReadModel, /logs\.submission_reporters\.view/u);
  assert.match(teamReadModel, /logs\.submission_report_moderation\.view/u);
  assert.match(ownReadModel, /get_own_submission_reports/u);
  assert.doesNotMatch(
    migration,
    /create or replace function public\.(?:list|get|manage)_submission_report_(?:cases|detail|unread|moderation|outcome|case)/u,
  );
});

test("the rollback-only DEV contract covers open phases, closure residue, and finished history", () => {
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_SUBMISSION_OPEN_FAILED/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_VOTING_OPEN_FAILED/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_ELIGIBILITY_OPEN/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_RPC_ACCEPTED/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_RESIDUE/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_EXISTING_FACT_CHANGED/u);
  assert.match(devContract, /POST_VOTING_REPORT_LOCK_HISTORY_FAILED/u);
  assert.match(devContract, /rollback;\s*$/u);
});

test("the prepared multi-connection DEV race is phase-first and self-cleaning", () => {
  assert.match(raceContract, /Promise\.all\(\[/u);
  assert.match(raceContract, /pg_advisory_lock/u);
  assert.match(raceContract, /set status = 'voting_closed'/u);
  assert.match(raceContract, /create_submission_report_v2/u);
  assert.match(raceContract, /reportResult\.code === 0/u);
  assert.match(raceContract, /voting_closed:0:0:0:0:0/u);
  assert.match(raceContract, /postflight !== baseline/u);
  assert.doesNotMatch(
    raceContract,
    /delete from public\.submission_report_(?:cases|reports|payloads|case_events|requests|reads)/u,
  );
});
