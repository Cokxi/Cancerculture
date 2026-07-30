

import {
  isAdminTeamRole,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";
import {
  hasResolvedTeamCapability,
  type TeamAuthorizationContext,
} from "@/lib/auth/teamAuthorization";

export type TeamMemberUI = { role: CanonicalTeamRole };

export function requireAdminUI(member: TeamMemberUI) {
  if (!isAdminTeamRole(member.role)) {
    throw new Error("Admin only");
  }
}

export function requireSubmissionModeratorUI(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >
) {
  if (
    !hasResolvedTeamCapability(
      context,
      "submissions.submission_phase.moderate"
    )
  ) {
    throw new Error("Forbidden");
  }
}
