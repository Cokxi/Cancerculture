"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type RefObject } from "react";
import type {
  CommunityFeedCycleCatalogItem,
  FinalizedCommunityFeedKind,
} from "@/lib/feed/communityFeed";
import {
  formatCommunityFeedCycleDateRange,
  getCommunityFeedHref,
  groupCommunityFeedCyclesByNumberRange,
} from "@/lib/feed/communityFeedSurface";

type ResumeControlsProps = {
  resumeAvailable: boolean;
  resumedFromSavedPlace: boolean;
  isLoading: boolean;
  resumeError: string | null;
  restartError: string | null;
  onContinue: () => void;
  onDismiss: () => void;
  onStartFromBeginning: () => void;
};

type NavigatorPanelProps = {
  instanceId: "desktop" | "mobile";
  feed: FinalizedCommunityFeedKind;
  selectedCycleNumber: number | null;
  items: CommunityFeedCycleCatalogItem[];
  totalCount: number | null;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  onLoadMore: () => void;
  onNavigate?: () => void;
} & Omit<ResumeControlsProps, "isLoading"> & {
    resumeLoading: boolean;
  };

export function CommunityFeedCycleNavigatorButton({
  selectedCycleNumber,
  controlsId,
  open,
  triggerRef,
  hasSavedPlace,
  onOpen,
}: {
  selectedCycleNumber: number | null;
  controlsId: string;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  hasSavedPlace: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="dialog"
      aria-controls={controlsId}
      aria-expanded={open}
      onClick={onOpen}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-white/20 bg-black/55 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] lg:hidden"
    >
      {hasSavedPlace ? "Resume · " : ""}
      {selectedCycleNumber === null ? "All Cycles" : `Cycle #${selectedCycleNumber}`}
      <span aria-hidden="true" className="ml-2 text-[10px]">
        ▼
      </span>
    </button>
  );
}

