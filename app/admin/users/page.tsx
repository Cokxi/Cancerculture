export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import UserSubmissionsDropdown from "./UserSubmissionsDropdown";
import UserModerationActions from "./UserModerationActions";


type UserLog = {
  discord_user_id: string;
  current_discord_username: string | null;
  known_discord_usernames: string[] | null;
  username_change_count: number;
  submission_count: number;

  
  flagged_for_review: boolean;
  flag_reason_code: string | null;
  flag_note: string | null;
  flagged_at: string | null;
  flagged_by_discord_username: string | null;

  
  unflag_reason: string | null;
  unflagged_by_discord_username: string | null;
  unflagged_at: string | null;

  
  is_banned: boolean;
  ban_reason: string | null;
  first_seen_at: string;
  last_seen_at: string;
};



export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; q?: string }>;
}) {

const params = await searchParams;

const focusUserId = params?.focus ?? null;
const query =
  typeof params?.q === "string"
    ? params.q.trim()
    : "";






    
  let discordUserId: string;

  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    redirect("/403");
  }

  
  const { data: member } = await supabaseAdmin
    .from("team_members")
    .select("role")
    .eq("discord_user_id", discordUserId)
    .single();

  if (!member || (member.role !== "admin" && member.role !== "mod")) {
    redirect("/403");
  }


  
  const { data: users, error } = await supabaseAdmin
    .from("user_logs_with_stats")
    .select("*")
    .order("last_seen_at", { ascending: false });

    const filteredUsers =
  query === ""
    ? users
    : (users ?? []).filter((user: UserLog) => {
        const qLower = query.toLowerCase();

        return (
          user.discord_user_id.includes(query) ||
          user.current_discord_username
            ?.toLowerCase()
            .includes(qLower) ||
          (user.known_discord_usernames ?? [])
            .join(" ")
            .toLowerCase()
            .includes(qLower)
        );
      });


  if (error) {
    console.error("USER LOG VIEW ERROR", error);
    return <div style={{ padding: 24 }}>Failed to load user logs</div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – User Logs</h1>

      <form method="get" style={{ marginTop: 12 }}>
  <input
    type="text"
    name="q"
    placeholder="Filter by Discord ID or username"
    defaultValue={query}
    style={{
      padding: "4px 8px",
      fontSize: 13,
      width: 320,
      background: "#0b0b0b",
      border: "1px solid #333",
      color: "white",
    }}
  />

  
</form>


      {!filteredUsers || filteredUsers.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>No users found.</p>
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
              <th align="left">Discord ID</th>
              <th align="left">Stats</th>
              <th align="left">Activity</th>
            </tr>
          </thead>

          <tbody>
            {filteredUsers.map((user: UserLog) => {
  const isMatch =
    query !== "" &&
    (
      user.discord_user_id.includes(query) ||
      user.current_discord_username
        ?.toLowerCase()
        .includes(query.toLowerCase()) ||
      (user.known_discord_usernames ?? [])
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase())
    );

  return (
    <tr
      key={user.discord_user_id}
      style={{
        borderTop: "1px solid #333",
        verticalAlign: "top",
        background: isMatch ? "#141414" : undefined,
      }}
    >


                
                <td style={{ padding: "8px 0" }}>
  <strong>
    {user.current_discord_username ?? "Unknown"}
  </strong>

  
  {user.flagged_for_review && (
    <div
      style={{
        marginTop: 6,
        fontSize: 12,
        background: "#181818",
        border: "1px solid #333",
        borderRadius: 4,
        padding: "6px 8px",
        color: "#ff9800",
      }}
    >
      <strong>FLAGGED</strong>

      {user.flag_reason_code && (
        <div>
          Reason:{" "}
          {user.flag_reason_code.replaceAll("_", " ")}
        </div>
      )}

      {user.flag_note && (
        <div style={{ opacity: 0.8 }}>
          {user.flag_note}
        </div>
      )}
    </div>
  )}

  
{user.is_banned && user.ban_reason && (
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
    <strong>BANNED</strong>
    <div style={{ marginTop: 2 }}>
      {user.ban_reason}
    </div>
  </div>
)}


  
  {!user.flagged_for_review && user.unflag_reason && (
    <div
      style={{
        marginTop: 6,
        fontSize: 12,
        background: "#141414",
        border: "1px solid #2f2f2f",
        borderRadius: 4,
        padding: "6px 8px",
        color: "#8bc34a",
      }}
    >
      <strong>Reviewed</strong>

      <div style={{ marginTop: 2 }}>
        {user.unflag_reason}
      </div>

      <div style={{ marginTop: 2, opacity: 0.7 }}>
        by {user.unflagged_by_discord_username}{" "}
        {user.unflagged_at &&
          `(${new Date(user.unflagged_at).toLocaleString()})`}
      </div>
    </div>
  )}
  <UserModerationActions
  discordUserId={user.discord_user_id}
  isFlagged={user.flagged_for_review}
  isBanned={user.is_banned}
  role={member.role}
/>

</td>


                
                <td
                  style={{
                    fontFamily: "monospace",
                    fontSize: 12,
                    padding: "8px 0",
                    opacity: 0.8,
                  }}
                >
                  {user.discord_user_id}
                </td>

                  

                
                <td style={{ padding: "8px 0" }}>
                  <div>
                    Submissions: <strong>{user.submission_count}</strong>
                  </div>

                  <div>
                    Name changes:{" "}
                    <strong>{user.username_change_count}</strong>
                  </div>

                  {user.known_discord_usernames &&
                    user.known_discord_usernames.length > 1 && (
                      <details style={{ marginTop: 4, fontSize: 12 }}>
                        <summary
                          style={{ cursor: "pointer", opacity: 0.8 }}
                        >
                          Known names
                        </summary>
                        <ul style={{ marginTop: 4, paddingLeft: 16 }}>
                          {user.known_discord_usernames.map((name, i) => (
                            <li key={i}>{name}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                  <UserSubmissionsDropdown
  discordUserId={user.discord_user_id}
  defaultOpen={focusUserId === user.discord_user_id}
/>

                </td>

                
                <td
                  style={{
                    padding: "8px 0",
                    fontSize: 12,
                    opacity: 0.8,
                  }}
                >
                  <div>
                    First seen:
                    <br />
                    {new Date(user.first_seen_at).toLocaleString()}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    Last seen:
                    <br />
                    {new Date(user.last_seen_at).toLocaleString()}
                  </div>
                </td>
                           </tr>
            );
          })}

          </tbody>
        </table>
      )}
      
    </div>
  );
}
