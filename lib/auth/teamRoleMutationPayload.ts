const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;
const CAPABILITY_KEY_PATTERN =
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const DISCORD_USER_ID_PATTERN = /^[0-9]{5,32}$/u;

export class TeamRoleMutationPayloadError extends Error {
  readonly status = 400;
}

type CommonPayload = {
  reason: string;
  idempotencyKey: string;
};

export type TeamCapabilityBatchRoleSnapshot = Readonly<{
  role_key: string;
  expected_row_version: number;
}>;

export type TeamCapabilityBatchCapabilitySnapshot = Readonly<{
  capability_key: string;
  expected_implementation_version: number;
  expected_definition_hash: string;
}>;

export type TeamCapabilityBatchChange = Readonly<{
  role_key: string;
  capability_key: string;
  desired_granted: boolean;
}>;

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
      operation: "apply_team_role_capability_changes";
      roleSnapshots: readonly TeamCapabilityBatchRoleSnapshot[];
      capabilitySnapshots: readonly TeamCapabilityBatchCapabilitySnapshot[];
      changes: readonly TeamCapabilityBatchChange[];
      confirmationWord: "SAVE";
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
    })
  | (CommonPayload & {
      operation: "add_team_member";
      targetDiscordUserId: string;
      initialRoleKey: string;
      confirmationWord: "ADD";
    })
  | (CommonPayload & {
      operation: "remove_team_member";
      targetDiscordUserId: string;
      expectedPreviousRoleKey: string;
      confirmationWord: "REMOVE";
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

function discordUserId(
  payload: Record<string, unknown>,
  key: string
) {
  const value = requiredText(payload, key, 32);
  if (!DISCORD_USER_ID_PATTERN.test(value)) {
    throw new TeamRoleMutationPayloadError(`Invalid ${key}`);
  }

  return value;
}

function confirmationWord<
  TExpected extends "ADMIN" | "ADD" | "REMOVE" | "SAVE",
>(
  payload: Record<string, unknown>,
  expected: TExpected
): TExpected {
  const value = requiredText(
    payload,
    "confirmationWord",
    expected.length
  );
  if (value !== expected) {
    throw new TeamRoleMutationPayloadError(
      `Type ${expected} to confirm`
    );
  }

  return expected;
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

function requiredArray(
  payload: Record<string, unknown>,
  key: string
) {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new TeamRoleMutationPayloadError(`Invalid ${key}`);
  }
  return value;
}

function capabilityKey(
  payload: Record<string, unknown>,
  key: string
) {
  const value = requiredText(payload, key, 128);
  if (
    !CAPABILITY_KEY_PATTERN.test(value) ||
    value.includes("*")
  ) {
    throw new TeamRoleMutationPayloadError(`Invalid ${key}`);
  }
  return value;
}

function definitionHash(
  payload: Record<string, unknown>,
  key: string
) {
  const value = requiredText(payload, key, 64);
  if (!HASH_PATTERN.test(value)) {
    throw new TeamRoleMutationPayloadError(`Invalid ${key}`);
  }
  return value;
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

  if (operation === "apply_team_role_capability_changes") {
    assertOnlyKeys(payload, [
      "operation",
      "roleSnapshots",
      "capabilitySnapshots",
      "changes",
      "confirmationWord",
      "reason",
      "idempotencyKey",
    ]);
    const rawRoles = requiredArray(payload, "roleSnapshots");
    const rawCapabilities = requiredArray(
      payload,
      "capabilitySnapshots"
    );
    const rawChanges = requiredArray(payload, "changes");

    if (
      rawChanges.length === 0 ||
      rawChanges.length > 500 ||
      rawRoles.length > 500 ||
      rawCapabilities.length > 500
    ) {
      throw new TeamRoleMutationPayloadError(
        "Capability batch is empty or too large"
      );
    }

    const roleKeys = new Set<string>();
    const roleSnapshots = rawRoles.map((value) => {
      const snapshot = asRecord(value);
      assertOnlyKeys(snapshot, [
        "role_key",
        "expected_row_version",
      ]);
      const parsed = {
        role_key: roleKey(snapshot, "role_key"),
        expected_row_version: integer(
          snapshot,
          "expected_row_version",
          1,
          Number.MAX_SAFE_INTEGER
        ),
      };
      if (roleKeys.has(parsed.role_key)) {
        throw new TeamRoleMutationPayloadError(
          "Duplicate role snapshot"
        );
      }
      roleKeys.add(parsed.role_key);
      return Object.freeze(parsed);
    });

    const capabilityKeys = new Set<string>();
    const capabilitySnapshots = rawCapabilities.map((value) => {
      const snapshot = asRecord(value);
      assertOnlyKeys(snapshot, [
        "capability_key",
        "expected_implementation_version",
        "expected_definition_hash",
      ]);
      const parsed = {
        capability_key: capabilityKey(
          snapshot,
          "capability_key"
        ),
        expected_implementation_version: integer(
          snapshot,
          "expected_implementation_version",
          1,
          Number.MAX_SAFE_INTEGER
        ),
        expected_definition_hash: definitionHash(
          snapshot,
          "expected_definition_hash"
        ),
      };
      if (capabilityKeys.has(parsed.capability_key)) {
        throw new TeamRoleMutationPayloadError(
          "Duplicate capability snapshot"
        );
      }
      capabilityKeys.add(parsed.capability_key);
      return Object.freeze(parsed);
    });

    const changeRoleKeys = new Set<string>();
    const changeCapabilityKeys = new Set<string>();
    const pairKeys = new Set<string>();
    const changes = rawChanges.map((value) => {
      const change = asRecord(value);
      assertOnlyKeys(change, [
        "role_key",
        "capability_key",
        "desired_granted",
      ]);
      const parsed = {
        role_key: roleKey(change, "role_key"),
        capability_key: capabilityKey(
          change,
          "capability_key"
        ),
        desired_granted: booleanValue(
          change,
          "desired_granted"
        ),
      };
      const pairKey = `${parsed.role_key}\u0000${parsed.capability_key}`;
      if (pairKeys.has(pairKey)) {
        throw new TeamRoleMutationPayloadError(
          "Duplicate capability change"
        );
      }
      pairKeys.add(pairKey);
      changeRoleKeys.add(parsed.role_key);
      changeCapabilityKeys.add(parsed.capability_key);
      return Object.freeze(parsed);
    });

    if (
      roleKeys.size !== changeRoleKeys.size ||
      [...roleKeys].some((key) => !changeRoleKeys.has(key))
    ) {
      throw new TeamRoleMutationPayloadError(
        "Role snapshots do not match changes"
      );
    }
    if (
      capabilityKeys.size !== changeCapabilityKeys.size ||
      [...capabilityKeys].some(
        (key) => !changeCapabilityKeys.has(key)
      )
    ) {
      throw new TeamRoleMutationPayloadError(
        "Capability snapshots do not match changes"
      );
    }

    return {
      operation,
      roleSnapshots: Object.freeze(
        roleSnapshots.sort((left, right) =>
          left.role_key.localeCompare(right.role_key)
        )
      ),
      capabilitySnapshots: Object.freeze(
        capabilitySnapshots.sort((left, right) =>
          left.capability_key.localeCompare(
            right.capability_key
          )
        )
      ),
      changes: Object.freeze(
        changes.sort(
          (left, right) =>
            left.role_key.localeCompare(right.role_key) ||
            left.capability_key.localeCompare(
              right.capability_key
            )
        )
      ),
      confirmationWord: confirmationWord(payload, "SAVE"),
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
    const confirmed = confirmationWord(payload, "ADMIN");

    if (!isAdmin && fallbackRoleKey === null) {
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
      confirmationWord: confirmed,
      ...common(payload),
    };
  }

  if (operation === "add_team_member") {
    assertOnlyKeys(payload, [
      "operation",
      "targetDiscordUserId",
      "initialRoleKey",
      "confirmationWord",
      "reason",
      "idempotencyKey",
    ]);
    return {
      operation,
      targetDiscordUserId: discordUserId(
        payload,
        "targetDiscordUserId"
      ),
      initialRoleKey: roleKey(payload, "initialRoleKey"),
      confirmationWord: confirmationWord(payload, "ADD"),
      ...common(payload),
    };
  }

  if (operation === "remove_team_member") {
    assertOnlyKeys(payload, [
      "operation",
      "targetDiscordUserId",
      "expectedPreviousRoleKey",
      "confirmationWord",
      "reason",
      "idempotencyKey",
    ]);
    return {
      operation,
      targetDiscordUserId: discordUserId(
        payload,
        "targetDiscordUserId"
      ),
      expectedPreviousRoleKey: roleKey(
        payload,
        "expectedPreviousRoleKey"
      ),
      confirmationWord: confirmationWord(payload, "REMOVE"),
      ...common(payload),
    };
  }

  throw new TeamRoleMutationPayloadError(
    "Unknown mutation operation"
  );
}
