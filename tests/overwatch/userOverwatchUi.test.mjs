import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const usersPage = await readFile(
  new URL("../../app/admin/users/page.tsx", import.meta.url),
  "utf8",
);
const addAction = await readFile(
  new URL("../../app/admin/users/UserOverwatchAddAction.tsx", import.meta.url),
  "utf8",
);
const overwatchPage = await readFile(
  new URL("../../app/admin/overwatch/page.tsx", import.meta.url),
  "utf8",
);
const removeAction = await readFile(
  new URL("../../app/admin/overwatch/UserOverwatchRemoveAction.tsx", import.meta.url),
  "utf8",
);
const navigation = await readFile(
  new URL("../../lib/admin/teamAreaNavigation.ts", import.meta.url),
  "utf8",
);
const serverActions = await readFile(
  new URL("../../app/admin/actions/userOverwatch.ts", import.meta.url),
  "utf8",
);

test("User Logs exposes Add only through exact Manage preparation and confirmation", () => {
  assert.match(usersPage, /hasResolvedTeamCapability\([\s\S]*"users\.overwatch\.manage"/u);
  assert.match(usersPage, /canManageOverwatch[\s\S]*<UserOverwatchAddAction/u);
  assert.match(addAction, /"Add to Overwatch"/u);
  assert.match(addAction, /prepareAddToOverwatch\(targetDiscordUserId\)/u);
  assert.match(addAction, /expectedState: prepared\.expectedState/u);
  assert.match(addAction, /expectedRowVersion: prepared\.expectedRowVersion/u);
  assert.match(addAction, /crypto\.randomUUID\(\)/u);
  assert.match(addAction, /window\.confirm\(/u);
  assert.match(addAction, /does not flag, warn, sanction, notify, or change the user's participation/u);
});

test("the separate Active and immutable History surface is exact View only", () => {
  assert.match(overwatchPage, /requireTeamCapabilityPage\([\s\S]*"users\.overwatch\.view"/u);
  assert.match(overwatchPage, /loadUserOverwatchEntries\("active"\)/u);
  assert.match(overwatchPage, /loadUserOverwatchEntries\("history"\)/u);
  assert.match(overwatchPage, />Active entries</u);
  assert.match(overwatchPage, />Immutable history</u);
  assert.match(overwatchPage, /entry\.state === "active" && canManage/u);
  assert.match(navigation, /href: "\/admin\/overwatch"[\s\S]*requirement: userOverwatchView/u);
  assert.match(navigation, /capability: "users\.overwatch\.view"/u);
});

test("Remove is explicit, expected-version bound, UUID-idempotent, and history preserving", () => {
  assert.match(removeAction, /expectedRowVersion/u);
  assert.match(removeAction, /crypto\.randomUUID\(\)/u);
  assert.match(removeAction, /window\.confirm\(/u);
  assert.match(removeAction, /remain permanently preserved/u);
  assert.match(removeAction, /"Remove from Overwatch"/u);
  assert.match(serverActions, /removeUserFromOverwatch/u);
  assert.doesNotMatch(serverActions, /warning|flag|notification|push/iu);
});
