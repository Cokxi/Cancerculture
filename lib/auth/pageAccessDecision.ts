import { getAuthErrorStatus } from "@/lib/auth/AuthError";

export function getTeamPageAccessRedirect(error: unknown) {
  const status = getAuthErrorStatus(error);
  if (status === 401 || status === 403) {
    return "/403";
  }

  return status === 503 ? "/503" : null;
}
