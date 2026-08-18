import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("My Profile separates active Claims below the Wallet from collapsed win history", async () => {
  const [page, pending, sections, countdown] = await Promise.all([
    source("app/my-profile/page.tsx"),
    source("app/my-profile/PendingWinnerClaims.tsx"),
    source("app/my-profile/ProfileSections.tsx"),
    source("app/components/winners/ClaimCountdown.tsx"),
  ]);
  assert.match(page, /getOwnWinnerClaims\(session\)/u);
  assert.ok(page.indexOf("<PendingWinnerClaims") < page.indexOf("Current Cycle"));
  assert.ok(page.indexOf("<SolProfileWalletSettings") < page.indexOf("<PendingWinnerClaims"));
  assert.match(pending, /filter\(\(claim\) => claim\.status === "unclaimed"\)/u);
  assert.match(sections, /<Section title="My Submissions">[\s\S]*<Section title="My Wins">/u);
  assert.match(sections, /filter\(\(claim\) => claim\.status !== "unclaimed"\)/u);
  assert.match(countdown, /data-winner-claim-countdown/u);
  assert.match(countdown, /router\.refresh\(\)/u);
  assert.match(pending, /\/my-profile\/winnings\/\$\{claim\.claimId\}/u);
  assert.match(sections, /Donation — no claim required/u);
});

test("the direct Claim route awaits Next 16 params and enforces the owning Website session", async () => {
  const [page, service] = await Promise.all([
    source("app/my-profile/winnings/[claimId]/page.tsx"),
    source("lib/winnerClaims/service.server.ts"),
  ]);
  assert.match(page, /params: Promise<\{ claimId: string \}>/u);
  assert.match(page, /const \{ claimId \} = await params/u);
  assert.match(page, /getSessionState\(\)/u);
  assert.match(page, /getOwnWinnerClaim\(sessionState\.session, claimId\)/u);
  assert.match(service, /rpc\("get_own_winner_claim"[\s\S]*p_session_id: session\.session_id/u);
});

test("Claim confirmation shows the full address, publication notice, stale refresh, and separate decline confirmation", async () => {
  const client = await source("app/my-profile/winnings/[claimId]/WinnerClaimClient.tsx");
  assert.match(client, /data-winner-claim-recipient/u);
  assert.match(client, /whitespace-nowrap[\s\S]*candidate\.address/u);
  assert.doesNotMatch(client, /slice\(|truncate|text-ellipsis/u);
  assert.match(client, /confirmed winner recipient will be shown publicly/u);
  assert.match(client, /Confirm wallet and claim prize/u);
  assert.match(client, /declining is final/u);
  assert.match(client, /candidate_stale[\s\S]*router\.refresh/u);
  assert.match(client, /Retry same operation/u);
  assert.match(client, /claim\.status === "unclaimed"[\s\S]*No valid recipient is available yet/u);
  assert.match(client, /expiryRefreshRef[\s\S]*router\.refresh\(\)/u);
});

test("the owner mutation API accepts only an opaque revision and never an authoritative address", async () => {
  const route = await source("app/api/account/winner-claims/[claimId]/route.ts");
  assert.match(route, /requireSession\(\)/u);
  assert.match(route, /expectedCandidateRevision/u);
  assert.match(route, /mutateOwnWinnerClaim/u);
  assert.doesNotMatch(route, /body\?\.(?:address|wallet|recipient)/u);
  assert.match(route, /enforceRouteMutationGate/u);
  assert.match(route, /Cache-Control": "no-store/u);
});

test("Team corrections require both view and zero-grant mutation capabilities before the database RPC", async () => {
  const [route, page, controls, service] = await Promise.all([
    source("app/api/admin/winner-recipient-corrections/route.ts"),
    source("app/admin/logs/winners/page.tsx"),
    source("app/admin/logs/winners/WinnerCorrectionControls.tsx"),
    source("lib/winnerClaims/service.server.ts"),
  ]);
  assert.ok(route.indexOf('"winners.payouts.view"') < route.indexOf('"winners.recipient_corrections.manage"'));
  assert.match(page, /hasResolvedTeamCapability[\s\S]*winners\.recipient_corrections\.manage/u);
  assert.match(page, /canManageCorrections[\s\S]*WinnerCorrectionControls/u);
  assert.match(page, /winner\.status === "unclaimed"[\s\S]*ClaimCountdown/u);
  assert.match(controls, /Propose correction and start 24h/u);
  assert.match(page, /winner\.profileWalletOwnerControlled[\s\S]*Team recipient correction is unavailable/u);
  assert.match(page, /winner\.correctionEligible && !winner\.profileWalletOwnerControlled/u);
  assert.match(service, /profileWalletOwnerControlled: row\.profileWalletOwnerControlled === true/u);
  assert.match(controls, /WINNER_PROFILE_WALLET_OWNER_CONTROLLED/u);
  assert.doesNotMatch(controls, /Tally|case reference|report date|datetime-local|record_pending/iu);
  assert.doesNotMatch(route, /caseReference|reportedAt|record_pending|body\?\.action/u);
  assert.match(service, /rpc\("manage_winner_recipient_correction"/u);
});

test("the winner cannot reject a correction from the Claim screen", async () => {
  const [client, route, service] = await Promise.all([
    source("app/my-profile/winnings/[claimId]/WinnerClaimClient.tsx"),
    source("app/api/account/winner-claims/[claimId]/route.ts"),
    source("lib/winnerClaims/service.server.ts"),
  ]);
  assert.match(client, /Wallet Issue reports must have been sent from the exact Current Cycle Submission before finalization/u);
  assert.doesNotMatch(`${client}\n${route}\n${service}`, /correction_incorrect/u);
});

test("Wall DTOs deliberately allowlist only the confirmed winner projection", async () => {
  const [readModel, types, fame, shame] = await Promise.all([
    source("lib/walls/getPublicWallPage.ts"),
    source("lib/walls/publicWallTypes.ts"),
    source("app/wall/fame/FameGrid.tsx"),
    source("app/wall/shame/ShameGrid.tsx"),
  ]);
  assert.match(types, /wallet_address: string \| null/u);
  assert.match(types, /claim_expired: boolean/u);
  assert.match(readModel, /process_due_winner_claim_transitions/u);
  assert.match(readModel, /getServerWriteGateMode\(\) === "open"/u);
  assert.match(readModel, /claim_expired: winner\.claim_expired === true/u);
  assert.match(readModel, /winner\.payout_choice === "keep" \|\| winner\.payout_choice === "split"[\s\S]*winner\.wallet_address/u);
  assert.match(fame, /active\.wallet_address[\s\S]*Confirmed winner recipient/u);
  assert.match(shame, /active\.wallet_address[\s\S]*Confirmed winner recipient/u);
  assert.match(fame, /active\.claim_expired[\s\S]*not claimed within the 24-hour window/u);
  assert.match(shame, /active\.claim_expired[\s\S]*not claimed within the 24-hour window/u);
  assert.match(fame, /winner\.claim_expired[\s\S]*Not claimed in time/u);
  assert.match(shame, /winner\.claim_expired[\s\S]*Not claimed in time/u);
  assert.doesNotMatch(`${readModel}\n${types}`, /winner_claims|winner_recipient_corrections|account_sol_profile_wallets/u);
});
