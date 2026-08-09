import { redirect } from "next/navigation";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  canModerateSubmission,
  requireLiveModerationPage,
} from "@/lib/moderation/submissionModerationAuthorization";
import {
  getCurrentModerationCycle,
  getLiveModerationSubmissions,
} from "@/lib/moderation/submissionModerationReadModel";
import ModerationGrid from "./ModerationGrid";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";

export const dynamic = "force-dynamic";

export default async function AdminModerationSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ submission?: string }>;
}) {
  let authorization;
  let currentCycle;
  let submissions;
  const requestedSubmissionId = Number((await searchParams).submission);
  const focusedSubmissionId =
    Number.isSafeInteger(requestedSubmissionId) && requestedSubmissionId > 0
      ? requestedSubmissionId
      : null;

  try {
    authorization = await getTeamAuthorizationContext();
    currentCycle = await getCurrentModerationCycle();
    requireLiveModerationPage(
      authorization,
      currentCycle?.status ?? null
    );
    submissions = currentCycle
      ? await getLiveModerationSubmissions(
          currentCycle.id,
          focusedSubmissionId
        )
      : [];
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  if (!currentCycle) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Admin – Moderation (Submissions)</h1>
        <p>No current submission or voting phase.</p>
      </div>
    );
  }

  const submissionsWithUrls = submissions.map((submission) => {
    const imageUrl = getPublicImageUrl(submission.r2_key) ?? "";
    return {
      ...submission,
      is_disqualified: submission.is_disqualified === true,
      image_url: imageUrl,
      thumb_url: imageUrl
        ? getSubmissionThumbnailUrl(imageUrl)
        : "",
    };
  });
  const canDisqualify = canModerateSubmission(
    authorization,
    currentCycle.status,
    "disqualify"
  );
  const canReinstate = canModerateSubmission(
    authorization,
    currentCycle.status,
    "reinstate"
  );

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Moderation (Submissions)</h1>
      <p style={{ marginTop: 8, opacity: 0.7 }}>
        Cycle #{currentCycle.id} · {currentCycle.status}
      </p>

      {focusedSubmissionId !== null ? (
        <p style={{ marginTop: 8 }}>
          Focused Submission #{focusedSubmissionId} ·{" "}
          <a
            href="/admin/moderation/submissions"
            style={{ color: "#ff9800", textDecoration: "underline" }}
          >
            View all current submissions
          </a>
        </p>
      ) : null}

      {submissions.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>
          {focusedSubmissionId === null
            ? "No submissions found for the current cycle."
            : `Submission #${focusedSubmissionId} is not available in the current moderation cycle.`}
        </p>
      ) : (
        <ModerationGrid
          submissions={submissionsWithUrls}
          phase={currentCycle.status}
          canDisqualify={canDisqualify}
          canReinstate={canReinstate}
          focusedSubmissionId={focusedSubmissionId}
        />
      )}
    </div>
  );
}
