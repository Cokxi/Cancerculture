export const dynamic = "force-dynamic";

import Link from "next/link";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { hasResolvedTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  loadCommunityCommentModerationExplorer,
  type CommunityCommentModerationExplorerItem,
} from "@/lib/comments/commentModeration.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type SearchQuery = Readonly<{
  comment?: string | string[];
  submission?: string | string[];
  details?: string | string[];
  beforeAt?: string | string[];
  beforeId?: string | string[];
}>;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Europe/Vienna",
  }).format(new Date(value));
}

function statusLabel(status: CommunityCommentModerationExplorerItem["currentStatus"]): string {
  if (status === "team_removed") return "Removed by Team";
  if (status === "author_deleted") return "Deleted by author";
  return "Visible";
}

function groupItems(items: readonly CommunityCommentModerationExplorerItem[]) {
  const groups = new Map<string, CommunityCommentModerationExplorerItem[]>();
  for (const item of items) {
    const group = groups.get(item.publicCommentId) ?? [];
    group.push(item);
    groups.set(item.publicCommentId, group);
  }
  return [...groups.values()].map((events) => [...events].reverse());
}

function buildPageHref(input: Readonly<{
  comment: string;
  submission: string;
  details: boolean;
  beforeAt?: string;
  beforeId?: number;
}>): string {
  const params = new URLSearchParams();
  if (input.comment) params.set("comment", input.comment);
  if (input.submission) params.set("submission", input.submission);
  if (input.details) params.set("details", "1");
  if (input.beforeAt && input.beforeId) {
    params.set("beforeAt", input.beforeAt);
    params.set("beforeId", String(input.beforeId));
  }
  const query = params.toString();
  return query ? `/admin/logs/comment-moderation?${query}` : "/admin/logs/comment-moderation";
}

