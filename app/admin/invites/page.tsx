import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

import CreateInviteButton from "./CreateInviteButton";
import InviteUserRow from "./InviteUserRow";

export const dynamic = "force-dynamic";

type TeamMember = {
  discord_user_id: string;
  role: "admin" | "mod";
};

export default async function AdminInvitesPage() {
  /* 🔐 Admin-only Page */
  try {
    await requireAdmin();
  } catch (error: any) {
    // nicht eingeloggt → Discord OAuth
    if (error?.status === 401) {
      redirect("/api/auth/discord/login?state=/admin/invites");
    }

    // eingeloggt, aber kein Admin
    redirect("/403");
  }

  /* 📦 Team (für Rollenanzeige in Logs) */
  const { data: team } = await supabaseAdmin
    .from("team_members")
    .select("discord_user_id, role");

  const teamMembers: TeamMember[] = team ?? [];

  function getRole(discordId: string) {
    return teamMembers.find(
      (m) => m.discord_user_id === discordId
    )?.role;
  }

  /* 📦 Invites + Logs */
  const { data: invites, error } =
    await supabaseAdmin
      .from("admin_invites")
      .select(`
        id,
        invite_slug,
        invited_by_discord_id,
        is_active,
        created_at,
        invite_auth_logs (
          invited_discord_user_id,
          discord_username,
          created_at
        )
      `)
      .order("created_at", { ascending: false });

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        Failed to load invites
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Invites</h1>

      {/* ➕ Invite erstellen (Admin only) */}
      <div style={{ margin: "16px 0" }}>
        <CreateInviteButton />
      </div>

      {invites.length === 0 && (
        <p>No invites created yet.</p>
      )}

      {invites.map((invite: any) => (
        <div
          key={invite.id}
          style={{
            border: "1px solid #333",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          {/* Header: Invite + Delete */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <strong>
              Invite: {invite.invite_slug}
            </strong>

            <form
              action="/api/admin/invites/delete"
              method="POST"
              style={{ margin: 0 }}
            >
              <input
                type="hidden"
                name="invite_id"
                value={invite.id}
              />
              <button
                style={{
                  background: "transparent",
                  color: "#fcfcfcff",
                  border: "1px solid #000000ff",
                  padding: "2px 6px",
                  borderRadius: 4,
                  fontSize: 12,
                  cursor: "pointer",
                }}
                title="Delete invite"
              >
                Delete
              </button>
            </form>
          </div>

          <div>
            <strong>Created by:</strong>{" "}
            {invite.invited_by_discord_id}
            <br />
            <strong>Status:</strong>{" "}
            {invite.is_active ? "Active" : "Disabled"}
            <br />
            <strong>Uses:</strong>{" "}
            {invite.invite_auth_logs.length}
          </div>

          {invite.invite_auth_logs.length > 0 && (
            <ul style={{ marginTop: 8 }}>
              {invite.invite_auth_logs.map(
                (log: any, i: number) => (
                  <InviteUserRow
                    key={i}
                    discordUserId={
                      log.invited_discord_user_id
                    }
                    discordUsername={
                      log.discord_username
                    }
                    createdAt={log.created_at}
                    role={getRole(
                      log.invited_discord_user_id
                    )}
                  />
                )
              )}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
