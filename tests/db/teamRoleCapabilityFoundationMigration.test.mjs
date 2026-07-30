import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260730000300_team_role_capability_foundation.sql",
    import.meta.url
  ),
  "utf8"
);

const capabilityDefinitions = [
  {
    key: "submissions.submission_phase.moderate",
    display_name: "Submission Phase Moderation",
    description:
      "Moderate submissions only during the currently permitted submission phase.",
    category: "Submission Moderation",
    included_actions: [
      "Disqualify submissions during the currently allowed submission phase.",
      "Reinstate submissions during the currently allowed submission phase.",
    ],
    excluded_actions: [
      "Voting-phase moderation.",
      "Vote refunds.",
      "Public visibility changes.",
      "Legal review.",
      "Finalized or archived cycles.",
    ],
    risk_level: "high",
    assignable_to_non_admin: true,
    implementation_version: 1,
  },
  {
    key: "users.flag",
    display_name: "Flag Users",
    description: "Internally flag a user for later review.",
    category: "User Moderation",
    included_actions: [
      "Internally mark a user for later review.",
    ],
    excluded_actions: [
      "Read flag details for other users.",
      "Review or resolve flags.",
      "Manage website bans.",
      "Apply any other sanction.",
    ],
    risk_level: "moderate",
    assignable_to_non_admin: true,
    implementation_version: 1,
  },
  {
    key: "users.directory.basic.view",
    display_name: "View Basic User Directory",
    description:
      "View the minimal redacted user directory used for selection and flagging.",
    category: "User Moderation",
    included_actions: [
      "View the minimal redacted user list used for selection and flagging.",
    ],
    excluded_actions: [
      "Full user histories.",
      "Flag reasons.",
      "Ban or unban reasons.",
      "Social, session, vote, wallet, or sync data.",
    ],
    risk_level: "low",
    assignable_to_non_admin: true,
    implementation_version: 1,
  },
];

const expectedHashes = new Map(
  capabilityDefinitions.map((definition) => [
    definition.key,
    createHash("sha256")
      .update(JSON.stringify(definition), "utf8")
      .digest("hex"),
  ])
);

test("the foundation migration is one bounded transaction with strict preflights", () => {
  assert.match(migration, /^begin;\s/);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /set local lock_timeout = '5s'/);
  assert.match(migration, /set local statement_timeout = '45s'/);
  assert.match(
    migration,
    /message = 'TEAM_AUTHORIZATION_FOUNDATION_ALREADY_EXISTS'/
  );
  assert.match(migration, /message = 'UNKNOWN_TEAM_MEMBER_ROLE'/);
  assert.match(
    migration,
    /message = 'UNKNOWN_SOCIAL_VERIFICATION_ACTOR_ROLE'/
  );
  assert.match(
    migration,
    /lock table public\.team_members in share row exclusive mode/
  );
});

test("the migration registers exactly the four canonical seed roles", () => {
  assert.match(migration, /create table public\.team_roles/);

  for (const [key, label] of [
    ["admin", "Admin"],
    ["trial_moderator", "Trial Moderator"],
    ["moderator", "Moderator"],
    ["super_moderator", "Super Moderator"],
  ]) {
    assert.match(
      migration,
      new RegExp(`'${key}',\\s*'${label}'`)
    );
  }

  assert.match(
    migration,
    /team_roles_admin_invariant_check[\s\S]*key <> 'admin'[\s\S]*is_system = true and is_active = true/
  );
  assert.match(
    migration,
    /team_roles_key_format_check[\s\S]*\^\[a-z\]\[a-z0-9_\]\{2,63\}\$/
  );
});

test("team members retain the role column and receive the restrictive foreign key", () => {
  assert.match(
    migration,
    /set role = 'trial_moderator'\s+where role = 'mod'/
  );
  assert.match(
    migration,
    /drop constraint team_members_role_check/
  );
  assert.match(
    migration,
    /add constraint team_members_role_fkey[\s\S]*foreign key \(role\)[\s\S]*references public\.team_roles\(key\)[\s\S]*on update restrict[\s\S]*on delete restrict/
  );
  assert.match(
    migration,
    /create index if not exists team_members_role_idx\s+on public\.team_members \(role\)/
  );
  assert.doesNotMatch(migration, /delete from public\.team_members/i);
});

