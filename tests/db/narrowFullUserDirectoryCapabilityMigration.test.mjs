import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260801000300_narrow_full_user_directory_capability.sql",
    import.meta.url
  ),
  "utf8"
);
const dropdown = await readFile(
  new URL("../../app/admin/users/UserSubmissionsDropdown.tsx", import.meta.url),
  "utf8"
);
const usersPage = await readFile(
  new URL("../../app/admin/users/page.tsx", import.meta.url),
  "utf8"
);
const bansPage = await readFile(
  new URL("../../app/admin/bans/page.tsx", import.meta.url),
  "utf8"
);

test("the full directory definition explicitly excludes DQ history and vote totals", () => {
  assert.match(migration, /implementation_version = 2/u);
  assert.match(migration, /recent non-disqualified submission list/u);
  assert.match(migration, /disqualified submission history or per-submission vote totals/u);
  assert.match(migration, /df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1/u);
  assert.match(migration, /exists \(select 1 from public\.team_role_capabilities\)/u);
});

test("non-Admin directory previews filter DQ rows and do not query vote counts", () => {
  assert.match(dropdown, /if \(!includeDisqualified\)[\s\S]*?\.eq\("is_disqualified", false\)/u);
  assert.match(dropdown, /const \{ data: votes \} = includeVoteCounts/u);
  assert.match(usersPage, /includeDisqualified=\{authorization\.isAdmin\}/u);
  assert.match(usersPage, /includeVoteCounts=\{authorization\.isAdmin\}/u);
});

test("website-ban view alone does not disclose submission history", () => {
  assert.match(bansPage, /"users\.directory\.full\.view"/u);
  assert.match(bansPage, /\{canViewFullDirectory \? <div[\s\S]*?<UserSubmissionsDropdown/u);
});
