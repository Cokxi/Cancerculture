import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";

export function getTeamPageAccessRedirect(error: unknown) {
  const status = getAuthErrorStatus(error);
  const code = getAuthErrorCode(error);
  if (
    code === "TEAM_TOTP_REQUIRED" ||
    code === "TEAM_SECURITY_CONTEXT_CHANGED"
  ) {
    return "/team-access";
  }
  if (status === 401 || status === 403) {
    return "/403";
  }

  return status === 503 ? "/503" : null;
}
