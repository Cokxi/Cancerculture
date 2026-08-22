import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260822000500_wallet_issue_two_factor_self_service.sql",
    import.meta.url
  ),
  "utf8"
);

test("active 2FA is the fail-closed Wallet Issue self-service boundary", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /create or replace function public\.assert_own_wallet_issue_intake_open/u);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*'account-2fa:'/u);
  assert.match(migration, /from public\.account_totp_factors/u);
  assert.match(migration, /WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE/u);
  assert.doesNotMatch(
    migration.match(
      /create or replace function public\.assert_own_wallet_issue_intake_open[\s\S]*?\$function\$;/u
    )?.[0] ?? "",
    /account_sol_profile_wallets/u
  );
});

test("finalization suppresses stale held reports after 2FA activation", () => {
  const finalization = migration.match(
    /create or replace function public\.finalize_cycle_without_prize_pool[\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(finalization, /status = 'held'/u);
  assert.match(finalization, /account_totp_factors/u);
  assert.match(finalization, /status = 'not_relevant'/u);
  assert.match(finalization, /delete_after = v_finalized_at \+ interval '14 days'/u);
  assert.match(finalization, /v_claim_found[\s\S]*winner_claim_required/u);
  assert.match(finalization, /claim\.submission_id = v_intake\.submission_id/u);
  assert.match(finalization, /status = 'correction_pending'/u);
});

test("replaced RPCs preserve owner, fixed path, and service-role-only execution", () => {
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /alter function public\.assert_own_wallet_issue_intake_open\(uuid,bigint\)\s+owner to postgres/u);
  assert.match(migration, /alter function public\.finalize_cycle_without_prize_pool\(bigint,text\)\s+owner to postgres/u);
  assert.match(migration, /revoke all on function public\.assert_own_wallet_issue_intake_open\(uuid,bigint\)[\s\S]*service_role/u);
  assert.match(migration, /grant execute on function public\.assert_own_wallet_issue_intake_open\(uuid,bigint\) to service_role/u);
  assert.doesNotMatch(migration, /grant execute on function public\.finalize_cycle_without_prize_pool/u);
  assert.match(migration, /commit;\s*$/u);
});
