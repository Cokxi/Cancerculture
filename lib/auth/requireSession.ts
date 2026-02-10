import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/db/server";

export async function requireSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session_id")?.value;

  if (!sessionId) {
    throw new Response("Not authenticated", { status: 401 });
  }

  const { data: session, error } = await supabaseServer
    .from("sessions")
    .select("id, discord_user_id, revoked_at")
    .eq("id", sessionId)
    .single();

  if (error || !session || session.revoked_at) {
    throw new Response("Invalid session", { status: 401 });
  }

  // last_seen_at aktualisieren
  await supabaseServer
    .from("sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sessionId);

  return {
    discord_user_id: session.discord_user_id,
    session_id: sessionId,
  };
}
