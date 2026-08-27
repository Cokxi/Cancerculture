import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL(
  "../../supabase/migrations/20260827000300_user_warning_appeal_status_volatility_correction.sql",
  import.meta.url,
), "utf8");

test("Warning Appeal owner status correction is baseline-bound and volatile", () => {
  assert.match(migration, /792759acf8a49abefe4b4bbbb65e97de/u);
  assert.match(migration, /function_row\.provolatile <> 's'/u);
  const definition = migration.match(
    /create or replace function public\.get_own_user_warning_appeal_status\([\s\S]*?\n\$function\$;/u,
  )?.[0] ?? "";
  assert.match(definition, /language plpgsql\s+volatile\s+security definer/u);
  assert.doesNotMatch(definition, /language plpgsql\s+stable/u);
  assert.match(definition, /require_account_session\(p_session_id\)/u);
  assert.match(migration, /function_row\.provolatile <> 'v'/u);
  assert.match(migration, /search_path=public, pg_temp/u);
  assert.match(migration, /array\['postgres', 'service_role'\]::name\[\]/u);
});
