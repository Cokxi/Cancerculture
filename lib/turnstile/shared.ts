export const TURNSTILE_TOKEN_HEADER = "X-Turnstile-Token";

export const TURNSTILE_ACTIONS = {
  vote: "vote",
  submissionUpload: "submission_upload",
  submissionReport: "submission_report",
  twoFactorRecovery: "two_factor_recovery",
} as const;

export type TurnstileAction =
  (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];
