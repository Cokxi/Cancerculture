import "server-only";

import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";

export type SessionState =
  | { status: "anonymous" }
  | {
      status: "authenticated";
      session: Awaited<ReturnType<typeof requireSession>>;
    }
  | {
      status: "restricted";
      reason: "discord_banned" | "website_banned";
    }
  | { status: "dependency_unavailable" };

export async function getSessionState(): Promise<SessionState> {
  try {
    return {
      status: "authenticated",
      session: await requireSession(),
    };
  } catch (error) {
    const status = getAuthErrorStatus(error);
    const code = getAuthErrorCode(error)?.split(":")[0];

    if (status === 401) {
      return { status: "anonymous" };
    }

    if (status === 403 && code === "DISCORD_BANNED") {
      return { status: "restricted", reason: "discord_banned" };
    }

    if (status === 403 && code === "WEBSITE_BANNED") {
      return { status: "restricted", reason: "website_banned" };
    }

    if (status !== null) {
      return { status: "dependency_unavailable" };
    }

    throw error;
  }
}
