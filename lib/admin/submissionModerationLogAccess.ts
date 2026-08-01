export type DelegatedSubmissionModerationReason =
  | "illegal_content"
  | "legal_or_rights_review"
  | "manual_review"
  | "moderation_reason_redacted"
  | "rules_violation";

const RULES_VIOLATION_REASONS = new Set([
  "spam",
  "nudity",
  "hate",
  "harassment",
  "low_effort",
  "off_topic",
  "policy_violation",
]);

const ILLEGAL_CONTENT_REASONS = new Set([
  "child_abuse",
  "terrorism",
  "extreme_violence",
  "illegal_drugs",
  "copyright_violation",
]);

const LEGAL_OR_RIGHTS_REVIEW_REASONS = new Set([
  "copyright_claim",
  "dmca_notice",
  "identity_rights_claim",
  "legal_review",
  "pending_verification",
]);

export function getDelegatedSubmissionModerationReason(
  reasonCode: string | null
): DelegatedSubmissionModerationReason {
  const normalizedReason = reasonCode?.trim().toLowerCase() ?? "";

  if (RULES_VIOLATION_REASONS.has(normalizedReason)) {
    return "rules_violation";
  }
  if (ILLEGAL_CONTENT_REASONS.has(normalizedReason)) {
    return "illegal_content";
  }
  if (LEGAL_OR_RIGHTS_REVIEW_REASONS.has(normalizedReason)) {
    return "legal_or_rights_review";
  }
  if (normalizedReason === "manual_review") {
    return "manual_review";
  }

  return "moderation_reason_redacted";
}
