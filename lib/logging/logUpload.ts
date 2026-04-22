import { supabaseAdmin } from "@/lib/db/admin";

export async function logUpload({
  cycleId,
  discordUserId,
  submissionId,
  status,
  reason,
}: {
  cycleId: number | null;
  discordUserId: string | null;
  submissionId?: number;
  status: "success" | "failed";
  reason?: string;
}) {
  try {
    await supabaseAdmin.from("upload_logs").insert({
      cycle_id: cycleId,
      discord_user_id: discordUserId,
      submission_id: submissionId ?? null,
      status,
      reason: reason ?? null,
    });
  } catch (error) {
    console.error("[UPLOAD LOG]", error);
  }
}
