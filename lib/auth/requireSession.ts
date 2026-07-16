import { cookies } from "next/headers";
import { AuthError } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import { supabaseServer } from "@/lib/db/server";

export async function requireSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session_id")?.value;

  if (!sessionId) {
    throw new AuthError(401, "Not authenticated");
  }

  const { data: session, error } = await runAuthQueryWithTimeout(
    "session lookup",
    supabaseServer
      .from("sessions")
      .select("id, discord_user_id, revoked_at")
      .eq("id", sessionId)
      .maybeSingle()
  );

  if (error) {
    console.error("[ADMIN_AUTH] session lookup Supabase error", error);
    throw new AuthError(
      503,
      "Authentication service temporarily unavailable"
    );
  }

  if (!session || session.revoked_at) {
    throw new AuthError(401, "Invalid session");
  }

  try {
    const lastSeenResult = await runAuthQueryWithTimeout(
      "session last-seen update",
      supabaseServer
        .from("sessions")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", sessionId),
      3_000
    );

    if (lastSeenResult.error) {
      console.warn(
        "[ADMIN_AUTH] session last-seen Supabase error",
        lastSeenResult.error
      );
    }
  } catch (error) {
    console.warn("[ADMIN_AUTH] session last-seen update skipped", error);
  }

  return {
    discord_user_id: session.discord_user_id,
    session_id: sessionId,
  };
}
