import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260802000400_harden_public_schema_and_internal_function_acls.sql",
    import.meta.url,
  ),
  "utf8",
);

const internalSignatures = [
  "apply_discord_live_event",
  "audit_discord_sync_action",
  "claim_discord_membership_sync_event",
  "finish_discord_membership_sync_event",
  "enforce_discord_authenticated_action",
  "enforce_discord_ban_submissions",
  "enforce_discord_ban_submissions_trigger",
  "enforce_submission_upload_abuse_block",
  "protect_discord_ban_republish",
  "revoke_website_ban_sessions",
];

const outerSignatures = [
  "apply_discord_member_join_v2",
  "apply_discord_member_join",
  "apply_discord_member_remove",
  "apply_discord_ban",
  "apply_discord_unban",
  "begin_discord_reconciliation_snapshot",
  "append_discord_reconciliation_chunk",
  "finalize_discord_reconciliation_snapshot",
  "record_discord_reconciliation_failure",
  "get_cancerculture_session_access",
  "create_cancerculture_session",
];

test("the migration is additive, transactional, and excludes provider-owned defaults", () => {
  assert.match(migration, /^begin;/);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /set local lock_timeout = '5s'/);
  assert.match(migration, /set local statement_timeout = '30s'/);
  assert.doesNotMatch(migration, /alter default privileges for role supabase_admin/i);
  assert.doesNotMatch(migration, /create\s+(?:table|function|role)/i);
  assert.doesNotMatch(migration, /drop\s+(?:table|function|schema|role)/i);
  assert.doesNotMatch(migration, /scamguard/i);
});

test("the public schema and postgres defaults converge on the DEV contract", () => {
  assert.match(migration, /alter schema public owner to postgres/);
  assert.match(
    migration,
    /revoke all on schema public[\s\S]*from public, anon, authenticated, pg_database_owner,[\s\S]*service_role, discord_bot, postgres/,
  );
  assert.match(migration, /grant usage, create on schema public to postgres/);
  assert.match(
    migration,
    /grant usage on schema public to service_role, discord_bot/,
  );

  for (const objectType of ["tables", "sequences", "functions"]) {
    assert.match(
      migration,
      new RegExp(
        `alter default privileges for role postgres in schema public\\s+revoke all on ${objectType}`,
      ),
    );
  }

  assert.match(
    migration,
    /alter default privileges for role postgres in schema public\s+grant all on tables to service_role/,
  );
  assert.match(
    migration,
    /alter default privileges for role postgres in schema public\s+grant all on sequences to service_role/,
  );
  assert.doesNotMatch(
    migration,
    /alter default privileges[\s\S]*grant all on functions/i,
  );
});

test("all ten internal functions lose direct execution for non-owner roles", () => {
  assert.equal(internalSignatures.length, 10);

  for (const functionName of internalSignatures) {
    assert.match(
      migration,
      new RegExp(
        `revoke execute on function public\\.${functionName}\\([\\s\\S]*?\\)\\s+from public, anon, authenticated, service_role, discord_bot;`,
      ),
    );
  }

  assert.match(
    migration,
    /PUBLIC_ACL_INTERNAL_FUNCTION_POSTFLIGHT_MISMATCH/,
  );
});

test("the external Discord RPC and Bot contracts remain explicit", () => {
  assert.equal(outerSignatures.length, 11);

  for (const functionName of outerSignatures) {
    assert.match(
      migration,
      new RegExp(
        `grant execute on function public\\.${functionName}\\([\\s\\S]*?\\)\\s+to service_role;`,
      ),
    );
  }

  assert.match(
    migration,
    /grant execute on function public\.sync_discord_user_context\([\s\S]*?\) to service_role, discord_bot/,
  );
  assert.match(
    migration,
    /revoke all on table public\.discord_guard_logs from discord_bot;\s+grant insert on table public\.discord_guard_logs to discord_bot/,
  );
  assert.match(
    migration,
    /revoke all on sequence public\.discord_guard_logs_id_seq from discord_bot;\s+grant usage, select on sequence public\.discord_guard_logs_id_seq\s+to discord_bot/,
  );
});

test("preflight and postflight fail closed around owners, ACLs, and RLS", () => {
  for (const marker of [
    "PUBLIC_ACL_ROLE_BASELINE_MISMATCH",
    "PUBLIC_ACL_SCHEMA_BASELINE_MISMATCH",
    "PUBLIC_ACL_DEFAULT_PRIVILEGE_BASELINE_MISMATCH",
    "PUBLIC_ACL_FUNCTION_BASELINE_MISMATCH",
    "PUBLIC_ACL_DISCORD_GUARD_BASELINE_MISMATCH",
    "PUBLIC_ACL_SCHEMA_POSTFLIGHT_MISMATCH",
    "PUBLIC_ACL_DEFAULT_PRIVILEGE_POSTFLIGHT_MISMATCH",
    "PUBLIC_ACL_INTERNAL_FUNCTION_POSTFLIGHT_MISMATCH",
    "PUBLIC_ACL_OUTER_FUNCTION_POSTFLIGHT_MISMATCH",
    "PUBLIC_ACL_SYNC_FUNCTION_POSTFLIGHT_MISMATCH",
    "PUBLIC_ACL_DISCORD_GUARD_POSTFLIGHT_MISMATCH",
  ]) {
    assert.match(migration, new RegExp(marker));
  }

  assert.match(migration, /pg_get_userbyid\(p\.proowner\) = 'postgres'/);
  assert.match(migration, /p\.prosecdef/);
  assert.match(
    migration,
    /p\.proconfig = array\['search_path=public, pg_temp'\]::text\[\]/,
  );
  assert.match(migration, /relrowsecurity/);
  assert.match(migration, /discord_bot_insert_guard_logs/);
});
