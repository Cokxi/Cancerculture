import "server-only";

import type {
  DynamicTeamAuthorizationDiagnosticCode,
  DynamicTeamAuthorizationResult,
  DynamicTeamAuthorizationStatus,
} from "@/lib/auth/dynamicTeamAuthorization";
import type { RegisteredTeamCapabilityKey } from "@/lib/auth/teamCapabilityRegistry";
import {
  hasTeamCapability,
  type TeamCapability,
} from "@/lib/auth/teamRoles";

export type ConnectedTeamCapabilityShadowMapping =
  Readonly<{
    capabilityKey: RegisteredTeamCapabilityKey;
    staticCapability: TeamCapability;
  }>;

export const CONNECTED_TEAM_CAPABILITY_SHADOW_MAP: readonly ConnectedTeamCapabilityShadowMapping[] =
  Object.freeze([
    Object.freeze({
      capabilityKey:
        "submissions.submission_phase.moderate",
      staticCapability: "canModerateSubmissionPhase",
    }),
    Object.freeze({
      capabilityKey: "users.flag",
      staticCapability: "canFlagUsers",
    }),
    Object.freeze({
      capabilityKey: "users.directory.basic.view",
      staticCapability: "canViewBasicUserDirectory",
    }),
  ]);

export type TeamAuthorizationShadowMismatch = Readonly<{
  roleKey: string | null;
  capabilityKey: RegisteredTeamCapabilityKey;
  staticValue: boolean;
  dynamicValue: boolean;
  reasonCode:
    | DynamicTeamAuthorizationDiagnosticCode
    | "resolver_status_mismatch";
  reason: string;
}>;

export type TeamAuthorizationShadowComparison = Readonly<{
  roleKey: string | null;
  capabilityKey: RegisteredTeamCapabilityKey;
  staticValue: boolean;
  dynamicValue: boolean;
  matches: boolean;
}>;

export type TeamAuthorizationShadowResult = Readonly<{
  roleKey: string | null;
  dynamicStatus: DynamicTeamAuthorizationStatus;
  isMatch: boolean;
  comparisons: readonly TeamAuthorizationShadowComparison[];
  mismatches: readonly TeamAuthorizationShadowMismatch[];
}>;

function isComparableStatus(
  status: DynamicTeamAuthorizationStatus
): boolean {
  return status === "resolved" || status === "registry_drift";
}

export function compareTeamAuthorizationShadow(
  dynamicResult: DynamicTeamAuthorizationResult
): TeamAuthorizationShadowResult {
  const resolved = new Set(
    dynamicResult.resolvedCapabilities
  );
  const comparisons: TeamAuthorizationShadowComparison[] = [];
  const mismatches: TeamAuthorizationShadowMismatch[] = [];

  for (const mapping of CONNECTED_TEAM_CAPABILITY_SHADOW_MAP) {
    const staticValue = hasTeamCapability(
      dynamicResult.roleKey,
      mapping.staticCapability
    );
    const dynamicValue =
      dynamicResult.isAdmin ||
      resolved.has(mapping.capabilityKey);
    const matches =
      isComparableStatus(dynamicResult.status) &&
      staticValue === dynamicValue;
    const comparison = Object.freeze({
      roleKey: dynamicResult.roleKey,
      capabilityKey: mapping.capabilityKey,
      staticValue,
      dynamicValue,
      matches,
    });

    comparisons.push(comparison);

    if (!matches) {
      const cause =
        dynamicResult.diagnostics.find(
          (entry) =>
            entry.capabilityKey === mapping.capabilityKey
        ) ?? dynamicResult.diagnostics[0];

      mismatches.push(
        Object.freeze({
          roleKey: dynamicResult.roleKey,
          capabilityKey: mapping.capabilityKey,
          staticValue,
          dynamicValue,
          reasonCode:
            cause?.code ?? "resolver_status_mismatch",
          reason:
            cause?.reason ??
            "The dynamic resolver status is not comparable.",
        })
      );
    }
  }

  return Object.freeze({
    roleKey: dynamicResult.roleKey,
    dynamicStatus: dynamicResult.status,
    isMatch:
      dynamicResult.status === "resolved" &&
      mismatches.length === 0,
    comparisons: Object.freeze(comparisons),
    mismatches: Object.freeze(mismatches),
  });
}
