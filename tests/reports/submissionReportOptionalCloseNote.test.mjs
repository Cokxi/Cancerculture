import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, registry, server, route, queue, panel, devContract] = await Promise.all([
  read("supabase/migrations/20260810000100_optional_submission_report_close_note.sql"),
  read("lib/auth/teamCapabilityRegistry.ts"),
  read("lib/reports/submissionReportTeam.server.ts"),
  read("app/api/admin/submission-reports/review/route.ts"),
  read("app/admin/reports/SubmissionReportQueueClient.tsx"),
  read("app/components/SubmissionReportPanel.tsx"),
  read("tests/db/submissionReportOptionalCloseNote.dev.sql"),
]);

test("the additive migration makes only Close notes optional and preserves grants and facts", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_BASELINE_MISMATCH/u);
  assert.match(migration, /implementation_version = 4/u);
  assert.match(migration, /106f2027e9ba597867aa4bafa80871f8432c3c27a3cae980061e09930b5b36e1/u);
  assert.match(migration, /status = 'closed'[\s\S]*close_disposition is not null\)[\s\S]*\);/u);
  assert.doesNotMatch(
    migration.match(/add constraint submission_report_cases_state_metadata_check[\s\S]*?\);/u)?.[0] ?? "",
    /status = 'closed'[\s\S]*close_note is not null/u
  );
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.team_role_capabilities/iu
  );
  assert.match(migration, /DATA_POSTFLIGHT_MISMATCH/u);
});

test("the V4 entry point delegates existing operations and records an empty Close note as null", () => {
  assert.match(migration, /create function public\.manage_submission_report_case_v3/u);
  assert.match(migration, /v_operation <> 'close' or v_note is not null[\s\S]*return public\.manage_submission_report_case_v2/u);
  assert.match(migration, /close_note = null/u);
  assert.match(migration, /'case_closed'[\s\S]*v_disposition,[\s\S]*null,/u);
  assert.match(migration, /grant execute on function public\.manage_submission_report_case_v3[\s\S]*to service_role/u);
  assert.match(server, /"manage_submission_report_case_v3"/u);
});

test("API and queue accept an empty Close note but keep Admin override reasons mandatory", () => {
  assert.match(route, /operation === "forced_release" && note === null/u);
  assert.match(route, /\["forced_release", "close"\]\.includes\(operation\)[\s\S]*!noteHasValidLength/u);
  assert.match(queue, /Close note \(optional\)/u);
  assert.match(queue, /noteLength === 0 \|\| \(noteLength >= 10 && noteLength <= 1000\)/u);
  assert.match(queue, /!optionalCloseNoteReady[\s\S]*Close Case/u);
  assert.match(queue, /!requiredOverrideNoteReady[\s\S]*Admin override release/u);
  assert.match(registry, /implementationVersion: 4/u);
});

test("Other is concise and does not show a redundant detail selector", () => {
  assert.match(panel, /reason === "other_rules_concern" \? "other" : subcategory/u);
  assert.match(panel, /reason !== "other_rules_concern" \? \([\s\S]*More detail \(required\)/u);
  assert.match(panel, /subcategory: effectiveSubcategory/u);
  assert.match(panel, /submissionReportRequiresContext\(reason, effectiveSubcategory\)/u);
});

test("the rollback-only DEV contract proves optional Close and mandatory override notes", () => {
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /rollback;\s*$/u);
  assert.match(devContract, /SHORT_NOTE_ACCEPTED/u);
  assert.match(devContract, /OVERRIDE_WITHOUT_REASON_ACCEPTED/u);
  assert.match(devContract, /close_note is null/u);
  assert.match(devContract, /event_row\.note is null/u);
});
