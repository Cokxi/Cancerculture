import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, queue, panel, createMigration, closeMigration, devContract] =
  await Promise.all([
    read("supabase/migrations/20260812000300_report_work_backlog_and_multiple_hint.sql"),
    read("app/admin/reports/SubmissionReportQueueClient.tsx"),
    read("app/components/SubmissionReportPanel.tsx"),
    read("supabase/migrations/20260809000400_fix_submission_report_v2_append_only_creation.sql"),
    read("supabase/migrations/20260810000100_optional_submission_report_close_note.sql"),
    read("tests/db/submissionReportWorkBacklog.dev.sql"),
  ]);

function sqlFunction(name) {
  return migration.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`,
      "u",
    ),
  )?.[0] ?? "";
}

test("the additive migration keeps facts and exact hardened entry points", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /9588d2d2463be9702a3611fa51dc302b/u);
  assert.match(migration, /162bdd7333873221782bb3eef932e2ff/u);
  assert.match(migration, /SUBMISSION_REPORT_WORK_BACKLOG_BASELINE_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_WORK_BACKLOG_DATA_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /proowner = 'postgres'::regrole/u);
  assert.match(migration, /search_path=public, pg_temp/u);
  assert.match(migration, /aclexplode/u);
  assert.match(migration, /to service_role/u);
  assert.doesNotMatch(migration, /create table public\./iu);
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.submission_report_reads/iu,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\.(?:create|manage|get_submission_report_detail|list_submission_report_moderation)/u,
  );
});

test("queue and navigation count team work after the reviewed-through close boundary", () => {
  const list = sqlFunction("list_submission_report_cases_v2");
  const counts = sqlFunction("get_submission_report_unread_counts_v2");

  for (const definition of [list, counts]) {
    assert.match(definition, /reviewed_through_report_id is null/u);
    assert.match(definition, /boundary_event\.event_type = 'case_closed'/u);
    assert.match(
      definition,
      /boundary_event\.report_cursor_id = report_case\.reviewed_through_report_id/u,
    );
    assert.match(
      definition,
      /report_event\.case_version > boundary_event\.case_version/u,
    );
    assert.match(definition, /report_case\.status in \('open', 'in_review'\)/u);
    assert.doesNotMatch(definition, /submission_report_reads/u);
  }

  assert.match(list, /'workBacklogReportCount'/u);
  assert.doesNotMatch(list, /'unreadReportCount'/u);
  assert.equal(
    counts.match(/submission_report_case_area\(report\.case_id\) =/gu)?.length,
    2,
  );
  assert.match(counts, /'total', v_live \+ v_finalized/u);
});

test("the Case report list keeps personal reads separate from operational New", () => {
  const summary = sqlFunction("get_submission_report_case_summary_v2");

  assert.match(summary, /'isRead', receipt\.report_id is not null/u);
  assert.match(summary, /submission_report_reads receipt/u);
  assert.match(summary, /'isNew', report_case\.reviewed_through_report_id is null or exists/u);
  assert.match(summary, /report_event\.case_version > boundary_event\.case_version/u);
  assert.match(queue, /workBacklogReportCount/u);
  assert.match(queue, /report\.isNew === true/u);
  assert.match(queue, /report\.isRead === true/u);
  assert.match(queue, /No new work/u);
  assert.doesNotMatch(queue, /unreadReportCount/u);
  assert.doesNotMatch(queue, /Math\.max\(0,[\s\S]*ReportCount/u);
});

test("Close and Report creation serialize on the Case and the projection uses that order", () => {
  const create = createMigration.match(
    /create or replace function public\.create_submission_report_v2\([\s\S]*?\$function\$;/u,
  )?.[0] ?? "";
  const close = closeMigration.match(
    /create function public\.manage_submission_report_case_v3\([\s\S]*?\$function\$;/u,
  )?.[0] ?? "";

  assert.match(create, /from public\.submission_report_cases[\s\S]*for update/u);
  assert.match(create, /'report_created'[\s\S]*v_case\.row_version \+ 1/u);
  assert.match(create, /'case_reopened_by_report'/u);
  assert.match(close, /from public\.submission_report_cases[\s\S]*for update/u);
  assert.match(close, /reviewed_through_report_id = latest_report_id/u);
  assert.match(close, /'case_closed'[\s\S]*v_case\.row_version \+ 1/u);
  assert.match(migration, /report_event\.case_version > boundary_event\.case_version/u);
  assert.doesNotMatch(migration, /report\.created_at[\s\S]*reviewed_through_report_at/u);
});

test("the multiple-report hint starts at five and exposes only the existing boolean", () => {
  const eligibility = sqlFunction("get_submission_report_eligibility");
  const copy =
    "Several reports about this submission have already reached the team. Please submit another report only if you can add relevant information.";

  assert.match(eligibility, /select count\(\*\) >= 5/u);
  assert.doesNotMatch(eligibility, /count\(\*\) >= [0-4]/u);
  assert.match(eligibility, /'hasMultipleExistingReports', v_multiple/u);
  assert.doesNotMatch(eligibility, /existingReportCount|exactReportCount/u);
  assert.equal(panel.replace(/\s+/gu, " ").includes(copy), true);
  assert.equal(panel.replace(/\s+/gu, " ").split(copy).length - 1, 1);
  assert.ok(
    panel.indexOf("eligibility.hasMultipleExistingReports") <
      panel.indexOf("Submit report"),
  );
  assert.doesNotMatch(panel, /already been reported multiple times/u);
});

test("the rollback-only DEV contract covers backlog, reads, reopen, areas, and both serial orders", () => {
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /rollback;\s*$/u);
  for (const marker of [
    "REPORT_WORK_BACKLOG_DEV_FOUR_HINT_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_FIVE_HINT_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_OPEN_COUNT_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_READ_CHANGED_WORK_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_CLAIM_CHANGED_WORK_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_RELEASE_CHANGED_WORK_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_CLOSE_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_REOPEN_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_THIRTY_PLUS_ONE_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_AREA_CHANGE_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_CYCLE_RESET_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_REPORT_BEFORE_CLOSE_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_CLOSE_BEFORE_REPORT_MISMATCH",
    "REPORT_WORK_BACKLOG_DEV_LOG_REGRESSION",
  ]) {
    assert.match(devContract, new RegExp(marker, "u"));
  }
});
