// app/admin/users/UserSubmissionsDropdown.tsx

import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

type Props = {
  discordUserId: string;
  defaultOpen?: boolean;
};


type CycleResultRow = {
  cycle_id: number;
  submission_id: number;
  vote_count: number;
  rank: number | null;
};

type SubmissionRow = {
  id: number;
  r2_key: string;
  image_url?: string;
  is_disqualified: boolean;
  disqualification_reason_code: string | null;
};

export default async function UserSubmissionsDropdown({
  discordUserId,
  defaultOpen,
}: Props) {

  // 1️⃣ Alle Submission-IDs des Users holen
  const { data: submissionIds } = await supabaseAdmin
    .from("submissions")
    .select("id")
    .eq("discord_user_id", discordUserId);

  if (!submissionIds || submissionIds.length === 0) {
    return (
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
        No previous submissions
      </div>
    );
  }

  const ids = submissionIds.map((s) => s.id);

  // 2️⃣ Cycle Results für diese Submissions holen
  const { data: results } = await supabaseAdmin
    .from("cycle_results")
    .select("cycle_id, submission_id, vote_count, rank")
    .in("submission_id", ids)
    .order("cycle_id", { ascending: false })
    .limit(6);

  if (!results || results.length === 0) {
    return (
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
        No previous submissions
      </div>
    );
  }

  // 3️⃣ Submissions separat laden
  const { data: submissions } = await supabaseAdmin
    .from("submissions")
    .select("id, r2_key, is_disqualified, disqualification_reason_code")
    .in(
      "id",
      results.map((r) => r.submission_id)
    );

  const submissionMap = new Map<number, SubmissionRow>();

submissions?.forEach((s) => {
  submissionMap.set(s.id, {
    ...s,
    image_url: getPublicImageUrl(s.r2_key),
  });
});

  // 4️⃣ Render
  return (
  <details open={defaultOpen} style={{ marginTop: 8 }}>

      <summary
        style={{
          cursor: "pointer",
          fontSize: 12,
          opacity: 0.8,
        }}
      >
        Show last submissions
      </summary>

      <div
        style={{
          marginTop: 8,
          display: "grid",
          gridTemplateColumns: "repeat(3, 96px)",
          gap: 8,
        }}
      >
        {(results as CycleResultRow[]).map((row) => {
          const submission = submissionMap.get(row.submission_id);

          // Submission wirklich nicht mehr vorhanden
          if (!submission) {
            return (
              <div
                key={`${row.cycle_id}-${row.submission_id}`}
                style={{
                  width: 96,
                  height: 96,
                  border: "1px solid #a00",
                  fontSize: 10,
                  color: "#a00",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                }}
              >
                Removed
                <br />
                C{row.cycle_id}
              </div>
            );
          }

          return (
            <div
              key={`${row.cycle_id}-${row.submission_id}`}
              style={{
                width: 96,
                fontSize: 10,
                textAlign: "center",
              }}
            >
              {/* Thumbnail */}
              <div
                style={{
                  width: 96,
                  height: 96,
                  overflow: "hidden",
                  border: submission.is_disqualified
                    ? "1px solid #a00"
                    : "1px solid #444",
                  background: "#111",
                }}
              >
                {submission.image_url ? (
  <a
    href={submission.image_url}
    target="_blank"
    rel="noopener noreferrer"
    style={{ display: "block" }}
  >
    <img
      src={submission.image_url}
      alt={`Cycle ${row.cycle_id}`}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        cursor: "pointer",
      }}
    />
  </a>
) : (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      opacity: 0.5,
    }}
  >
    No image
  </div>
)}
              </div>

              {/* Caption */}
              <div style={{ marginTop: 4, opacity: 0.8 }}>
                C{row.cycle_id} · {row.vote_count}v
              </div>

              {submission.is_disqualified && (
                <div style={{ color: "#a00" }}>DQ</div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
