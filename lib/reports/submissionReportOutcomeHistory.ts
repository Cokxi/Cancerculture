import {
  isSubmissionReportOutcomeCode,
  SUBMISSION_REPORT_OUTCOME_LABELS,
} from "@/lib/reports/submissionReportOutcome";

export const SUBMISSION_REPORT_OUTCOME_HISTORY_FILTERS = Object.freeze([
  Object.freeze({ value: null, label: "All outcomes" }),
  Object.freeze({ value: "reopened", label: "Reopened" }),
  Object.freeze({ value: "action_taken", label: "Action taken" }),
  Object.freeze({ value: "no_action_current_rules", label: "No action" }),
  Object.freeze({
    value: "insufficient_information",
    label: "Insufficient information",
  }),
  Object.freeze({
    value: "submission_unavailable",
    label: "Submission unavailable",
  }),
] as const);

export type SubmissionReportOutcomeHistoryFilter = Exclude<
  (typeof SUBMISSION_REPORT_OUTCOME_HISTORY_FILTERS)[number]["value"],
  null
>;

export function parseSubmissionReportOutcomeHistoryFilter(
  value: unknown
): SubmissionReportOutcomeHistoryFilter | null {
  return SUBMISSION_REPORT_OUTCOME_HISTORY_FILTERS.some(
    (option) => option.value === value && option.value !== null
  )
    ? (value as SubmissionReportOutcomeHistoryFilter)
    : null;
}

export function getSubmissionReportOutcomeHistoryLabel(value: unknown) {
  if (value === "reopened_after_new_report") {
    return "Reopened after a new report";
  }

  return isSubmissionReportOutcomeCode(value)
    ? SUBMISSION_REPORT_OUTCOME_LABELS[value]
    : "Outcome unavailable";
}
