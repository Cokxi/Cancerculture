import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import {
  CANONICAL_TEAM_ROLES,
  TEAM_ROLE_LABELS,
  normalizeTeamRole,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";
import UserRoleActions from "@/app/admin/users/UserRoleActions";

export const dynamic = "force-dynamic";

type TeamMember = {
  discord_user_id: string;
  discord_username: string | null;
  role: CanonicalTeamRole;
};

export default async function AdminModsPage() {
  await requireAdminPage("/admin/mods");

  const { data: memberRows, error } = await supabaseAdmin
    .from("team_members")
    .select("discord_user_id, discord_username, role")
    .in("role", [...CANONICAL_TEAM_ROLES, "mod"])
    .order("role", { ascending: true });

  if (error) {
    return <div>Failed to load moderation team.</div>;
  }

  const team: TeamMember[] = (memberRows ?? []).flatMap(
    (member) => {
      const role = normalizeTeamRole(member.role);

      return role
        ? [
            {
              discord_user_id: member.discord_user_id,
              discord_username: member.discord_username,
              role,
            },
          ]
        : [];
    }
  );

  return (
    <div style={{ padding: 24 }}>
      <h1>Moderation Team</h1>

      {team.length === 0 ? (
        <p>No team members found.</p>
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
              <th align="left">Role</th>
              <th align="left">Manage</th>
            </tr>
          </thead>
          <tbody>
            {team.map((member) => (
              <tr key={member.discord_user_id}>
                <td>
                  {member.discord_username ?? "Unknown User"}
                </td>
                <td
                  style={{
                    fontFamily: "monospace",
                    fontSize: 12,
                  }}
                >
                  {member.discord_user_id}
                </td>
                <td>{TEAM_ROLE_LABELS[member.role]}</td>
                <td>
                  <UserRoleActions
                    discordUserId={member.discord_user_id}
                    role={member.role}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
