import { supabaseAdmin } from "@/lib/db/admin";

type TouchUserLogInput = {
  discordUserId: string;
  discordUsername?: string | null;
};

export async function touchUserLog({
  discordUserId,
  discordUsername,
}: TouchUserLogInput): Promise<void> {
  try {
    if (!discordUserId) return;

    
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
      console.warn(
        "[touchUserLog][load]",
        loadError
      );
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
          });

      if (insertError) {
        console.warn(
          "[touchUserLog][insert]",
          insertError
        );
      }

      return;
    }

    
    const updatePayload: any = {
      last_seen_at: now,
    };

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
      console.warn(
        "[touchUserLog][update]",
        updateError
      );
    }
  } catch (err) {
    console.warn(
      "[touchUserLog][unexpected]",
      err
    );
  }
}
