import { supabaseAdmin } from "@/lib/db/admin";
import type { CanonicalTeamRole } from "@/lib/auth/teamRoles";

type AdminActionMetadataValue = string | number | boolean | null;

type LogParams = {
  actorType: CanonicalTeamRole | "system";
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string | number;
  meta?: Record<string, AdminActionMetadataValue>;
};

export async function logAdminAction(params: LogParams) {
  const {
    actorType,
    actorId,
    action,
    targetType,
    targetId,
    meta,
  } = params;

  const { error } = await supabaseAdmin
    .from("admin_action_logs")
    .insert({
      actor_type: actorType,
      actor_id: actorId,
      action,
      target_type: targetType ?? null,
      target_id: targetId ? String(targetId) : null,
      meta: meta ?? null,
    });

  if (error) {
    console.error("❌ Failed to write admin_action_log", error);
    throw error;
  }
}
