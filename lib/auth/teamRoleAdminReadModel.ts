import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import {
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
  type TeamCapabilityRiskLevel,
} from "@/lib/auth/teamCapabilityRegistry";
import { supabaseAdmin } from "@/lib/db/admin";

export const TEAM_CAPABILITY_SYNC_STATUSES = [
  "synchronized",
  "code_missing",
  "catalog_missing",
  "definition_mismatch",
  "version_mismatch",
  "inactive",
  "not_assignable",
] as const;

export type TeamCapabilitySyncStatus =
  (typeof TEAM_CAPABILITY_SYNC_STATUSES)[number];

export type TeamRoleAdminRole = Readonly<{
  key: string;
  displayName: string;
  description: string;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  createdByDiscordUserId: string | null;
  updatedByDiscordUserId: string | null;
  memberCount: number;
  grantedCapabilityKeys: readonly string[];
  canDeactivate: boolean;
}>;

export type TeamRoleAdminCapability = Readonly<{
  key: string;
  displayName: string;
  description: string;
  category: string;
  includedActions: readonly string[];
  excludedActions: readonly string[];
  riskLevel: TeamCapabilityRiskLevel;
  assignableToNonAdmin: boolean;
  isActive: boolean;
  implementationVersion: number | null;
  definitionHash: string | null;
  deprecatedAt: string | null;
  syncStatus: TeamCapabilitySyncStatus;
  mutable: boolean;
}>;

export type TeamRoleAdminGrant = Readonly<{
  roleKey: string;
  capabilityKey: string;
  grantedAt: string;
  grantedByDiscordUserId: string | null;
  grantReason: string;
}>;

export type TeamRoleAdminMember = Readonly<{
  discordUserId: string;
  displayName: string;
  roleKey: string;
  isAdmin: boolean;
  isCurrentAdmin: boolean;
}>;

export type TeamAuthorizationAuditEntry = Readonly<{
  id: string;
  occurredAt: string;
  actorDiscordUserId: string;
  actorRoleKey: string;
  eventType: string;
  targetRoleKey: string | null;
  targetDiscordUserId: string | null;
  capabilityKey: string | null;
  beforeState: Readonly<Record<string, unknown>>;
  afterState: Readonly<Record<string, unknown>>;
  reason: string;
  requestId: string | null;
}>;

export type TeamRoleAdminReadModel = Readonly<{
  roles: readonly TeamRoleAdminRole[];
  capabilities: readonly TeamRoleAdminCapability[];
  grants: readonly TeamRoleAdminGrant[];
  members: readonly TeamRoleAdminMember[];
  audit: readonly TeamAuthorizationAuditEntry[];
  activeNonAdminRoles: readonly TeamRoleAdminRole[];
  currentAdminDiscordUserId: string;
}>;

type RoleRow = {
  key: string;
  display_name: string;
  description: string;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  row_version: number;
  created_at: string;
  updated_at: string;
  created_by_discord_user_id: string | null;
  updated_by_discord_user_id: string | null;
};

type CapabilityRow = {
  key: string;
  display_name: string;
  description: string;
  category: string;
  included_actions: string[];
  excluded_actions: string[];
  risk_level: TeamCapabilityRiskLevel;
  assignable_to_non_admin: boolean;
  is_active: boolean;
  implementation_version: number;
  definition_hash: string;
  deprecated_at: string | null;
};

type GrantRow = {
  role_key: string;
  capability_key: string;
  granted_at: string;
  granted_by_discord_user_id: string | null;
  grant_reason: string;
};

type MemberRow = {
  discord_user_id: string;
  discord_username: string | null;
  role: string;
};

type AuditRow = {
  id: string;
  occurred_at: string;
  actor_discord_user_id: string;
  actor_role_key: string;
  event_type: string;
  target_role_key: string | null;
  target_discord_user_id: string | null;
  capability_key: string | null;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  reason: string;
  request_id: string | null;
};

export type TeamRoleAdminSnapshot = Readonly<{
  roleRows: readonly RoleRow[];
  capabilityRows: readonly CapabilityRow[];
  grantRows: readonly GrantRow[];
  memberRows: readonly MemberRow[];
  auditRows: readonly AuditRow[];
  currentAdminDiscordUserId: string;
}>;

function getCapabilitySyncStatus(
  catalogEntry: CapabilityRow | undefined,
  registered:
    | (typeof TEAM_CAPABILITY_REGISTRY)[keyof typeof TEAM_CAPABILITY_REGISTRY]
    | undefined
): TeamCapabilitySyncStatus {
  if (!catalogEntry) {
    return "catalog_missing";
  }

  if (!registered) {
    return "code_missing";
  }

  if (!catalogEntry.is_active) {
    return "inactive";
  }

  if (!catalogEntry.assignable_to_non_admin) {
    return "not_assignable";
  }

  if (
    catalogEntry.implementation_version !==
    registered.implementationVersion
  ) {
    return "version_mismatch";
  }

  if (catalogEntry.definition_hash !== registered.definitionHash) {
    return "definition_mismatch";
  }

  return "synchronized";
}

