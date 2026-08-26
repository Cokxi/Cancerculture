import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  "supabase/migrations/20260826001000_warning_withdrawal_member_status.sql",
  "utf8",
);

test("withdrawn owner detail projects neutral current account Warning status", () => {
  const detail = sql.slice(
    sql.indexOf("create or replace function public.get_own_user_warning_detail"),
    sql.indexOf("create or replace function public.get_own_notifications"),
  );
  assert.match(detail, /when current_row\.state = 'overruled' then 'withdrawn'/u);
  assert.match(detail, /when current_row\.state = 'overruled' then null/u);
  assert.match(detail, /accountActiveWarningCount/u);
  assert.match(detail, /accountLatestActiveExpiresAt/u);
  assert.match(detail, /account_row\.state = 'active'/u);
  assert.match(detail, /account_row\.expires_at > v_now/u);
  assert.doesNotMatch(
    detail,
    /actor_display|actor_role|source_comment|auto_flag|correction_reason/iu,
  );
});

test("correction notification uses withdrawn member language and updated status action", () => {
  const notifications = sql.slice(
    sql.indexOf("create or replace function public.get_own_notifications"),
    sql.indexOf("alter function public.get_own_user_warning_detail"),
  );
  assert.match(notifications, /Account Warning withdrawn/u);
  assert.match(
    notifications,
    /A Warning for your account was withdrawn\. Review your updated account Warning status\./u,
  );
  assert.match(notifications, /View updated status/u);
  assert.doesNotMatch(notifications, /Account Warning corrected|was overruled/iu);
  assert.doesNotMatch(
    notifications,
    /actor_display|actor_role|source_comment|auto_flag|correction_reason/iu,
  );
});

test("member projections retain postgres ownership, fixed paths and service-only execution", () => {
  for (const signature of [
    "get_own_user_warning_detail(uuid,uuid)",
    "get_own_notifications(uuid,timestamptz,uuid,integer)",
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(sql, new RegExp(`alter function public\\.${escaped}[\\s\\S]*owner to postgres`, "u"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}`, "u"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*to service_role`, "u"));
  }
  assert.match(sql, /set search_path = public, pg_temp/gu);
  assert.match(sql, /WARNING_WITHDRAWAL_MEMBER_STATUS_POSTFLIGHT_MISMATCH/u);
});
