import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Payouts, logs, mutations, evidence, and owner return Claims each enforce their exact server boundary", async () => {
  const [page, actions, logs, evidence, returns] = await Promise.all([
    source("app/admin/payouts/page.tsx"), source("app/admin/payouts/actions.ts"),
    source("app/admin/payout-logs/page.tsx"), source("app/api/admin/payout-evidence/[evidenceId]/route.ts"),
    source("app/api/account/payout-return-claims/[claimId]/route.ts"),
  ]);
  assert.match(page, /requireTeamCapabilityPage\("winners\.payouts\.view"/u);
  assert.match(actions, /requireDynamicTeamCapability\("winners\.manage_payouts"\)/u);
  assert.match(logs, /requireTeamCapabilityPage\("winners\.payout_logs\.view"/u);
  assert.match(evidence, /requireDynamicTeamCapability\("winners\.manage_payouts"\)/u);
  assert.match(returns, /requireSession\(\)/u); assert.doesNotMatch(returns, /requireDynamicTeamCapability/u);
});

test("Prepare and transaction recording derive identity, recipient, and amount from canonical server context", async () => {
  const [actions, service] = await Promise.all([source("app/admin/payouts/actions.ts"), source("lib/payouts/service.server.ts")]);
  assert.match(actions, /preparePayoutPlan[\s\S]*allocationPublicId[\s\S]*expectedClaimVersion/u);
  assert.doesNotMatch(actions, /formData, "(?:winner|user|discord_user_id|amount_lamports|winner_recipient)"/u);
  assert.match(actions, /getTeamPayoutContext[\s\S]*line\.recipient[\s\S]*line\.amountLamports/u);
  assert.match(actions, /verifyMainnetPayoutTransaction/u);
  assert.match(service, /p_allocation_public_id[\s\S]*p_expected_claim_version/u);
  assert.doesNotMatch(service, /p_winner_discord_user_id|p_winner_amount/u);
});

test("HUD, private evidence, and media profiles disclose only their bounded projections", async () => {
  const [hud, migration, profiles, evidenceRoute] = await Promise.all([
    source("app/components/CycleHud.tsx"), source("supabase/migrations/20260821000300_cycle_prize_pool_payouts_and_logs.sql"),
    source("lib/media/profiles.ts"), source("app/api/admin/payout-evidence/[evidenceId]/route.ts"),
  ]);
  assert.match(hud, /prizePool\.totalLamports[\s\S]*Prize Pool/u);
  assert.doesNotMatch(hud, /amount pending|TBA/u);
  assert.match(profiles, /PAYOUT_EVIDENCE_MEDIA_PROFILE[\s\S]*maxInputBytes: 3_000_000[\s\S]*stripMetadata: true/u);
  assert.match(evidenceRoute, /R2_PAYOUT_EVIDENCE_BUCKET_NAME/u); assert.match(evidenceRoute, /private, no-store/u);
  assert.match(migration, /p_include_management[\s\S]*'recipient'/u);
  assert.doesNotMatch(migration.slice(migration.indexOf("create function public.get_current_cycle_prize_pool"), migration.indexOf("create function public.get_team_payout_context")), /winner_recipient|discord_user_id|r2_key/u);
});

test("simple payout UI accepts multiple verified transfers without a recipient override", async () => {
  const [manager, route, service, publicDetails] = await Promise.all([
    source("app/admin/payouts/PayoutManager.tsx"),
    source("app/api/admin/payouts/[allocationId]/publish/route.ts"),
    source("lib/payouts/service.server.ts"),
    source("app/components/payouts/PublicPayoutDetails.tsx"),
  ]);
  assert.match(manager, /Add another winner transaction/u);
  assert.match(manager, /Add another donation transaction/u);
  assert.match(manager, /Still due/u);
  assert.match(manager, /Publish the actual higher amount as an overpayment/u);
  assert.match(route, /inspectMainnetPayoutTransaction/u);
  assert.match(route, /new Set\(signatures\)\.size/u);
  assert.match(route, /expectedRecipient/u);
  assert.doesNotMatch(route, /recipientOverride|skipVerification|adminOverride/u);
  assert.match(service, /complete_and_publish_payout_v2/u);
  assert.match(publicDetails, /winnerTransactions/u);
  assert.match(publicDetails, /donationTransactions/u);
});
