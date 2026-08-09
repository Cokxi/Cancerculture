export const SUBMISSION_REPORT_OUTCOME_LABELS = Object.freeze({
  report_received: "Report received",
  under_review: "Under review",
  action_taken_after_review: "Action taken after case review",
  reviewed_no_action_current_rules: "Reviewed — no action under current rules",
  closed_submission_unavailable: "Closed — submission no longer available",
  included_in_completed_review: "Included in a completed review",
} as const);

export type SubmissionReportOutcomeCode =
  keyof typeof SUBMISSION_REPORT_OUTCOME_LABELS;

export function isSubmissionReportOutcomeCode(
  value: unknown
): value is SubmissionReportOutcomeCode {
  return (
    typeof value === "string" &&
    Object.hasOwn(SUBMISSION_REPORT_OUTCOME_LABELS, value)
  );
}
