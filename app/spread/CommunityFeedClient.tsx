"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import LoadMoreButton from "@/app/components/ui/LoadMoreButton";
import {
  COMMUNITY_FEEDS,
  type CommunityFeedContext,
  type CommunityFeedItem,
  type CommunityFeedKind,
  type CommunityFeedPage,
} from "@/lib/feed/communityFeed";
import {
  COMMUNITY_FEED_DESCRIPTIONS,
  COMMUNITY_FEED_LABELS,
  getCommunityFeedHref,
  isCommunityFeedPage,
  mergeCommunityFeedItems,
} from "@/lib/feed/communityFeedSurface";
import {
  COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS,
  COMMUNITY_FEED_VIEWPORT_DWELL_MS,
  COMMUNITY_FEED_VIEWPORT_THRESHOLD,
  createCommunityFeedResumeRecord,
  getCommunityFeedResumeStorageKey,
  isCommunityFeedResumeCurrent,
  parseCommunityFeedResumeRecord,
  type CommunityFeedResumeRecord,
} from "@/lib/feed/communityFeedResume";

const FEED_ORDER = Object.values(COMMUNITY_FEEDS);

function initialFallbackNotice(page: CommunityFeedPage) {
  if (page.cursorState === "anchor_unavailable_reset") {
    return "That submission is no longer available in this feed. We started from the beginning.";
  }
  if (page.cursorState === "context_unavailable_reset") {
    return "That Live position expired after the Cycle changed or reset. We started from the beginning.";
  }
  return null;
}

function getFallbackNotice(page: CommunityFeedPage) {
  return page.cursorState === "context_unavailable_reset"
    ? "Your saved Live position expired after the Cycle changed or reset. We started from the beginning."
    : "Your saved submission is no longer public in this feed. We started from the beginning.";
}

function mediaStyle(item: CommunityFeedItem): CSSProperties {
  return {
    aspectRatio:
      item.mediaWidth && item.mediaHeight
        ? `${item.mediaWidth} / ${item.mediaHeight}`
        : "4 / 3",
  };
}

