import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";

export type UploadLogRow = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  status: string;
  reason: string | null;
  discord_user_id: string | null;
  discord_user_label?: string | null;
  discord_public_profile_id?: string | null;
  submission_id: number | null;
};

export type VoteLogRow = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  submission_id: number | null;
  discord_user_id: string | null;
  discord_user_label?: string | null;
  discord_public_profile_id?: string | null;
  status: string;
  reason: string | null;
};

export type AvatarUploadLogRow = UploadLogRow;

type LogWithDiscordUserId = {
  discord_user_id: string | null;
};

async function addDiscordUserLabels<TLog extends LogWithDiscordUserId>(
  logs: TLog[] | null
) {
  const discordUserIds = Array.from(
    new Set(
      (logs ?? [])
        .map((log) => log.discord_user_id)
        .filter((discordUserId): discordUserId is string =>
          Boolean(discordUserId)
        )
    )
  );

  if (discordUserIds.length === 0) {
    return logs ?? [];
  }

  const { data: users } = await supabaseAdmin
    .from("user_logs")
    .select(
      "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
    )
    .in("discord_user_id", discordUserIds);

  const userByDiscordUserId = new Map(
    (users ?? []).map((user) => [
      user.discord_user_id,
      {
        label: formatDiscordUserLabel(user, "admin"),
        publicProfileId: user.public_profile_id,
      },
    ])
  );

  return (logs ?? []).map((log) => ({
    ...log,
    discord_user_label: log.discord_user_id
      ? userByDiscordUserId.get(log.discord_user_id)?.label ?? null
      : null,
    discord_public_profile_id: log.discord_user_id
      ? userByDiscordUserId.get(log.discord_user_id)?.publicProfileId ?? null
      : null,
  }));
}

export async function getUploadLogs() {
  const { data, error } = await supabaseAdmin
    .from("upload_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(400);

  return {
    data: await addDiscordUserLabels(data),
    error,
  };
}

export async function getVoteLogs() {
  const { data, error } = await supabaseAdmin
    .from("vote_logs")
    .select(
      "id, created_at, cycle_id, submission_id, discord_user_id, status, reason"
    )
    .order("created_at", { ascending: false })
    .limit(300);

  return {
    data: await addDiscordUserLabels(data),
    error,
  };
}

export async function getAvatarUploadLogs() {
  const { data, error } = await supabaseAdmin
    .from("avatar_upload_logs")
    .select(
      "id, created_at, discord_user_id, status, reason, avatar_key, cooldown_until"
    )
    .order("created_at", { ascending: false })
    .limit(400);

  const logs =
    data?.map((log) => ({
      ...log,
      cycle_id: null,
      submission_id: null,
    })) ?? [];

  return {
    data: await addDiscordUserLabels(logs),
    error,
  };
}
