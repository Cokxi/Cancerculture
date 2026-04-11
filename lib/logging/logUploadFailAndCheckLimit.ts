import { supabaseAdmin } from "@/lib/db/admin";

type Mode = "check" | "fail";

export async function logUploadFailAndCheckLimit({
  discordUserId,
  mode,
}: {
  discordUserId: string;
  mode: Mode;
}) {
  const { data } = await supabaseAdmin
    .from("user_logs")
    .select("upload_fail_count")
    .eq("discord_user_id", discordUserId)
    .limit(1);

  const userLog = data?.[0] ?? null;

  let failCount = userLog?.upload_fail_count ?? 0;

  
  if (mode === "check") {
    // 5 fails → cooldown
    return failCount >= 5;
  }

  
  failCount++;

  const now = new Date();

  
if (failCount === 5) {
  
  const { data: activeCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id")
    .eq("status", "active")
    .maybeSingle();

  if (activeCycle?.id) {
    
    await supabaseAdmin
  .from("blocked_cycle_events")
  .insert({
    discord_user_id: discordUserId,
    cycle_id: activeCycle.id,
  });
  }
}


  await supabaseAdmin
    .from("user_logs")
    .update({
      upload_fail_count: failCount,
      last_upload_fail_at: now.toISOString(),
    })
    .eq("discord_user_id", discordUserId);

  return false;
}