export const WALLET_ISSUE_DESCRIPTION_MIN_LENGTH = 20;
export const WALLET_ISSUE_DESCRIPTION_MAX_LENGTH = 1000;
export const WALLET_ISSUE_SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;
export const WALLET_ISSUE_SCREENSHOT_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
] as const);

export const WALLET_ISSUE_REQUEST_ID_HEADER = "X-Wallet-Issue-Request-Id";
export const WALLET_ISSUE_SUBMISSION_ID_HEADER = "X-Wallet-Issue-Submission-Id";

export const WALLET_ISSUE_STATUSES = Object.freeze([
  "held",
  "promoted",
  "not_relevant",
  "resolved",
] as const);

export type WalletIssueStatus = (typeof WALLET_ISSUE_STATUSES)[number];

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
export function parseSubmissionId(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
