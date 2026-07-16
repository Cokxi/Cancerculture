import { supabaseAdmin } from "@/lib/db/admin";

type TouchUserLogInput = {
  discordUserId: string;
  discordUsername?: string | null;
  discordAvatar?: string | null;
  throwOnError?: boolean;
};

class UserLogSyncError extends Error {
  constructor() {
    super("User log synchronization failed");
    this.name = "UserLogSyncError";
  }
}

function handleSyncError({
  error,
  stage,
  throwOnError,
}: {
  error: unknown;
  stage: string;
  throwOnError: boolean;
}) {
  console.warn(`[touchUserLog][${stage}]`, error);

  if (throwOnError) {
    throw new UserLogSyncError();
  }
}

export async function touchUserLog({
  discordUserId,
  discordUsername,
  discordAvatar,
  throwOnError = false,
}: TouchUserLogInput): Promise<void> {
  try {
    if (!discordUserId) {
      handleSyncError({
        error: new Error("Discord user ID is missing"),
        stage: "input",
        throwOnError,
      });
      return;
    }

    
    const { data: existing, error: loadError } =
      await supabaseAdmin
        .from("user_logs")
        .select(
          `
          discord_user_id,
          current_discord_username,
          known_discord_usernames,
          username_change_count
          `
        )
        .eq("discord_user_id", discordUserId)
        .maybeSingle();

    if (loadError) {
      handleSyncError({
        error: loadError,
        stage: "load",
        throwOnError,
      });
      return;
    }

    const now = new Date().toISOString();

    
    if (!existing) {
      const { error: insertError } =
        await supabaseAdmin
          .from("user_logs")
          .insert({
  discord_user_id: discordUserId,
  current_discord_username:
    discordUsername ?? "unknown",
  known_discord_usernames: discordUsername
    ? [discordUsername]
    : [],
  username_change_count: 0,
  first_seen_at: now,
  last_seen_at: now,
  discord_avatar: discordAvatar ?? null,
});

      if (insertError) {
        handleSyncError({
          error: insertError,
          stage: "insert",
          throwOnError,
        });
      }

      return;
    }

    
    const updatePayload: {
      last_seen_at: string;
      discord_avatar?: string;
      current_discord_username?: string;
      known_discord_usernames?: string[];
      username_change_count?: number;
    } = {
      last_seen_at: now,
    };

    if (discordAvatar) {
  updatePayload.discord_avatar = discordAvatar;
}

    if (discordUsername) {
      const currentName =
        existing.current_discord_username;
      const knownNames: string[] =
        existing.known_discord_usernames ?? [];

      if (discordUsername !== currentName) {
        updatePayload.current_discord_username =
          discordUsername;

        if (!knownNames.includes(discordUsername)) {
          updatePayload.known_discord_usernames = [
            ...knownNames,
            discordUsername,
          ];
          updatePayload.username_change_count =
            (existing.username_change_count ??
              0) + 1;
        }
      }
    }

    const { error: updateError } =
      await supabaseAdmin
        .from("user_logs")
        .update(updatePayload)
        .eq("discord_user_id", discordUserId);

    if (updateError) {
      handleSyncError({
        error: updateError,
        stage: "update",
        throwOnError,
      });
    }
  } catch (err) {
    if (err instanceof UserLogSyncError) {
      throw err;
    }

    handleSyncError({
      error: err,
      stage: "unexpected",
      throwOnError,
    });
  }
}
