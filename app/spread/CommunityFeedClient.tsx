"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import LoadMoreButton from "@/app/components/ui/LoadMoreButton";
import {
  CommunityFeedCycleNavigatorButton,
  CommunityFeedCycleNavigatorDrawer,
  CommunityFeedCycleNavigatorPanel,
} from "@/app/spread/CommunityFeedCycleNavigator";
import CommunityFeedSponsor from "@/app/spread/CommunityFeedSponsor";
import {
  COMMUNITY_FEEDS,
  type CommunityFeedContext,
  type CommunityFeedCycleCatalogItem,
  type CommunityFeedItem,
  type CommunityFeedKind,
  type CommunityFeedPage,
} from "@/lib/feed/communityFeed";
import { getCommunityFeedDetailHref } from "@/lib/feed/communityFeedDetail";
import {
  COMMUNITY_FEED_DESCRIPTIONS,
  COMMUNITY_FEED_LABELS,
  getCommunityFeedHref,
  isCommunityFeedCycleCatalogPage,
  isCommunityFeedPage,
  mergeCommunityFeedCycleCatalogItems,
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
    return page.feed === "live"
      ? "That Live position expired after the Cycle changed or reset. We started from the beginning."
      : "That Cycle filter is no longer available. No other Cycle was substituted.";
  }
  return null;
}

function getFallbackNotice(page: CommunityFeedPage) {
  return page.cursorState === "context_unavailable_reset"
    ? page.feed === "live"
      ? "Your saved Live position expired after the Cycle changed or reset. We started from the beginning."
      : "Your saved Cycle filter is no longer available. No other Cycle was substituted."
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
  const hasDimensions = Boolean(item.mediaWidth && item.mediaHeight);

  return (
    <article
      id={`submission-${item.submissionId}`}
      tabIndex={-1}
      role="article"
      aria-label={`Meme ${position}`}
      aria-posinset={position}
      data-feed-submission-id={item.submissionId}
      className="scroll-mt-56 overflow-hidden rounded-3xl border border-white/10 bg-black/55 shadow-xl shadow-black/30 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] lg:scroll-mt-40"
    >
      <Link
        href={getCommunityFeedDetailHref(item.submissionId)}
        aria-label="Open meme details"
        className="block min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--orange-main)]"
      >
        <div
          className="relative w-full overflow-hidden bg-neutral-950"
          style={mediaStyle(item)}
        >
          {item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Feed URLs are already canonical public media; intrinsic dimensions and a fixed aspect box prevent layout shifts.
            <img
              src={item.imageUrl}
              alt="Community meme"
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
              aria-label="Meme image unavailable"
              className="absolute inset-0 grid place-items-center bg-gradient-to-br from-neutral-900 to-black px-6 text-center text-sm text-white/55"
            >
              This meme image is currently unavailable.
            </div>
          )}
        </div>
      </Link>

      <CommunityFeedSponsor
        feed={feed}
        submissionId={item.submissionId}
      />
    </article>
  );
}

async function readPageResponse(
  response: Response,
  feed: CommunityFeedKind,
  cycleNumber: number | null
) {
  if (!response.ok) throw new Error("COMMUNITY_FEED_REQUEST_FAILED");
  const value: unknown = await response.json();
  if (
    !isCommunityFeedPage(value) ||
    value.feed !== feed ||
    (feed !== "live" &&
      (value.context?.kind !== "finalized" ||
        value.context.cycleNumber !== cycleNumber))
  ) {
    throw new Error("COMMUNITY_FEED_RESPONSE_INVALID");
  }
  return value;
}

async function readCycleCatalogResponse(response: Response) {
  if (!response.ok) throw new Error("COMMUNITY_FEED_CYCLE_CATALOG_FAILED");
  const value: unknown = await response.json();
  if (!isCommunityFeedCycleCatalogPage(value)) {
    throw new Error("COMMUNITY_FEED_CYCLE_CATALOG_INVALID");
  }
  return value;
}

