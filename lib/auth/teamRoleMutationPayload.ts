const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;
const CAPABILITY_KEY_PATTERN =
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export class TeamRoleMutationPayloadError extends Error {
  readonly status = 400;
}

type CommonPayload = {
  reason: string;
  idempotencyKey: string;
};

export type TeamRoleMutationPayload =
  | (CommonPayload & {
      operation: "create_role";
      displayName: string;
      description: string;
      sortOrder: number;
    })
  | (CommonPayload & {
      operation: "update_role";
      roleKey: string;
      displayName: string;
      description: string;
      sortOrder: number;
      expectedRowVersion: number;
    })
  | (CommonPayload & {
      operation: "set_role_active";
      roleKey: string;
      isActive: boolean;
      expectedRowVersion: number;
    })
  | (CommonPayload & {
      operation: "set_role_capability";
      roleKey: string;
      capabilityKey: string;
      granted: boolean;
      expectedRoleRowVersion: number;
      expectedCapabilityImplementationVersion: number;
      expectedCapabilityDefinitionHash: string;
    })
  | (CommonPayload & {
      operation: "set_member_non_admin_role";
      targetDiscordUserId: string;
      newRoleKey: string;
      expectedPreviousRoleKey: string;
    })
  | (CommonPayload & {
      operation: "set_member_admin_role";
      targetDiscordUserId: string;
      isAdmin: boolean;
      expectedPreviousRoleKey: string;
      fallbackRoleKey: string | null;
      confirmationWord: "ADMIN";
    });

function asRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TeamRoleMutationPayloadError("Invalid payload");
  }

  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  payload: Record<string, unknown>,
  keys: readonly string[]
) {
  const allowed = new Set(keys);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new TeamRoleMutationPayloadError(
      "Unexpected payload field"
    );
  }
}

function requiredText(
  payload: Record<string, unknown>,
  key: string,
  maximum: number
) {
  const value =
    typeof payload[key] === "string" ? payload[key].trim() : "";

  if (!value || value.length > maximum) {
    throw new TeamRoleMutationPayloadError(
      `Invalid ${key}`
    );
  }

  return value;
}

function optionalText(
  payload: Record<string, unknown>,
  key: string,
  maximum: number
) {
  const value =
    typeof payload[key] === "string" ? payload[key].trim() : "";

  if (value.length > maximum) {
    throw new TeamRoleMutationPayloadError(
      `Invalid ${key}`
    );
  }

  return value;
}

function integer(
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
) {
  const value = payload[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TeamRoleMutationPayloadError(
      `Invalid ${key}`
    );
  }

  return value;
}

function booleanValue(
  payload: Record<string, unknown>,
  key: string
) {
  if (typeof payload[key] !== "boolean") {
    throw new TeamRoleMutationPayloadError(
      `Invalid ${key}`
    );
  }

  return payload[key] as boolean;
}

function roleKey(
  payload: Record<string, unknown>,
  key: string,
  allowAdmin = false
) {
  const value = requiredText(payload, key, 64);
  if (
    !ROLE_KEY_PATTERN.test(value) ||
    (!allowAdmin && value === "admin")
  ) {
    throw new TeamRoleMutationPayloadError(
      `Invalid ${key}`
    );
  }

  return value;
}

function common(payload: Record<string, unknown>) {
  const reason = requiredText(payload, "reason", 1000);
  const idempotencyKey = requiredText(
    payload,
    "idempotencyKey",
    36
  );

  if (reason.length < 3) {
    throw new TeamRoleMutationPayloadError(
      "Reason must contain at least 3 characters"
    );
  }

  if (!UUID_PATTERN.test(idempotencyKey)) {
    throw new TeamRoleMutationPayloadError(
      "Invalid idempotencyKey"
    );
  }

  return { reason, idempotencyKey };
}

