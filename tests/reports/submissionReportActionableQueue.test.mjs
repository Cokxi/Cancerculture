import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, devContract] = await Promise.all([
  read("supabase/migrations/20260809000700_hide_closed_submission_report_cases_from_queues.sql"),
  read("tests/db/submissionReportTeamWorkflowCutover.dev.sql"),
]);

test("the additive correction is guarded against the exact DEV cutover baseline", () => {
  assert.match(migration, /SUBMISSION_REPORT_ACTIONABLE_QUEUE_CATALOG_MISMATCH/u);
  assert.match(migration, /523e3bec832b7c26706be2e7d8bf06c7/u);
  assert.match(migration, /e4f4484e0a65b3d4044c2fe84f1d3730/u);
  assert.match(migration, /SUBMISSION_REPORT_ACTIONABLE_QUEUE_BASELINE_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_ACTIONABLE_QUEUE_POSTFLIGHT_MISMATCH/u);
});

test("queues and navigation counts include only open or in-review Cases", () => {
  const listFunction = migration.match(
    /create or replace function public\.list_submission_report_cases_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  const unreadFunction = migration.match(
    /create or replace function public\.get_submission_report_unread_counts_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";

  assert.match(listFunction, /report_case\.status in \('open', 'in_review'\)/u);
  assert.equal(
    unreadFunction.match(/report_case\.status in \('open', 'in_review'\)/gu)?.length,
    2
  );
  assert.doesNotMatch(listFunction, /report_case\.status in \([^)]*'closed'/u);
  assert.doesNotMatch(unreadFunction, /report_case\.status in \([^)]*'closed'/u);
});

test("the two replaced entry points retain hardened service-only execution", () => {
  for (const signature of [
    "list_submission_report_cases_v2\\(text, text, integer\\)",
    "get_submission_report_unread_counts_v2\\(text\\)",
  ]) {
    assert.match(migration, new RegExp(`alter function public\\.${signature} owner to postgres`, "u"));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*to service_role`, "u"));
  }
  assert.match(migration, /from anon, authenticated, discord_bot/u);
  assert.match(migration, /aclexplode/u);
});

test("the rollback-only DEV contract hides closed Cases but preserves authorized log detail", () => {
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_CLOSED_QUEUE_VISIBLE/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_CLOSED_BADGE_VISIBLE/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_CLOSED_DETAIL_MISSING/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_ADMIN_LOG_MISMATCH/u);
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /rollback;\s*$/u);
});
