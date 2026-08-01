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
  isFullView: boolean;
};

export function getUserDirectoryQuery(
  canViewFullDirectory: boolean
): UserDirectoryQuery {
  if (canViewFullDirectory) {
    return {
      relation: "user_logs_with_stats",
      select: "*",
      orderBy: "last_seen_at",
      isFullView: true,
    };
  }

  return {
    relation: "user_logs",
    select: BASIC_USER_DIRECTORY_SELECT,
    orderBy: "current_discord_username",
    isFullView: false,
  };
}
