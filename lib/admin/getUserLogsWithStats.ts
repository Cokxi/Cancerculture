import { supabaseAdmin } from "@/lib/db/admin";

const BASE_USER_LOG_SELECT = `
  discord_user_id,
  current_discord_username,
  is_banned,
  submission_count
`;

export async function getBannedUsersWithStats() {
  return supabaseAdmin
    .from("user_logs_with_stats")
    .select(`
      ${BASE_USER_LOG_SELECT},
      ban_reason,
      banned_at,
      banned_by_discord_username
    `)
    .eq("is_banned", true)
    .order("banned_at", { ascending: false });
}
