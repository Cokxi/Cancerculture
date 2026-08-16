import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, service, ui, securityPage, myProfilePage, publicProfile, publicDto, totpFoundation] = await Promise.all([
  readFile(new URL("../../app/api/account/sol-wallet/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/solana/profileWallet.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/auth/SolProfileWalletSettings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/settings/security/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/my-profile/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../lib/profile/getPublicUserProfileData.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/feed/communityFeedReadModel.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../supabase/migrations/20260816000100_account_totp_two_factor_foundation.sql", import.meta.url), "utf8"),
]);

test("owner GET and PUT are session-gated, dynamic, no-store, and service-RPC-only", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /getSolProfileWallet\(await requireSession\(\)\)/u);
  assert.match(route, /session: await requireSession\(\)/u);
  assert.match(route, /readTwoFactorJson\(request\)/u);
  assert.match(route, /twoFactorJson/u);
  assert.match(route, /enforceRouteMutationGate/u);
  assert.match(service, /get_account_sol_profile_wallet/u);
  assert.match(service, /change_account_sol_profile_wallet/u);
  assert.doesNotMatch(service, /\.from\(|account_sol_profile_wallets/u);
  assert.doesNotMatch(route, /walletAddress|console\.(?:log|info)/u);
});

test("client and server import the same canonical validator", () => {
  assert.match(ui, /import \{ validateSolRecipientAddress \} from "@\/lib\/solana\/address"/u);
  assert.match(service, /import \{ validateSolRecipientAddress \} from "@\/lib\/solana\/address"/u);
  assert.match(service, /validation\?\.ok === true \? validation\.address/u);
});

test("wallet UI is private, TOTP-gated, deliberate, idempotent, and payout-neutral", () => {
  assert.match(myProfilePage, /<SolProfileWalletSettings/u);
  assert.doesNotMatch(securityPage, /SolProfileWalletSettings/u);
  assert.match(ui, /My Solana Wallet/u);
  assert.match(ui, /You can save or change your wallet only with two-factor/u);
  assert.match(ui, /status\.walletAddress \? "Change wallet" : "Add wallet"/u);
  assert.match(ui, /\{mode \? \([\s\S]*sol-wallet-step-up-code/u);
  assert.match(ui, /purpose: "sol_wallet_change"/u);
  assert.match(ui, /crypto\.randomUUID\(\)/u);
  assert.match(ui, /Retry same operation/u);
  assert.match(ui, /REMOVE SOL PROFILE WALLET/u);
  assert.match(ui, /does not[\s\S]*alter Submission data/u);
  assert.doesNotMatch(ui, /chain selector|wallet adapter|treasury|lamport|transaction signature/iu);
});

test("public profile and feed projections have no Profile Wallet dependency", () => {
  for (const projection of [publicProfile, publicDto]) {
    assert.doesNotMatch(
      projection,
      /account_sol_profile_wallet|SolProfileWallet|private-sol-wallet/iu
    );
  }
});

test("factor changes, recovery, deactivation, and session revocation invalidate unused grants", () => {
  const activation = totpFoundation.slice(
    totpFoundation.indexOf("create function public.activate_account_totp_enrollment"),
    totpFoundation.indexOf("create function public.record_account_totp_failure")
  );
  const deactivation = totpFoundation.slice(
    totpFoundation.indexOf("create function public.deactivate_account_totp_factor"),
    totpFoundation.indexOf("create function public.begin_account_recovery_email_change")
  );
  const consume = totpFoundation.slice(
    totpFoundation.indexOf("create function public.account_consume_step_up"),
    totpFoundation.indexOf("create function public.get_account_two_factor_status")
  );
  assert.match(activation, /delete from public\.account_step_up_grants/u);
  assert.match(activation, /intent = 'email_recovery'[\s\S]*update public\.sessions/u);
  assert.match(deactivation, /delete from public\.account_totp_factors/u);
  assert.match(consume, /session_id = p_session_id/u);
  assert.match(totpFoundation, /session_id uuid not null references public\.sessions\(id\) on delete cascade/u);
});
