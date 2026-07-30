import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
  "20260730000400_team_authorization_mutations.sql"
);
const foundationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260730000300_team_role_capability_foundation.sql"
);
const migration = await readFile(migrationPath, "utf8");
const foundation = await readFile(foundationPath);

const functions = [
  {
    name: "create_team_role",
    signature: "text, text, text, integer, text, uuid",
  },
  {
    name: "update_team_role",
    signature:
      "text, text, text, text, integer, bigint, text, uuid",
  },
  {
    name: "set_team_role_active",
    signature: "text, text, boolean, bigint, text, uuid",
  },
  {
    name: "set_team_role_capability",
    signature:
      "text, text, text, boolean, bigint, integer, text, text, uuid",
  },
  {
    name: "set_team_member_non_admin_role",
    signature: "text, text, text, text, text, uuid",
  },
  {
    name: "set_team_member_admin_role",
    signature: "text, text, boolean, text, text, text, uuid",
  },
  {
    name: "set_team_member_role",
    signature: "text, text, text, text",
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("the migration is additive, bounded, and foundation-pinned", () => {
  assert.equal(
    createHash("sha256").update(foundation).digest("hex"),
    "f3a1f2ee24abbbad98aaf8eb9a53a0931c957791d0427344105dd74aa0693bc9"
  );
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(
    migration,
    /set local statement_timeout = '45s'/u
  );
  assert.match(
    migration,
    /message = 'TEAM_AUTHORIZATION_AUDIT_NOT_EMPTY'/u
  );
  assert.doesNotMatch(migration, /\bcreate\s+table\b/iu);
  assert.doesNotMatch(migration, /\bdrop\s+table\b/iu);
  assert.doesNotMatch(
    migration,
    /\balter\s+default\s+privileges\b/iu
  );
  assert.doesNotMatch(
    migration,
    /\bgrant\s+usage\s+on\s+schema\b/iu
  );
  assert.doesNotMatch(migration, /\bcreate\s+extension\b/iu);
  assert.doesNotMatch(migration, /\bexecute\s+format\s*\(/iu);
});

test("the audit fingerprint is mandatory, constrained, and documented", () => {
  assert.match(
    migration,
    /add column request_hash text not null/u
  );
  assert.match(
    migration,
    /team_authorization_audit_request_hash_check\s+check \(request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/u
  );
  assert.match(
    migration,
    /jsonb_build_object\(\.\.\. \)::text after input normalization/u
  );
  assert.match(
    migration,
    /extensions\.digest\([\s\S]*?'sha256'[\s\S]*?\)/u
  );
  assert.match(
    migration,
    /hashtextextended\(p_idempotency_key::text, 0\)/u
  );
  assert.match(
    migration,
    /TEAM_AUTH_IDEMPOTENCY_CONFLICT/u
  );
  for (const operation of [
    "create_team_role",
    "update_team_role",
    "set_team_role_active",
    "set_team_role_capability",
    "set_team_member_non_admin_role",
    "set_team_member_admin_role",
    "set_team_member_role_compatibility",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `v_payload := jsonb_build_object\\([\\s\\S]*?'operation', '${operation}'[\\s\\S]*?'reason', v_reason[\\s\\S]*?\\);`,
        "u"
      )
    );
  }
  assert.equal(
    migration.match(
      /v_reason is null\s+or char_length\(v_reason\) not between 3 and 1000/gu
    )?.length,
    7
  );
  assert.match(
    migration,
    /v_expected_hash is null\s+or v_expected_hash !~ '\^\[0-9a-f\]\{64\}\$'/u
  );
});

test("every mutation RPC has the exact allowlisted signature and hardening", () => {
  for (const entry of functions) {
    const escapedName = escapeRegExp(entry.name);
    const escapedSignature = escapeRegExp(entry.signature);
    const createPattern =
      entry.name === "set_team_member_role"
        ? "create or replace"
        : "create";

    assert.match(
      migration,
      new RegExp(
        `${createPattern} function public\\.${escapedName}\\([\\s\\S]*?\\)\\s*returns jsonb\\s*language plpgsql\\s*security definer\\s*set search_path = public, pg_temp`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `alter function public\\.${escapedName}\\(\\s*${escapedSignature.replaceAll(
          ", ",
          ",\\s*"
        )}\\s*\\) owner to postgres`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${escapedName}\\([\\s\\S]*?\\) from public, anon, authenticated, discord_bot, service_role`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `grant execute on function public\\.${escapedName}\\([\\s\\S]*?\\) to service_role`,
        "u"
      )
    );
  }
});

test("role, capability, member, and admin invariants are enforced in SQL", () => {
  assert.match(
    migration,
    /'custom_' \|\| replace\(p_idempotency_key::text, '-', ''\)/u
  );
  assert.match(migration, /ADMIN_ROLE_IMMUTABLE/u);
  assert.match(migration, /ADMIN_CAPABILITY_GRANT_FORBIDDEN/u);
  assert.match(migration, /CAPABILITY_DEFINITION_CONFLICT/u);
  assert.match(migration, /CAPABILITY_NOT_ASSIGNABLE/u);
  assert.match(migration, /CAPABILITY_INACTIVE/u);
  assert.match(migration, /TEAM_ROLE_HAS_ASSIGNED_MEMBERS/u);
  assert.match(migration, /ADMIN_ROLE_REQUIRES_OWNER_RPC/u);
  assert.match(migration, /ADMIN_SELF_DEMOTION_FORBIDDEN/u);
  assert.match(migration, /LAST_ADMIN_PROTECTED/u);
  assert.match(
    migration,
    /public\.team_authorization\.admin_population/u
  );
  assert.match(
    migration,
    /where discord_user_id = v_target_id\s+for update/gu
  );
  const grantInsert =
    migration.match(
      /insert into public\.team_role_capabilities \([\s\S]*?\n    \);/u
    )?.[0] ?? "";
  assert.notEqual(grantInsert, "");
  assert.doesNotMatch(grantInsert, /'admin'/u);
});

test("real mutations are versioned and atomically audited", () => {
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
    assert.match(migration, new RegExp(`'${eventType}'`, "u"));
  }

  assert.match(
    migration,
    /row_version = row_version \+ 1/gu
  );
  assert.match(migration, /TEAM_ROLE_VERSION_CONFLICT/u);
  assert.match(
    migration,
    /insert into public\.team_authorization_audit/gu
  );
  assert.doesNotMatch(
    migration,
    /exception[\s\S]{0,120}when others[\s\S]{0,120}null/iu
  );
});

test("table privileges remain browser-denied and service-role read-only", () => {
  for (const tableName of [
    "team_roles",
    "capability_catalog",
    "team_role_capabilities",
    "team_authorization_audit",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke all on table public\\.${tableName}\\s+from public, anon, authenticated, discord_bot, service_role`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `grant select on table public\\.${tableName} to service_role`,
        "u"
      )
    );
  }

  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|truncate|all)[^;]*service_role/iu
  );
});

test("the legacy four-text jsonb RPC remains a deprecated compatibility wrapper", () => {
  assert.match(
    migration,
    /create or replace function public\.set_team_member_role\([\s\S]*?p_actor_discord_user_id text,[\s\S]*?p_target_discord_user_id text,[\s\S]*?p_new_role text,[\s\S]*?p_reason text[\s\S]*?\)\s*returns jsonb/u
  );
  assert.match(
    migration,
    /operation', 'set_team_member_role_compatibility'/u
  );
  assert.match(
    migration,
    /insert into public\.admin_action_logs/u
  );
  assert.match(migration, /Deprecated compatibility wrapper/u);
});

test("no UI or application call site for the new RPCs is introduced", async () => {
  const sourceRoots = ["app", "lib"];
  const newRpcNames = functions
    .map((entry) => entry.name)
    .filter((name) => name !== "set_team_member_role");

  async function walk(directory) {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(fullPath)));
      } else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  for (const root of sourceRoots) {
    for (const file of await walk(path.join(repoRoot, root))) {
      const source = await readFile(file, "utf8");
      for (const rpcName of newRpcNames) {
        assert.equal(
          source.includes(rpcName),
          false,
          `${path.relative(repoRoot, file)} references ${rpcName}`
        );
      }
    }
  }
});
