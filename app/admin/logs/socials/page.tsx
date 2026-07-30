export const dynamic = "force-dynamic";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdminPage } from "@/lib/auth/pageAccess";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import UserProfileLink from "../shared/UserProfileLink";
import {
  isAdminTeamRole,
  type ReadableTeamRole,
} from "@/lib/auth/teamRoles";

type SocialLogRow = {
  id: number;
  created_at: string;
  action: "verify_social" | "unverify_social";
  actor_discord_user_id: string;
  actor_role: ReadableTeamRole;
  target_discord_user_id: string;
  user_social_link_id: number;
  platform: string;
  profile_url: string;
  handle: string | null;
  note: string | null;
};

export default async function AdminSocialLogsPage() {
  await requireModOrAdminPage("/admin/logs/socials");

  const { data: logs, error } = await supabaseAdmin
    .from("social_verification_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    console.error("[admin/logs/socials]", error);
    return <div style={{ padding: 24 }}>Failed to load social logs</div>;
  }

  const actorIds = Array.from(
    new Set(
      (logs ?? []).map((log) => log.actor_discord_user_id)
    )
  );
  const targetIds = Array.from(
    new Set(
      (logs ?? []).map((log) => log.target_discord_user_id)
    )
  );
  const lookupIds = Array.from(
    new Set([...actorIds, ...targetIds])
  );

  const { data: users } =
    lookupIds.length > 0
      ? await supabaseAdmin
          .from("user_logs")
          .select(
            "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
          )
          .in("discord_user_id", lookupIds)
      : { data: [] };

  const userLabelByDiscordId = new Map<string, string>();
  const publicProfileIdByDiscordId = new Map<string, string>();
  (users ?? []).forEach((user) => {
    userLabelByDiscordId.set(
      user.discord_user_id,
      formatDiscordUserLabel(user)
    );
    publicProfileIdByDiscordId.set(
      user.discord_user_id,
      user.public_profile_id
    );
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin - Social Logs</h1>

      {!logs || logs.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>
          No social verification logs yet.
        </p>
      ) : (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          {(logs as SocialLogRow[]).map((log) => (
            <div
              key={log.id}
              style={{
                border: "1px solid #333",
                borderRadius: 8,
                padding: 12,
                background: "#101010",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <strong>
                  {log.action === "verify_social"
                    ? "Verified"
                    : "Unverified"}
                </strong>
                <span
                  style={{
                    fontSize: 12,
                    color:
                      isAdminTeamRole(log.actor_role)
                        ? "#ffb74d"
                        : "#ffe082",
                  }}
                >
                  {log.actor_role.toUpperCase()}
                </span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  {new Date(log.created_at).toLocaleString()}
                </span>
              </div>

              <div style={{ marginTop: 8, fontSize: 13 }}>
                <div>
                  Actor:{" "}
                  <UserProfileLink
                    discordUserId={log.actor_discord_user_id}
                    label={
                      userLabelByDiscordId.get(
                        log.actor_discord_user_id
                      ) ?? log.actor_discord_user_id
                    }
                    publicProfileId={publicProfileIdByDiscordId.get(
                      log.actor_discord_user_id
                    )}
                  />{" "}
                  ({log.actor_discord_user_id})
                </div>
                <div style={{ marginTop: 4 }}>
                  User:{" "}
                  <UserProfileLink
                    discordUserId={log.target_discord_user_id}
                    label={
                      userLabelByDiscordId.get(
                        log.target_discord_user_id
                      ) ?? log.target_discord_user_id
                    }
                    publicProfileId={publicProfileIdByDiscordId.get(
                      log.target_discord_user_id
                    )}
                  />{" "}
                  ({log.target_discord_user_id})
                </div>
                <div style={{ marginTop: 4 }}>
                  Platform: <strong>{log.platform}</strong>
                </div>
                <div style={{ marginTop: 4 }}>
                  Link:{" "}
                  <a
                    href={log.profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#ffb74d" }}
                  >
                    {log.handle ?? log.profile_url}
                  </a>
                </div>
                {log.note ? (
                  <div style={{ marginTop: 4 }}>
                    Note: {log.note}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