export function CommunityFeedResumeControls({
  resumeAvailable,
  resumedFromSavedPlace,
  isLoading,
  resumeError,
  restartError,
  onContinue,
  onDismiss,
  onStartFromBeginning,
}: ResumeControlsProps) {
  if (!resumeAvailable && !resumedFromSavedPlace) return null;

  return (
    <section
      aria-label="Saved place controls"
      className="mt-4 rounded-2xl border border-orange-400/35 bg-orange-500/10 p-3"
    >
      {resumeAvailable ? (
        <>
          <h3 className="text-sm font-semibold text-white">
            Resume where you left off
          </h3>
          <p className="mt-1 text-xs leading-5 text-white/60">
            Continue from your last saved meme in this Feed.
          </p>
          <div className="mt-3 grid gap-2">
            <button
              type="button"
              disabled={isLoading}
              onClick={onContinue}
              aria-label="Continue where you left off"
              className="min-h-11 rounded-xl bg-[var(--orange-dark)] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[var(--orange-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
            >
              {isLoading ? "Restoring…" : "Continue"}
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={onDismiss}
              aria-label="Dismiss saved place"
              className="min-h-11 rounded-xl border border-white/15 px-3 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] disabled:opacity-50"
            >
              Dismiss saved place
            </button>
          </div>
          {resumeError ? (
            <p role="alert" className="mt-3 text-xs leading-5 text-red-300">
              {resumeError}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <h3 className="text-sm font-semibold text-white">
            Browsing from your saved place
          </h3>
          <button
            type="button"
            disabled={isLoading}
            onClick={onStartFromBeginning}
            aria-label="Start from the beginning"
            className="mt-3 min-h-11 w-full rounded-xl border border-white/15 bg-black/35 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] disabled:opacity-50"
          >
            {isLoading ? "Loading…" : "Back to latest"}
          </button>
          {restartError ? (
            <p role="alert" className="mt-3 text-xs leading-5 text-red-300">
              {restartError}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export function CommunityFeedCycleNavigatorPanel({
  instanceId,
  feed,
  selectedCycleNumber,
  items,
  totalCount,
  hasMore,
  isLoading,
  error,
  onLoadMore,
  onNavigate,
  resumeAvailable,
  resumedFromSavedPlace,
  resumeLoading,
  resumeError,
  restartError,
  onContinue,
  onDismiss,
  onStartFromBeginning,
}: NavigatorPanelProps) {
  const groups = groupCommunityFeedCyclesByNumberRange(items);
  const selectedCycleIsLoaded = items.some(
    (item) => item.cycleNumber === selectedCycleNumber
  );
  const listRef = useRef<HTMLDivElement>(null);

  const handleListKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = Array.from(
      listRef.current?.querySelectorAll<HTMLAnchorElement>(
        "[data-cycle-navigation-link]"
      ) ?? []
    ).filter((link) => link.offsetParent !== null);
    if (links.length === 0) return;

    const currentIndex = links.indexOf(
      document.activeElement as HTMLAnchorElement
    );
    if (currentIndex < 0) return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    links[(currentIndex + offset + links.length) % links.length]?.focus();
  };

  return (
    <div
      aria-busy={isLoading}
      className="rounded-3xl border border-orange-500/35 bg-black/95 p-4 shadow-xl shadow-black/35"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-['Permanent_Marker'] text-xl text-[var(--orange-main)]">
            Finalized Cycles
          </h2>
          <p className="mt-1 text-xs leading-5 text-white/55">
            Choose one Cycle or browse them all.
          </p>
        </div>
      </div>

      <CommunityFeedResumeControls
        resumeAvailable={resumeAvailable}
        resumedFromSavedPlace={resumedFromSavedPlace}
        isLoading={resumeLoading}
        resumeError={resumeError}
        restartError={restartError}
        onContinue={onContinue}
        onDismiss={onDismiss}
        onStartFromBeginning={onStartFromBeginning}
      />

      {totalCount !== null ? (
        <p className="mt-4 text-xs text-white/60">
          {totalCount} finalized {totalCount === 1 ? "Cycle" : "Cycles"}
          {hasMore ? ` · ${items.length} shown` : ""}
        </p>
      ) : null}

      <form action="/spread" method="get" className="mt-4">
        <input type="hidden" name="feed" value={feed} />
        <label
          htmlFor={`cycle-jump-${feed}-${instanceId}`}
          className="block text-xs font-semibold text-white/70"
        >
          Jump to Cycle number
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id={`cycle-jump-${feed}-${instanceId}`}
            name="cycle"
            type="text"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            required
            aria-label="Public Cycle number"
            placeholder="e.g. 42"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/15 bg-black/70 px-3 text-sm text-white outline-none placeholder:text-white/35 focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
          />
          <button
            type="submit"
            className="min-h-11 rounded-xl bg-[var(--orange-dark)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--orange-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Go
          </button>
        </div>
      </form>

      <div
        ref={listRef}
        onKeyDown={handleListKeyDown}
        className="mt-4 space-y-3"
      >
        <Link
          href={getCommunityFeedHref(feed)}
          data-cycle-navigation-link
          aria-current={selectedCycleNumber === null ? "page" : undefined}
          onClick={onNavigate}
          className={`flex min-h-11 items-center rounded-xl border px-3 py-2 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] ${
            selectedCycleNumber === null
              ? "border-orange-400/70 bg-orange-500/20 text-white"
              : "border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/10 hover:text-white"
          }`}
        >
          All Cycles
        </Link>

        {selectedCycleNumber !== null && !selectedCycleIsLoaded ? (
          <p
            aria-current="page"
            className="rounded-xl border border-orange-400/70 bg-orange-500/20 px-3 py-3 text-sm font-semibold text-white"
          >
            Cycle #{selectedCycleNumber}
            <span className="mt-1 block text-xs font-normal text-white/60">
              Selected by direct link
            </span>
          </p>
        ) : null}

        {groups.map((group, groupIndex) => (
          <details
            key={group.rangeStart}
            open={
              groupIndex === 0 ||
              group.cycles.some(
                (item) => item.cycleNumber === selectedCycleNumber
              )
            }
            className="group rounded-xl border border-white/10 bg-white/[0.03]"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold text-white/75 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]">
              Cycles {group.rangeStart}–{group.rangeEnd}
              <span aria-hidden="true" className="text-xs group-open:rotate-180">
                ▼
              </span>
            </summary>
            <ul className="space-y-1 border-t border-white/10 p-2">
              {group.cycles.map((item) => {
                const active = item.cycleNumber === selectedCycleNumber;
                return (
                  <li key={item.cycleNumber}>
                    <Link
                      href={getCommunityFeedHref(
                        feed,
                        undefined,
                        item.cycleNumber
                      )}
                      data-cycle-navigation-link
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={`block min-h-11 rounded-lg px-3 py-2 text-sm leading-5 outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] ${
                        active
                          ? "bg-orange-500/20 font-semibold text-white"
                          : "text-white/65 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      Cycle #{item.cycleNumber}
                      <span className="block text-xs text-white/50">
                        {formatCommunityFeedCycleDateRange(item)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>

      {items.length === 0 && isLoading ? (
        <p role="status" className="mt-4 text-sm text-white/60">
          Loading finalized Cycles…
        </p>
      ) : null}
      {items.length === 0 && !isLoading && !error ? (
        <p role="status" className="mt-4 text-sm text-white/60">
          No finalized Cycles are available yet.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {(hasMore || error) && !isLoading ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="mt-4 min-h-11 w-full rounded-xl border border-white/15 bg-black/55 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
        >
          {error ? "Retry Cycle catalog" : "Load older Cycles"}
        </button>
      ) : null}
      {items.length > 0 && isLoading ? (
        <p role="status" className="mt-4 text-sm text-white/60">
          Loading more Cycles…
        </p>
      ) : null}
    </div>
  );
}

export function CommunityFeedCycleNavigatorDrawer({
  id,
  open,
  triggerRef,
  onClose,
  children,
}: {
  id: string;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, triggerRef]);

  if (!open) return null;

  return (
    <div id={id} className="fixed inset-x-0 bottom-0 top-16 z-[60] lg:hidden">
      <button
        type="button"
        aria-label="Close Cycle navigator"
        onClick={() => {
          onClose();
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        className="absolute inset-0 bg-black/75"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-t-3xl border-t border-orange-500/40 bg-neutral-950 p-4 shadow-2xl shadow-black"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a[href]")) onClose();
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="font-['Permanent_Marker'] text-xl text-[var(--orange-main)]">
            Cycle Navigator
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => {
              onClose();
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}
            aria-label="Close Cycle navigator"
            className="grid min-h-11 min-w-11 place-items-center rounded-full text-2xl text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
