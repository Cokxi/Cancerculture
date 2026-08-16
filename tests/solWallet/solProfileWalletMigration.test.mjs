import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260816000400_account_sol_profile_wallet.sql",
    import.meta.url
  ),
  "utf8"
);

const mutation = migration.slice(
  migration.indexOf("create function public.change_account_sol_profile_wallet"),
  migration.indexOf("alter table public.account_sol_profile_wallets owner")
);

test("migration is additive, fail-closed, and creates only the private wallet contract", () => {
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_BASELINE_MISMATCH/u);
  assert.match(migration, /to_regclass\('public\.account_sol_profile_wallets'\) is not null/u);
  assert.match(migration, /to_regclass\('public\.account_totp_factors'\) is null/u);
  assert.match(migration, /pg_get_constraintdef\(c\.oid\) like '%sol_wallet_change%'/u);
  assert.match(migration, /create table public\.account_sol_profile_wallets/u);
  assert.match(migration, /create table public\.account_sol_profile_wallet_audit/u);
  assert.doesNotMatch(migration, /drop table|truncate table|submission_private_data|winner|payout|lamport/iu);
});

test("wallet address validation is canonical on the database boundary", () => {
  const validator = migration.slice(
    migration.indexOf("create function public.is_valid_sol_recipient_address"),
    migration.indexOf("create table public.account_sol_profile_wallets")
  );
  assert.match(validator, /length\(p_address\) not between 32 and 44/u);
  assert.match(validator, /\^\[1-9A-HJ-NP-Za-km-z\]\+\$/u);
  assert.match(validator, /v_bytes\[v_byte_index\] \* 58/u);
  assert.match(validator, /v_leading_zeroes \+ v_significant_length = 32/u);
  assert.match(validator, /p_address <> repeat\('1', 32\)/u);
  assert.match(migration, /account_sol_profile_wallet_address_check[\s\S]*is_valid_sol_recipient_address/u);
});

test("one atomic RPC consumes the exact step-up and serializes optimistic changes", () => {
  const idempotency = mutation.indexOf("from public.account_sol_profile_wallet_audit");
  const consume = mutation.indexOf("perform public.account_consume_step_up");
  const walletWrite = mutation.indexOf("insert into public.account_sol_profile_wallets");
  const auditWrite = mutation.indexOf("insert into public.account_sol_profile_wallet_audit");
  assert.ok(idempotency > -1 && idempotency < consume);
  assert.ok(consume > -1 && consume < walletWrite);
  assert.ok(walletWrite > -1 && walletWrite < auditWrite);
  assert.match(mutation, /pg_advisory_xact_lock/u);
  assert.match(mutation, /'sol_wallet_change'/u);
  assert.match(mutation, /p_expected_version <> v_current_version/u);
  assert.match(mutation, /v_reason := 'stale_version'/u);
  assert.match(mutation, /v_reason := 'no_change'/u);
  assert.match(mutation, /v_reason := 'address_invalid'/u);
  assert.match(mutation, /idempotentReplay', true/u);
  assert.match(mutation, /v_audit\.session_id <> p_session_id/u);
});

test("domain rejections consume the grant and commit a bounded redacted result", () => {
  const consume = mutation.indexOf("perform public.account_consume_step_up");
  for (const reason of [
    "membership_pending",
    "not_member",
    "stale_version",
    "address_invalid",
    "no_change",
  ]) {
    assert.ok(mutation.indexOf(`v_reason := '${reason}'`) > consume);
  }
  const auditTable = migration.slice(
    migration.indexOf("create table public.account_sol_profile_wallet_audit"),
    migration.indexOf("create index account_sol_profile_wallet_audit_user_idx")
  );
  assert.match(auditTable, /action text not null/u);
  assert.match(auditTable, /outcome text not null/u);
  assert.match(auditTable, /reason text not null/u);
  assert.match(auditTable, /unique \(discord_user_id, request_id\)/u);
  assert.doesNotMatch(
    auditTable,
    /wallet_address|email|totp|recovery|ip_address|user_agent|metadata|free_text/iu
  );
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_AUDIT_IS_APPEND_ONLY/u);
});

test("RLS, table ACLs, function ownership, fixed search paths, and overloads are checked", () => {
  for (const table of [
    "account_sol_profile_wallets",
    "account_sol_profile_wallet_audit",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table}`, "u"));
    assert.match(migration, new RegExp(`alter table public\\.${table} owner to postgres`, "u"));
  }
  for (const signature of [
    "get_account_sol_profile_wallet(uuid)",
    "change_account_sol_profile_wallet(uuid,uuid,bigint,text)",
  ]) {
    assert.ok(migration.includes(`alter function public.${signature} owner to postgres`));
    assert.ok(migration.includes(`grant execute on function public.${signature}`));
  }
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_FUNCTION_SECURITY_MISMATCH/u);
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_INTERNAL_FUNCTION_SECURITY_MISMATCH/u);
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_TABLE_ACL_MISMATCH/u);
  assert.match(migration, /ACCOUNT_SOL_PROFILE_WALLET_RLS_MISMATCH/u);
  assert.match(migration, /revoke all on sequence public\.account_sol_profile_wallet_audit_id_seq/u);
});
