import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, server, reporterPage, outcomePage, thumbnailServer, ownServer, myReportsPage] = await Promise.all([
  read("supabase/migrations/20260809001000_submission_report_outcome_history.sql"),
  read("lib/reports/submissionReportTeam.server.ts"),
  read("app/admin/reports/users/[publicProfileId]/page.tsx"),
  read("app/admin/logs/submission-reports/page.tsx"),
  read("lib/reports/submissionReportThumbnail.server.ts"),
  read("lib/reports/submissionReportOwn.server.ts"),
  read("app/my-reports/page.tsx"),
]);

test("the outcome history migration is additive, capability-guarded, and hardened", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(
    migration,
    /create function public\.list_submission_report_outcome_events_v3/u
  );
  assert.match(
    migration,
    /authorize_submission_report_capability_v2\([\s\S]*'logs\.submission_report_moderation\.view'/u
  );
  assert.match(migration, /stable security definer set search_path = public, pg_temp/u);
  assert.match(migration, /owner to postgres/u);
  assert.match(
    migration,
    /revoke all on function public\.list_submission_report_outcome_events_v3[\s\S]*from public, anon, authenticated, discord_bot/u
  );
  assert.match(
    migration,
    /grant execute on function public\.list_submission_report_outcome_events_v3[\s\S]*to service_role/u
  );
  assert.match(migration, /SUBMISSION_REPORT_OUTCOME_HISTORY_HARDENING_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_OUTCOME_HISTORY_ACL_MISMATCH/u);
  assert.doesNotMatch(migration, /drop table|delete from public\./iu);
});

test("the paginated read model exposes only close outcomes and Report-caused reopenings", () => {
  const outcomeFunction = migration.match(
    /create function public\.list_submission_report_outcome_events_v3\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(
    outcomeFunction,
    /event\.event_type in \('case_closed', 'case_reopened_by_report'\)/u
  );
  assert.match(outcomeFunction, /event\.disposition = v_filter/u);
  assert.match(outcomeFunction, /limit p_limit \+ 1/u);
  assert.match(outcomeFunction, /'nextCursor'/u);
  assert.doesNotMatch(
    outcomeFunction,
    /case_claimed|case_released|case_forced_released|case_reassigned|case_claim_recovered/u
  );
});

test("Reporter User Logs filter neutral outcomes and use only a current safe thumbnail", () => {
  assert.match(server, /addSafeReporterThumbnails/u);
  assert.match(server, /item\.currentAvailable === true/u);
  assert.match(server, /item\.currentDisqualified !== true/u);
  assert.match(server, /text\(item\.currentVisibility\) === "visible"/u);
  assert.match(
    server,
    /select\("id, r2_key, is_disqualified, public_visibility_status"\)/u
  );
  assert.match(server, /row\.is_disqualified !== true/u);
  assert.match(server, /row\.public_visibility_status === "visible"/u);
  assert.match(server, /getSubmissionThumbnailUrl\(publicUrl\)/u);
  assert.match(reporterPage, /SUBMISSION_REPORT_OUTCOME_FILTERS/u);
  assert.match(reporterPage, /parseSubmissionReportOutcomeFilter/u);
  assert.match(reporterPage, /Current public preview unavailable/u);
  assert.match(reporterPage, /no Report stores a media snapshot/u);
  assert.match(reporterPage, /<Image/u);
  assert.doesNotMatch(reporterPage, /reporter score|success rate|troll/iu);
});

test("the normal log uses the outcome-only read model and hides assignment mechanics", () => {
  assert.match(server, /list_submission_report_outcome_events_v3/u);
  assert.match(server, /p_outcome_filter: outcomeFilter/u);
  assert.match(outcomePage, /Submission Report Outcome History/u);
  assert.match(outcomePage, /SUBMISSION_REPORT_OUTCOME_HISTORY_FILTERS/u);
  assert.match(outcomePage, /Older outcomes/u);
  assert.doesNotMatch(outcomePage, /Open Case|\/admin\/reports\/\$\{/u);
  assert.doesNotMatch(
    outcomePage,
    /previousAssigneeDisplayName|newAssigneeDisplayName|Assignment:/u
  );
});

test("Outcome History and My Reports share a fresh visibility-safe thumbnail boundary", () => {
  assert.match(thumbnailServer, /select\("id, r2_key, is_disqualified, public_visibility_status"\)/u);
  assert.match(thumbnailServer, /row\.is_disqualified !== true/u);
  assert.match(thumbnailServer, /row\.public_visibility_status === "visible"/u);
  assert.match(thumbnailServer, /getSubmissionThumbnailUrl\(publicUrl\)/u);
  assert.match(server, /addVisibilitySafeSubmissionReportThumbnails/u);
  assert.match(ownServer, /addVisibilitySafeSubmissionReportThumbnails/u);
  assert.match(outcomePage, /Current public preview unavailable/u);
  assert.match(outcomePage, /<Image/u);
  assert.match(myReportsPage, /Current public preview unavailable/u);
  assert.match(myReportsPage, /Open current public view of submission/u);
  assert.match(myReportsPage, /<Image/u);
  assert.doesNotMatch(thumbnailServer, /snapshot|copy|insert|update|delete/iu);
});
