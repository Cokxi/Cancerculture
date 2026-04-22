import { supabaseAdmin } from "@/lib/db/admin";

export async function getActorAuditInfo(discordUserId: string) {
  const { data: actorLog } = await supabaseAdmin
    .from("user_logs")
    .select("current_discord_username")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  return {
    discordUserId,
    username: actorLog?.current_discord_username ?? null,
  };
}
