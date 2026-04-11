import { supabaseAdmin } from "@/lib/db/admin";

export async function logVote({
  cycleId,
  submissionId,
  discordUserId,
  status,
  reason,
}: {
  cycleId: string | number | null;
  submissionId?: string | number;
  discordUserId: string | null;
  status: "accepted" | "rejected";
  reason?: string;
}) {
  try {
    await supabaseAdmin.from("vote_logs").insert({
      cycle_id: cycleId !== null ? String(cycleId) : null,
      submission_id: submissionId ? String(submissionId) : null,
      discord_user_id: discordUserId,
      status,
      reason: reason ?? null,
    });
  } catch {
    
  }
}
