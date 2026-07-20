import { getAuthErrorStatus } from "@/lib/auth/AuthError";

export function getTeamPageAccessRedirect(error: unknown) {
  const status = getAuthErrorStatus(error);
  return status === 401 || status === 403 ? "/403" : null;
}
