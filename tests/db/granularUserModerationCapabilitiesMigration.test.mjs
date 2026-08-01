import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260801000200_granular_user_moderation_capabilities.sql",
    import.meta.url
  ),
  "utf8"
);
const registry = await readFile(
  new URL("../../lib/auth/teamCapabilityRegistry.ts", import.meta.url),
  "utf8"
);
const banAction = await readFile(
  new URL("../../app/admin/actions/banUser.ts", import.meta.url),
  "utf8"
);
const unbanAction = await readFile(
  new URL("../../app/admin/actions/unbanUser.ts", import.meta.url),
  "utf8"
);

const capabilityKeys = [
  "users.directory.full.view",
  "users.upload_blocks.view",
  "users.website_bans.view",
  "users.website_bans.create",
  "users.website_bans.revoke",
  "logs.website_bans.view",
];

test("only real user moderation surfaces are registered and all start ungranted", () => {
  for (const key of capabilityKeys) {
    assert.match(migration, new RegExp(`'${key.replaceAll(".", "\\.")}'`, "u"));
    assert.match(registry, new RegExp(`"${key.replaceAll(".", "\\.")}"`, "u"));
  }
  assert.doesNotMatch(migration, /users\.upload_blocks\.(?:manage|unblock)/u);
  assert.doesNotMatch(registry, /users\.upload_blocks\.(?:manage|unblock)/u);
  assert.match(migration, /USER_MODERATION_NEW_CAPABILITIES_MUST_START_UNGRANTED/u);
  assert.match(migration, /if exists \(select 1 from public\.team_role_capabilities\)/u);
});

test("website ban mutations are versioned, idempotent, and append-only audited", () => {
  assert.match(migration, /add column website_ban_version bigint not null default 0/u);
  assert.match(migration, /create table public\.website_ban_events/u);
  assert.match(migration, /create table public\.website_ban_requests/u);
  assert.match(migration, /WEBSITE_BAN_HISTORY_APPEND_ONLY/u);
  assert.match(migration, /WEBSITE_BAN_STALE_VERSION/u);
  assert.match(migration, /WEBSITE_BAN_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /WEBSITE_BAN_TEAM_MEMBER_PROTECTED/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /for update/u);
});

test("manual ban and revocation actions require separate capabilities and hardened RPCs", () => {
  assert.match(banAction, /requireDynamicTeamCapability\(\s*"users\.website_bans\.create"/u);
  assert.match(banAction, /ban_website_user_v2/u);
  assert.match(unbanAction, /requireDynamicTeamCapability\(\s*"users\.website_bans\.revoke"/u);
  assert.match(unbanAction, /revoke_website_ban/u);
  assert.doesNotMatch(unbanAction, /\.from\("user_logs"\)\s*\.update/u);
});

test("privileged helpers remain private and only hardened mutation RPCs reach service_role", () => {
  for (const signature of [
    "protect_website_ban_history\\(\\)",
    "authorize_user_moderation_capability\\(text, text\\)",
    "apply_website_ban_contract\\(text, text, text, text\\)",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?service_role`, "u")
    );
  }
  assert.match(migration, /grant execute on function public\.ban_website_user_v2/u);
  assert.match(migration, /grant execute on function public\.revoke_website_ban/u);
});
