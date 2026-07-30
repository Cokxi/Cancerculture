export const dynamic = "force-dynamic";

import { supabaseAdmin } from "@/lib/db/admin";
import { getActiveCycle } from "@/lib/cycles/getActiveCycle";
import { requireSubmissionModeratorPage } from "@/lib/auth/pageAccess";
import ReinstateButton from "./reinstate-button";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export default async function DisqualifiedSubmissionsPage() {
  await requireSubmissionModeratorPage(
    "/admin/moderation/disqualified"
  );

  const currentCycle = await getActiveCycle();

  if (!currentCycle) {
    return <div style={{ padding: 24 }}>No active cycle found.</div>;
  }

  
  const {
    data: submissions,
    error: submissionsError,
  } = await supabaseAdmin
    .from("submissions")
    .select(`
      id,
      cycle_id,
      r2_key,
      is_disqualified,
      disqualification_reason_code,
      disqualification_reason_text,
      disqualified_at,
      disqualified_by_discord_username,
      discord_user_id
    `)
    .eq("cycle_id", currentCycle.id)
    .eq("is_disqualified", true)
    .order("disqualified_at", { ascending: false });

  const submissionsWithUrls =
    submissions?.map((s) => ({
      ...s,
      image_url: getPublicImageUrl(s.r2_key),
    })) ?? [];

  if (submissionsError) {
    return (
      <div style={{ padding: 24 }}>
        Failed to load disqualified submissions.
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>
        Disqualified Submissions – Cycle #{currentCycle.id}
      </h1>

      {submissionsWithUrls.length === 0 && (
        <div style={{ marginTop: 16, opacity: 0.7 }}>
          No disqualified submissions in the current cycle.
        </div>
      )}

      {submissionsWithUrls.map((sub) => (
        <div
          key={sub.id}
          style={{
            marginTop: 16,
            padding: 12,
            background: "#0b0b0b",
            border: "1px solid #222",
            borderRadius: 6,
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <a
  href={sub.image_url ?? undefined}
  target="_blank"
  rel="noopener noreferrer"
>
  <img
    src={sub.image_url ?? undefined}
    alt=""
    style={{
      width: 96,
      height: 96,
      objectFit: "cover",
      border: "1px solid #444",
      cursor: "pointer",
    }}
  />
</a>

          <div style={{ fontSize: 13 }}>
            <div>
              <strong>Disqualified</strong>
            </div>

            {sub.disqualification_reason_code && (
              <div style={{ marginTop: 4 }}>
                Reason:{" "}
                <strong>
                  {sub.disqualification_reason_code.replaceAll("_", " ")}
                </strong>
              </div>
            )}

            {sub.disqualification_reason_text && (
              <div style={{ opacity: 0.8 }}>
                {sub.disqualification_reason_text}
              </div>
            )}

            {sub.disqualified_by_discord_username && (
              <div style={{ marginTop: 4, opacity: 0.7 }}>
                Disqualified by{" "}
                <strong>
                  {sub.disqualified_by_discord_username}
                </strong>
              </div>
                          )}

<div style={{ marginTop: 6, opacity: 0.75 }}>
 Discord ID:
  <div
    style={{
      fontFamily: "monospace",
      fontSize: 12,
      opacity: 0.9,
    }}
  >
    {sub.discord_user_id}
  </div>
</div>


            {sub.disqualified_at && (
              <div style={{ opacity: 0.6 }}>
                {new Date(sub.disqualified_at).toLocaleString()}
              </div>
            )}

            <ReinstateButton submissionId={sub.id} />
          </div>
        </div>
      ))}
    </div>
  );
}
