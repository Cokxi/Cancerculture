import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const usersPage = readFileSync("app/admin/users/page.tsx", "utf8");
const disclosure = readFileSync(
  "app/admin/users/UserWarningHistoryDisclosure.tsx",
  "utf8",
);
const correction = readFileSync(
  "app/admin/users/UserWarningOverruleAction.tsx",
  "utf8",
);
const serverAction = readFileSync(
  "app/admin/actions/overruleUserWarning.ts",
  "utf8",
);
const flagPage = readFileSync("app/admin/flags/page.tsx", "utf8");
const automaticCard = readFileSync(
  "app/admin/flags/AutomaticWarningFlagCaseCard.tsx",
  "utf8",
);
const pushPayload = readFileSync("lib/notifications/pushPayload.ts", "utf8");

test("selected User Logs history separates Warning view from exact Overrule authority", () => {
  assert.match(usersPage, /hasResolvedTeamCapability\([\s\S]*users\.warnings\.view/u);
  assert.match(usersPage, /hasResolvedTeamCapability\([\s\S]*users\.warnings\.overrule/u);
  assert.match(usersPage, /canOverrule=\{canOverruleWarnings\}/u);
  assert.match(disclosure, /canOverrule && warning\.effectiveStatus !== "overruled"/u);
  assert.match(disclosure, /expectedRowVersion=\{warning\.rowVersion\}/u);
});

test("Overrule UI binds a fresh request UUID, internal reason and irreversible audit confirmation", () => {
  assert.match(correction, /Internal correction reason/u);
  assert.match(correction, /minLength=\{3\}/u);
  assert.match(correction, /maxLength=\{1000\}/u);
  assert.match(correction, /crypto\.randomUUID\(\)/u);
  assert.match(correction, /irreversible audit event/u);
  assert.match(correction, /will not be deleted or rewritten/u);
  assert.match(correction, /targetDiscordUserId/u);
  assert.match(correction, /expectedRowVersion/u);
  assert.doesNotMatch(correction, /Issue Warning|deleteWarning|rewriteWarning/u);
  assert.match(serverAction, /overruleTeamUserWarning/u);
});

test("Flagged Users renders automatic Warning flags as a separate read-only surface", () => {
  assert.match(flagPage, /listUserWarningAutoFlagCases/u);
  assert.match(flagPage, /Manual flags/u);
  assert.match(flagPage, /Automatic Warning flags/u);
  assert.match(automaticCard, /Automatic · Warning threshold/u);
  assert.match(automaticCard, /Three active Warnings/u);
  assert.match(automaticCard, /Active fourteen-day Warning/u);
  assert.match(automaticCard, /Opened/u);
  assert.match(automaticCard, /Recomputed/u);
  assert.match(automaticCard, /Closed/u);
  assert.match(automaticCard, /No manual close, Ban, Participation Hold/u);
  assert.doesNotMatch(
    automaticCard,
    /FlagCaseReviewActions|reviewUserFlagCase|ban_website_user|createUserFlagCase/u,
  );
});

test("Warning correction stays outside every Push payload catalog", () => {
  assert.match(pushPayload, /IN_PRODUCT_ONLY_EVENT_TYPES[\s\S]*user_warning_overruled/u);
  const catalog = pushPayload.slice(
    pushPayload.indexOf("PUSH_PAYLOAD_CATALOG"),
    pushPayload.indexOf("export type PushEventType"),
  );
  assert.doesNotMatch(catalog, /user_warning_overruled/u);
});
