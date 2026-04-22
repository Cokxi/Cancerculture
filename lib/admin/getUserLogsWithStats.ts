import { supabaseAdmin } from "@/lib/db/admin";

const BASE_USER_LOG_SELECT = `
  discord_user_id,
  current_discord_username,
  flagged_for_review,
  is_banned,
  submission_count
`;

export async function getFlaggedUsersWithStats() {
  return supabaseAdmin
    .from("user_logs_with_stats")
    .select(`
      ${BASE_USER_LOG_SELECT},
      flag_reason_code,
      flag_note,
      flagged_at,
      flagged_by_discord_username
    `)
    .eq("flagged_for_review", true)
    .eq("is_banned", false)
    .order("flagged_at", { ascending: false });
}

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
