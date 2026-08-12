import Link from "next/link";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { loadCycleEndModerationReadModel } from "@/lib/moderation/submissionModerationReadModel";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import ModerationGrid from "@/app/admin/moderation/submissions/ModerationGrid";

export const dynamic = "force-dynamic";

export default async function CycleEndModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; submission?: string }>;
}) {
  await requireTeamCapabilityPage(
    "cycles.manage",
    "/admin/cycles/end-moderation"
  );
  const params = await searchParams;
  const requestedPage = Number(params.page ?? "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? requestedPage
    : 1;
  const requestedSubmissionId = Number(params.submission);
  const focusedSubmissionId =
    Number.isSafeInteger(requestedSubmissionId) && requestedSubmissionId > 0
      ? requestedSubmissionId
      : null;
  const readModel = await loadCycleEndModerationReadModel(
    page,
    focusedSubmissionId
  );
  const cycle = readModel.cycle;

  if (!cycle) {
    return (
      <section className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold">Cycle End Moderation</h1>
        <p className="mt-3 text-white/65">
          This review becomes available after voting closes and ends when the
          cycle is finalized.
        </p>
        <Link
          href="/admin/cycles"
          className="mt-5 inline-flex cursor-pointer text-orange-300 underline underline-offset-4"
        >
          Return to Cycle Management
        </Link>
      </section>
    );
  }

  const result = readModel.submissions;
  if (!result) {
    throw new Error("Cycle End Moderation read model is inconsistent");
  }
  const submissions = result.items.map((submission) => {
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

  return (
    <section className="mx-auto max-w-7xl">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-300">
        Critical pre-finalization review
      </p>
      <h1 className="mt-2 text-2xl font-semibold">
        Cycle End Moderation · Cycle internal ID #{cycle.id}
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65">
        Voting is closed. Review the submissions before manually finalizing
        the cycle. Every disqualification or reinstatement is capability-
        checked, idempotent, and audited.
      </p>
      <p className="mt-2 text-sm text-white/50">
        {focusedSubmissionId === null
          ? `Showing ${submissions.length} of ${result.total} submissions.`
          : `Focused Submission #${focusedSubmissionId}.`}
      </p>
      {focusedSubmissionId !== null ? (
        <Link
          href="/admin/cycles/end-moderation"
          className="mt-3 inline-flex cursor-pointer text-orange-300 underline underline-offset-4"
        >
          View all Cycle End submissions
        </Link>
      ) : null}

      {submissions.length > 0 ? (
        <ModerationGrid
          submissions={submissions}
          phase="voting_closed"
          canDisqualify
          canReinstate
          focusedSubmissionId={focusedSubmissionId}
        />
      ) : (
        <p className="mt-8 text-white/60">
          {focusedSubmissionId === null
            ? "No submissions in this cycle."
            : `Submission #${focusedSubmissionId} is not available in the Cycle End review.`}
        </p>
      )}

      <nav className="mt-8 flex flex-wrap gap-3" aria-label="Pagination">
        {focusedSubmissionId === null && result.hasPrevious ? (
          <Link
            href={`?page=${page - 1}`}
            className="cursor-pointer rounded-md border border-white/20 px-4 py-2 hover:bg-white/10"
          >
            Previous
          </Link>
        ) : null}
        {focusedSubmissionId === null && result.hasNext ? (
          <Link
            href={`?page=${page + 1}`}
            className="cursor-pointer rounded-md border border-white/20 px-4 py-2 hover:bg-white/10"
          >
            Next
          </Link>
        ) : null}
        <Link
          href="/admin/cycles"
          className="cursor-pointer rounded-md border border-orange-300/50 px-4 py-2 text-orange-200 hover:bg-orange-500/15"
        >
          Return to Cycle Management
        </Link>
      </nav>
    </section>
  );
}
