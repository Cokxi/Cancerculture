import "server-only";

import {
  TEAM_CAPABILITY_REGISTRY,
  getRegisteredTeamCapability,
} from "@/lib/auth/teamCapabilityRegistry";
import type { TeamRoleMutationPayload } from "@/lib/auth/teamRoleMutationPayload";
import { supabaseAdmin } from "@/lib/db/admin";

export class TeamRoleMutationError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503;
  readonly code: string;

  constructor(
    status: 400 | 403 | 404 | 409 | 503,
    message: string,
    code: string
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function mapDatabaseMutationError(error: {
  code?: string;
  message?: string;
}) {
  const message = error.message ?? "";

  const conflictCodes = [
    "TEAM_ROLE_VERSION_CONFLICT",
    "TEAM_MEMBER_ROLE_CONFLICT",
    "TEAM_AUTH_IDEMPOTENCY_CONFLICT",
    "TEAM_ROLE_HAS_ASSIGNED_MEMBERS",
    "LAST_ADMIN_PROTECTED",
    "ADMIN_SELF_DEMOTION_FORBIDDEN",
    "TARGET_ALREADY_ADMIN",
    "TARGET_NOT_ADMIN",
    "TEAM_ROLE_KEY_COLLISION",
    "TEAM_ROLE_INACTIVE",
  ];
  const notFoundCodes = [
    "TEAM_ROLE_NOT_FOUND",
    "TEAM_MEMBER_NOT_FOUND",
    "CAPABILITY_NOT_FOUND",
    "TARGET_USER_NOT_FOUND",
  ];
  const forbiddenCodes = [
    "ACTOR_NOT_ADMIN",
    "ADMIN_ROLE_IMMUTABLE",
    "ADMIN_CAPABILITY_GRANT_FORBIDDEN",
    "ADMIN_ROLE_REQUIRES_OWNER_RPC",
  ];

  const matchedConflict = conflictCodes.find((code) =>
    message.includes(code)
  );
  if (matchedConflict) {
    return new TeamRoleMutationError(
      409,
      matchedConflict === "TEAM_ROLE_HAS_ASSIGNED_MEMBERS"
        ? "Move every member to another role before deactivating this role."
        : matchedConflict === "LAST_ADMIN_PROTECTED"
          ? "The last Admin account cannot be demoted."
          : matchedConflict === "ADMIN_SELF_DEMOTION_FORBIDDEN"
            ? "You cannot demote your own Admin account."
            : "The authorization state changed. Refresh and review the latest values.",
      matchedConflict
    );
  }

  const matchedNotFound = notFoundCodes.find((code) =>
    message.includes(code)
  );
  if (matchedNotFound) {
    return new TeamRoleMutationError(
      404,
      "The requested role, capability, or team member no longer exists.",
      matchedNotFound
    );
  }

  const matchedForbidden = forbiddenCodes.find((code) =>
    message.includes(code)
  );
  if (matchedForbidden) {
    return new TeamRoleMutationError(
      403,
      "This Admin operation is not permitted.",
      matchedForbidden
    );
  }

  const registryDriftCodes = [
    "CAPABILITY_DEFINITION_CONFLICT",
    "CAPABILITY_INACTIVE",
    "CAPABILITY_NOT_ASSIGNABLE",
  ];
  const matchedRegistryDrift = registryDriftCodes.find((code) =>
    message.includes(code)
  );
  if (matchedRegistryDrift) {
    return new TeamRoleMutationError(
      503,
      "The capability registry and database catalog are not synchronized.",
      matchedRegistryDrift
    );
  }

  if (
    message.includes("INVALID_") ||
    message.includes("REASON_REQUIRED") ||
    message.includes("IDEMPOTENCY_KEY_REQUIRED") ||
    message.includes("ADMIN_DEMOTION_FALLBACK_REQUIRED")
  ) {
    return new TeamRoleMutationError(
      400,
      "The mutation request is invalid.",
      "INVALID_MUTATION_REQUEST"
    );
  }

  console.error("[TEAM_ROLE_MUTATION] database dependency failed", {
    databaseCode: error.code ?? null,
  });
  return new TeamRoleMutationError(
    503,
    "Team roles and permissions are temporarily unavailable.",
    "TEAM_ROLE_MUTATION_UNAVAILABLE"
  );
}

async function assertCapabilityIsSynchronized(
  payload: Extract<
    TeamRoleMutationPayload,
    { operation: "set_role_capability" }
  >
) {
  const registered = getRegisteredTeamCapability(
    payload.capabilityKey
  );

  if (!registered) {
    throw new TeamRoleMutationError(
      503,
      "The capability registry and database catalog are not synchronized.",
      "CAPABILITY_CODE_MISSING"
    );
  }

  const { data, error } = await supabaseAdmin
    .from("capability_catalog")
    .select(
      "key, is_active, assignable_to_non_admin, implementation_version, definition_hash"
    )
    .eq("key", payload.capabilityKey)
    .maybeSingle();

  if (error) {
    console.error("[TEAM_ROLE_MUTATION] catalog read failed", {
      databaseCode: error.code ?? null,
    });
    throw new TeamRoleMutationError(
      503,
      "Team roles and permissions are temporarily unavailable.",
      "CAPABILITY_CATALOG_UNAVAILABLE"
    );
  }

  if (
    !data ||
    !data.is_active ||
    !data.assignable_to_non_admin ||
    data.implementation_version !==
      registered.implementationVersion ||
    data.definition_hash !== registered.definitionHash ||
    payload.expectedCapabilityImplementationVersion !==
      registered.implementationVersion ||
    payload.expectedCapabilityDefinitionHash !==
      registered.definitionHash ||
    !Object.hasOwn(
      TEAM_CAPABILITY_REGISTRY,
      payload.capabilityKey
    )
  ) {
    throw new TeamRoleMutationError(
      503,
      "The capability registry and database catalog are not synchronized.",
      "CAPABILITY_REGISTRY_DRIFT"
    );
  }
}

async function callMutationRpc(
  name: string,
  parameters: Record<string, unknown>
) {
  const { data, error } = await supabaseAdmin.rpc(
    name,
    parameters
  );

  if (error) {
    throw mapDatabaseMutationError(error);
  }

  if (!data || typeof data !== "object") {
    throw new TeamRoleMutationError(
      503,
      "The authorization service returned an invalid response.",
      "INVALID_MUTATION_RESPONSE"
    );
  }

  return data as Record<string, unknown>;
}

export async function executeTeamRoleMutation(
  actorDiscordUserId: string,
  payload: TeamRoleMutationPayload
) {
  if (payload.operation === "create_role") {
    return callMutationRpc("create_team_role", {
      p_actor_discord_user_id: actorDiscordUserId,
      p_display_name: payload.displayName,
      p_description: payload.description,
      p_sort_order: payload.sortOrder,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
    });
  }

  if (payload.operation === "update_role") {
    return callMutationRpc("update_team_role", {
      p_actor_discord_user_id: actorDiscordUserId,
      p_role_key: payload.roleKey,
      p_display_name: payload.displayName,
      p_description: payload.description,
      p_sort_order: payload.sortOrder,
      p_expected_row_version: payload.expectedRowVersion,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
    });
  }

  if (payload.operation === "set_role_active") {
    return callMutationRpc("set_team_role_active", {
      p_actor_discord_user_id: actorDiscordUserId,
      p_role_key: payload.roleKey,
      p_is_active: payload.isActive,
      p_expected_row_version: payload.expectedRowVersion,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
    });
  }

  if (payload.operation === "set_role_capability") {
    await assertCapabilityIsSynchronized(payload);
    return callMutationRpc("set_team_role_capability", {
      p_actor_discord_user_id: actorDiscordUserId,
      p_role_key: payload.roleKey,
      p_capability_key: payload.capabilityKey,
      p_granted: payload.granted,
      p_expected_role_row_version:
        payload.expectedRoleRowVersion,
      p_expected_capability_implementation_version:
        payload.expectedCapabilityImplementationVersion,
      p_expected_capability_definition_hash:
        payload.expectedCapabilityDefinitionHash,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
    });
  }

  if (payload.operation === "set_member_non_admin_role") {
    return callMutationRpc("set_team_member_non_admin_role", {
      p_actor_discord_user_id: actorDiscordUserId,
      p_target_discord_user_id: payload.targetDiscordUserId,
      p_new_role_key: payload.newRoleKey,
      p_expected_previous_role_key:
        payload.expectedPreviousRoleKey,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
    });
  }

  return callMutationRpc("set_team_member_admin_role", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_target_discord_user_id: payload.targetDiscordUserId,
    p_is_admin: payload.isAdmin,
    p_expected_previous_role_key:
      payload.expectedPreviousRoleKey,
    p_fallback_role_key: payload.fallbackRoleKey,
    p_reason: payload.reason,
    p_idempotency_key: payload.idempotencyKey,
  });
}
