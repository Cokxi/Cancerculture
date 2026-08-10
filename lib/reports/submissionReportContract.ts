export const SUBMISSION_REPORT_TAXONOMY_VERSION = 2;

export const SUBMISSION_REPORT_REASONS = Object.freeze([
  "illegal_or_harmful_content",
  "hate_harassment_or_threats",
  "privacy_or_personal_information",
  "rights_or_ownership",
  "fair_play_manipulation",
  "low_effort_or_off_topic",
  "other_rules_concern",
] as const);

export type SubmissionReportReason =
  (typeof SUBMISSION_REPORT_REASONS)[number];

export type SubmissionReportSurface = "active" | "history";

export const SUBMISSION_REPORT_REASONS_BY_SURFACE: Readonly<
  Record<SubmissionReportSurface, readonly SubmissionReportReason[]>
> = Object.freeze({
  active: Object.freeze([
    "illegal_or_harmful_content",
    "hate_harassment_or_threats",
    "privacy_or_personal_information",
    "fair_play_manipulation",
    "low_effort_or_off_topic",
    "other_rules_concern",
  ] as const),
  history: Object.freeze([
    "illegal_or_harmful_content",
    "hate_harassment_or_threats",
    "privacy_or_personal_information",
    "rights_or_ownership",
    "other_rules_concern",
  ] as const),
});

export const SUBMISSION_REPORT_REASON_LABELS: Readonly<
  Record<SubmissionReportReason, string>
> = Object.freeze({
  illegal_or_harmful_content: "Illegal or harmful content",
  hate_harassment_or_threats: "Hate, harassment, or threats",
  privacy_or_personal_information: "Privacy or doxxing",
  rights_or_ownership: "Rights or ownership concern",
  fair_play_manipulation: "Fair-play manipulation",
  low_effort_or_off_topic: "Low effort or off topic",
  other_rules_concern: "Other",
});

export const SUBMISSION_REPORT_SUBCATEGORIES = Object.freeze({
  illegal_or_harmful_content: Object.freeze([
    "sexual_abuse_content",
    "extreme_violence",
    "terrorism_or_illegal_activity",
    "other",
  ]),
  hate_harassment_or_threats: Object.freeze([
    "hate_speech",
    "threats",
    "targeted_harassment",
    "other",
  ]),
  privacy_or_personal_information: Object.freeze(["doxxing", "other"]),
  rights_or_ownership: Object.freeze([
    "copyright_or_unlicensed_use",
    "other",
  ]),
  fair_play_manipulation: Object.freeze([
    "vote_influence_or_promotion",
    "coordinated_manipulation",
    "other",
  ]),
  low_effort_or_off_topic: Object.freeze([
    "low_effort",
    "off_topic",
    "other",
  ]),
  other_rules_concern: Object.freeze(["other"]),
} satisfies Record<SubmissionReportReason, readonly string[]>);

export const SUBMISSION_REPORT_SUBCATEGORY_LABELS: Readonly<
  Record<string, string>
> = Object.freeze({
  sexual_abuse_content: "Sexual abuse content",
  extreme_violence: "Extreme violence",
  terrorism_or_illegal_activity: "Terrorism or illegal activity",
  hate_speech: "Hate speech",
  threats: "Threats",
  targeted_harassment: "Targeted harassment",
  doxxing: "Doxxing",
  copyright_or_unlicensed_use: "Copyright or unlicensed use",
  vote_influence_or_promotion: "Vote influence or public promotion",
  coordinated_manipulation: "Coordinated manipulation",
  low_effort: "Low effort",
  off_topic: "Off topic",
  other: "Other",
});

export const SUBMISSION_REPORT_COMMENT_MAX_LENGTH = 500;
export const SUBMISSION_REPORT_COMMENT_MIN_LENGTH = 10;
export const SUBMISSION_REPORT_REQUIRED_COMMENT_MIN_LENGTH = 20;

export type SubmissionReportCreateInput = Readonly<{
  submissionId: number;
  reason: SubmissionReportReason;
  subcategory: string;
  comment: string | null;
  idempotencyKey: string;
}>;

export function isSubmissionReportReason(
  value: unknown
): value is SubmissionReportReason {
  return (
    typeof value === "string" &&
    (SUBMISSION_REPORT_REASONS as readonly string[]).includes(value)
  );
}

export function submissionReportRequiresContext(
  reason: SubmissionReportReason,
  subcategory: string
) {
  return (
    reason === "fair_play_manipulation" ||
    reason === "rights_or_ownership" ||
    reason === "other_rules_concern" ||
    subcategory === "other"
  );
}

export function parseSubmissionReportCreateInput(
  value: unknown
): SubmissionReportCreateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const submissionId = input.submissionId;
  const reason = input.reason;
  const idempotencyKey = input.idempotencyKey;
  const rawSubcategory = input.subcategory;
  const rawComment = input.comment;

  if (
    typeof submissionId !== "number" ||
    !Number.isSafeInteger(submissionId) ||
    submissionId < 1 ||
    !isSubmissionReportReason(reason) ||
    typeof idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      idempotencyKey
    )
  ) {
    return null;
  }

  const subcategory =
    typeof rawSubcategory === "string" ? rawSubcategory.trim() : "";
  if (
    !subcategory ||
    !SUBMISSION_REPORT_SUBCATEGORIES[reason].includes(subcategory as never)
  ) {
    return null;
  }

  const comment =
    typeof rawComment === "string" && rawComment.trim()
      ? rawComment.trim()
      : null;
  const contextRequired = submissionReportRequiresContext(reason, subcategory);
  if (
    (contextRequired &&
      (comment === null ||
        comment.length < SUBMISSION_REPORT_REQUIRED_COMMENT_MIN_LENGTH)) ||
    (comment !== null &&
      (comment.length < SUBMISSION_REPORT_COMMENT_MIN_LENGTH ||
        comment.length > SUBMISSION_REPORT_COMMENT_MAX_LENGTH))
  ) {
    return null;
  }

  return Object.freeze({
    submissionId,
    reason,
    subcategory,
    comment,
    idempotencyKey: idempotencyKey.toLowerCase(),
  });
}
