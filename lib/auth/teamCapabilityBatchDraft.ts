import type {
  TeamRoleAdminCapability,
  TeamRoleAdminRole,
} from "@/lib/auth/teamRoleAdminReadModel";

export type TeamCapabilityDraftEntry = Readonly<{
  roleKey: string;
  capabilityKey: string;
  originalGranted: boolean;
  desiredGranted: boolean;
}>;

export type TeamCapabilityDraftConflict = Readonly<{
  entry: TeamCapabilityDraftEntry;
  reason: "role_unavailable" | "capability_unavailable";
}>;

export type TeamCapabilityBatchReviewEntry = Readonly<{
  roleKey: string;
  roleDisplayName: string;
  capabilityKey: string;
  capabilityDisplayName: string;
  originalGranted: boolean;
  desiredGranted: boolean;
}>;

export type TeamCapabilityBatchReview = Readonly<{
  entries: readonly TeamCapabilityBatchReviewEntry[];
  changes: readonly Readonly<{
    role_key: string;
    capability_key: string;
    desired_granted: boolean;
  }>[];
  roleSnapshots: readonly Readonly<{
    role_key: string;
    expected_row_version: number;
  }>[];
  capabilitySnapshots: readonly Readonly<{
    capability_key: string;
    expected_implementation_version: number;
    expected_definition_hash: string;
  }>[];
  fingerprint: string;
}>;

export type TeamCapabilityBatchRequestIdentity = Readonly<{
  semanticFingerprint: string;
  idempotencyKey: string;
}>;

export function capabilityDraftKey(
  roleKey: string,
  capabilityKey: string
) {
  return `${roleKey}\u0000${capabilityKey}`;
}

function sortDraft(
  draft: readonly TeamCapabilityDraftEntry[]
) {
  return [...draft].sort(
    (left, right) =>
      left.capabilityKey.localeCompare(right.capabilityKey) ||
      left.roleKey.localeCompare(right.roleKey)
  );
}

export function toggleCapabilityDraft(
  draft: readonly TeamCapabilityDraftEntry[],
  input: Readonly<{
    roleKey: string;
    capabilityKey: string;
    originalGranted: boolean;
  }>
): readonly TeamCapabilityDraftEntry[] {
  const key = capabilityDraftKey(
    input.roleKey,
    input.capabilityKey
  );
  const existing = draft.find(
    (entry) =>
      capabilityDraftKey(entry.roleKey, entry.capabilityKey) === key
  );
  const current = existing?.desiredGranted ?? input.originalGranted;
  const desiredGranted = !current;
  const withoutPair = draft.filter(
    (entry) =>
      capabilityDraftKey(entry.roleKey, entry.capabilityKey) !== key
  );

  if (desiredGranted === input.originalGranted) {
    return Object.freeze(sortDraft(withoutPair));
  }

  return Object.freeze(
    sortDraft([
      ...withoutPair,
      Object.freeze({
        roleKey: input.roleKey,
        capabilityKey: input.capabilityKey,
        originalGranted: input.originalGranted,
        desiredGranted,
      }),
    ])
  );
}

export function summarizeCapabilityDraft(
  draft: readonly TeamCapabilityDraftEntry[]
) {
  return Object.freeze({
    total: draft.length,
    grants: draft.filter((entry) => entry.desiredGranted).length,
    revocations: draft.filter(
      (entry) => !entry.desiredGranted
    ).length,
    roles: new Set(draft.map((entry) => entry.roleKey)).size,
    capabilities: new Set(
      draft.map((entry) => entry.capabilityKey)
    ).size,
  });
}

export function resolveCapabilityBatchRequestIdentity(
  current: TeamCapabilityBatchRequestIdentity | null,
  reviewFingerprint: string,
  reason: string,
  createIdempotencyKey: () => string
) {
  const semanticFingerprint = `${reviewFingerprint}\n${reason.trim()}`;
  if (current?.semanticFingerprint === semanticFingerprint) {
    return current;
  }
  return Object.freeze({
    semanticFingerprint,
    idempotencyKey: createIdempotencyKey(),
  });
}

