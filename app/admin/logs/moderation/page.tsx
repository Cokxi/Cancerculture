export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";
import type {
  ActorUser,
  ModerationLogRow,
} from "@/lib/admin/moderationLogs";
import ModerationLogList from "./moderation-log-list";

export default async function AdminModerationLogsPage() {
  
  try {
    await requireAdmin();
  } catch {
    redirect("/403");
  }

  
  const { data: logs, error } = await supabaseAdmin
    .from("moderation_action_logs")
    .select(`
      id,
      created_at,
      actor_role,
      actor_id,
      action,
      target_id,
      reason_code,
      reason_text,
      cycle_id,
      evidence
    `)
    .in("action", [
      "disqualify_submission",
      "reinstate_submission",
      "mark_submission_legal_review",
      "restore_submission_public_visibility",
      "remove_submission_from_public",
    ])
    .not("cycle_id", "is", null)
    .order("cycle_id", { ascending: false })
    .order("created_at", { ascending: false });

  if (error || !logs) {
    return <div style={{ padding: 24 }}>Failed to load logs</div>;
  }

  
  const actorIds = Array.from(
    new Set(logs.map((l) => l.actor_id).filter(Boolean))
  );

  const { data: actors } =
    actorIds.length > 0
      ? await supabaseAdmin
          .from("user_logs")
          .select("discord_user_id, current_discord_username")
          .in("discord_user_id", actorIds)
      : { data: [] };

  const actorMap = new Map<string, ActorUser>();
  (actors ?? []).forEach((a) =>
    actorMap.set(a.discord_user_id, a)
  );

  
  const submissionIds = Array.from(
    new Set(
      logs
        .map((l) => Number(l.target_id))
        .filter((id) => !isNaN(id))
    )
  );

  const { data: submissions } =
    submissionIds.length > 0
      ? await supabaseAdmin
          .from("submissions")
          .select("id, discord_user_id")
          .in("id", submissionIds)
      : { data: [] };

  const submissionUserMap = new Map<number, string>();
  (submissions ?? []).forEach((s) =>
    submissionUserMap.set(s.id, s.discord_user_id)
  );

  
  const byCycle = new Map<number, ModerationLogRow[]>();
  logs.forEach((log: ModerationLogRow) => {
    if (!byCycle.has(log.cycle_id)) {
      byCycle.set(log.cycle_id, []);
    }
    byCycle.get(log.cycle_id)!.push(log);
  });

  
  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Moderation Logs</h1>

      <ModerationLogList
        byCycle={byCycle}
        actorMap={actorMap}
        submissionUserMap={submissionUserMap}
      />
    </div>
  );
}
