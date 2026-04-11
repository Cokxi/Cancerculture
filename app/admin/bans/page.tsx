export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import UserModerationActions from "../users/UserModerationActions";
import UserSubmissionsDropdown from "../users/UserSubmissionsDropdown";

type BannedUser = {
  discord_user_id: string;
  current_discord_username: string | null;

  is_banned: boolean;
  ban_reason: string | null;
  banned_at: string | null;
  banned_by_discord_username: string | null;
  
  submission_count: number;
};

export default async function AdminBannedUsersPage() {
  
  try {
    await requireAdmin();
  } catch {
    redirect("/403");
  }

  const { data: users, error } = await supabaseAdmin
    .from("user_logs_with_stats")
    .select(`
      discord_user_id,
      current_discord_username,
      is_banned,
      ban_reason,
      banned_at,
      banned_by_discord_username,
      submission_count
    `)
    .eq("is_banned", true)
    .order("banned_at", { ascending: false });

  if (error) {
    console.error("BANNED USERS LOAD ERROR", error);
    return (
      <div style={{ padding: 24 }}>
        Failed to load banned users
      </div>
    );
  }

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
                      isFlagged={false}
                      isBanned={true}
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