export function CommunityFeedCard({
  feed,
  item,
  position,
}: {
  feed: CommunityFeedKind;
  item: CommunityFeedItem;
  position: number;
}) {
  const titleId = `spread-submission-${item.submissionId}-title`;
  const hasDimensions = Boolean(item.mediaWidth && item.mediaHeight);

  return (
    <article
      id={`submission-${item.submissionId}`}
      tabIndex={-1}
      role="article"
      aria-labelledby={titleId}
      aria-posinset={position}
      data-feed-submission-id={item.submissionId}
      className="scroll-mt-52 overflow-hidden rounded-3xl border border-white/10 bg-black/55 shadow-xl shadow-black/30 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <h2 id={titleId} className="text-sm font-semibold text-white/90">
          Cycle #{item.cycleNumber}
        </h2>
        <div className="flex flex-wrap justify-end gap-2 text-xs text-white/60">
          {feed === "live" ? (
            <span className="rounded-full bg-red-500/15 px-2.5 py-1 font-semibold text-red-200">
              Live
            </span>
          ) : (
            <>
              {item.rankInCycle ? (
                <span>Rank #{item.rankInCycle}</span>
              ) : null}
              {item.finalVoteCount ? (
                <span>
                  {item.finalVoteCount} vote
                  {item.finalVoteCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div
        className="relative w-full overflow-hidden bg-neutral-950"
        style={mediaStyle(item)}
      >
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Feed URLs are already canonical public media; intrinsic dimensions and a fixed aspect box prevent layout shifts.
          <img
            src={item.imageUrl}
            alt={`Community submission from Cycle #${item.cycleNumber}`}
            width={hasDimensions ? item.mediaWidth ?? undefined : undefined}
            height={hasDimensions ? item.mediaHeight ?? undefined : undefined}
            loading={position === 1 ? "eager" : "lazy"}
            fetchPriority={position === 1 ? "high" : "auto"}
            decoding="async"
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : (
          <div
            role="img"
            aria-label="Submission image unavailable"
            className="absolute inset-0 grid place-items-center bg-gradient-to-br from-neutral-900 to-black px-6 text-center text-sm text-white/55"
          >
            This submission image is currently unavailable.
          </div>
        )}
      </div>

      <div className="px-4 py-3 text-xs text-white/50 sm:px-5">
        <time dateTime={item.finalizedAt ?? item.createdAt}>
          {new Date(item.finalizedAt ?? item.createdAt).toLocaleDateString(
            "en-GB",
            { day: "2-digit", month: "short", year: "numeric" }
          )}
        </time>
      </div>
    </article>
  );
}

async function readPageResponse(response: Response, feed: CommunityFeedKind) {
  if (!response.ok) throw new Error("COMMUNITY_FEED_REQUEST_FAILED");
  const value: unknown = await response.json();
  if (!isCommunityFeedPage(value) || value.feed !== feed) {
    throw new Error("COMMUNITY_FEED_RESPONSE_INVALID");
  }
  return value;
}

export default function CommunityFeedClient({
  feed,
  feedLabel,
  initialAnchorRequested,
  initialPage,
}: {
  feed: CommunityFeedKind;
  feedLabel: string;
  initialAnchorRequested: boolean;
  initialPage: CommunityFeedPage;
}) {
  const [page, setPage] = useState(initialPage);
  const [resumeRecord, setResumeRecord] =
    useState<CommunityFeedResumeRecord | null>(null);
  const [resumedFromSavedPlace, setResumedFromSavedPlace] = useState(false);
  const [notice, setNotice] = useState<string | null>(() =>
    initialFallbackNotice(initialPage)
  );
  const [error, setError] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const feedListRef = useRef<HTMLDivElement>(null);
  const prefetchMarkerRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const writeTimerRef = useRef<number | null>(null);
  const prefetchRef = useRef<{
    cursor: string;
    promise: Promise<CommunityFeedPage | null>;
  } | null>(null);

  const storageKey = getCommunityFeedResumeStorageKey(feed);

  const clearSavedProgress = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {}
  }, [storageKey]);

  const fetchPage = useCallback(
    async ({
      cursor,
      anchorSubmissionId,
    }: {
      cursor?: string;
      anchorSubmissionId?: number;
    }) => {
      const params = new URLSearchParams({ feed });
      if (cursor) params.set("cursor", cursor);
      if (anchorSubmissionId) {
        params.set("anchor", String(anchorSubmissionId));
      }
      const response = await fetch(`/api/community-feed?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      return readPageResponse(response, feed);
    },
    [feed]
  );

  useEffect(() => {
    if (initialAnchorRequested) return;

    let serialized: string | null = null;
    try {
      serialized = window.localStorage.getItem(storageKey);
    } catch {
      return;
    }

    if (!serialized) return;
    const record = parseCommunityFeedResumeRecord(serialized);
    if (!record || !isCommunityFeedResumeCurrent(record, feed, initialPage.context)) {
      clearSavedProgress();
      return;
    }
    setResumeRecord(record);
  }, [
    clearSavedProgress,
    feed,
    initialAnchorRequested,
    initialPage.context,
    storageKey,
  ]);

  const scheduleProgressWrite = useCallback(
    (submissionId: number) => {
      const context: CommunityFeedContext | null = page.context;
      if (!context) return;

      if (writeTimerRef.current !== null) {
        window.clearTimeout(writeTimerRef.current);
      }

      writeTimerRef.current = window.setTimeout(() => {
        writeTimerRef.current = null;
        try {
          const record = createCommunityFeedResumeRecord({
            feed,
            submissionId,
            context,
          });
          window.localStorage.setItem(storageKey, JSON.stringify(record));
        } catch {}
      }, COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS);
    },
    [feed, page.context, storageKey]
  );

  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null) {
        window.clearTimeout(writeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (resumeRecord || !page.context || typeof IntersectionObserver === "undefined") {
      return;
    }

    const dwellTimers = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const existingTimer = dwellTimers.get(entry.target);
          if (
            entry.isIntersecting &&
            entry.intersectionRatio >= COMMUNITY_FEED_VIEWPORT_THRESHOLD
          ) {
            if (existingTimer !== undefined) continue;
            const timer = window.setTimeout(() => {
              dwellTimers.delete(entry.target);
              const rawId = (entry.target as HTMLElement).dataset
                .feedSubmissionId;
              const submissionId = Number(rawId);
              if (Number.isSafeInteger(submissionId) && submissionId > 0) {
                scheduleProgressWrite(submissionId);
              }
            }, COMMUNITY_FEED_VIEWPORT_DWELL_MS);
            dwellTimers.set(entry.target, timer);
          } else if (existingTimer !== undefined) {
            window.clearTimeout(existingTimer);
            dwellTimers.delete(entry.target);
          }
        }
      },
      { threshold: [COMMUNITY_FEED_VIEWPORT_THRESHOLD] }
    );

    const cards = feedListRef.current?.querySelectorAll(
      "[data-feed-submission-id]"
    );
    cards?.forEach((card) => observer.observe(card));

    return () => {
      observer.disconnect();
      dwellTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [page.context, page.items, resumeRecord, scheduleProgressWrite]);

  useEffect(() => {
    const marker = prefetchMarkerRef.current;
    const cursor = page.nextCursor;
    if (
      !marker ||
      !cursor ||
      !page.hasMore ||
      resumeRecord ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (prefetchRef.current?.cursor === cursor) return;

        prefetchRef.current = {
          cursor,
          promise: fetchPage({ cursor }).catch(() => null),
        };
        observer.disconnect();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [fetchPage, page.hasMore, page.nextCursor, resumeRecord]);

  const focusNotice = () => {
    window.requestAnimationFrame(() => noticeRef.current?.focus());
  };

  const handleDismissResume = () => {
    clearSavedProgress();
    setResumeRecord(null);
    setError(null);
    setRestartError(null);
    setNotice(null);
  };

  const handleStartFromBeginning = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setRestartError(null);

    try {
      const startPage = await fetchPage({});
      prefetchRef.current = null;
      clearSavedProgress();
      setResumeRecord(null);
      setResumedFromSavedPlace(false);
      setPage(startPage);
      setNotice("Showing the newest submissions.");
      window.history.replaceState(
        window.history.state,
        "",
        getCommunityFeedHref(feed)
      );
      window.scrollTo({ top: 0, behavior: "auto" });
      focusNotice();
    } catch {
      setRestartError(
        "Could not load the newest submissions. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleContinue = async () => {
    if (!resumeRecord || isLoading) return;
    setIsLoading(true);
    setError(null);

    try {
      const resumedPage = await fetchPage({
        anchorSubmissionId: resumeRecord.submissionId,
      });
      prefetchRef.current = null;
      setPage(resumedPage);
      setResumeRecord(null);

      if (resumedPage.cursorState === "continued") {
        setResumedFromSavedPlace(true);
        setNotice(null);
        window.requestAnimationFrame(() => {
          feedListRef.current
            ?.querySelector<HTMLElement>("[data-feed-submission-id]")
            ?.focus();
        });
      } else {
        clearSavedProgress();
        setResumedFromSavedPlace(false);
        setNotice(getFallbackNotice(resumedPage));
        focusNotice();
      }
    } catch {
      setError("Could not restore your saved place. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadMore = async () => {
    const cursor = page.nextCursor;
    if (!cursor || !page.hasMore || isLoading) return;
    setIsLoading(true);
    setError(null);

    try {
      const prefetched = prefetchRef.current;
      const nextPage =
        prefetched?.cursor === cursor
          ? await prefetched.promise
          : await fetchPage({ cursor });
      prefetchRef.current = null;
      if (!nextPage) throw new Error("COMMUNITY_FEED_PREFETCH_FAILED");

      if (nextPage.cursorState !== "continued") {
        setPage(nextPage);
        clearSavedProgress();
        setResumedFromSavedPlace(false);
        setNotice(getFallbackNotice(nextPage));
        window.scrollTo({ top: 0, behavior: "auto" });
        focusNotice();
        return;
      }

      setPage((current) => ({
        ...nextPage,
        items: mergeCommunityFeedItems(current.items, nextPage.items),
      }));
    } catch {
      setError("Could not load more. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <header className="pointer-events-none fixed inset-x-0 top-0 z-40 h-44">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(to_bottom,#0b0b0b_0%,#0b0b0b_86%,transparent_100%)]"
        />
        <div className="pointer-events-auto relative mx-auto mt-16 w-[calc(100%-2rem)] max-w-3xl rounded-[2rem] border-2 border-orange-500/70 bg-black/95 p-2 shadow-lg shadow-black/50 backdrop-blur sm:flex sm:items-center sm:gap-3 sm:px-3">
          <h1 className="shrink-0 px-3 pb-1 text-center font-['Permanent_Marker'] text-xl leading-none text-[var(--orange-main)] sm:pb-0 sm:text-2xl">
            The Spread
          </h1>
          <nav className="min-w-0 flex-1" aria-label="Community feeds">
            <ul className="flex gap-1 overflow-x-auto rounded-full bg-black/60 p-1">
              {FEED_ORDER.map((kind) => (
                <li key={kind} className="min-w-fit flex-1">
                  <Link
                    href={getCommunityFeedHref(kind)}
                    aria-current={kind === feed ? "page" : undefined}
                    className={`flex min-h-11 items-center justify-center rounded-full px-3 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] sm:text-sm ${
                      kind === feed
                        ? "bg-[var(--orange-dark)] text-white"
                        : "text-white/65 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    {COMMUNITY_FEED_LABELS[kind]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <div aria-hidden="true" className="h-44" />

      <p className="mx-auto mb-6 max-w-xl text-center text-sm leading-6 text-white/65 sm:text-base">
        {COMMUNITY_FEED_DESCRIPTIONS[feed]}
      </p>

      {resumeRecord ? (
        <section
          aria-labelledby="spread-resume-title"
          className="relative mb-6 rounded-2xl border border-[var(--orange-main)]/35 bg-[var(--orange-dark)]/10 p-5 pr-14"
        >
          <button
            type="button"
            disabled={isLoading}
            onClick={handleDismissResume}
            aria-label="Dismiss saved place"
            className="absolute right-3 top-3 grid min-h-11 min-w-11 place-items-center rounded-full text-xl text-white/65 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] disabled:opacity-50"
          >
            <span aria-hidden="true">&times;</span>
          </button>
          <h2 id="spread-resume-title" className="text-lg font-semibold">
            Resume {feedLabel}?
          </h2>
          <p className="mt-2 text-sm leading-6 text-white/65">
            A saved place is available on this browser.
          </p>
          <div className="mt-4">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void handleContinue()}
              className="min-h-11 w-full rounded-xl bg-[var(--orange-dark)] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[var(--orange-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 sm:w-auto"
            >
              {isLoading ? "Restoring..." : "Continue where you left off"}
            </button>
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-red-300">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}

      {resumedFromSavedPlace ? (
        <section
          aria-label="Saved place controls"
          className="mb-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/45 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-white/70">
            Continued from your saved place.
          </p>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => void handleStartFromBeginning()}
            className="min-h-11 rounded-xl border border-white/20 bg-black/40 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] disabled:opacity-50"
          >
            {isLoading ? "Loading newest..." : "Start from the beginning"}
          </button>
          {restartError ? (
            <p role="alert" className="text-sm text-red-300 sm:basis-full">
              {restartError}
            </p>
          ) : null}
        </section>
      ) : null}

      {notice ? (
        <p
          ref={noticeRef}
          role="status"
          tabIndex={-1}
          className="mb-6 rounded-xl border border-white/10 bg-black/45 px-4 py-3 text-sm text-white/70 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
        >
          {notice}
        </p>
      ) : null}

      <div
        ref={feedListRef}
        role="feed"
        aria-label={`${feedLabel} submissions`}
        aria-busy={isLoading}
        className="space-y-6"
      >
        {page.items.map((item, index) => (
          <CommunityFeedCard
            key={item.submissionId}
            feed={feed}
            item={item}
            position={index + 1}
          />
        ))}
      </div>

      {page.items.length === 0 && !page.hasMore ? (
        <div className="rounded-2xl border border-white/10 bg-black/45 px-6 py-10 text-center text-white/60">
          {feed === "live"
            ? "No live submissions right now."
            : feed === "trash"
              ? "Trash is empty for now."
              : "Nothing has reached this feed yet."}
        </div>
      ) : null}

      <div ref={prefetchMarkerRef} aria-hidden="true" className="h-px" />
      <LoadMoreButton
        error={resumeRecord ? null : error}
        hasMore={page.hasMore}
        isLoading={isLoading}
        onLoadMore={() => void handleLoadMore()}
      />
    </>
  );
}
