export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Image from "next/image";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  canModerateSubmission,
  requireDisqualifiedSubmissionsPage,
} from "@/lib/moderation/submissionModerationAuthorization";
import {
  getCurrentModerationCycle,
  getDisqualifiedModerationSubmissions,
} from "@/lib/moderation/submissionModerationReadModel";
import ReinstateButton from "./reinstate-button";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";

export default async function DisqualifiedSubmissionsPage() {
  let authorization;
  let currentCycle;
  let submissions;

  try {
    authorization = await getTeamAuthorizationContext();
    currentCycle = await getCurrentModerationCycle();
    requireDisqualifiedSubmissionsPage(
      authorization,
      currentCycle?.status ?? null
    );
    submissions = currentCycle
      ? await getDisqualifiedModerationSubmissions(currentCycle.id)
      : [];
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  if (!currentCycle) {
    return (
      <div style={{ padding: 24 }}>
        No current submission or voting phase.
      </div>
    );
  }

  const canReinstate = canModerateSubmission(
    authorization,
    currentCycle.status,
    "reinstate"
  );

  return (
    <div style={{ padding: 24 }}>
      <h1>Disqualified Submissions – Cycle #{currentCycle.id}</h1>
      <p style={{ marginTop: 8, opacity: 0.7 }}>
        Current phase: {currentCycle.status}
      </p>

      {submissions.length === 0 && (
        <div style={{ marginTop: 16, opacity: 0.7 }}>
          No disqualified submissions in the current cycle.
        </div>
      )}

      {submissions.map((submission) => {
        const imageUrl = getPublicImageUrl(submission.r2_key);
        return (
          <div
            key={submission.id}
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
            {imageUrl ? (
              <a
                href={imageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
              <Image
                src={getSubmissionThumbnailUrl(imageUrl)}
                alt=""
                width={96}
                height={96}
                unoptimized
                style={{
                  width: 96,
                  height: 96,
                  objectFit: "cover",
                  border: "1px solid #444",
                  cursor: "pointer",
                }}
              />
              </a>
            ) : (
              <div
                style={{
                  width: 96,
                  height: 96,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid #444",
                  fontSize: 12,
                  opacity: 0.7,
                }}
              >
                Preview unavailable
              </div>
            )}

            <div style={{ fontSize: 13 }}>
              <div>
                <strong>Disqualified</strong>
              </div>
              {submission.disqualification_reason_code && (
                <div style={{ marginTop: 4 }}>
                  Reason:{" "}
                  <strong>
                    {submission.disqualification_reason_code.replaceAll(
                      "_",
                      " "
                    )}
                  </strong>
                </div>
              )}
              {submission.disqualification_reason_text && (
                <div style={{ opacity: 0.8 }}>
                  {submission.disqualification_reason_text}
                </div>
              )}
              {submission.disqualified_by_discord_username && (
                <div style={{ marginTop: 4, opacity: 0.7 }}>
                  Disqualified by{" "}
                  <strong>
                    {submission.disqualified_by_discord_username}
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
                  {submission.discord_user_id}
                </div>
              </div>
              {submission.disqualified_at && (
                <div style={{ opacity: 0.6 }}>
                  {new Date(
                    submission.disqualified_at
                  ).toLocaleString()}
                </div>
              )}
              {submission.vote_refund_id ? (
                <div style={{ marginTop: 8, color: "#fcd34d" }}>
                  Votes refunded · reinstatement unavailable
                </div>
              ) : canReinstate ? (
                <ReinstateButton
                  submissionId={submission.id}
                  cycleId={currentCycle.id}
                  phase={currentCycle.status}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
