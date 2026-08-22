import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Payout Logs group the newest Cycle first and keep only that Cycle open by default", async () => {
  const page = await source("app/admin/payout-logs/page.tsx");

  assert.match(page, /groupPayoutLogsByCycle/u);
  assert.match(page, /cycleNumber/u);
  assert.match(
    page,
    /sort\(\s*\(left, right\) => right\.cycleNumber - left\.cycleNumber\s*\)/u
  );
  assert.match(page, /open=\{index === 0\}/u);
  assert.match(page, /Cycle #\{group\.cycleNumber\}/u);
});

test("Payout Log cards present time, action, and optional reason in a bounded responsive grid", async () => {
  const page = await source("app/admin/payout-logs/page.tsx");

  assert.match(page, /max-w-7xl/u);
  assert.match(page, /grid-cols-1[\s\S]*lg:grid-cols-2[\s\S]*2xl:grid-cols-3/u);
  assert.match(page, />Time</u);
  assert.match(page, />Action</u);
  assert.match(page, />Reason</u);
  assert.match(page, /item\.reason \?/u);
  assert.doesNotMatch(page, /Audit details|targetPublicId|JSON\.stringify\(item\.details/u);
  assert.match(page, /href="\/api\/admin\/payout-logs\/export"/u);
  assert.match(page, /Download technical audit/u);
  assert.match(page, /troubleshooting only/u);
});

test("the emergency audit export repeats the exact capability and returns a private bounded JSON attachment", async () => {
  const route = await source("app/api/admin/payout-logs/export/route.ts");

  assert.match(route, /requireDynamicTeamCapability\("winners\.payout_logs\.view"\)/u);
  assert.match(route, /getTeamPayoutLogs\(authorization\.discord_user_id, EXPORT_LIMIT\)/u);
  assert.match(route, /const EXPORT_LIMIT = 500/u);
  assert.match(route, /schemaVersion: 1/u);
  assert.match(route, /entryCount: items\.length/u);
  assert.match(route, /truncated: items\.length === EXPORT_LIMIT/u);
  assert.match(route, /Content-Disposition/u);
  assert.match(route, /attachment; filename=/u);
  assert.match(route, /application\/json; charset=utf-8/u);
  assert.match(route, /private, no-store, max-age=0/u);
  assert.match(route, /X-Content-Type-Options/u);
  assert.match(route, /getRouteErrorResponse/u);
});

test("the protected payout-log projection resolves every existing target type to its public Cycle", async () => {
  const migration = await source(
    "supabase/migrations/20260822000600_payout_log_cycle_projection.sql"
  );

  assert.match(migration, /^begin;/u);
  assert.match(migration, /create or replace function public\.get_team_payout_logs/u);
  assert.match(migration, /assert_winners_payout_capability[\s\S]*winners\.payout_logs\.view/u);
  for (const targetType of [
    "pool",
    "component",
    "allocation",
    "plan",
    "line",
    "transaction",
    "return_claim",
    "donation_correction",
    "payout_disqualification",
  ]) {
    assert.match(migration, new RegExp(`event\\.target_type = '${targetType}'`, "u"));
  }
  assert.match(migration, /'cycleNumber', cycle\.public_number/u);
  assert.match(migration, /'cycleStatus', cycle\.status/u);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /alter function public\.get_team_payout_logs\(text,integer\) owner to postgres/u);
  assert.match(migration, /revoke all on function public\.get_team_payout_logs\(text,integer\)[\s\S]*service_role/u);
  assert.match(migration, /grant execute on function public\.get_team_payout_logs\(text,integer\) to service_role/u);
  assert.match(migration, /commit;\s*$/u);
});