function roleSort(
  left: TeamRoleAdminRole,
  right: TeamRoleAdminRole
) {
  if (left.key === "admin") return -1;
  if (right.key === "admin") return 1;
  if (left.isActive !== right.isActive) {
    return left.isActive ? -1 : 1;
  }

  return (
    left.sortOrder - right.sortOrder ||
    left.displayName.localeCompare(right.displayName) ||
    left.key.localeCompare(right.key)
  );
}

export function buildTeamRoleAdminReadModel(
  snapshot: TeamRoleAdminSnapshot
): TeamRoleAdminReadModel {
  const memberCountByRole = new Map<string, number>();
  for (const member of snapshot.memberRows) {
    memberCountByRole.set(
      member.role,
      (memberCountByRole.get(member.role) ?? 0) + 1
    );
  }

  const grantKeysByRole = new Map<string, string[]>();
  const grants: TeamRoleAdminGrant[] = snapshot.grantRows.map(
    (grant) => {
      const keys = grantKeysByRole.get(grant.role_key) ?? [];
      keys.push(grant.capability_key);
      grantKeysByRole.set(grant.role_key, keys);

      return Object.freeze({
        roleKey: grant.role_key,
        capabilityKey: grant.capability_key,
        grantedAt: grant.granted_at,
        grantedByDiscordUserId:
          grant.granted_by_discord_user_id,
        grantReason: grant.grant_reason,
      });
    }
  );

  const roles = snapshot.roleRows
    .map((role): TeamRoleAdminRole => {
      const memberCount = memberCountByRole.get(role.key) ?? 0;

      return Object.freeze({
        key: role.key,
        displayName: role.display_name,
        description: role.description,
        isSystem: role.is_system,
        isActive: role.is_active,
        sortOrder: role.sort_order,
        rowVersion: Number(role.row_version),
        createdAt: role.created_at,
        updatedAt: role.updated_at,
        createdByDiscordUserId:
          role.created_by_discord_user_id,
        updatedByDiscordUserId:
          role.updated_by_discord_user_id,
        memberCount,
        grantedCapabilityKeys: Object.freeze(
          [...(grantKeysByRole.get(role.key) ?? [])].sort()
        ),
        canDeactivate:
          role.key !== "admin" &&
          role.is_active &&
          memberCount === 0,
      });
    })
    .sort(roleSort);

  const catalogByKey = new Map(
    snapshot.capabilityRows.map((entry) => [entry.key, entry])
  );
  const capabilityKeys = new Set<string>([
    ...REGISTERED_TEAM_CAPABILITY_KEYS,
    ...snapshot.capabilityRows.map((entry) => entry.key),
  ]);
  const capabilities = [...capabilityKeys]
    .map((key): TeamRoleAdminCapability => {
      const catalogEntry = catalogByKey.get(key);
      const registered = Object.hasOwn(
        TEAM_CAPABILITY_REGISTRY,
        key
      )
        ? TEAM_CAPABILITY_REGISTRY[
            key as keyof typeof TEAM_CAPABILITY_REGISTRY
          ]
        : undefined;
      const syncStatus = getCapabilitySyncStatus(
        catalogEntry,
        registered
      );

      return Object.freeze({
        key,
        displayName:
          catalogEntry?.display_name ??
          registered?.displayName ??
          key,
        description:
          catalogEntry?.description ??
          registered?.description ??
          "No capability definition is available.",
        category:
          catalogEntry?.category ??
          registered?.category ??
          "Unregistered",
        includedActions: Object.freeze([
          ...(catalogEntry?.included_actions ??
            registered?.includedActions ??
            []),
        ]),
        excludedActions: Object.freeze([
          ...(catalogEntry?.excluded_actions ??
            registered?.excludedActions ??
            []),
        ]),
        riskLevel:
          catalogEntry?.risk_level ??
          registered?.riskLevel ??
          "critical",
        assignableToNonAdmin:
          catalogEntry?.assignable_to_non_admin ?? false,
        isActive: catalogEntry?.is_active ?? false,
        implementationVersion:
          catalogEntry?.implementation_version ?? null,
        definitionHash: catalogEntry?.definition_hash ?? null,
        deprecatedAt: catalogEntry?.deprecated_at ?? null,
        syncStatus,
        mutable: syncStatus === "synchronized",
      });
    })
    .sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.displayName.localeCompare(right.displayName) ||
        left.key.localeCompare(right.key)
    );

  const members = snapshot.memberRows
    .map(
      (member): TeamRoleAdminMember =>
        Object.freeze({
          discordUserId: member.discord_user_id,
          displayName:
            member.discord_username?.trim() ||
            `Discord ${member.discord_user_id}`,
          roleKey: member.role,
          isAdmin: member.role === "admin",
          isCurrentAdmin:
            member.discord_user_id ===
            snapshot.currentAdminDiscordUserId,
        })
    )
    .sort(
      (left, right) =>
        Number(right.isAdmin) - Number(left.isAdmin) ||
        left.displayName.localeCompare(right.displayName) ||
        left.discordUserId.localeCompare(right.discordUserId)
    );

  const audit = snapshot.auditRows.map(
    (entry): TeamAuthorizationAuditEntry =>
      Object.freeze({
        id: entry.id,
        occurredAt: entry.occurred_at,
        actorDiscordUserId: entry.actor_discord_user_id,
        actorRoleKey: entry.actor_role_key,
        eventType: entry.event_type,
        targetRoleKey: entry.target_role_key,
        targetDiscordUserId: entry.target_discord_user_id,
        capabilityKey: entry.capability_key,
        beforeState: Object.freeze({ ...entry.before_state }),
        afterState: Object.freeze({ ...entry.after_state }),
        reason: entry.reason,
        requestId: entry.request_id,
      })
  );

  return Object.freeze({
    roles: Object.freeze(roles),
    capabilities: Object.freeze(capabilities),
    grants: Object.freeze(grants),
    members: Object.freeze(members),
    audit: Object.freeze(audit),
    activeNonAdminRoles: Object.freeze(
      roles.filter(
        (role) => role.key !== "admin" && role.isActive
      )
    ),
    currentAdminDiscordUserId:
      snapshot.currentAdminDiscordUserId,
  });
}

