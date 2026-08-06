export const TURNSTILE_TOKEN_HEADER = "X-Turnstile-Token";

export const TURNSTILE_ACTIONS = {
  vote: "vote",
  submissionUpload: "submission_upload",
} as const;

export type TurnstileAction =
  (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];
