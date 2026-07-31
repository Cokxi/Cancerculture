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
}, rpcName?: string) {
  const message = error.message ?? "";

  if (rpcName === "apply_team_role_capability_changes") {
    for (const code of [
      "CAPABILITY_IMPLEMENTATION_VERSION_CONFLICT",
      "CAPABILITY_DEFINITION_CONFLICT",
      "CAPABILITY_INACTIVE",
      "CAPABILITY_NOT_ASSIGNABLE",
    ]) {
      if (message.includes(code)) {
        return new TeamRoleMutationError(
          409,
          code === "CAPABILITY_INACTIVE" ||
            code === "CAPABILITY_NOT_ASSIGNABLE"
            ? "A reviewed capability is no longer active or assignable. Reload the latest permissions."
            : "A capability definition changed after this review. Reload the latest permissions.",
          code
        );
      }
    }

    if (
      message.includes("CAPABILITY_BATCH_") ||
      message.includes("DUPLICATE_") ||
      message.includes("SNAPSHOT_MISMATCH")
    ) {
      return new TeamRoleMutationError(
        400,
        "The capability batch request is invalid.",
        "INVALID_CAPABILITY_BATCH"
      );
    }
  }

  const conflictCodes = [
    "TEAM_ROLE_VERSION_CONFLICT",
    "TEAM_MEMBER_ROLE_CONFLICT",
    "TEAM_AUTH_IDEMPOTENCY_CONFLICT",
    "TEAM_MEMBER_ALREADY_EXISTS",
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
    "ADMIN_MEMBER_REMOVE_FORBIDDEN",
  ];

  const matchedConflict = conflictCodes.find((code) =>
    message.includes(code)
  );
  if (matchedConflict) {
    const messageByCode: Partial<Record<string, string>> = {
      TEAM_MEMBER_ALREADY_EXISTS:
        "This Discord ID is already a current team member.",
      TEAM_MEMBER_ROLE_CONFLICT:
        "This team member's role changed. Refresh and review the latest assignment.",
      TEAM_AUTH_IDEMPOTENCY_CONFLICT:
        "This request conflicts with a previous authorization change. Review the payload and try again.",
      TEAM_ROLE_INACTIVE:
        "The selected role is no longer active.",
    };
    return new TeamRoleMutationError(
      409,
      messageByCode[matchedConflict] ??
        (matchedConflict === "TEAM_ROLE_HAS_ASSIGNED_MEMBERS"
          ? "Move every member to another role before deactivating this role."
          : matchedConflict === "LAST_ADMIN_PROTECTED"
            ? "The last Admin account cannot be demoted."
            : matchedConflict === "ADMIN_SELF_DEMOTION_FORBIDDEN"
              ? "You cannot demote your own Admin account."
              : "The authorization state changed. Refresh and review the latest values."),
      matchedConflict
    );
  }

  const matchedNotFound = notFoundCodes.find((code) =>
    message.includes(code)
  );
  if (matchedNotFound) {
    const messageByCode: Partial<Record<string, string>> = {
      TEAM_MEMBER_NOT_FOUND:
        "This team member is no longer present. Refresh and review the current list.",
      TEAM_ROLE_NOT_FOUND:
        "The selected role no longer exists.",
    };
    return new TeamRoleMutationError(
      404,
      messageByCode[matchedNotFound] ??
        "The requested role, capability, or team member no longer exists.",
      matchedNotFound
    );
  }

  const matchedForbidden = forbiddenCodes.find((code) =>
    message.includes(code)
  );
  if (matchedForbidden) {
    const messageByCode: Partial<Record<string, string>> = {
      ADMIN_MEMBER_REMOVE_FORBIDDEN:
        "Owner accounts cannot be removed from Team Members.",
      ADMIN_ROLE_REQUIRES_OWNER_RPC:
        "Admin access can only be changed through Owner Accounts.",
    };
    return new TeamRoleMutationError(
      403,
      messageByCode[matchedForbidden] ??
        "This Admin operation is not permitted.",
      matchedForbidden
    );
  }

  if (message.includes("TARGET_IDENTITY_UNKNOWN")) {
    return new TeamRoleMutationError(
      400,
      "This Discord ID is not yet available as a known identity.",
      "TARGET_IDENTITY_UNKNOWN"
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
    registered.lifecycle !== "active" ||
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
    throw mapDatabaseMutationError(error, name);
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

export type TeamCapabilityBatchMutationResult = Readonly<{
  operation: "apply_team_role_capability_changes";
  batchId: string;
  replayed: boolean;
  submittedCount: number;
  changedCount: number;
  noopCount: number;
  grantCount: number;
  revokeCount: number;
  affectedRoles: readonly Readonly<{
    roleKey: string;
    rowVersion: number;
  }>[];
}>;

const UUID_RESULT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safeCount(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function normalizeTeamCapabilityBatchResult(
  data: Record<string, unknown>
): TeamCapabilityBatchMutationResult {
  const submittedCount = safeCount(data.submittedCount);
  const changedCount = safeCount(data.changedCount);
  const noopCount = safeCount(data.noopCount);
  const grantCount = safeCount(data.grantCount);
  const revokeCount = safeCount(data.revokeCount);
  const rawAffectedRoles = Array.isArray(data.affectedRoles)
    ? data.affectedRoles
    : null;
  const affectedRoles = rawAffectedRoles?.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return null;
    }
    const role = value as Record<string, unknown>;
    const rowVersion = safeCount(role.rowVersion);
    if (
      typeof role.roleKey !== "string" ||
      role.roleKey === "admin" ||
      rowVersion === null ||
      rowVersion < 1
    ) {
      return null;
    }
    return Object.freeze({
      roleKey: role.roleKey,
      rowVersion,
    });
  });

  if (
    data.operation !== "apply_team_role_capability_changes" ||
    typeof data.batchId !== "string" ||
    !UUID_RESULT_PATTERN.test(data.batchId) ||
    typeof data.replayed !== "boolean" ||
    submittedCount === null ||
    submittedCount < 1 ||
    changedCount === null ||
    noopCount === null ||
    grantCount === null ||
    revokeCount === null ||
    changedCount + noopCount !== submittedCount ||
    grantCount + revokeCount !== changedCount ||
    !affectedRoles ||
    affectedRoles.some((role) => role === null)
  ) {
    throw new TeamRoleMutationError(
      503,
      "The authorization service returned an invalid response.",
      "INVALID_MUTATION_RESPONSE"
    );
  }

  return Object.freeze({
    operation: "apply_team_role_capability_changes",
    batchId: data.batchId,
    replayed: data.replayed,
    submittedCount,
    changedCount,
    noopCount,
    grantCount,
    revokeCount,
    affectedRoles: Object.freeze(
      affectedRoles as Array<{
        roleKey: string;
        rowVersion: number;
      }>
    ),
  });
}

function assertBatchCapabilitiesRegistered(
  payload: Extract<
    TeamRoleMutationPayload,
    { operation: "apply_team_role_capability_changes" }
  >
) {
  for (const snapshot of payload.capabilitySnapshots) {
    const registered = getRegisteredTeamCapability(
      snapshot.capability_key
    );
    if (
      !registered ||
      registered.lifecycle !== "active" ||
      snapshot.expected_implementation_version !==
        registered.implementationVersion ||
      snapshot.expected_definition_hash !==
        registered.definitionHash
    ) {
      throw new TeamRoleMutationError(
        503,
        "The capability registry and database catalog are not synchronized.",
        "CAPABILITY_REGISTRY_DRIFT"
      );
    }
  }
}

export type TeamMemberMutationResult = Readonly<{
  operation: "add_team_member" | "remove_team_member";
  changed: true;
  targetDiscordUserId: string;
  previousRole: string | null;
  newRole: string | null;
}>;

function normalizeTeamMemberMutationResult(
  data: Record<string, unknown>,
  expectedOperation: TeamMemberMutationResult["operation"]
): TeamMemberMutationResult {
  const previousRole =
    typeof data.previousRole === "string"
      ? data.previousRole
      : data.previousRole === null
        ? null
        : undefined;
  const newRole =
    typeof data.newRole === "string"
      ? data.newRole
      : data.newRole === null
        ? null
        : undefined;

  if (
    data.operation !== expectedOperation ||
    data.changed !== true ||
    typeof data.targetDiscordUserId !== "string" ||
    previousRole === undefined ||
    newRole === undefined
  ) {
    throw new TeamRoleMutationError(
      503,
      "The authorization service returned an invalid response.",
      "INVALID_MUTATION_RESPONSE"
    );
  }

  return Object.freeze({
    operation: expectedOperation,
    changed: true,
    targetDiscordUserId: data.targetDiscordUserId,
    previousRole,
    newRole,
  });
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

  if (
    payload.operation ===
    "apply_team_role_capability_changes"
  ) {
    assertBatchCapabilitiesRegistered(payload);
    const result = await callMutationRpc(
      "apply_team_role_capability_changes",
      {
        p_actor_discord_user_id: actorDiscordUserId,
        p_role_snapshots: payload.roleSnapshots,
        p_capability_snapshots:
          payload.capabilitySnapshots,
        p_changes: payload.changes,
        p_reason: payload.reason,
        p_idempotency_key: payload.idempotencyKey,
      }
    );
    return normalizeTeamCapabilityBatchResult(result);
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

  if (payload.operation === "set_member_admin_role") {
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

  if (payload.operation === "add_team_member") {
    const result = await callMutationRpc("add_team_member", {
      p_actor_discord_user_id: actorDiscordUserId,
      p_target_discord_user_id: payload.targetDiscordUserId,
      p_initial_role_key: payload.initialRoleKey,
      p_expected_absent: true,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
    });
    return normalizeTeamMemberMutationResult(
      result,
      "add_team_member"
    );
  }

  const result = await callMutationRpc("remove_team_member", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_target_discord_user_id: payload.targetDiscordUserId,
    p_expected_previous_role_key:
      payload.expectedPreviousRoleKey,
    p_reason: payload.reason,
    p_idempotency_key: payload.idempotencyKey,
  });
  return normalizeTeamMemberMutationResult(
    result,
    "remove_team_member"
  );
}
