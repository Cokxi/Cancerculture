import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { getDelegatedUploadLogReason } from "@/lib/admin/uploadLogAccess";
import { getDelegatedAvatarUploadLogReason } from "@/lib/admin/avatarUploadLogAccess";
import { getDelegatedVoteLogReason } from "@/lib/admin/voteLogAccess";

export type UploadLogRow = {
  id: string;
  created_at: string;
  cycle_id: string | null;
  status: string;
  reason: string | null;
  discord_user_id: string | null;
  discord_user_label?: string | null;
  discord_public_profile_id?: string | null;
  submission_id: string | null;
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

export type AvatarUploadLogRow = Omit<
  UploadLogRow,
  "id" | "cycle_id" | "submission_id"
> & {
  id: number;
  cycle_id: null;
  submission_id: null;
  avatar_key?: string | null;
  cooldown_until?: string | null;
};

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

export async function getUploadLogs({
  includeRawReason = false,
}: {
  includeRawReason?: boolean;
} = {}) {
  const { data, error } = await supabaseAdmin
    .from("upload_logs")
    .select(
      "id, created_at, cycle_id, submission_id, discord_user_id, status, reason"
    )
    .order("created_at", { ascending: false })
    .limit(400);

  const visibleLogs = (data ?? []).map((log) => ({
    ...log,
    reason: includeRawReason
      ? log.reason
      : getDelegatedUploadLogReason(log.reason, log.status),
  }));

  return {
    data: await addDiscordUserLabels(visibleLogs),
    error,
  };
}

export async function getVoteLogs({
  includeRawReason = false,
}: {
  includeRawReason?: boolean;
} = {}) {
  const { data, error } = await supabaseAdmin
    .from("vote_logs")
    .select(
      "id, created_at, cycle_id, submission_id, discord_user_id, status, reason"
    )
    .order("created_at", { ascending: false })
    .limit(300);

  const visibleLogs = (data ?? []).map((log) => ({
    ...log,
    reason: includeRawReason
      ? log.reason
      : getDelegatedVoteLogReason(log.reason, log.status),
  }));

  return {
    data: await addDiscordUserLabels(visibleLogs),
    error,
  };
}

export async function getAvatarUploadLogs({
  includeAdminDetails = false,
}: {
  includeAdminDetails?: boolean;
} = {}) {
  const { data, error } = includeAdminDetails
    ? await supabaseAdmin
        .from("avatar_upload_logs")
        .select(
          "id, created_at, discord_user_id, status, reason, avatar_key, cooldown_until"
        )
        .order("created_at", { ascending: false })
        .limit(400)
    : await supabaseAdmin
        .from("avatar_upload_logs")
        .select("id, created_at, discord_user_id, status, reason")
        .order("created_at", { ascending: false })
        .limit(400);

  const logs = (data ?? []).map((log) => ({
    ...log,
    cycle_id: null,
    submission_id: null,
    reason: includeAdminDetails
      ? log.reason
      : getDelegatedAvatarUploadLogReason(log.reason, log.status),
  }));

  return {
    data: await addDiscordUserLabels(logs),
    error,
  };
}
