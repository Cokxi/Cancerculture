import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

type TeamMember = {
  discord_user_id: string;
  discord_username: string | null;
  role: "admin" | "mod";
};

export default async function AdminModsPage() {
  
  try {
    await requireAdmin();
  } catch (error: any) {
    
    if (error?.status === 401) {
      redirect("/api/auth/discord/login?state=/admin/mods");
    }

    
    redirect("/403");
  }

  
  const { data: members } = await supabaseAdmin
    .from("team_members")
    .select(
      "discord_user_id, discord_username, role"
    )
    .in("role", ["admin", "mod"])
    .order("role", { ascending: true });

  const team: TeamMember[] = members ?? [];

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Mods</h1>

      {team.length === 0 && (
        <p>No team members found.</p>
      )}

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
            <th align="left">Role</th>
            <th />
          </tr>
        </thead>

        <tbody>
          {team.map((member) => (
            <tr key={member.discord_user_id}>
              <td>
                {member.discord_username ??
                  "Unknown User"}
              </td>
              <td
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                }}
              >
                {member.discord_user_id}
              </td>
              <td>{member.role}</td>
              <td>
                {member.role === "mod" && (
                  <form
                    action="/api/admin/mods/remove"
                    method="POST"
                  >
                    <input
                      type="hidden"
                      name="discord_user_id"
                      value={
                        member.discord_user_id
                      }
                    />
                    <button
                      style={{
                        background: "transparent",
                        color: "#f8f8f8ff",
                        border: "none",
                        textDecoration: "underline",
                        cursor: "pointer",
                      }}
                    >
                      Disable Mod
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
