

import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import { getSubmissionDestinationHref } from "@/lib/submissions/getSubmissionDestinationHref";
import Image from "next/image";

type Props = {
  discordUserId: string;
  defaultOpen?: boolean;
  includeDisqualified?: boolean;
  includeVoteCounts?: boolean;
};

type SubmissionRow = {
  id: number;
  cycle_id: number;
  r2_key: string;
  is_disqualified: boolean;
  disqualification_reason_code: string | null;
  public_visibility_status: string | null;
};

export default async function UserSubmissionsDropdown({
  discordUserId,
  defaultOpen,
  includeDisqualified = false,
  includeVoteCounts = false,
}: Props) {
  let submissionsQuery = supabaseAdmin
    .from("submissions")
    .select(`
      id,
      cycle_id,
      r2_key,
      is_disqualified,
      disqualification_reason_code,
      public_visibility_status
    `)
    .eq("discord_user_id", discordUserId);
  if (!includeDisqualified) {
    submissionsQuery = submissionsQuery.eq("is_disqualified", false);
  }
  const { data: submissions } = await submissionsQuery
    .order("id", { ascending: false })
    .limit(6);

  if (!submissions || submissions.length === 0) {
    return (
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
        No previous submissions
      </div>
    );
  }

  const typedSubmissions = submissions as SubmissionRow[];
  const cycleIds = Array.from(
    new Set(typedSubmissions.map((submission) => submission.cycle_id))
  );
  const { data: cycleRows } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status")
    .in("id", cycleIds);
  const cycleStatusById = new Map(
    (cycleRows ?? []).map((cycle) => [cycle.id, cycle.status])
  );

  
  const submissionIds = typedSubmissions.map((s) => s.id);

  const { data: votes } = includeVoteCounts
    ? await supabaseAdmin
        .from("votes")
        .select("submission_id")
        .in("submission_id", submissionIds)
    : { data: [] };

  const voteCountMap = new Map<number, number>();

  votes?.forEach((v: { submission_id: number }) => {
    voteCountMap.set(
      v.submission_id,
      (voteCountMap.get(v.submission_id) ?? 0) + 1
    );
  });

  
  const submissionsWithUrls = typedSubmissions.map((s) => ({
    ...s,
    image_url: getPublicImageUrl(s.r2_key) ?? "",
    vote_count: voteCountMap.get(s.id) ?? 0,
    destination_href: getSubmissionDestinationHref({
      cycleId: s.cycle_id,
      cycleStatus: cycleStatusById.get(s.cycle_id),
      isDisqualified: s.is_disqualified,
      publicVisibilityStatus: s.public_visibility_status,
      submissionId: s.id,
    }),
  }));

  
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
        {submissionsWithUrls.map((sub) => (
          <div
            key={sub.id}
            style={{
              width: 96,
              fontSize: 10,
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 96,
                height: 96,
                overflow: "hidden",
                border: sub.is_disqualified
                  ? "1px solid #a00"
                  : "1px solid #444",
                background: "#111",
              }}
            >
              {sub.image_url ? (
                sub.destination_href ? (
                  <a
                    href={sub.destination_href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "block" }}
                  >
                    <Image
                      src={getSubmissionThumbnailUrl(sub.image_url)}
                      alt={`Cycle ${sub.cycle_id}`}
                      width={96}
                      height={96}
                      unoptimized
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
                  <Image
                    src={getSubmissionThumbnailUrl(sub.image_url)}
                    alt={`Cycle ${sub.cycle_id}`}
                    width={96}
                    height={96}
                    unoptimized
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                      cursor: "pointer",
                    }}
                  />
                )
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

            <div style={{ marginTop: 4, opacity: 0.8 }}>
              C{sub.cycle_id}
              {includeVoteCounts ? ` · ${sub.vote_count}v` : ""}
            </div>

            {sub.is_disqualified && (
              <div style={{ color: "#a00" }}>DQ</div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
