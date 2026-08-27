import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL(
  "../../supabase/migrations/20260827000400_user_warning_appeal_case_source_version_projection.sql",
  import.meta.url,
), "utf8");

test("Warning Appeal case detail projects the guarded case source version", () => {
  assert.match(migration, /d2bd87ed651bbf8805d9269ae7a8a31a/u);
  const definition = migration.match(
    /create or replace function public\.get_user_warning_appeal_case_detail\([\s\S]*?\n\$function\$;/u,
  )?.[0] ?? "";
  assert.match(definition, /'\{case,sourceVersion\}'/u);
  assert.match(definition, /case_row\.source_version/u);
  assert.match(definition, /assert_team_inbox_topic_access\(p_actor_discord_user_id, 'warning_appeals', false\)/u);
  assert.match(migration, /revoke all on function public\.get_user_warning_appeal_case_detail/u);
  assert.match(migration, /grant execute on function public\.get_user_warning_appeal_case_detail[\s\S]*to service_role/u);
  assert.match(migration, /position\('sourceVersion' in pg_get_functiondef/u);
});
