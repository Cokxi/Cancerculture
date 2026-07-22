import { supabase } from "@/lib/db/client";

type AuditMetadataValue = string | number | boolean | null;

export async function logAction({
  actor,
  action,
  targetType,
  targetId,
  metadata = {},
}: {
  actor: { id: number; role: string };
  action: string;
  targetType: string;
  targetId: number | null;
  metadata?: Record<string, AuditMetadataValue>;
}) {
  const { error } = await supabase.from("audit_logs").insert({
    actor_user_id: actor.id,
    actor_role: actor.role,
    action,
    target_type: targetType,
    target_id: targetId,
    metadata,
  });

  if (error) {
   
    throw error;
  }
}
