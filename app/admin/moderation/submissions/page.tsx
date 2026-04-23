import { supabaseAdmin } from "@/lib/db/admin";
import { getActiveCycle } from "@/lib/cycles/getActiveCycle";
import { requireModOrAdminPage } from "@/lib/auth/pageAccess";
import ModerationGrid from "./ModerationGrid";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export const dynamic = "force-dynamic";

export default async function AdminModerationSubmissionsPage() {
  await requireModOrAdminPage(
    "/admin/moderation/submissions"
  );

  const activeCycle = await getActiveCycle();

  if (!activeCycle) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Admin – Moderation (Submissions)</h1>
        <p>No active cycle.</p>
      </div>
    );
  }

  
  const { data: submissions } = await supabaseAdmin
    .from("submissions")
    .select(`
      id,
      cycle_id,
      r2_key,
      is_disqualified,
      discord_user_id
    `)
    .eq("cycle_id", activeCycle.id)
    .order("id", { ascending: false })
    .limit(50);

  const submissionsWithUrls =
    submissions?.map((s) => ({
      ...s,
      image_url: getPublicImageUrl(s.r2_key) ?? "",
      thumb_url: s.r2_key
        ? `${new URL(
            getPublicImageUrl(s.r2_key) ?? ""
          ).origin}/cdn-cgi/image/w=400,q=75/${s.r2_key}`
        : "",
    })) ?? [];

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Moderation (Submissions)</h1>

      {!submissions || submissions.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>
          No submissions found for the active cycle.
        </p>
      ) : (
        <ModerationGrid submissions={submissionsWithUrls} />
      )}
    </div>
  );
}
