import "server-only";

import {
  resolveDynamicTeamAuthorizationWithLoader,
  type DynamicTeamAuthorizationResult,
  type DynamicTeamAuthorizationSnapshot,
} from "@/lib/auth/dynamicTeamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

const DYNAMIC_AUTHORIZATION_READ_TIMEOUT_MS = 5_000;

async function runDynamicAuthorizationRead<T>(
  query: PromiseLike<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve(query),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              "DYNAMIC_TEAM_AUTHORIZATION_DEPENDENCY_TIMEOUT"
            )
          );
        }, DYNAMIC_AUTHORIZATION_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function loadDynamicTeamAuthorizationSnapshot(
  discordUserId: string
): Promise<DynamicTeamAuthorizationSnapshot> {
  const memberResult = await runDynamicAuthorizationRead(
    supabaseAdmin
      .from("team_members")
      .select("role")
      .eq("discord_user_id", discordUserId)
      .maybeSingle()
  );

  if (memberResult.error) {
    throw new Error("DYNAMIC_TEAM_MEMBER_LOOKUP_FAILED");
  }

  if (!memberResult.data) {
    return {
      teamMemberRoleKey: null,
      roles: [],
      catalog: [],
      grants: [],
    };
  }

  const roleKey =
    typeof memberResult.data.role === "string"
      ? memberResult.data.role
      : "";
  const roleResult = await runDynamicAuthorizationRead(
    supabaseAdmin
      .from("team_roles")
      .select("key, is_active")
      .eq("key", roleKey)
  );

  if (roleResult.error) {
    throw new Error(
      "DYNAMIC_TEAM_AUTHORIZATION_DEPENDENCY_FAILED"
    );
  }

  const roles = (roleResult.data ?? []).map((role) => ({
    key: typeof role.key === "string" ? role.key : "",
    isActive: role.is_active === true,
  }));
  const activeRole = roles.find(
    (role) => role.key === roleKey && role.isActive
  );

  if (!activeRole || roleKey === "admin") {
    return {
      teamMemberRoleKey: roleKey,
      roles,
      catalog: [],
      grants: [],
    };
  }

  const [catalogResult, grantResult] = await Promise.all([
    runDynamicAuthorizationRead(
      supabaseAdmin
        .from("capability_catalog")
        .select(
          "key, is_active, assignable_to_non_admin, implementation_version, definition_hash"
        )
    ),
    runDynamicAuthorizationRead(
      supabaseAdmin
        .from("team_role_capabilities")
        .select("role_key, capability_key")
        .eq("role_key", roleKey)
    ),
  ]);

  if (catalogResult.error || grantResult.error) {
    throw new Error(
      "DYNAMIC_TEAM_AUTHORIZATION_DEPENDENCY_FAILED"
    );
  }

  return {
    teamMemberRoleKey: roleKey,
    roles,
    catalog: (catalogResult.data ?? []).map((entry) => ({
      key: typeof entry.key === "string" ? entry.key : "",
      isActive: entry.is_active === true,
      assignableToNonAdmin:
        entry.assignable_to_non_admin === true,
      implementationVersion:
        typeof entry.implementation_version === "number"
          ? entry.implementation_version
          : 0,
      definitionHash:
        typeof entry.definition_hash === "string"
          ? entry.definition_hash
          : "",
    })),
    grants: (grantResult.data ?? []).map((grant) => ({
      roleKey:
        typeof grant.role_key === "string"
          ? grant.role_key
          : "",
      capabilityKey:
        typeof grant.capability_key === "string"
          ? grant.capability_key
          : "",
    })),
  };
}

export async function readDynamicTeamAuthorizationForDiscordUserId(
  discordUserId: string
): Promise<DynamicTeamAuthorizationResult> {
  return resolveDynamicTeamAuthorizationWithLoader(() =>
    loadDynamicTeamAuthorizationSnapshot(discordUserId)
  );
}
