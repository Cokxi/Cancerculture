import Image from "next/image";
import Link from "next/link";
import { formatReason } from "@/lib/profile/formatReason";
import type { DisqualificationHistoryPage } from "@/lib/profile/disqualificationHistoryReadModel.server";

function formatUtc(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function eventLabel(transition: "disqualified" | "reinstated") {
  return transition === "disqualified"
    ? "Disqualified"
    : "Reinstated";
}

export default function DisqualificationHistoryList({
  page,
  nextHref,
}: {
  page: DisqualificationHistoryPage;
  nextHref: string | null;
}) {
  if (page.items.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-gray-300">
        No disqualification history is available.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {page.legacyMayBeIncomplete ? (
        <div
          className="rounded-xl border border-yellow-400/30 bg-yellow-500/10 p-4 text-sm text-yellow-100"
          role="status"
        >
          Some older moderation history is incomplete. Only recorded
          events are shown; missing events are never inferred.
        </div>
      ) : null}

      {page.items.map((item) => (
        <article
          key={item.submissionId}
          className="rounded-xl border border-white/10 bg-black/40 p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row">
            {item.imageUrl ? (
              <Image
                src={item.imageUrl}
                alt={`Submission ${item.submissionId}`}
                width={128}
                height={128}
                className="h-32 w-32 rounded-lg object-cover"
                unoptimized
              />
            ) : (
              <div className="flex h-32 w-32 items-center justify-center rounded-lg bg-white/5 text-sm text-white/50">
                No preview
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-white">
                  Cycle #{item.cycleId} · Submission #{item.submissionId}
                </h2>
                <span
                  className={
                    item.status === "currently_disqualified"
                      ? "rounded-full bg-red-500/15 px-2.5 py-1 text-xs text-red-200"
                      : "rounded-full bg-green-500/15 px-2.5 py-1 text-xs text-green-200"
                  }
                >
                  {item.status === "currently_disqualified"
                    ? "Currently disqualified"
                    : "Reinstated"}
                </span>
              </div>

              <p className="text-xs text-gray-400">
                Latest event: {formatUtc(item.latestEventAt)} UTC
              </p>

              {item.destinationHref ? (
                <Link
                  href={item.destinationHref}
                  className="inline-flex rounded-full border border-[var(--orange-dark)]/40 px-3 py-1 text-xs text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
                >
                  View reinstated submission
                </Link>
              ) : null}
            </div>
          </div>

          <details className="mt-4 rounded-lg border border-white/10 bg-black/30 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--orange-dark)]">
              Event history ({item.eventCount})
            </summary>

            <ol className="mt-3 space-y-3">
              {item.events.map((event) => (
                <li
                  key={event.id}
                  className="rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-gray-200"
                >
                  <div className="font-semibold">
                    {eventLabel(event.transition)}
                  </div>
                  <div className="mt-1 text-xs text-gray-400">
                    {formatUtc(event.occurredAt)} UTC
                  </div>
                  <div className="mt-2 text-xs">
                    Reason:{" "}
                    {formatReason(
                      event.reasonCode ?? event.reasonCategory
                    )}
                  </div>
                  {event.reasonText ? (
                    <div className="mt-1 whitespace-pre-wrap text-xs text-gray-300">
                      Explanation: {event.reasonText}
                    </div>
                  ) : null}
                  {event.actorLabel ? (
                    <div className="mt-1 text-xs text-gray-300">
                      Actor: {event.actorLabel}
                    </div>
                  ) : null}
                  {event.source ? (
                    <div className="mt-1 text-xs text-gray-400">
                      Source: {event.source}
                    </div>
                  ) : null}
                  {event.legacyPartial ? (
                    <div className="mt-2 text-xs text-yellow-200">
                      Legacy record: surrounding history may be incomplete.
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        </article>
      ))}

      {page.nextCursor && nextHref ? (
        <div className="flex justify-center pt-2">
          <Link
            href={nextHref}
            className="rounded-full border border-[var(--orange-dark)]/50 px-5 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
          >
            View older history
          </Link>
        </div>
      ) : null}
    </div>
  );
}
