import {
  getPreferredDiscordName,
  type DiscordUserNameSource,
} from "@/lib/discord/getPreferredDiscordName";

export type DiscordUserLabelVariant = "compact" | "standard" | "admin" | "full";

function cleanHandle(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function formatDiscordUserLabel(
  user: DiscordUserNameSource,
  variant: DiscordUserLabelVariant = "standard"
) {
  const handle = cleanHandle(
    user.current_discord_handle ?? user.current_discord_username
  );
  const displayName = getPreferredDiscordName(user);

  if (displayName === "Unknown User") {
    return "Unknown User";
  }

  if (variant === "compact") {
    if (handle && (displayName === handle || displayName === `@${handle}`)) {
      return `@${handle}`;
    }

    return displayName;
  }

  let label: string;

  if (!handle) {
    label = displayName;
  } else if (displayName === handle || displayName === `@${handle}`) {
    label = `@${handle}`;
  } else {
    label = `${displayName} (@${handle})`;
  }

  if ((variant === "admin" || variant === "full") && user.discord_user_id) {
    return `${label} • ID: ${user.discord_user_id}`;
  }

  return label;
}
