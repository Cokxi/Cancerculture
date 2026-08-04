import {
  isSubmissionListedPublicly,
  normalizeSubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";

const CURRENT_PUBLIC_CYCLE_STATUSES = new Set([
  "active",
  "submission_open",
  "voting_open",
  "paused",
]);

export function getSubmissionDestinationHref({
  cycleId,
  cycleStatus,
  isDisqualified,
  publicVisibilityStatus,
  submissionId,
}: {
  cycleId: number;
  cycleStatus: string | null | undefined;
  isDisqualified: boolean | null | undefined;
  publicVisibilityStatus: string | null | undefined;
  submissionId: number;
}) {
  if (
    !Number.isSafeInteger(cycleId) ||
    cycleId <= 0 ||
    !Number.isSafeInteger(submissionId) ||
    submissionId <= 0 ||
    isDisqualified === true
  ) {
    return null;
  }

  if (CURRENT_PUBLIC_CYCLE_STATUSES.has(cycleStatus ?? "")) {
    return publicVisibilityStatus === "visible"
      ? `/submissions?submission=${submissionId}`
      : null;
  }

  if (
    cycleStatus === "finished" &&
    isSubmissionListedPublicly(
      normalizeSubmissionPublicVisibilityStatus(
        publicVisibilityStatus
      )
    )
  ) {
    return `/cycle-history?cycle=${cycleId}#submission-${submissionId}`;
  }

  return null;
}
