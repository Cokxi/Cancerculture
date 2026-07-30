

import {
  hasTeamCapability,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";

export type TeamMemberUI = { role: CanonicalTeamRole };

export function requireAdminUI(member: TeamMemberUI) {
  if (!hasTeamCapability(member.role, "canManageTeamRoles")) {
    throw new Error("Admin only");
  }
}

export function requireModOrAdminUI(member: TeamMemberUI) {
  if (
    !hasTeamCapability(
      member.role,
      "canModerateSubmissionPhase"
    )
  ) {
    throw new Error("Forbidden");
  }
}