export function parseTeamRoleMutationPayload(
  value: unknown
): TeamRoleMutationPayload {
  const payload = asRecord(value);
  const operation = payload.operation;

  if (typeof operation !== "string") {
    throw new TeamRoleMutationPayloadError(
      "Mutation operation is required"
    );
  }

  if (operation === "create_role") {
    assertOnlyKeys(payload, [
      "operation",
      "displayName",
      "description",
      "sortOrder",
      "reason",
      "idempotencyKey",
    ]);
    return {
      operation,
      displayName: requiredText(payload, "displayName", 100),
      description: optionalText(payload, "description", 1000),
      sortOrder: integer(payload, "sortOrder", -100000, 100000),
      ...common(payload),
    };
  }

  if (operation === "update_role") {
    assertOnlyKeys(payload, [
      "operation",
      "roleKey",
      "displayName",
      "description",
      "sortOrder",
      "expectedRowVersion",
      "reason",
      "idempotencyKey",
    ]);
    return {
      operation,
      roleKey: roleKey(payload, "roleKey"),
      displayName: requiredText(payload, "displayName", 100),
      description: optionalText(payload, "description", 1000),
      sortOrder: integer(payload, "sortOrder", -100000, 100000),
      expectedRowVersion: integer(
        payload,
        "expectedRowVersion",
        1,
        Number.MAX_SAFE_INTEGER
      ),
      ...common(payload),
    };
  }

  if (operation === "set_role_active") {
    assertOnlyKeys(payload, [
      "operation",
      "roleKey",
      "isActive",
      "expectedRowVersion",
      "reason",
      "idempotencyKey",
    ]);
    return {
      operation,
      roleKey: roleKey(payload, "roleKey"),
      isActive: booleanValue(payload, "isActive"),
      expectedRowVersion: integer(
        payload,
        "expectedRowVersion",
        1,
        Number.MAX_SAFE_INTEGER
      ),
      ...common(payload),
    };
  }

  if (operation === "set_role_capability") {
    assertOnlyKeys(payload, [
      "operation",
      "roleKey",
      "capabilityKey",
      "granted",
      "expectedRoleRowVersion",
      "expectedCapabilityImplementationVersion",
      "expectedCapabilityDefinitionHash",
      "reason",
      "idempotencyKey",
    ]);
    const capabilityKey = requiredText(
      payload,
      "capabilityKey",
      128
    );
    const definitionHash = requiredText(
      payload,
      "expectedCapabilityDefinitionHash",
      64
    );
    if (
      !CAPABILITY_KEY_PATTERN.test(capabilityKey) ||
      capabilityKey.includes("*") ||
      !HASH_PATTERN.test(definitionHash)
    ) {
      throw new TeamRoleMutationPayloadError(
        "Invalid capability definition"
      );
    }

    return {
      operation,
      roleKey: roleKey(payload, "roleKey"),
      capabilityKey,
      granted: booleanValue(payload, "granted"),
      expectedRoleRowVersion: integer(
        payload,
        "expectedRoleRowVersion",
        1,
        Number.MAX_SAFE_INTEGER
      ),
      expectedCapabilityImplementationVersion: integer(
        payload,
        "expectedCapabilityImplementationVersion",
        1,
        Number.MAX_SAFE_INTEGER
      ),
      expectedCapabilityDefinitionHash: definitionHash,
      ...common(payload),
    };
  }

  if (operation === "set_member_non_admin_role") {
    assertOnlyKeys(payload, [
      "operation",
      "targetDiscordUserId",
      "newRoleKey",
      "expectedPreviousRoleKey",
      "reason",
      "idempotencyKey",
    ]);
    return {
      operation,
      targetDiscordUserId: requiredText(
        payload,
        "targetDiscordUserId",
        100
      ),
      newRoleKey: roleKey(payload, "newRoleKey"),
      expectedPreviousRoleKey: roleKey(
        payload,
        "expectedPreviousRoleKey"
      ),
      ...common(payload),
    };
  }

  if (operation === "set_member_admin_role") {
    assertOnlyKeys(payload, [
      "operation",
      "targetDiscordUserId",
      "isAdmin",
      "expectedPreviousRoleKey",
      "fallbackRoleKey",
      "confirmationWord",
      "reason",
      "idempotencyKey",
    ]);
    const isAdmin = booleanValue(payload, "isAdmin");
    const fallbackValue = payload.fallbackRoleKey;
    const fallbackRoleKey =
      fallbackValue === null
        ? null
        : roleKey(payload, "fallbackRoleKey");
    const confirmationWord = requiredText(
      payload,
      "confirmationWord",
      5
    );

    if (
      confirmationWord !== "ADMIN" ||
      (!isAdmin && fallbackRoleKey === null)
    ) {
      throw new TeamRoleMutationPayloadError(
        "ADMIN confirmation and active fallback role are required"
      );
    }

    return {
      operation,
      targetDiscordUserId: requiredText(
        payload,
        "targetDiscordUserId",
        100
      ),
      isAdmin,
      expectedPreviousRoleKey: roleKey(
        payload,
        "expectedPreviousRoleKey",
        true
      ),
      fallbackRoleKey,
      confirmationWord: "ADMIN",
      ...common(payload),
    };
  }

  throw new TeamRoleMutationPayloadError(
    "Unknown mutation operation"
  );
}
