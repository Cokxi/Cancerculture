import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ownerPage = await readFile(new URL("../../app/warnings/[warningId]/page.tsx", import.meta.url), "utf8");
const ownerPanel = await readFile(new URL("../../app/warnings/[warningId]/WarningAppealPanel.tsx", import.meta.url), "utf8");
const teamDetail = await readFile(new URL("../../app/components/teamInbox/TeamInboxCaseDetail.tsx", import.meta.url), "utf8");
const server = await readFile(new URL("../../lib/warnings/userWarningAppeal.server.ts", import.meta.url), "utf8");
const pushPayload = await readFile(new URL("../../lib/notifications/pushPayload.ts", import.meta.url), "utf8");

test("owner Warning detail exposes one bounded Appeal without implying a pause", () => {
  assert.match(ownerPage, /loadOwnUserWarningAppealStatus/u);
  assert.match(ownerPage, /<WarningAppealPanel/u);
  assert.match(ownerPanel, /minimum 20/u);
  assert.match(ownerPanel, /maxLength=\{1000\}/u);
  assert.match(ownerPanel, /one Appeal for this Warning/u);
  assert.match(ownerPanel, /does not pause, shorten, or remove it/u);
  assert.match(ownerPanel, /crypto\.randomUUID\(\)/u);
  assert.doesNotMatch(ownerPanel, /Team member identit/u);
});

test("Team review is bounded, assigned, reasoned, confirmed, and capability split", () => {
  assert.match(teamDetail, /Warning Appeal details/u);
  assert.match(teamDetail, /Source Comment snapshot/u);
  assert.match(teamDetail, /warning-appeal\/review/u);
  assert.match(teamDetail, /expectedCaseSourceVersion: caseData\.sourceVersion/u);
  assert.match(teamDetail, /window\.confirm/u);
  assert.match(teamDetail, /canOverrule/u);
  assert.match(teamDetail, /Uphold Warning & solve/u);
  assert.match(teamDetail, /Overrule Warning & solve/u);
  assert.match(teamDetail, /const commentDomain = domain\?\.kind === "comment_report" \|\| domain\?\.kind === "comment_spam"/u);
  assert.match(teamDetail, /const warningAppeal = domain\?\.kind === "warning_appeal" \? domain : null/u);
  assert.match(server, /requireDynamicTeamCapability\("users\.warning_appeals\.review"\)/u);
  assert.doesNotMatch(teamDetail, /automatic Flags|Overwatch/u);
});

test("Appeal Uphold is explicitly excluded from Push", () => {
  assert.match(pushPayload, /IN_PRODUCT_ONLY_EVENT_TYPES[\s\S]*user_warning_appeal_upheld/u);
  assert.doesNotMatch(pushPayload, /user_warning_appeal_upheld:\s*\{/u);
});
