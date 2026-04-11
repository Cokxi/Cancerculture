import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";
import ModerationGrid from "./ModerationGrid";

export const dynamic = "force-dynamic";

export default async function AdminModerationSubmissionsPage() {

    
  let discordUserId: string;

  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    redirect(
      "/api/auth/discord/login?state=/admin/moderation/submissions"
    );
  }

  
  const { data: member } = await supabaseAdmin
    .from("team_members")
    .select("role")
    .eq("discord_user_id", discordUserId)
    .single();

  if (!member || (member.role !== "admin" && member.role !== "mod")) {
    redirect("/403");
  }


  
  const { data: activeCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id")
    .eq("status", "active")
    .single();

  if (!activeCycle) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Admin – Moderation (Submissions)</h1>
        <p>No active cycle.</p>
      </div>
    );
  }

  
  const { data: submissions } = await supabaseAdmin
    .from("submissions_with_votes")
    .select(`
      id,
      cycle_id,
      image_url,
      is_disqualified,
      vote_count,
      discord_user_id
    `)
    .eq("cycle_id", activeCycle.id)
    .order("id", { ascending: false })
    .limit(50);

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Moderation (Submissions)</h1>

      {!submissions || submissions.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>
          No submissions found for the active cycle.
        </p>
      ) : (
        <ModerationGrid submissions={submissions} />
      )}
    </div>
  );
}
