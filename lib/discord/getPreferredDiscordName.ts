export type DiscordUserNameSource = {
  discord_user_id?: string | null;
  current_guild_nickname?: string | null;
  current_display_name?: string | null;
  current_discord_handle?: string | null;
  current_discord_username?: string | null;
};

function cleanName(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function getPreferredDiscordName(user: DiscordUserNameSource) {
  return (
    cleanName(user.current_guild_nickname) ??
    cleanName(user.current_display_name) ??
    cleanName(user.current_discord_handle) ??
    cleanName(user.current_discord_username) ??
    "Unknown User"
  );
}
