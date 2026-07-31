import type { TeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import type { RegisteredTeamCapabilityKey } from "@/lib/auth/teamCapabilityRegistry";

export type SubmissionModerationPhase =
  | "submission_open"
  | "voting_open";
export type SubmissionModerationOperation =
  | "disqualify"
  | "reinstate";

export const SUBMISSION_MODERATION_CAPABILITIES = Object.freeze({
  submission_open: Object.freeze({
    disqualify: "submissions.submission_phase.disqualify",
    reinstate: "submissions.submission_phase.reinstate",
  }),
  voting_open: Object.freeze({
    disqualify: "submissions.voting_phase.disqualify",
    reinstate: "submissions.voting_phase.reinstate",
  }),
} as const);

const ALL_MODERATION_CAPABILITIES = Object.freeze(
  Object.values(SUBMISSION_MODERATION_CAPABILITIES).flatMap(
    (phase) => Object.values(phase)
  )
);
const ALL_REINSTATE_CAPABILITIES = Object.freeze([
  SUBMISSION_MODERATION_CAPABILITIES.submission_open.reinstate,
  SUBMISSION_MODERATION_CAPABILITIES.voting_open.reinstate,
]);

export function getSubmissionModerationCapability(
  phase: SubmissionModerationPhase,
  operation: SubmissionModerationOperation
): RegisteredTeamCapabilityKey {
  return SUBMISSION_MODERATION_CAPABILITIES[phase][operation];
}

export function canModerateSubmission(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >,
  phase: SubmissionModerationPhase,
  operation: SubmissionModerationOperation
) {
  return (
    context.isAdmin ||
    context.resolvedCapabilities.includes(
      getSubmissionModerationCapability(phase, operation)
    )
  );
}

function requireAnyCapability(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >,
  capabilities: readonly RegisteredTeamCapabilityKey[]
) {
  if (
    !context.isAdmin &&
    !capabilities.some((capability) =>
      context.resolvedCapabilities.includes(capability)
    )
  ) {
    throw Object.assign(new Error("Forbidden"), {
      status: 403,
      code: "TEAM_CAPABILITY_DENIED",
    });
  }
}

export function requireSubmissionModerationAction(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >,
  phase: SubmissionModerationPhase,
  operation: SubmissionModerationOperation
) {
  requireAnyCapability(context, [
    getSubmissionModerationCapability(phase, operation),
  ]);
}

export function requireLiveModerationPage(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >,
  phase: SubmissionModerationPhase | null
) {
  requireAnyCapability(
    context,
    phase
      ? Object.values(SUBMISSION_MODERATION_CAPABILITIES[phase])
      : ALL_MODERATION_CAPABILITIES
  );
}

export function requireDisqualifiedSubmissionsPage(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >,
  phase: SubmissionModerationPhase | null
) {
  requireAnyCapability(
    context,
    phase
      ? [SUBMISSION_MODERATION_CAPABILITIES[phase].reinstate]
      : ALL_REINSTATE_CAPABILITIES
  );
}