export default async function CommunityCommentModerationLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchQuery>;
}) {
  const pageContext = await requireTeamCapabilityPage(
    "logs.community_comment_moderation.view",
    "/admin/logs/comment-moderation",
  );
  const query = await searchParams;
  const comment = one(query.comment);
  const submission = one(query.submission);
  const beforeAt = one(query.beforeAt);
  const beforeIdRaw = one(query.beforeId);
  const includeSensitive = one(query.details) === "1";
  const submissionId = /^\d+$/u.test(submission) && Number.isSafeInteger(Number(submission))
    ? Number(submission)
    : null;
  const beforeId = /^\d+$/u.test(beforeIdRaw) && Number.isSafeInteger(Number(beforeIdRaw))
    ? Number(beforeIdRaw)
    : null;
  const filterError = comment && !UUID_PATTERN.test(comment)
    ? "Enter one complete public Comment UUID."
    : submission && (submissionId === null || submissionId < 1)
      ? "Submission ID must be a positive whole number."
      : (beforeAt || beforeIdRaw) && (
        !beforeAt || beforeId === null || beforeId < 1 || Number.isNaN(Date.parse(beforeAt))
      )
        ? "The history cursor is invalid. Clear the filters and try again."
        : null;
  const data = filterError
    ? {
      items: [],
      sensitiveDetailsIncluded: false,
      canViewSensitiveDetails: hasResolvedTeamCapability(
        pageContext,
        "logs.community_comment_moderation.details.view",
      ),
    }
    : await loadCommunityCommentModerationExplorer({
      publicCommentId: comment || null,
      submissionId,
      beforeCreatedAt: beforeAt || null,
      beforeId,
      includeSensitive,
    });
  const groups = groupItems(data.items);
  const oldest = data.items.at(-1);
  const hasNextPage = data.items.length === 50 && oldest !== undefined;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">
          Comment Moderation Explorer
        </h1>
        <p className="mt-2 max-w-4xl text-white/65">
          Search the durable Remove and Restore audit stream and review each Comment as one
          chronological timeline. Reporter identity, raw Spam signals and Discord IDs remain excluded.
        </p>
      </header>

      <form className="grid gap-4 rounded-2xl border border-white/10 bg-black/35 p-5 lg:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)_auto]">
        <label className="space-y-2 text-sm text-white/70">
          <span>Exact public Comment ID</span>
          <input
            name="comment"
            defaultValue={comment}
            placeholder="00000000-0000-0000-0000-000000000000"
            autoComplete="off"
            className="w-full rounded-xl border border-white/15 bg-black/45 px-3 py-2 text-white outline-none focus:border-[var(--orange-main)]"
          />
        </label>
        <label className="space-y-2 text-sm text-white/70">
          <span>Exact Submission ID</span>
          <input
            name="submission"
            defaultValue={submission}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            className="w-full rounded-xl border border-white/15 bg-black/45 px-3 py-2 text-white outline-none focus:border-[var(--orange-main)]"
          />
        </label>
        <div className="flex items-end gap-2">
          <button className="rounded-xl bg-[var(--orange-main)] px-4 py-2 font-semibold text-black">
            Search
          </button>
          <Link
            href="/admin/logs/comment-moderation"
            className="rounded-xl border border-white/15 px-4 py-2 text-white/75 hover:border-white/35 hover:text-white"
          >
            Clear
          </Link>
        </div>
        {data.canViewSensitiveDetails ? (
          <label className="flex items-center gap-2 text-sm text-white/70 lg:col-span-3">
            <input
              type="checkbox"
              name="details"
              value="1"
              defaultChecked={data.sensitiveDetailsIncluded}
              className="size-4 accent-[var(--orange-main)]"
            />
            Show protected reviewed text and internal reasons
          </label>
        ) : null}
      </form>

      {filterError ? (
        <p role="alert" className="rounded-2xl border border-red-400/35 bg-red-950/25 p-4 text-red-100">
          {filterError}
        </p>
      ) : null}

      {data.canViewSensitiveDetails && !data.sensitiveDetailsIncluded ? (
        <p className="rounded-2xl border border-amber-300/20 bg-amber-950/15 p-4 text-sm text-amber-100/80">
          Protected evidence is hidden by default. Enable it above only when the exact reviewed text or
          internal reason is needed.
        </p>
      ) : null}

      <div className="space-y-5">
        {groups.map((events) => {
          const current = events.at(-1)!;
          return (
            <article
              key={current.publicCommentId}
              className="rounded-2xl border border-white/10 bg-black/35 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.16em] text-white/45">Public Comment ID</p>
                  <p className="mt-1 break-all font-mono text-sm text-white/90">{current.publicCommentId}</p>
                  <p className="mt-2 text-sm text-white/55">
                    Submission #{current.submissionId} · object v{current.currentObjectVersion} · moderation v{current.currentModerationVersion} · text v{current.currentTextVersion}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/75">
                    {statusLabel(current.currentStatus)}
                  </span>
                  <Link
                    href={`/spread/${current.submissionId}?comment=${current.publicCommentId}`}
                    className="rounded-full border border-orange-300/30 px-3 py-1 text-xs text-orange-100 hover:border-orange-300/60"
                  >
                    Open public position
                  </Link>
                </div>
              </div>

              <ol className="relative mt-5 space-y-5 border-l border-white/15 pl-5">
                {events.map((event) => (
                  <li key={event.id} className="relative">
                    <span className="absolute -left-[1.45rem] top-1.5 size-2 rounded-full bg-[var(--orange-main)]" />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-semibold text-white">
                        {event.action === "remove" ? "Removed" : "Restored"} · moderation v{event.moderationVersion}
                      </p>
                      <time className="text-xs text-white/45">{formatDate(event.createdAt)}</time>
                    </div>
                    <p className="mt-1 text-sm text-white/55">
                      Object v{event.fromObjectVersion} → v{event.toObjectVersion} · {event.actorDisplayName} · {event.actorRole}
                    </p>
                    {event.reviewedTextVersionState === "bound" ? (
                      <p className="mt-2 text-sm text-emerald-200/75">
                        Evidence bound to immutable text version {event.reviewedTextVersion}.
                      </p>
                    ) : (
                      <p className="mt-2 text-sm text-amber-200/75">
                        Legacy event: the exact reviewed text version cannot be proven.
                      </p>
                    )}
                    {data.sensitiveDetailsIncluded ? (
                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <p className="text-xs uppercase tracking-wide text-white/40">Reviewed text</p>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/80">
                            {event.reviewedTextVersionState === "bound"
                              ? event.reviewedText ?? "No retained text for this bound version."
                              : "Unavailable for legacy evidence."}
                          </p>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <p className="text-xs uppercase tracking-wide text-white/40">Internal reason</p>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/80">
                            {event.internalReason ?? "Unavailable."}
                          </p>
                        </div>
                      </div>
                    ) : null}
                    {event.sourceCaseLinkAvailable && event.sourceCaseId && event.sourceTopic ? (
                      <Link
                        href={`/admin/inbox/${event.sourceTopic}/${event.sourceCaseId}`}
                        className="mt-3 inline-flex text-sm text-orange-200 underline decoration-orange-200/35 underline-offset-4"
                      >
                        Open source {event.sourceTopic === "comment_reports" ? "Comment Report" : "Spam Review"} Case
                      </Link>
                    ) : event.sourceTopic ? (
                      <p className="mt-3 text-xs text-white/40">
                        Source: {event.sourceTopic.replaceAll("_", " ")} · Case link requires its exact View right.
                      </p>
                    ) : (
                      <p className="mt-3 text-xs text-white/40">Source: standalone moderation</p>
                    )}
                  </li>
                ))}
              </ol>
            </article>
          );
        })}
      </div>

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-white/10 p-6 text-white/60">
          {comment || submission ? "No matching Comment moderation events." : "No Comment moderation events."}
        </p>
      ) : null}

      {hasNextPage ? (
        <Link
          href={buildPageHref({
            comment,
            submission,
            details: includeSensitive,
            beforeAt: oldest.createdAt,
            beforeId: oldest.id,
          })}
          className="inline-flex rounded-xl border border-white/15 px-4 py-2 text-white/75 hover:border-white/35 hover:text-white"
        >
          Older events
        </Link>
      ) : null}
    </section>
  );
}
