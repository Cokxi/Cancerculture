import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260817000100_submission_profile_wallet_binding.sql",
    import.meta.url
  ),
  "utf8"
);

const reserve = migration.slice(
  migration.indexOf("create function public.reserve_submission_upload"),
  migration.indexOf("drop function public.commit_submission_upload")
);
const commit = migration.slice(
  migration.indexOf("create function public.commit_submission_upload"),
  migration.indexOf("alter function public.get_completed_submission_upload_operation")
);

test("migration is additive and fails closed on an unexpected or active baseline", () => {
  assert.match(migration, /SUBMISSION_PROFILE_WALLET_BINDING_BASELINE_MISMATCH/u);
  assert.match(migration, /operation\.status in \('reserved', 'r2_uploaded'\)/u);
  assert.match(migration, /add column wallet_source text/u);
  assert.match(migration, /add column wallet_address text/u);
  assert.match(migration, /add column profile_wallet_version bigint/u);
  assert.doesNotMatch(migration, /drop table|truncate table|delete from public\./iu);
});

test("reserve binds canonical manual or server-resolved Profile Wallet data before R2", () => {
  assert.match(reserve, /public\.is_valid_sol_recipient_address\(v_manual_wallet_address\)/u);
  assert.match(reserve, /'account-2fa:' \|\| v_discord_user_id/u);
  assert.match(reserve, /'sol-profile-wallet:' \|\| v_discord_user_id/u);
  assert.match(reserve, /from public\.account_totp_factors/u);
  assert.match(reserve, /from public\.account_sol_profile_wallets wallet[\s\S]*for update/u);
  assert.match(reserve, /v_profile_wallet\.version <> p_profile_wallet_version/u);
  assert.match(reserve, /return jsonb_build_object\('outcome', 'profile_wallet_stale'\)/u);
  assert.match(reserve, /wallet_address = v_bound_wallet_address/u);
  assert.match(reserve, /profile_wallet_version = v_bound_profile_wallet_version/u);
});

test("same-key replay returns the frozen operation before current Profile Wallet resolution", () => {
  const replay = reserve.indexOf("if v_operation.status in ('reserved', 'r2_uploaded')");
  const profileLock = reserve.indexOf("'account-2fa:' || v_discord_user_id");
  assert.ok(replay > -1 && replay < profileLock);
  assert.match(reserve, /'storageKey', v_operation\.storage_key/u);
  assert.match(reserve, /'r2Uploaded', v_operation\.status = 'r2_uploaded'/u);
  assert.match(reserve, /v_operation\.request_fingerprint <> p_request_fingerprint/u);
});

test("commit accepts no payout or wallet input and copies only the reservation snapshot", () => {
  assert.match(
    migration,
    /create function public\.commit_submission_upload\(\s*p_operation_id uuid,\s*p_session_id uuid,\s*p_media_width integer,\s*p_media_height integer/u
  );
  assert.doesNotMatch(commit, /p_wallet_address|p_wallet_source|p_payout_choice|p_charity/u);
  assert.match(commit, /v_operation\.wallet_address/u);
  assert.match(commit, /v_operation\.payout_choice/u);
  assert.match(commit, /v_operation\.split_percent/u);
  assert.match(commit, /v_operation\.charity/u);
});

test("operation and Submission constraints enforce one canonical private recipient", () => {
  assert.match(migration, /submission_upload_operations_private_binding_check/u);
  assert.match(migration, /submission_private_data_sol_recipient_contract_check/u);
  assert.match(migration, /public\.is_valid_sol_recipient_address\(wallet_address\)/u);
  assert.match(migration, /payout_choice = 'donate'[\s\S]*wallet_address = ''/u);
  assert.match(migration, /payout_choice = 'split'[\s\S]*split_percent between 1 and 99/u);
});

test("RPCs are owner-fixed, service-only, no-overload, and direct ledgers are closed", () => {
  assert.match(migration, /owner to postgres/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(migration, /SUBMISSION_PROFILE_WALLET_BINDING_FUNCTION_SECURITY_MISMATCH/u);
  assert.match(migration, /SUBMISSION_PROFILE_WALLET_BINDING_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(migration, /SUBMISSION_PROFILE_WALLET_BINDING_TABLE_ACL_MISMATCH/u);
  assert.match(
    migration,
    /revoke all on table public\.submission_upload_operations[\s\S]*service_role/u
  );
  assert.match(
    migration,
    /revoke insert, update, delete on table public\.submission_private_data[\s\S]*service_role/u
  );
});