test("only the three currently connected capability definitions are seeded", () => {
  assert.match(
    migration,
    /create table public\.capability_catalog/
  );

  for (const definition of capabilityDefinitions) {
    assert.match(migration, new RegExp(`'${definition.key}'`));
    assert.match(
      migration,
      new RegExp(`'${expectedHashes.get(definition.key)}'`)
    );
  }

  for (const forbiddenKey of [
    "submissions.voting.disqualify",
    "submissions.voting.reinstate",
    "votes.refund_disqualified",
    "cycles.manage",
    "winners.manage_payouts",
  ]) {
    assert.doesNotMatch(migration, new RegExp(forbiddenKey));
  }

  assert.match(
    migration,
    /risk_level in \('low', 'moderate', 'high', 'critical'\)/
  );
  assert.match(
    migration,
    /definition_hash ~ '\^\[0-9a-f\]\{64\}\$'/
  );
});

test("the grant table stores only positive non-admin grants", () => {
  assert.match(
    migration,
    /create table public\.team_role_capabilities/
  );
  assert.match(
    migration,
    /primary key \(role_key, capability_key\)/
  );
  assert.match(
    migration,
    /team_role_capabilities_non_admin_check\s+check \(role_key <> 'admin'\)/
  );
  assert.doesNotMatch(
    migration.match(
      /create table public\.team_role_capabilities[\s\S]*?\n\);/
    )?.[0] ?? "",
    /\benabled\b/
  );
  assert.match(
    migration,
    /'trial_moderator',\s*'moderator',\s*'super_moderator'/
  );
});

test("authorization audit and catalog records are protected by narrow triggers", () => {
  assert.match(
    migration,
    /create table public\.team_authorization_audit/
  );

  for (const eventType of [
    "role_created",
    "role_updated",
    "role_activated",
    "role_deactivated",
    "capability_granted",
    "capability_revoked",
    "member_role_changed",
    "admin_role_changed",
  ]) {
    assert.match(migration, new RegExp(`'${eventType}'`));
  }

  for (const functionName of [
    "protect_team_roles_foundation",
    "protect_capability_catalog_foundation",
    "protect_team_authorization_audit",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `create function public\\.${functionName}\\(\\)[\\s\\S]*security invoker[\\s\\S]*set search_path = public, pg_temp`
      )
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${functionName}\\(\\)[\\s\\S]*from public, anon, authenticated, discord_bot, service_role`
      )
    );
  }

  assert.doesNotMatch(migration, /security definer/i);
});

test("the social actor snapshot accepts dynamic role-key syntax without a role foreign key", () => {
  assert.match(
    migration,
    /drop constraint social_verification_logs_actor_role_check/
  );
  assert.match(
    migration,
    /add constraint social_verification_logs_actor_role_check[\s\S]*actor_role ~ '\^\[a-z\]\[a-z0-9_\]\{2,63\}\$'/
  );
  assert.doesNotMatch(
    migration,
    /foreign key \(actor_role\)[\s\S]*team_roles/
  );
});

test("all new tables are browser-inaccessible and service-role read-only", () => {
  for (const tableName of [
    "team_roles",
    "capability_catalog",
    "team_role_capabilities",
    "team_authorization_audit",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `alter table public\\.${tableName} enable row level security`
      )
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on table public\\.${tableName}[\\s\\S]*from public, anon, authenticated, discord_bot, service_role`
      )
    );
    assert.match(
      migration,
      new RegExp(
        `grant select on table public\\.${tableName} to service_role`
      )
    );
  }

  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|truncate|all).*service_role/i
  );
  assert.doesNotMatch(migration, /grant\s+usage\s+on\s+schema/i);
  assert.doesNotMatch(migration, /alter\s+default\s+privileges/i);
  assert.doesNotMatch(migration, /create\s+extension/i);
});
