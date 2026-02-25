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

  /* 🚫 CHECK MODE */
  if (mode === "check") {
    // 5 fails → cooldown
    return failCount >= 5;
  }

  /* 🚫 FAIL MODE */
  failCount++;

  const now = new Date();

  /* 🔥 AUTO BAN AFTER 10 FAILS */
  if (failCount >= 10) {
    await supabaseAdmin
      .from("user_logs")
      .update({
        is_banned: true,
        ban_reason: "auto_upload_abuse",
        ban_source: "system",
        banned_at: now.toISOString(),
      })
      .eq("discord_user_id", discordUserId);
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