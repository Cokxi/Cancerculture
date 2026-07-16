import { cookies } from "next/headers";
import { AuthError } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import { supabaseAdmin } from "@/lib/db/admin";

type SessionAccessResult = {
  outcome?: unknown;
  discordUserId?: unknown;
  sessionId?: unknown;
  joinedAt?: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function accessDenied(outcome: string, joinedAt: unknown): never {
  if (outcome === "not_authenticated") {
    throw new AuthError(401, "Not authenticated", "NOT_AUTHENTICATED");
  }

  if (outcome === "discord_banned") {
    throw new AuthError(403, "Account restricted", "DISCORD_BANNED");
  }

  if (outcome === "website_banned") {
    throw new AuthError(403, "Account restricted", "WEBSITE_BANNED");
  }

  if (outcome === "not_in_discord") {
    throw new AuthError(403, "Discord membership required", "NOT_IN_DISCORD");
  }

  if (outcome === "joined_too_recently") {
    const suffix =
      typeof joinedAt === "string" ? `:${joinedAt}` : "";
    throw new AuthError(
      403,
      "Discord membership cooldown active",
      `JOINED_TOO_RECENTLY${suffix}`
    );
  }

  throw new AuthError(
    503,
    "Authentication service temporarily unavailable",
    "AUTHENTICATION_UNAVAILABLE"
  );
}

export async function requireSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session_id")?.value;

  if (!sessionId || !UUID_PATTERN.test(sessionId)) {
    throw new AuthError(401, "Not authenticated", "NOT_AUTHENTICATED");
  }

  const { data, error } = await runAuthQueryWithTimeout(
    "central session access",
    supabaseAdmin.rpc("get_cancerculture_session_access", {
      p_session_id: sessionId,
    })
  );

  if (error) {
    console.error("[AUTH] central session access failed", {
      code: error.code,
    });
    throw new AuthError(
      503,
      "Authentication service temporarily unavailable",
      "AUTHENTICATION_UNAVAILABLE"
    );
  }

  const result =
    data && typeof data === "object"
      ? (data as SessionAccessResult)
      : {};
  const outcome =
    typeof result.outcome === "string" ? result.outcome : "";

  if (outcome !== "allowed") {
    accessDenied(outcome, result.joinedAt);
  }

  if (
    typeof result.discordUserId !== "string" ||
    result.sessionId !== sessionId
  ) {
    throw new AuthError(
      503,
      "Authentication service temporarily unavailable",
      "AUTHENTICATION_UNAVAILABLE"
    );
  }

  return {
    discord_user_id: result.discordUserId,
    session_id: sessionId,
  };
}
