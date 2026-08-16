import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migration = await readFile(
  new URL("../../supabase/migrations/20260816000300_team_area_totp_access_grants.sql", import.meta.url),
  "utf8"
);

test("Team grants are opaque, factor/session bound, exactly 12 hours, and private", () => {
  assert.match(migration, /create table public[.]account_team_access_grants/u);
  assert.match(migration, /token_digest text not null unique/u);
  assert.match(migration, /context_digest text not null/u);
  assert.match(migration, /expires_at = issued_at \+ interval '12 hours'/u);
  assert.match(migration, /session_id uuid not null unique[\s\S]*references public[.]sessions\(id\) on delete cascade/u);
  assert.match(migration, /factor_id uuid not null[\s\S]*references public[.]account_totp_factors\(id\) on delete cascade/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /revoke all on table public[.]account_team_access_grants/u);
  assert.doesNotMatch(migration, /\b(?:ip_address|user_agent|device_id|fingerprint|browser_history)\b/iu);
});

test("grant consumes a replay-safe TOTP and rotates the website session atomically", () => {
  const grant = migration.slice(migration.indexOf("create function public.grant_account_team_access"));
  assert.match(grant, /role[.]is_active/u);
  assert.match(grant, /p_accepted_step <= v_factor[.]last_accepted_step/u);
  assert.match(grant, /account_totp_register_failure/u);
  assert.match(grant, /last_accepted_step = p_accepted_step/u);
  assert.match(grant, /insert into public[.]sessions/u);
  assert.match(grant, /update public[.]sessions[\s\S]*set revoked_at = v_now[\s\S]*where id = p_session_id/u);
  assert.match(grant, /team_access_granted/u);
});

test("verification fails closed on expiry, membership, factor, token, and context changes", () => {
  const verify = migration.slice(
    migration.indexOf("create function public.verify_account_team_access"),
    migration.indexOf("create function public.grant_account_team_access")
  );
  assert.match(verify, /delete from public[.]account_team_access_grants[\s\S]*expires_at <= v_now/u);
  assert.match(verify, /role[.]is_active/u);
  assert.match(verify, /account_totp_factors/u);
  assert.match(verify, /grant_row[.]token_digest = p_token_digest/u);
  assert.match(verify, /v_grant[.]context_digest <> p_context_digest/u);
  assert.match(verify, /team_access_context_changed/u);
});

test("session revocation and factor replacement remove grants without device history", () => {
  assert.match(migration, /sessions_delete_team_access_on_revocation/u);
  assert.match(migration, /delete_account_team_access_on_session_revocation/u);
  assert.doesNotMatch(migration, /insert into public[.]account_two_factor_audit[\s\S]{0,300}context_digest/u);
});
