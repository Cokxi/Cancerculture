import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, client, route, request, saga, publicWall, wallTypes, cycleHistory, cycleTypes] = await Promise.all([
  readFile(new URL("../../app/upload/page.tsx", import.meta.url), "utf8"),
  readFile(
    new URL("../../app/components/upload/DesktopUpload.tsx", import.meta.url),
    "utf8"
  ),
  readFile(new URL("../../app/api/upload/route.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../../lib/upload/submissionUploadRequest.ts", import.meta.url),
    "utf8"
  ),
  readFile(new URL("../../lib/upload/submissionUploadSaga.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/walls/getPublicWallPage.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/walls/publicWallTypes.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/cycles/getCycleHistoryData.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/cycles/cycleHistoryTypes.ts", import.meta.url), "utf8"),
]);

test("the dynamic Upload page loads only the authenticated owner's private Wallet projection", () => {
  assert.match(page, /export const dynamic = "force-dynamic"/u);
  assert.match(page, /getSolProfileWallet\(sessionState\.session\)/u);
  assert.match(page, /profileWallet=\{profileWallet\}/u);
  assert.doesNotMatch(page, /account_sol_profile_wallets|wallet_address/u);
});

test("Profile Wallet is compact, visibly read-only, and changeable only through Your Profile", () => {
  assert.match(client, /hasProfileWallet/u);
  assert.match(client, /Wallet recorded for this Submission/u);
  assert.match(client, /You can change it in/u);
  assert.match(client, /Your Profile/u);
  assert.match(client, /readOnly/u);
  assert.match(client, /h-10 cursor-not-allowed/u);
  assert.match(client, /cursor-not-allowed/u);
  assert.match(client, /bg-white\/70/u);
  assert.match(client, /font-mono text-base/u);
  assert.doesNotMatch(client, /font-mono text-xs/u);
  assert.match(client, /href="\/my-profile"/u);
  assert.doesNotMatch(client, /Change in My Profile/u);
  assert.match(client, /walletSource[\s\S]*"profile"/u);
  assert.match(client, /profileWalletVersion/u);
  assert.doesNotMatch(
    client.slice(
      client.indexOf('formData.append(\n        "walletAddress"'),
      client.indexOf('formData.append("payoutChoice"')
    ),
    /effectiveWalletAddress/u
  );
});

test("manual and Donate states preserve the complete non-2FA matrix", () => {
  assert.match(client, /One-time SOL recipient for this Submission/u);
  assert.match(client, /2FA can enable a reusable wallet/u);
  assert.match(client, /but it is not required to upload\./u);
  assert.doesNotMatch(client, /keep, or split a prize/u);
  assert.match(client, /Save a wallet in/u);
  assert.match(client, /to fill future uploads automatically\./u);
  assert.match(client, /Your Profile/u);
  assert.match(client, /walletRequired \? walletSource : "none"/u);
  assert.match(client, /if \(nextChoice === "donate"\)[\s\S]*setWalletAddress\(""\)/u);
});

test("client and request normalization share canonical SOL validation", () => {
  assert.match(client, /validateSolRecipientAddress/u);
  assert.match(request, /validateSolRecipientAddress/u);
  assert.match(request, /WALLET_ADDRESS_INVALID/u);
  assert.match(request, /walletSource === "profile"[\s\S]*rawWalletAddress !== ""/u);
  assert.match(request, /manualWalletAddress: privateData\.manualWalletAddress/u);
  assert.match(request, /profileWalletVersion: privateData\.profileWalletVersion/u);
});

test("inactive payout buttons remain legible and accessible even in the disabled fieldset", () => {
  assert.match(client, /type="button"/u);
  assert.match(client, /aria-pressed=\{payoutChoice === o\}/u);
  assert.match(client, /focus-visible:outline/u);
  assert.match(client, /bg-white text-black/u);
  assert.match(client, /disabled:opacity-100/u);
});

test("route sends no Profile Wallet address, refreshes stale state, and is explicitly no-store", () => {
  assert.match(route, /PRIVATE_UPLOAD_CACHE_CONTROL = "no-store, max-age=0"/u);
  assert.match(route, /privateData,/u);
  assert.match(route, /if \(!reservation\.r2Uploaded\)/u);
  assert.doesNotMatch(
    saga.slice(
      saga.indexOf("export async function commitSubmissionUpload"),
      saga.indexOf("export async function compensateSubmissionUpload")
    ),
    /privateData|p_wallet_address|p_payout_choice/u
  );
  assert.match(client, /data\.error === "PROFILE_WALLET_STALE"/u);
  assert.match(client, /router\.refresh\(\)/u);
  assert.doesNotMatch(route, /profileWalletAddress|walletAddress:/u);
});

test("private ledgers are accessed only through hardened service RPCs", () => {
  assert.match(saga, /get_completed_submission_upload_operation/u);
  assert.match(saga, /reserve_submission_upload/u);
  assert.match(saga, /commit_submission_upload/u);
  assert.doesNotMatch(saga, /\.from\("submission_upload_operations"\)/u);
});

test("public wall and Cycle History projections never select or return recipient addresses", () => {
  for (const projection of [publicWall, wallTypes, cycleHistory, cycleTypes]) {
    assert.doesNotMatch(projection, /wallet_address/u);
  }
});
