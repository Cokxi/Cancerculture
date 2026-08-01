import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("server operations use least capabilities and hardened RPCs", async () => {
  const model = await source("lib/admin/userFlagCases.ts");
  for (const [capability, rpc] of [
    ["users.flag.create", "create_user_flag_case"],
    ["users.flag.view", "list_user_flag_cases"],
    ["users.flag.review", "review_user_flag_case"],
  ]) {
    assert.match(model, new RegExp(`"${capability}"`, "u"));
    assert.match(model, new RegExp(`"${rpc}"`, "u"));
  }
  assert.match(model, /"get_user_flag_case"/u);
  assert.doesNotMatch(model, /\.from\("user_flag_(?:cases|events|requests)"\)/u);
  assert.doesNotMatch(model, /"users\.flag"/u);
});

test("create-only access exposes neither directory nor history", async () => {
  const [page, form] = await Promise.all([
    source("app/admin/users/page.tsx"),
    source("app/admin/users/UserFlagCaseCreateForm.tsx"),
  ]);
  assert.match(page, /if \(!canViewDirectory\)/u);
  assert.match(page, /canCreateFlags \? <UserFlagCaseCreateForm/u);
  assert.match(page, /canViewFlags \? \(/u);
  assert.doesNotMatch(form, /listUserFlagCases|getUserFlagCase|\.events\b/iu);
  assert.match(form, /crypto\.randomUUID\(\)/u);
});

test("list-view and concrete-review routes remain separated", async () => {
  const [list, detail] = await Promise.all([
    source("app/admin/flags/page.tsx"),
    source("app/admin/flags/[caseId]/page.tsx"),
  ]);
  assert.match(list, /"users\.flag\.view"/u);
  assert.match(list, /listUserFlagCases\(\{[\s\S]*section:/u);
  assert.match(detail, /getUserFlagCase\(caseId\)/u);
  assert.match(detail, /"users\.flag\.review"/u);
  assert.doesNotMatch(detail, /listUserFlagCases/u);
});

test("review UI confirms, locks pending actions, and handles stale refresh", async () => {
  const ui = await source("app/admin/flags/[caseId]/FlagCaseReviewActions.tsx");
  assert.match(ui, /window\.confirm\(/u);
  assert.match(ui, /setPending\(true\)/u);
  assert.match(ui, /disabled=\{pending \|\|/u);
  assert.match(ui, /crypto\.randomUUID\(\)/u);
  assert.match(ui, /router\.refresh\(\)/u);
});

test("legacy flag columns and unflag are absent from cut-over paths", async () => {
  const contents = await Promise.all([
    source("app/admin/users/page.tsx"),
    source("app/admin/flags/page.tsx"),
    source("app/api/admin/user-logs/route.ts"),
    source("lib/admin/getUserLogsWithStats.ts"),
    source("lib/admin/userDirectoryAccess.ts"),
  ]);
  assert.doesNotMatch(contents.join("\n"), /flagged_for_review|flag_reason_code|flag_note|unflagged_at/u);
  await assert.rejects(source("app/admin/actions/unflagUser.ts"));
});