export function buildCapabilityBatchReview(
  draft: readonly TeamCapabilityDraftEntry[],
  roles: readonly TeamRoleAdminRole[],
  capabilities: readonly TeamRoleAdminCapability[]
): TeamCapabilityBatchReview {
  if (draft.length === 0 || draft.length > 500) {
    throw new Error("Capability draft is empty or too large");
  }

  const roleByKey = new Map(roles.map((role) => [role.key, role]));
  const capabilityByKey = new Map(
    capabilities.map((capability) => [
      capability.key,
      capability,
    ])
  );
  const roleOrder = new Map(
    roles.map((role, index) => [role.key, index])
  );
  const capabilityOrder = new Map(
    capabilities.map((capability, index) => [
      capability.key,
      index,
    ])
  );
  const pairKeys = new Set<string>();

  const entries = draft.map((entry) => {
    const pairKey = capabilityDraftKey(
      entry.roleKey,
      entry.capabilityKey
    );
    if (pairKeys.has(pairKey)) {
      throw new Error("Duplicate capability draft pair");
    }
    pairKeys.add(pairKey);

    const role = roleByKey.get(entry.roleKey);
    const capability = capabilityByKey.get(entry.capabilityKey);
    if (
      !role ||
      role.key === "admin" ||
      !role.isActive ||
      !capability ||
      !capability.isActive ||
      !capability.assignableToNonAdmin ||
      !capability.mutable ||
      capability.implementationVersion === null ||
      capability.definitionHash === null ||
      entry.originalGranted === entry.desiredGranted
    ) {
      throw new Error("Capability draft contains unavailable data");
    }

    return Object.freeze({
      roleKey: role.key,
      roleDisplayName: role.displayName,
      capabilityKey: capability.key,
      capabilityDisplayName: capability.displayName,
      originalGranted: entry.originalGranted,
      desiredGranted: entry.desiredGranted,
    });
  });

  entries.sort(
    (left, right) =>
      (capabilityOrder.get(left.capabilityKey) ?? 0) -
        (capabilityOrder.get(right.capabilityKey) ?? 0) ||
      (roleOrder.get(left.roleKey) ?? 0) -
        (roleOrder.get(right.roleKey) ?? 0) ||
      left.capabilityKey.localeCompare(right.capabilityKey) ||
      left.roleKey.localeCompare(right.roleKey)
  );

  const referencedRoleKeys = new Set(
    entries.map((entry) => entry.roleKey)
  );
  const referencedCapabilityKeys = new Set(
    entries.map((entry) => entry.capabilityKey)
  );
  const roleSnapshots = roles
    .filter((role) => referencedRoleKeys.has(role.key))
    .map((role) =>
      Object.freeze({
        role_key: role.key,
        expected_row_version: role.rowVersion,
      })
    )
    .sort((left, right) =>
      left.role_key.localeCompare(right.role_key)
    );
  const capabilitySnapshots = capabilities
    .filter((capability) =>
      referencedCapabilityKeys.has(capability.key)
    )
    .map((capability) => {
      if (
        capability.implementationVersion === null ||
        capability.definitionHash === null
      ) {
        throw new Error("Capability snapshot is incomplete");
      }
      return Object.freeze({
        capability_key: capability.key,
        expected_implementation_version:
          capability.implementationVersion,
        expected_definition_hash: capability.definitionHash,
      });
    })
    .sort((left, right) =>
      left.capability_key.localeCompare(right.capability_key)
    );
  const changes = entries
    .map((entry) =>
      Object.freeze({
        role_key: entry.roleKey,
        capability_key: entry.capabilityKey,
        desired_granted: entry.desiredGranted,
      })
    )
    .sort(
      (left, right) =>
        left.role_key.localeCompare(right.role_key) ||
        left.capability_key.localeCompare(right.capability_key)
    );
  const fingerprint = JSON.stringify({
    roleSnapshots,
    capabilitySnapshots,
    changes,
  });

  return Object.freeze({
    entries: Object.freeze(entries),
    changes: Object.freeze(changes),
    roleSnapshots: Object.freeze(roleSnapshots),
    capabilitySnapshots: Object.freeze(capabilitySnapshots),
    fingerprint,
  });
}

export function permissionSnapshotFingerprint(
  roles: readonly TeamRoleAdminRole[],
  capabilities: readonly TeamRoleAdminCapability[]
) {
  return JSON.stringify({
    roles: roles.map((role) => ({
      key: role.key,
      active: role.isActive,
      version: role.rowVersion,
      grants: [...role.grantedCapabilityKeys].sort(),
    })),
    capabilities: capabilities.map((capability) => ({
      key: capability.key,
      active: capability.isActive,
      assignable: capability.assignableToNonAdmin,
      version: capability.implementationVersion,
      hash: capability.definitionHash,
      mutable: capability.mutable,
    })),
  });
}

export function rebaseCapabilityDraft(
  draft: readonly TeamCapabilityDraftEntry[],
  roles: readonly TeamRoleAdminRole[],
  capabilities: readonly TeamRoleAdminCapability[]
) {
  const roleByKey = new Map(roles.map((role) => [role.key, role]));
  const capabilityByKey = new Map(
    capabilities.map((capability) => [
      capability.key,
      capability,
    ])
  );
  const rebased: TeamCapabilityDraftEntry[] = [];
  const conflicts: TeamCapabilityDraftConflict[] = [];

  for (const entry of draft) {
    const role = roleByKey.get(entry.roleKey);
    if (!role || role.key === "admin" || !role.isActive) {
      conflicts.push(
        Object.freeze({ entry, reason: "role_unavailable" })
      );
      continue;
    }

    const capability = capabilityByKey.get(entry.capabilityKey);
    if (
      !capability ||
      !capability.isActive ||
      !capability.assignableToNonAdmin ||
      !capability.mutable ||
      capability.implementationVersion === null ||
      capability.definitionHash === null
    ) {
      conflicts.push(
        Object.freeze({
          entry,
          reason: "capability_unavailable",
        })
      );
      continue;
    }

    const serverGranted = role.grantedCapabilityKeys.includes(
      entry.capabilityKey
    );
    if (serverGranted !== entry.desiredGranted) {
      rebased.push(
        Object.freeze({
          ...entry,
          originalGranted: serverGranted,
        })
      );
    }
  }

  return Object.freeze({
    draft: Object.freeze(sortDraft(rebased)),
    conflicts: Object.freeze(conflicts),
  });
}
