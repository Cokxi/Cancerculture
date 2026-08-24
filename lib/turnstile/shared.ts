export const TURNSTILE_TOKEN_HEADER = "X-Turnstile-Token";

export const TURNSTILE_ACTIONS = {
  vote: "vote",
  submissionUpload: "submission_upload",
  submissionReport: "submission_report",
  walletIssueIntake: "wallet_issue_intake",
  twoFactorRecovery: "two_factor_recovery",
  communityComment: "community_comment",
  communityCommentReport: "community_comment_report",
} as const;

export type TurnstileAction =
  (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];
