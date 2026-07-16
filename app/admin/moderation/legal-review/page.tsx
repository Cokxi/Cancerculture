import { requireAdminPage } from "@/lib/auth/pageAccess";
import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import ReviewActions from "./review-actions";

type ReviewSubmissionRow = {
  id: number;
  cycle_id: number;
  r2_key: string | null;
  discord_user_id: string;
  discord_username_at_upload: string | null;
  public_visibility_status: string | null;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
  public_visibility_updated_at: string | null;
  public_visibility_updated_by_discord_username: string | null;
  public_visibility_source: string;
  is_disqualified: boolean;
};

function buildThumbUrl(imageUrl: string | null) {
  if (!imageUrl) {
    return null;
  }

  const url = new URL(imageUrl);
  return `${url.origin}/cdn-cgi/image/w=400,q=75${url.pathname}`;
}

function SubmissionSection({
  title,
  description,
  submissions,
  status,
}: {
  title: string;
  description: string;
  submissions: Array<
    ReviewSubmissionRow & {
      image_url: string | null;
      thumb_url: string | null;
    }
  >;
  status: "legal_review" | "removed";
}) {
  return (
    <section
      id={status === "legal_review" ? "legal-review" : "removed"}
      className="rounded-2xl border border-white/10 bg-black/40 p-5"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            {title}
          </h2>
          <p className="mt-2 text-sm text-white/65">
            {description}
          </p>
        </div>

        <div className="rounded-full bg-white/10 px-3 py-1 text-sm text-white/80">
          {submissions.length}
        </div>
      </div>

      {submissions.length === 0 ? (
        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/65">
          No submissions in this section.
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {submissions.map((submission) => (
            <article
              key={submission.id}
              className="rounded-xl border border-white/10 bg-neutral-950 p-4"
            >
              {submission.image_url ? (
                <a
                  href={submission.image_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <img
                    src={submission.thumb_url ?? submission.image_url}
                    alt=""
                    className="h-44 w-full rounded-lg object-cover"
                  />
                </a>
              ) : (
                <div className="flex h-44 w-full items-center justify-center rounded-lg bg-white/5 text-sm text-white/60">
                  Preview unavailable
                </div>
              )}

              <div className="mt-4 space-y-2 text-sm text-white/80">
                <div>
                  <strong>Cycle:</strong> #{submission.cycle_id}
                </div>

                <div>
                  <strong>User:</strong>{" "}
                  {submission.discord_username_at_upload ?? "unknown"}
                </div>

                <div className="break-all text-xs text-white/60">
                  <strong>Discord ID:</strong>{" "}
                  {submission.discord_user_id}
                </div>

                {submission.public_visibility_reason_code ? (
                  <div>
                    <strong>Reason:</strong>{" "}
                    {submission.public_visibility_reason_code}
                  </div>
                ) : null}

                {submission.public_visibility_reason_text ? (
                  <div className="text-xs text-white/65">
                    {submission.public_visibility_reason_text}
                  </div>
                ) : null}

                {submission.public_visibility_updated_by_discord_username ? (
                  <div className="text-xs text-white/60">
                    Last updated by{" "}
                    {
                      submission.public_visibility_updated_by_discord_username
                    }
                  </div>
                ) : null}

                {submission.public_visibility_updated_at ? (
                  <div className="text-xs text-white/50">
                    {new Date(
                      submission.public_visibility_updated_at
                    ).toLocaleString()}
                  </div>
                ) : null}

                {submission.is_disqualified ? (
                  <div className="text-xs font-semibold text-red-300">
                    Competition disqualification remains active
                  </div>
                ) : null}
              </div>

              <ReviewActions
                submissionId={submission.id}
                status={status}
                visibilitySource={submission.public_visibility_source}
              />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function AdminLegalReviewPage() {
  await requireAdminPage("/admin/moderation/legal-review");

  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, discord_user_id, discord_username_at_upload, is_disqualified, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text, public_visibility_updated_at, public_visibility_updated_by_discord_username, public_visibility_source"
    )
    .in("public_visibility_status", ["legal_review", "removed"])
    .order("public_visibility_updated_at", { ascending: false });

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        Failed to load legal review submissions.
      </div>
    );
  }

  const submissions = ((data ?? []) as ReviewSubmissionRow[]).map(
    (submission) => {
      const imageUrl =
        getPublicImageUrl(submission.r2_key) ?? null;

      return {
        ...submission,
        image_url: imageUrl,
        thumb_url: buildThumbUrl(imageUrl),
      };
    }
  );

  const legalReviewSubmissions = submissions.filter(
    (submission) =>
      submission.public_visibility_status === "legal_review"
  );
  const removedSubmissions = submissions.filter(
    (submission) =>
      submission.public_visibility_status === "removed"
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
          Legal Review
        </h1>
        <p className="mt-2 text-sm text-white/65">
          Review submissions that were flagged for legal checks or already removed from public view.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <a
          href="#legal-review"
          className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-yellow-200"
        >
          Legal Review
        </a>
        <a
          href="#removed"
          className="rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-red-200"
        >
          Removed from Public
        </a>
      </div>

      <SubmissionSection
        title="Open Legal Review"
        description="These submissions are hidden pending review and can be removed or restored from here."
        submissions={legalReviewSubmissions}
        status="legal_review"
      />

      <SubmissionSection
        title="Removed from Public"
        description="These submissions were already removed from the public archive and can be restored if needed."
        submissions={removedSubmissions}
        status="removed"
      />
    </div>
  );
}
