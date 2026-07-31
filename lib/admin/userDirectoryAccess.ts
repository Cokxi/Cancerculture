export const BASIC_USER_DIRECTORY_SELECT = [
  "discord_user_id",
  "public_profile_id",
  "current_discord_username",
  "current_discord_handle",
  "current_display_name",
  "current_guild_nickname",
].join(", ");

export type UserDirectoryQuery = {
  relation: "user_logs" | "user_logs_with_stats";
  select: string;
  orderBy: "current_discord_username" | "last_seen_at";
  isAdminView: boolean;
};

export function getUserDirectoryQuery(
  isAdmin: boolean
): UserDirectoryQuery {
  if (isAdmin) {
    return {
      relation: "user_logs_with_stats",
      select: "*",
      orderBy: "last_seen_at",
      isAdminView: true,
    };
  }

  return {
    relation: "user_logs",
    select: BASIC_USER_DIRECTORY_SELECT,
    orderBy: "current_discord_username",
    isAdminView: false,
  };
}
