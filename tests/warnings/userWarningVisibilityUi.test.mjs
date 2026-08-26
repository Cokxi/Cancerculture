import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const usersPage = readFileSync("app/admin/users/page.tsx", "utf8");
const disclosure = readFileSync(
  "app/admin/users/UserWarningHistoryDisclosure.tsx",
  "utf8",
);
const ownerPage = readFileSync("app/warnings/[warningId]/page.tsx", "utf8");
const notificationParser = readFileSync(
  "lib/notifications/ownerNotifications.server.ts",
  "utf8",
);
const pushPayload = readFileSync("lib/notifications/pushPayload.ts", "utf8");

test("User Logs Warning status and selected history are separately capability gated", () => {
  assert.match(usersPage, /hasResolvedTeamCapability\([\s\S]*users\.warnings\.view/u);
  assert.match(usersPage, /loadTeamUserWarningSummaries/u);
  assert.match(usersPage, /selectedWarningUserId[\s\S]*loadTeamUserWarningHistory/u);
  assert.match(usersPage, /ACTIVE WARNING/u);
  assert.match(usersPage, /View Warning history/u);
  assert.doesNotMatch(usersPage, /issueCommunityCommentWarning|Issue Warning/u);
});

test("Team history shows immutable evidence, effective recalculation and only the bounded correction control", () => {
  assert.match(disclosure, /Source Comment evidence/u);
  assert.match(disclosure, /sourceCommentObjectVersion/u);
  assert.match(disclosure, /sourceCommentTextVersion/u);
  assert.match(disclosure, /Original:/u);
  assert.match(disclosure, /Effective:/u);
  assert.match(disclosure, /Lifecycle/u);
  assert.match(disclosure, /UserWarningOverruleAction/u);
  assert.doesNotMatch(disclosure, /Issue Warning|Add to Overwatch|appeal/iu);
});

test("owner Warning page is authenticated, noindex, neutral, and contains no Team or auto-Flag detail", () => {
  assert.match(ownerPage, /getSessionState/u);
  assert.match(ownerPage, /loadOwnUserWarningDetail/u);
  assert.match(ownerPage, /robots: \{ index: false, follow: false \}/u);
  assert.match(ownerPage, /Category/u);
  assert.match(ownerPage, /Warning status/u);
  assert.match(ownerPage, /Effective expiry/u);
  assert.match(ownerPage, /Account Warning withdrawn/u);
  assert.match(ownerPage, /This Warning was withdrawn and is no longer active/u);
  assert.match(ownerPage, /Current account Warning status/u);
  assert.match(ownerPage, /You currently have no active Warnings/u);
  assert.match(ownerPage, /No longer applies/u);
  assert.match(ownerPage, /Reason/u);
  assert.match(ownerPage, /font-\['Permanent_Marker'\][^\n]*text-\[var\(--orange-main\)\]/u);
  assert.match(ownerPage, /border-\[var\(--orange-main\)\]\/55/u);
  assert.doesNotMatch(ownerPage, /issuedBy|actorDiscord|autoFlag|sourceCommentBody/u);
  assert.doesNotMatch(ownerPage, /appeal form|Overrule Warning/iu);
});

test("Warning is accepted as an in-product event without entering the Push catalog", () => {
  assert.match(notificationParser, /isNotificationEventType/u);
  assert.match(pushPayload, /IN_PRODUCT_ONLY_EVENT_TYPES[\s\S]*user_warning_issued/u);
  const catalog = pushPayload.slice(
    pushPayload.indexOf("PUSH_PAYLOAD_CATALOG"),
    pushPayload.indexOf("export type PushEventType"),
  );
  assert.doesNotMatch(catalog, /user_warning_issued/u);
});
