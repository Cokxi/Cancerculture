import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const path = "supabase/migrations/20260826000800_user_warning_copy_polish.sql";
const sql = readFileSync(path, "utf8");

test("Warning copy polish is additive and guarded by the installed visibility contract", () => {
  assert.match(sql, /capability_catalog\) <> 52/u);
  assert.match(sql, /users\.warnings\.view/u);
  assert.match(sql, /account_warnings/u);
  assert.match(sql, /USER_WARNING_COPY_BASELINE_MISMATCH/u);
  assert.match(sql, /USER_WARNING_COPY_DEFINITION_MISMATCH/u);
});

test("Notification Center uses the accepted neutral Warning title only", () => {
  const replacement = sql.slice(
    sql.indexOf("create or replace function public.get_own_notifications"),
    sql.indexOf("alter function public.get_own_notifications"),
  );
  assert.match(replacement, /when 'user_warning_issued' then 'Account Warning'/u);
  assert.doesNotMatch(replacement, /Account warning issued/u);
  assert.match(replacement, /Review a Warning issued by the CancerCulture Team\./u);
  assert.doesNotMatch(replacement, /warning_row\.reason|issued_by|actor|auto_flag/iu);
});

test("Notification read RPC remains postgres-owned, fixed-path and service-only", () => {
  assert.match(sql, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(
    sql,
    /alter function public\.get_own_notifications\(uuid,timestamptz,uuid,integer\)[\s\S]*owner to postgres/u,
  );
  assert.match(
    sql,
    /revoke all on function public\.get_own_notifications\(uuid,timestamptz,uuid,integer\)[\s\S]*from public, anon, authenticated, discord_bot, service_role/u,
  );
  assert.match(
    sql,
    /grant execute on function public\.get_own_notifications\(uuid,timestamptz,uuid,integer\)[\s\S]*to service_role/u,
  );
  assert.match(sql, /USER_WARNING_COPY_FINAL_STATE_MISMATCH/u);
});
