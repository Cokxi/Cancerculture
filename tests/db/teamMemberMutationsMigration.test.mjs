import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const migrationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260731000100_team_member_mutations.sql"
);
const foundationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260730000300_team_role_capability_foundation.sql"
);
const mutationLayerPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260730000400_team_authorization_mutations.sql"
);
const [migration, foundation, mutationLayer] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(foundationPath),
  readFile(mutationLayerPath),
]);

const functions = [
  {
    name: "add_team_member",
    signature: "text, text, text, boolean, text, uuid",
  },
  {
    name: "remove_team_member",
    signature: "text, text, text, text, uuid",
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("the member mutation migration is additive and pins both predecessors", () => {
  assert.equal(
    createHash("sha256").update(foundation).digest("hex"),
    "f3a1f2ee24abbbad98aaf8eb9a53a0931c957791d0427344105dd74aa0693bc9"
  );
  assert.equal(
    createHash("sha256").update(mutationLayer).digest("hex"),
    "6f4beb015b80756413c3dd1df4d7dc1f51cb90dc902cc937b937f6c7d1cee582"
  );
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(
    migration,
    /set local statement_timeout = '45s'/u
  );
  assert.doesNotMatch(migration, /\bcreate\s+table\b/iu);
  assert.doesNotMatch(migration, /\bdrop\s+table\b/iu);
  assert.doesNotMatch(migration, /\bcreate\s+extension\b/iu);
  assert.doesNotMatch(migration, /\bexecute\s+format\s*\(/iu);
  assert.doesNotMatch(
    migration,
    /\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.team_role_capabilities\b/iu
  );
});

test("the audit contract adds only member add and remove events", () => {
  for (const eventType of [
    "role_created",
    "role_updated",
    "role_activated",
    "role_deactivated",
    "capability_granted",
    "capability_revoked",
    "member_role_changed",
    "admin_role_changed",
    "member_added",
    "member_removed",
  ]) {
    assert.match(migration, new RegExp(`'${eventType}'`, "u"));
  }

  assert.equal(
    migration.match(/'member_added'/gu)?.length,
    4
  );
  assert.equal(
    migration.match(/'member_removed'/gu)?.length,
    4
  );
  assert.match(
    migration,
    /drop constraint team_authorization_audit_event_type_check[\s\S]*add constraint team_authorization_audit_event_type_check[\s\S]*validate constraint team_authorization_audit_event_type_check/u
  );
  assert.match(
    migration,
    /drop constraint team_authorization_audit_target_check[\s\S]*add constraint team_authorization_audit_target_check[\s\S]*validate constraint team_authorization_audit_target_check/u
  );
  assert.doesNotMatch(
    migration,
    /create\s+trigger|drop\s+trigger|disable\s+trigger/iu
  );
});

test("both exact RPC signatures are security-definer and service-role only", () => {
  for (const entry of functions) {
    const name = escapeRegExp(entry.name);
    const signature = escapeRegExp(entry.signature).replaceAll(
      ", ",
      ",\\s*"
    );

    assert.match(
      migration,
      new RegExp(
        `create function public\\.${name}\\([\\s\\S]*?\\)\\s*returns jsonb\\s*language plpgsql\\s*security definer\\s*set search_path = public, pg_temp`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `alter function public\\.${name}\\(\\s*${signature}\\s*\\) owner to postgres`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${name}\\([\\s\\S]*?\\) from public, anon, authenticated, discord_bot, service_role`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `grant execute on function public\\.${name}\\([\\s\\S]*?\\) to service_role`,
        "u"
      )
    );
  }

  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|truncate|all)\s+on\s+table/iu
  );
  assert.doesNotMatch(
    migration,
    /grant\s+select\s+on\s+table/iu
  );
});

test("add requires a known identity, absent membership, and an active non-admin role", () => {
  assert.match(
    migration,
    /from public\.user_logs[\s\S]*where discord_user_id = v_target_id[\s\S]*for key share/u
  );
  assert.match(
    migration,
    /from public\.discord_member_state[\s\S]*where discord_user_id = v_target_id[\s\S]*for key share/u
  );
  assert.match(migration, /TARGET_IDENTITY_UNKNOWN/u);
  assert.match(migration, /TEAM_MEMBER_EXPECTED_ABSENT_REQUIRED/u);
  assert.match(migration, /TEAM_MEMBER_ALREADY_EXISTS/u);
  assert.match(migration, /ADMIN_ROLE_REQUIRES_OWNER_RPC/u);
  assert.match(migration, /TEAM_ROLE_NOT_FOUND/u);
  assert.match(migration, /TEAM_ROLE_INACTIVE/u);
  assert.match(
    migration,
    /insert into public\.team_members \([\s\S]*?discord_user_id,[\s\S]*?discord_username,[\s\S]*?role[\s\S]*?\);/u
  );
  assert.doesNotMatch(
    migration,
    /p_target_discord_username|p_discord_username/u
  );
});

test("remove is physical, non-admin only, and stale-state protected", () => {
  assert.match(
    migration,
    /select role[\s\S]*from public\.team_members[\s\S]*where discord_user_id = v_target_id[\s\S]*for update/u
  );
  assert.match(migration, /ADMIN_MEMBER_REMOVE_FORBIDDEN/u);
  assert.match(migration, /TEAM_MEMBER_NOT_FOUND/u);
  assert.match(migration, /TEAM_MEMBER_ROLE_CONFLICT/u);
  assert.match(
    migration,
    /delete from public\.team_members\s+where discord_user_id = v_target_id/u
  );
  assert.doesNotMatch(
    migration,
    /soft_delete|deleted_at|is_removed|is_active\s*=\s*false/iu
  );
});

test("idempotency, actor authorization, locks, and audit are all-or-nothing", () => {
  assert.equal(
    migration.match(
      /hashtextextended\(p_idempotency_key::text, 0\)/gu
    )?.length,
    2
  );
  assert.equal(
    migration.match(
      /'public\.team_authorization\.mutations'/gu
    )?.length,
    2
  );
  assert.equal(
    migration.match(
      /'public\.team_authorization\.member:' \|\| v_target_id/gu
    )?.length,
    2
  );
  assert.equal(
    migration.match(
      /where discord_user_id = v_actor_id\s+for update/gu
    )?.length,
    2
  );
  assert.equal(
    migration.match(/TEAM_AUTH_IDEMPOTENCY_CONFLICT/gu)?.length,
    2
  );
  assert.equal(
    migration.match(
      /extensions\.digest\([\s\S]*?'sha256'[\s\S]*?\)/gu
    )?.length,
    2
  );
  assert.match(
    migration,
    /v_existing_event = 'member_added'[\s\S]*return v_existing_result/u
  );
  assert.match(
    migration,
    /v_existing_event = 'member_removed'[\s\S]*return v_existing_result/u
  );
  assert.equal(
    migration.match(
      /insert into public\.team_authorization_audit/gu
    )?.length,
    2
  );
  assert.doesNotMatch(
    migration,
    /exception[\s\S]{0,120}when others[\s\S]{0,120}null/iu
  );
});

test("no capability, UI, invitation, or member-grant surface is introduced", () => {
  for (const capabilityKey of [
    "submissions.submission_phase.moderate",
    "users.flag",
    "users.directory.basic.view",
  ]) {
    assert.doesNotMatch(migration, new RegExp(capabilityKey, "u"));
  }
  assert.doesNotMatch(
    migration,
    /invitation|invite|member_capabilit|server action|\/admin\//iu
  );
});
