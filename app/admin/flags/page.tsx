export const dynamic = "force-dynamic";

import { getFlaggedUsersWithStats } from "@/lib/admin/getUserLogsWithStats";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guards";

import UserModerationActions from "../users/UserModerationActions";
import UserSubmissionsDropdown from "../users/UserSubmissionsDropdown";

type FlaggedUser = {
  discord_user_id: string;
  current_discord_username: string | null;

  flagged_for_review: boolean;
  is_banned: boolean;

  flag_reason_code: string | null;
  flag_note: string | null;
  flagged_at: string | null;
  flagged_by_discord_username: string | null;

  submission_count: number;
};

export default async function AdminFlaggedUsersPage() {
  
  try {
    await requireAdmin();
  } catch {
    redirect("/403");
  }

  const { data: users, error } = await getFlaggedUsersWithStats();

  if (error) {
    console.error("FLAGGED USERS VIEW ERROR", error);
    return <div style={{ padding: 24 }}>Failed to load flagged users</div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Flagged Users</h1>

      {!users || users.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>
          No flagged users 🎉
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
            {users.map((user: FlaggedUser) => (
              <tr
                key={user.discord_user_id}
                style={{
                  borderTop: "1px solid #333",
                  verticalAlign: "top",
                }}
              >
                
                <td style={{ padding: "8px 0" }}>
                  <strong>
                    {user.current_discord_username ?? "Unknown"}
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

                  
                  <div style={{ marginTop: 6 }}>
                    <UserModerationActions
                      discordUserId={user.discord_user_id}
                      isFlagged={user.flagged_for_review}
                      isBanned={user.is_banned}
                      role="admin"
                    />
                  </div>

                  
                  <div style={{ marginTop: 6 }}>
                    <UserSubmissionsDropdown
                      discordUserId={user.discord_user_id}
                    />
                  </div>
                </td>

                
<td style={{ padding: "8px 0", fontSize: 12 }}>
  {user.flag_reason_code ? (
    <div>
      <strong style={{ color: "#ff9800" }}>
        {user.flag_reason_code.replaceAll("_", " ")}
      </strong>
    </div>
  ) : (
    <div style={{ opacity: 0.6 }}>—</div>
  )}

  {user.flag_note && (
    <div style={{ marginTop: 4, opacity: 0.85 }}>
      {user.flag_note}
    </div>
  )}
</td>


                
                <td
                  style={{
                    padding: "8px 0",
                    fontSize: 12,
                    opacity: 0.8,
                  }}
                >
                  <div>
                    Flagged by:{" "}
                    <strong>
                      {user.flagged_by_discord_username ?? "—"}
                    </strong>
                  </div>

                  <div style={{ marginTop: 2 }}>
                    {user.flagged_at &&
                      new Date(user.flagged_at).toLocaleString()}
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
