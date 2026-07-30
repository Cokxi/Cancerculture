import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260730000200_moderation_roles_and_capabilities.sql",
    import.meta.url
  ),
  "utf8"
);

test("the migration validates and atomically canonicalizes legacy roles", () => {
  assert.match(migration, /^begin;/);
  assert.match(migration, /commit;\s*$/);
  assert.match(
    migration,
    /where role not in \('admin', 'mod'\)/
  );
  assert.match(migration, /message = 'UNKNOWN_TEAM_MEMBER_ROLE'/);
  assert.match(
    migration,
    /set role = 'trial_moderator'\s+where role = 'mod'/
  );

  for (const role of [
    "trial_moderator",
    "moderator",
    "super_moderator",
    "admin",
  ]) {
    assert.match(migration, new RegExp(`'${role}'`));
  }
});

test("the atomic role RPC is invoker-security and service-role-only", () => {
  assert.match(
    migration,
    /create or replace function public\.set_team_member_role\(/
  );
  assert.match(migration, /security invoker/);
  assert.match(migration, /set search_path = public, pg_temp/);
  assert.match(
    migration,
    /owner to postgres/
  );
  assert.match(
    migration,
    /revoke all on function public\.set_team_member_role\(text, text, text, text\)\s+from public/
  );
  assert.match(
    migration,
    /revoke execute on function public\.set_team_member_role\(text, text, text, text\)\s+from anon, authenticated/
  );
  assert.match(
    migration,
    /grant execute on function public\.set_team_member_role\(text, text, text, text\)\s+to service_role/
  );
  assert.doesNotMatch(migration, /security definer/);
});

test("the RPC enforces actor, target, reason, last-admin, idempotency, and audit", () => {
  for (const marker of [
    "ACTOR_NOT_ADMIN",
    "TARGET_USER_NOT_FOUND",
    "REASON_REQUIRED",
    "INVALID_TEAM_ROLE",
    "LAST_ADMIN_PROTECTED",
  ]) {
    assert.match(migration, new RegExp(marker));
  }

  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /'changed', false/);
  assert.match(migration, /insert into public\.admin_action_logs/);
  assert.match(migration, /'previousRole'/);
  assert.match(migration, /'newRole'/);
  assert.match(migration, /'reason'/);
});

test("the migration does not broaden table, schema, or default privileges", () => {
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|insert|update|delete|all).*on\s+table/i
  );
  assert.doesNotMatch(migration, /grant\s+usage\s+on\s+schema/i);
  assert.doesNotMatch(migration, /alter\s+default\s+privileges/i);
  assert.doesNotMatch(
    migration,
    /grant\s+execute[\s\S]*to\s+(?:public|anon|authenticated)/i
  );
});
