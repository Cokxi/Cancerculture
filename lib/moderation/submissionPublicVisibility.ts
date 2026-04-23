export const SUBMISSION_PUBLIC_VISIBILITY = {
  visible: "visible",
  legalReview: "legal_review",
  removed: "removed",
} as const;

export type SubmissionPublicVisibilityStatus =
  (typeof SUBMISSION_PUBLIC_VISIBILITY)[keyof typeof SUBMISSION_PUBLIC_VISIBILITY];

export function normalizeSubmissionPublicVisibilityStatus(
  status: string | null | undefined
): SubmissionPublicVisibilityStatus {
  if (
    status === SUBMISSION_PUBLIC_VISIBILITY.legalReview ||
    status === SUBMISSION_PUBLIC_VISIBILITY.removed
  ) {
    return status;
  }

  return SUBMISSION_PUBLIC_VISIBILITY.visible;
}

export function isSubmissionListedPublicly(
  status: SubmissionPublicVisibilityStatus
) {
  return status !== SUBMISSION_PUBLIC_VISIBILITY.removed;
}

export function showsSubmissionImagePublicly(
  status: SubmissionPublicVisibilityStatus
) {
  return status === SUBMISSION_PUBLIC_VISIBILITY.visible;
}

export function isSubmissionUnderLegalReview(
  status: SubmissionPublicVisibilityStatus
) {
  return status === SUBMISSION_PUBLIC_VISIBILITY.legalReview;
}

export function isSubmissionRemovedFromPublic(
  status: SubmissionPublicVisibilityStatus
) {
  return status === SUBMISSION_PUBLIC_VISIBILITY.removed;
}
