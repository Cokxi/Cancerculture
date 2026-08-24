export const COMMUNITY_COMMENT_REPORT_CATEGORIES = Object.freeze([
  "hate_discriminatory",
  "harassment_threats",
  "illegal_harmful",
  "privacy_doxxing",
  "spam_scam_manipulation",
  "other",
] as const);

export type CommunityCommentReportCategory =
  (typeof COMMUNITY_COMMENT_REPORT_CATEGORIES)[number];

export const COMMUNITY_COMMENT_REPORT_LABELS: Readonly<
  Record<CommunityCommentReportCategory, string>
> = Object.freeze({
  hate_discriminatory: "Hate or discriminatory content",
  harassment_threats: "Harassment or threats",
  illegal_harmful: "Illegal or harmful content",
  privacy_doxxing: "Privacy or doxxing",
  spam_scam_manipulation: "Spam, scam, or manipulation",
  other: "Other rules concern",
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseCommunityCommentReportInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const category = input.category;
  const requestId = input.requestId;
  const explanation = typeof input.explanation === "string"
    ? input.explanation.trim()
    : "";
  if (
    typeof category !== "string" ||
    !(COMMUNITY_COMMENT_REPORT_CATEGORIES as readonly string[]).includes(category) ||
    typeof requestId !== "string" ||
    !UUID_PATTERN.test(requestId) ||
    input.rulesAffirmed !== true ||
    (category === "other"
      ? explanation.length < 20 || explanation.length > 500
      : explanation.length > 0 && (explanation.length < 10 || explanation.length > 500))
  ) return null;
  return Object.freeze({
    category: category as CommunityCommentReportCategory,
    explanation: explanation || null,
    requestId,
  });
}
