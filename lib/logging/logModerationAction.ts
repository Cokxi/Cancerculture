import { supabaseAdmin } from "@/lib/db/admin";

export async function logModerationAction({
  actorRole,
  actorId,
  actorUsername,
  action,
  targetType,
  targetId,
  targetDiscordUserId,
  targetDiscordUsername,
  reasonCode,
  reasonText,
  evidence,
  cycleId,
}: {
  actorRole: "admin" | "mod" | "system";
  actorId: string;
  actorUsername?: string | null;

  action: string;
  targetType: string;
  targetId: string | number;

  targetDiscordUserId?: string | null;
  targetDiscordUsername?: string | null;

  reasonCode?: string | null;
  reasonText?: string | null;
  evidence?: Record<string, any>;
  cycleId?: number | null;
}) {
  try {
    await supabaseAdmin
      .from("moderation_action_logs")
      .insert({
        actor_role: actorRole,
        actor_id: actorId,
        actor_discord_username: actorUsername ?? null,

        action,
        target_type: targetType,
        target_id: String(targetId),

        target_discord_user_id: targetDiscordUserId ?? null,
        target_discord_username: targetDiscordUsername ?? null,

        reason_code: reasonCode ?? "manual_review",
        reason_text: reasonText ?? null,

        evidence: evidence ?? null,
        cycle_id: cycleId ?? null,
      });
  } catch {
    
  }
}
