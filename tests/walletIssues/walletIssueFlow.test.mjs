import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("owner intake is authenticated, submission-bound, replay-safe, and verifies before multipart image work", async () => {
  const [route, service, turnstile] = await Promise.all([
    source("app/api/wallet-issues/intakes/route.ts"),
    source("lib/walletIssues/service.server.ts"),
    source("lib/turnstile/shared.ts"),
  ]);
  const handler = route.indexOf("export async function POST");
  const auth = route.indexOf("requireSession()", handler);
  const replay = route.indexOf("getWalletIssueIntakeReplay", handler);
  const eligibility = route.indexOf("assertWalletIssueIntakeOpen", handler);
  const verification = route.indexOf("verifyTurnstileRequest(", handler);
  const formData = route.indexOf("request.formData()", handler);
  const image = route.indexOf("normalizeWalletIssueScreenshot(", handler);
  assert.ok(auth < replay && replay < eligibility && eligibility < verification);
  assert.ok(verification < formData && formData < image);
  assert.match(service, /create_own_wallet_issue_intake/u);
  assert.match(service, /p_submission_id: input\.submissionId/u);
  assert.match(turnstile, /walletIssueIntake: "wallet_issue_intake"/u);
});

test("optional screenshots are bounded, decoded once, rotated, resized, re-encoded, and metadata-free", async () => {
  const [contract, screenshot] = await Promise.all([
    source("lib/walletIssues/contract.ts"),
    source("lib/walletIssues/screenshot.server.ts"),
  ]);
  assert.match(contract, /3 \* 1024 \* 1024/u);
  assert.match(contract, /"image\/jpeg"[\s\S]*"image\/png"[\s\S]*"image\/webp"/u);
  assert.match(screenshot, /sharp\(source/u);
  assert.match(screenshot, /\.rotate\(\)/u);
  assert.match(screenshot, /\.resize\(\{ width: 1600, height: 1600/u);
  assert.match(screenshot, /\.webp\(\{ quality: 82/u);
  assert.doesNotMatch(screenshot, /withMetadata/u);
});

test("My Profile renders one Wallet Issue intake control per eligible current Submission", async () => {
  const [page, form] = await Promise.all([
    source("app/my-profile/page.tsx"),
    source("app/my-profile/WalletIssueIntakeForm.tsx"),
  ]);
  assert.match(page, /currentSubmissions\.map/u);
  assert.match(page, /privateData\?\.payout_choice === "keep"[\s\S]*privateData\?\.payout_choice === "split"/u);
  assert.match(page, /submissionId=\{submission\.id\}/u);
  assert.match(form, /Report Wallet Issue for this Submission/u);
  assert.match(form, /only becomes a Team case if this exact Submission wins/u);
  assert.match(form, /It is tied only to Submission #\{submissionId\}/u);
});

test("Intake Monitor is a separate permission-protected shadow view and normal topic history links only promoted cases", async () => {
  const [page, component, route, topic] = await Promise.all([
    source("app/admin/inbox/wallet_issues/intake-monitor/page.tsx"),
    source("app/components/teamInbox/WalletIssueIntakeMonitor.tsx"),
    source("app/api/admin/team-inbox/wallet-issues/intake-monitor/route.ts"),
    source("app/admin/inbox/[topicKey]/page.tsx"),
  ]);
  assert.match(page, /loadAuthorizedTeamInboxTopics/u);
  assert.match(page, /topicKey === "wallet_issues"/u);
  assert.match(route, /export async function POST/u);
  assert.match(route, /enforceRouteMutationGate/u);
  assert.match(component, /permanently deleted 14 days after Cycle finalization/u);
  assert.match(component, /typeof item\.caseId === "string"/u);
  assert.match(topic, /Open Intake Monitor/u);
});

test("Wallet Issue case resolution stays assignee-only and leaves final confirmation to the winner", async () => {
  const [detail, copyButton, route, service] = await Promise.all([
    source("app/components/teamInbox/TeamInboxCaseDetail.tsx"),
    source("app/components/teamInbox/CopyReportedWalletButton.tsx"),
    source("app/api/admin/team-inbox/cases/[caseId]/wallet-issue/resolve/route.ts"),
    source("lib/walletIssues/service.server.ts"),
  ]);
  assert.match(detail, /caseStatus === "in_progress" && assignedToMe/u);
  assert.match(detail, /accept_correction/u);
  assert.match(detail, /no_action/u);
  assert.match(detail, /Team resolution never confirms the Claim/u);
  assert.match(detail, /New Wallet reported by the user[\s\S]*CopyReportedWalletButton[\s\S]*Current candidate/u);
  assert.equal(detail.match(/<CopyReportedWalletButton/gu)?.length, 1);
  assert.match(copyButton, /navigator\.clipboard\.writeText\(walletAddress\)/u);
  assert.match(copyButton, /Copy reported Wallet/u);
  assert.match(route, /expectedCaseRowVersion/u);
  assert.match(route, /expectedCaseWorkVersion/u);
  assert.match(service, /expectedIntakeVersion/u);
  assert.match(service, /expectedClaimVersion/u);
});

test("Wallet Issue notifications use generic copies without recipient, description, or screenshot data", async () => {
  const [owner, push] = await Promise.all([
    source("lib/notifications/ownerNotifications.server.ts"),
    source("lib/notifications/pushPayload.ts"),
  ]);
  for (const eventType of [
    "winner_correction_ready",
    "wallet_issue_received",
    "wallet_issue_correction_ready",
    "wallet_issue_resolved",
  ]) {
    assert.match(owner, new RegExp(eventType, "u"));
    assert.match(push, new RegExp(eventType, "u"));
  }
  assert.doesNotMatch(push, /recipient address|desiredRecipient|description|screenshot/iu);
});