export default function CommunityFeedClient({
  feed,
  cycleNumber,
  feedLabel,
  initialAnchorRequested,
  initialPage,
}: {
  feed: CommunityFeedKind;
  cycleNumber: number | null;
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
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cycleCatalogItems, setCycleCatalogItems] = useState<
    CommunityFeedCycleCatalogItem[]
  >([]);
  const [cycleCatalogCursor, setCycleCatalogCursor] = useState<string | null>(
    null
  );
  const [cycleCatalogHasMore, setCycleCatalogHasMore] = useState(false);
  const [cycleCatalogTotalCount, setCycleCatalogTotalCount] = useState<
    number | null
  >(null);
  const [cycleCatalogLoading, setCycleCatalogLoading] = useState(false);
  const [cycleCatalogError, setCycleCatalogError] = useState<string | null>(
    null
  );
  const [cycleNavigatorOpen, setCycleNavigatorOpen] = useState(false);
  const cycleNavigatorId = useId();
  const cycleNavigatorTriggerRef = useRef<HTMLButtonElement>(null);
  const feedListRef = useRef<HTMLDivElement>(null);
  const prefetchMarkerRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const writeTimerRef = useRef<number | null>(null);
  const prefetchRef = useRef<{
    cursor: string;
    promise: Promise<CommunityFeedPage | null>;
  } | null>(null);

  const storageKey = getCommunityFeedResumeStorageKey(feed, cycleNumber);
  const finalizedFeed = feed === "live" ? null : feed;

  const closeCycleNavigator = useCallback(() => {
    setCycleNavigatorOpen(false);
  }, []);

  const loadCycleCatalog = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setCycleCatalogLoading(true);
      setCycleCatalogError(null);
      try {
        const params = new URLSearchParams();
        if (cursor) params.set("cursor", cursor);
        const query = params.size > 0 ? `?${params.toString()}` : "";
        const response = await fetch(`/api/community-feed/cycles${query}`, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal,
        });
        const catalogPage = await readCycleCatalogResponse(response);
        if (signal?.aborted) return;
        setCycleCatalogItems((current) =>
          mergeCommunityFeedCycleCatalogItems(current, catalogPage.items)
        );
        setCycleCatalogCursor(catalogPage.nextCursor);
        setCycleCatalogHasMore(catalogPage.hasMore);
        setCycleCatalogTotalCount((current) =>
          catalogPage.totalCount ?? current
        );
      } catch {
        if (signal?.aborted) return;
        setCycleCatalogError(
          "The finalized Cycle catalog is temporarily unavailable. Please try again."
        );
      } finally {
        if (!signal?.aborted) setCycleCatalogLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (feed === "live") return;
    const controller = new AbortController();
    void loadCycleCatalog(null, controller.signal);
    return () => controller.abort();
  }, [feed, loadCycleCatalog]);

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
      if (feed !== "live" && cycleNumber !== null) {
        params.set("cycle", String(cycleNumber));
      }
      if (cursor) params.set("cursor", cursor);
      if (anchorSubmissionId) {
        params.set("anchor", String(anchorSubmissionId));
      }
      const response = await fetch(`/api/community-feed?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      return readPageResponse(response, feed, cycleNumber);
    },
    [cycleNumber, feed]
  );

  useEffect(() => {
    if (feed === "live" || initialAnchorRequested) return;

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
      if (feed === "live") return;
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
    if (
      feed === "live" ||
      resumeRecord ||
      !page.context ||
      typeof IntersectionObserver === "undefined"
    ) {
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
  }, [feed, page.context, page.items, resumeRecord, scheduleProgressWrite]);

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
    setResumeError(null);
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
        getCommunityFeedHref(feed, undefined, cycleNumber)
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
    setResumeError(null);

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
      setResumeError("Could not restore your saved place. Please try again.");
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
      <header className="pointer-events-none fixed inset-x-0 top-0 z-40 h-56 lg:h-40">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(to_bottom,#0b0b0b_0%,#0b0b0b_86%,transparent_100%)]"
        />
        <div className="pointer-events-auto relative mx-auto mt-16 w-[calc(100%-2rem)] max-w-5xl rounded-[2rem] border-2 border-orange-500/70 bg-black/95 p-2 shadow-lg shadow-black/50 backdrop-blur lg:flex lg:items-center lg:gap-3 lg:px-3">
          <h1 className="shrink-0 px-3 pb-1 text-center font-['Permanent_Marker'] text-xl leading-none text-[var(--orange-main)] lg:pb-0 lg:text-2xl">
            The Spread
          </h1>
          <nav className="min-w-0 flex-1" aria-label="Community feeds">
            <ul className="flex gap-1 overflow-x-auto rounded-full bg-black/60 p-1">
              {FEED_ORDER.map((kind) => (
                <li key={kind} className="min-w-fit flex-1">
                  <Link
                    href={getCommunityFeedHref(
                      kind,
                      undefined,
                      kind === "live" ? null : cycleNumber
                    )}
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
          {finalizedFeed ? (
            <div className="mt-2 flex min-w-0 items-center justify-center px-1 lg:mt-0 lg:px-0">
              <CommunityFeedCycleNavigatorButton
                selectedCycleNumber={cycleNumber}
                controlsId={cycleNavigatorId}
                open={cycleNavigatorOpen}
                triggerRef={cycleNavigatorTriggerRef}
                hasSavedPlace={resumeRecord !== null}
                onOpen={() => setCycleNavigatorOpen(true)}
              />
            </div>
          ) : null}
        </div>
      </header>
      <div aria-hidden="true" className="h-56 lg:h-40" />

      {finalizedFeed ? (
        <CommunityFeedCycleNavigatorDrawer
          id={cycleNavigatorId}
          open={cycleNavigatorOpen}
          triggerRef={cycleNavigatorTriggerRef}
          onClose={closeCycleNavigator}
        >
          <CommunityFeedCycleNavigatorPanel
            instanceId="mobile"
            feed={finalizedFeed}
            selectedCycleNumber={cycleNumber}
            items={cycleCatalogItems}
            totalCount={cycleCatalogTotalCount}
            hasMore={cycleCatalogHasMore}
            isLoading={cycleCatalogLoading}
            error={cycleCatalogError}
            resumeAvailable={resumeRecord !== null}
            resumedFromSavedPlace={resumedFromSavedPlace}
            resumeLoading={isLoading}
            resumeError={resumeError}
            restartError={restartError}
            onContinue={() => void handleContinue()}
            onDismiss={handleDismissResume}
            onStartFromBeginning={() => void handleStartFromBeginning()}
            onLoadMore={() =>
              void loadCycleCatalog(cycleCatalogCursor)
            }
            onNavigate={closeCycleNavigator}
          />
        </CommunityFeedCycleNavigatorDrawer>
      ) : null}

      <div
        className={`mx-auto w-full ${
          finalizedFeed
            ? "max-w-6xl lg:grid lg:grid-cols-[15rem_minmax(0,48rem)] lg:justify-center lg:gap-8"
            : "max-w-3xl"
        }`}
      >
        {finalizedFeed ? (
          <aside
            aria-label="Finalized Cycle navigator"
            className="hidden lg:block lg:self-stretch"
          >
            <div
              className="fixed top-40 w-60 max-h-[calc(100dvh-11rem)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
              style={{ left: "max(1.5rem, calc(50% - 32.5rem))" }}
            >
              <CommunityFeedCycleNavigatorPanel
                instanceId="desktop"
                feed={finalizedFeed}
                selectedCycleNumber={cycleNumber}
                items={cycleCatalogItems}
                totalCount={cycleCatalogTotalCount}
                hasMore={cycleCatalogHasMore}
                isLoading={cycleCatalogLoading}
                error={cycleCatalogError}
                resumeAvailable={resumeRecord !== null}
                resumedFromSavedPlace={resumedFromSavedPlace}
                resumeLoading={isLoading}
                resumeError={resumeError}
                restartError={restartError}
                onContinue={() => void handleContinue()}
                onDismiss={handleDismissResume}
                onStartFromBeginning={() => void handleStartFromBeginning()}
                onLoadMore={() =>
                  void loadCycleCatalog(cycleCatalogCursor)
                }
              />
            </div>
          </aside>
        ) : null}

        <div className="min-w-0">
          <p className="mx-auto mb-6 max-w-xl text-center text-sm leading-6 text-white/65 sm:text-base">
            {COMMUNITY_FEED_DESCRIPTIONS[feed]}
          </p>

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
            error={error}
            hasMore={page.hasMore}
            isLoading={isLoading}
            onLoadMore={() => void handleLoadMore()}
          />
        </div>
      </div>
    </>
  );
}
