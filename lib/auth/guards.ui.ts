

import {
  hasTeamCapability,
  isAdminTeamRole,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";

export type TeamMemberUI = { role: CanonicalTeamRole };

export function requireAdminUI(member: TeamMemberUI) {
  if (!isAdminTeamRole(member.role)) {
    throw new Error("Admin only");
  }
}

export function requireSubmissionModeratorUI(member: TeamMemberUI) {
  if (
    !hasTeamCapability(
      member.role,
      "canModerateSubmissionPhase"
    )
  ) {
    throw new Error("Forbidden");
  }
}
