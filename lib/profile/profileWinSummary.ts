import type { ProfileSubmission } from "@/lib/profile/getUserProfileData";
import type { OwnWinnerClaimSummary } from "@/lib/winnerClaims/service.server";

export type ProfileWinSummary = OwnWinnerClaimSummary & {
  imageUrl: string | null;
  destinationHref: string | null;
};

export function enrichOwnWinnerClaims(
  winnings: OwnWinnerClaimSummary[] | null,
  submissions: ProfileSubmission[],
): ProfileWinSummary[] | null {
  if (winnings === null) return null;

  const submissionById = new Map(
    submissions.map((submission) => [submission.id, submission] as const),
  );

  return winnings.map((claim) => {
    const submission = submissionById.get(claim.submissionId);

    return {
      ...claim,
      imageUrl: submission?.image_url ?? null,
      destinationHref: submission?.destination_href ?? null,
    };
  });
}
