export const DEFAULT_SUBMISSIONS_PER_USER = 2;
export const MIN_SUBMISSIONS_PER_USER = 1;
export const MAX_SUBMISSIONS_PER_USER = 20;

export const DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS = 120;
export const MIN_UPLOAD_SUCCESS_COOLDOWN_SECONDS = 30;
export const MAX_UPLOAD_SUCCESS_COOLDOWN_SECONDS = 300;

export function isValidSubmissionsPerUser(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= MIN_SUBMISSIONS_PER_USER &&
    Number(value) <= MAX_SUBMISSIONS_PER_USER
  );
}

export function isValidUploadSuccessCooldownSeconds(
  value: unknown
): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= MIN_UPLOAD_SUCCESS_COOLDOWN_SECONDS &&
    Number(value) <= MAX_UPLOAD_SUCCESS_COOLDOWN_SECONDS
  );
}
