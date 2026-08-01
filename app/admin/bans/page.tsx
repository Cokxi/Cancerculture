export const dynamic = "force-dynamic";

import { getBannedUsersWithStats } from "@/lib/admin/getUserLogsWithStats";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { hasResolvedTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import UserModerationActions from "../users/UserModerationActions";
import UserSubmissionsDropdown from "../users/UserSubmissionsDropdown";

type BannedUser = {
  discord_user_id: string;
  current_discord_username: string | null;
  current_discord_handle?: string | null;
  current_display_name?: string | null;
  current_guild_nickname?: string | null;

  is_banned: boolean;
  ban_reason: string | null;
  banned_at: string | null;
  banned_by_discord_username: string | null;
  
  submission_count: number;
  website_ban_version?: number;
};

export default async function AdminBannedUsersPage() {
  
  const authorization = await requireTeamCapabilityPage(
    "users.website_bans.view",
    "/admin/bans"
  );
  const canRevokeWebsiteBan = hasResolvedTeamCapability(
    authorization,
    "users.website_bans.revoke"
  );
  const canViewFullDirectory = hasResolvedTeamCapability(
    authorization,
    "users.directory.full.view"
  );

  const { data: users, error } = await getBannedUsersWithStats();

  if (error) {
    console.error("BANNED USERS LOAD ERROR", error);
    return (
      <div style={{ padding: 24 }}>
        Failed to load banned users
      </div>
    );
  }

  const discordUserIds = (users ?? []).map(
    (user: BannedUser) => user.discord_user_id
  );
  const { data: userNames } =
    discordUserIds.length > 0
      ? await supabaseAdmin
          .from("user_logs")
          .select(
            "discord_user_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname, website_ban_version"
          )
          .in("discord_user_id", discordUserIds)
      : { data: [] };
  const userLabelByDiscordUserId = new Map(
    (userNames ?? []).map((user) => [
      user.discord_user_id,
      formatDiscordUserLabel(user),
    ])
  );
  const websiteBanVersionByDiscordUserId = new Map(
    (userNames ?? []).map((user) => [
      user.discord_user_id,
      user.website_ban_version ?? 0,
    ])
  );

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Banned Users</h1>

      {!users || users.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>
          No banned users 🎉
        </p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: 16,
          }}
        >
          <thead>
            <tr>
              <th align="left">User</th>
              <th align="left">Reason</th>
              <th align="left">Context</th>
              <th align="left">Stats</th>
            </tr>
          </thead>

          <tbody>
            {users.map((user: BannedUser) => (
              <tr
                key={user.discord_user_id}
                style={{
                  borderTop: "1px solid #333",
                  verticalAlign: "top",
                }}
              >
               
                <td style={{ padding: "8px 0" }}>
                  <strong>
                    {userLabelByDiscordUserId.get(
                      user.discord_user_id
                    ) ?? formatDiscordUserLabel(user)}
                  </strong>

                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.7,
                      marginTop: 2,
                    }}
                  >
                    {user.discord_user_id}
                  </div>
                  {user.ban_reason && (
  <div
    style={{
      marginTop: 6,
      fontSize: 12,
      background: "#1a0e0e",
      border: "1px solid #553333",
      borderRadius: 4,
      padding: "6px 8px",
      color: "#ff6b6b",
    }}
  >
    <strong>Banned reason</strong>
    <div style={{ marginTop: 2 }}>
      {user.ban_reason}
    </div>
  </div>
)}


                  
                  <div style={{ marginTop: 6 }}>
                    <UserModerationActions
                      discordUserId={user.discord_user_id}
                      isBanned={true}
                      websiteBanVersion={
                        websiteBanVersionByDiscordUserId.get(
                          user.discord_user_id
                        ) ?? 0
                      }
                      canCreateFlags={false}
                      canCreateWebsiteBan={false}
                      canRevokeWebsiteBan={canRevokeWebsiteBan}
                    />
                  </div>

                  
                  {canViewFullDirectory ? <div style={{ marginTop: 6 }}>
                    <UserSubmissionsDropdown
                      discordUserId={user.discord_user_id}
                      includeDisqualified={authorization.isAdmin}
                      includeVoteCounts={authorization.isAdmin}
                    />
                  </div> : null}
                </td>

                
                <td style={{ padding: "8px 0", fontSize: 12 }}>
                  {user.ban_reason ?? "—"}
                </td>

                
                <td
                  style={{
                    padding: "8px 0",
                    fontSize: 12,
                    opacity: 0.8,
                  }}
                >
                  <div>
                    Banned by:{" "}
                    <strong>
                      {user.banned_by_discord_username ?? "—"}
                    </strong>
                  </div>

                  <div style={{ marginTop: 2 }}>
                    {user.banned_at &&
                      new Date(user.banned_at).toLocaleString()}
                  </div>
                </td>

                
                <td style={{ padding: "8px 0", fontSize: 12 }}>
                  Submissions:{" "}
                  <strong>{user.submission_count}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