function readModelUnavailable() {
  return new AuthError(
    503,
    "Team roles and permissions are temporarily unavailable",
    "TEAM_ROLE_READ_MODEL_UNAVAILABLE"
  );
}

export async function loadTeamRoleAdminReadModel(
  currentAdminDiscordUserId: string
): Promise<TeamRoleAdminReadModel> {
  const [
    rolesResult,
    capabilitiesResult,
    grantsResult,
    membersResult,
    auditResult,
  ] = await Promise.all([
    supabaseAdmin
      .from("team_roles")
      .select(
        "key, display_name, description, is_system, is_active, sort_order, row_version, created_at, updated_at, created_by_discord_user_id, updated_by_discord_user_id"
      ),
    supabaseAdmin
      .from("capability_catalog")
      .select(
        "key, display_name, description, category, included_actions, excluded_actions, risk_level, assignable_to_non_admin, is_active, implementation_version, definition_hash, deprecated_at"
      ),
    supabaseAdmin
      .from("team_role_capabilities")
      .select(
        "role_key, capability_key, granted_at, granted_by_discord_user_id, grant_reason"
      ),
    supabaseAdmin
      .from("team_members")
      .select("discord_user_id, discord_username, role"),
    supabaseAdmin
      .from("team_authorization_audit")
      .select(
        "id, occurred_at, actor_discord_user_id, actor_role_key, event_type, target_role_key, target_discord_user_id, capability_key, before_state, after_state, reason, request_id"
      )
      .order("occurred_at", { ascending: false })
      .limit(50),
  ]);

  if (
    rolesResult.error ||
    capabilitiesResult.error ||
    grantsResult.error ||
    membersResult.error ||
    auditResult.error
  ) {
    console.error("[TEAM_ROLE_ADMIN] read model unavailable", {
      roles: rolesResult.error?.code ?? null,
      capabilities: capabilitiesResult.error?.code ?? null,
      grants: grantsResult.error?.code ?? null,
      members: membersResult.error?.code ?? null,
      audit: auditResult.error?.code ?? null,
    });
    throw readModelUnavailable();
  }

  try {
    return buildTeamRoleAdminReadModel({
      roleRows: (rolesResult.data ?? []) as RoleRow[],
      capabilityRows:
        (capabilitiesResult.data ?? []) as CapabilityRow[],
      grantRows: (grantsResult.data ?? []) as GrantRow[],
      memberRows: (membersResult.data ?? []) as MemberRow[],
      auditRows: (auditResult.data ?? []) as AuditRow[],
      currentAdminDiscordUserId,
    });
  } catch (error) {
    console.error("[TEAM_ROLE_ADMIN] invalid read model shape", {
      errorName:
        error instanceof Error ? error.name : "UnknownError",
    });
    throw readModelUnavailable();
  }
}
