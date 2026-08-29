"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import SubmissionReportPanel from "@/app/components/SubmissionReportPanel";
import {
  getCommunityFeedCanonicalUrl,
} from "@/lib/feed/communityFeedDetail";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import { getCommunityFeedHref } from "@/lib/feed/communityFeedSurface";
import { shareCommunityFeedMeme } from "@/lib/feed/communityFeedShare";

export type SavedMemeAccountState =
  | "unknown"
  | "authenticated"
  | "anonymous"
  | "unavailable";

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("COPY_FAILED");
}

export default function CommunityFeedCardActions({
  submissionId,
  saved,
  savedStateKnown,
  accountState,
  onSavedChange,
  feed,
  turnstileSiteKey,
  commentAction = null,
}: {
  submissionId: number;
  saved: boolean;
  savedStateKnown: boolean;
  accountState: SavedMemeAccountState;
  onSavedChange: (saved: boolean) => void;
  feed: CommunityFeedKind;
  turnstileSiteKey: string | null;
  commentAction?: ReactNode | null;
}) {
  const router = useRouter();
  const [shareBusy, setShareBusy] = useState(false);
  const [shareOptionsOpen, setShareOptionsOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const requestIdentityRef = useRef(0);
  const shareBusyRef = useRef(false);
  const shareOptionsId = `community-feed-share-options-${submissionId}`;

  function canonicalUrl() {
    return getCommunityFeedCanonicalUrl(submissionId);
  }

  async function copyLink(message = "Meme link copied.") {
    try {
      await copyToClipboard(canonicalUrl());
      setStatus(message);
    } catch {
      setStatus("Could not copy the meme link. Please copy it from the address bar.");
    }
  }

  async function shareNative() {
    if (shareBusyRef.current) return;
    shareBusyRef.current = true;
    setShareBusy(true);
    setStatus(null);
    try {
      const outcome = await shareCommunityFeedMeme({ submissionId });
      if (outcome === "unsupported") {
        setStatus("Native sharing is not available here. Use Copy Link instead.");
      } else if (outcome === "aborted") {
        setStatus("Sharing canceled.");
      } else if (outcome === "failed") {
        setStatus("Sharing did not work. Use Copy Link instead.");
      }
    } finally {
      shareBusyRef.current = false;
      setShareBusy(false);
    }
  }

  function loginForSave() {
    const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    router.push(
      `/api/auth/discord/login?state=${encodeURIComponent(returnPath)}`,
    );
  }

  async function toggleSaved() {
    if (accountState === "anonymous") {
      loginForSave();
      return;
    }
    if (saveBusy || accountState === "unavailable") return;

    const requestIdentity = requestIdentityRef.current + 1;
    requestIdentityRef.current = requestIdentity;
    const nextSaved = !saved;
    onSavedChange(nextSaved);
    setSaveBusy(true);
    setStatus(null);

    try {
      const response = await fetch(
        `/api/account/saved-memes/${submissionId}`,
        {
          method: saved ? "DELETE" : "PUT",
          cache: "no-store",
        },
      );
      const data: unknown = await response.json().catch(() => null);
      if (requestIdentity !== requestIdentityRef.current) return;
      if (response.status === 401) {
        onSavedChange(saved);
        loginForSave();
        return;
      }
      const result =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      if (
        !response.ok ||
        result.submissionId !== submissionId ||
        result.saved !== nextSaved ||
        !["saved", "removed", "unchanged"].includes(String(result.outcome))
      ) {
        throw new Error(
          response.status === 409 ? "MEME_NOT_PUBLIC" : "SAVE_FAILED",
        );
      }
      setStatus(nextSaved ? "Saved to My Saved Memes." : "Removed from saved memes.");
    } catch (error) {
      if (requestIdentity !== requestIdentityRef.current) return;
      onSavedChange(saved);
      setStatus(
        error instanceof Error && error.message === "MEME_NOT_PUBLIC"
          ? "This meme is no longer public and could not be saved."
          : "Could not update this saved meme. Please try again.",
      );
    } finally {
      if (requestIdentity === requestIdentityRef.current) setSaveBusy(false);
    }
  }

  return (
    <div className="relative border-t border-orange-500/20 px-3 py-2.5 sm:px-4">
      <div
        className={`grid items-start justify-center gap-2 ${
          commentAction
            ? "grid-cols-4 sm:grid-cols-[repeat(5,max-content)]"
            : "grid-cols-3 sm:grid-cols-[repeat(4,max-content)]"
        }`}
      >
        <button
          type="button"
          disabled={shareBusy}
          aria-busy={shareBusy}
          aria-label={shareBusy ? "Preparing share" : "Share"}
          aria-controls={shareOptionsId}
          aria-expanded={shareOptionsOpen}
          onClick={() => {
            if (window.matchMedia("(max-width: 639px)").matches) {
              setShareOptionsOpen((current) => !current);
              return;
            }
            void shareNative();
          }}
          className="inline-flex h-11 w-full min-w-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-orange-500/35 px-1 text-xs font-semibold text-orange-100 transition hover:border-orange-400/70 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-wait disabled:opacity-60 sm:w-auto sm:gap-2 sm:px-4 sm:text-sm"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="hidden h-4 w-4 fill-none stroke-current sm:block" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 5h5v5" />
            <path d="M10 14 19 5" />
            <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
          <span>
            {shareBusy ? "Preparing..." : "Share"}
          </span>
        </button>
        <button
          type="button"
          aria-label="Copy Link"
          onClick={() => copyLink()}
          className="hidden h-11 cursor-pointer items-center justify-center gap-2 rounded-full border border-white/20 px-4 text-sm font-semibold text-white transition hover:border-white/35 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 sm:inline-flex sm:w-auto"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M16 8V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1" />
          </svg>
          <span>Copy Link</span>
        </button>
        <button
          type="button"
          onClick={toggleSaved}
          disabled={saveBusy || accountState === "unavailable"}
          aria-pressed={savedStateKnown ? saved : false}
          aria-label={saveBusy ? "Saving" : savedStateKnown && saved ? "Saved" : "Save"}
          className="inline-flex h-11 w-full min-w-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-orange-500/35 px-1 text-xs font-semibold text-orange-100 transition hover:border-orange-400/70 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto sm:gap-2 sm:px-4 sm:text-sm"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className={`hidden h-4 w-4 stroke-current sm:block ${savedStateKnown && saved ? "fill-current" : "fill-none"}`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
          </svg>
          <span>
            {saveBusy
              ? "Saving..."
              : savedStateKnown && saved
                ? "Saved"
                : "Save"}
          </span>
        </button>
        {commentAction}
        <SubmissionReportPanel
          isAuthenticated={accountState === "authenticated"}
          loginReturnPath={getCommunityFeedHref(feed, submissionId)}
          submissionId={submissionId}
          surface={feed === "live" ? "active" : "history"}
          reportingOpen
          turnstileSiteKey={turnstileSiteKey}
          presentation="feed_action"
        />
        {shareOptionsOpen ? (
          <div
            id={shareOptionsId}
            className="col-span-full grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-black/85 p-2 sm:hidden"
          >
            <button
              type="button"
              disabled={shareBusy}
              onClick={() => {
                setShareOptionsOpen(false);
                void shareNative();
              }}
              className="inline-flex h-10 cursor-pointer items-center justify-center rounded-full border border-orange-500/35 px-3 text-xs font-semibold text-orange-100 transition hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-wait disabled:opacity-60"
            >
              Share…
            </button>
            <button
              type="button"
              onClick={() => {
                setShareOptionsOpen(false);
                void copyLink();
              }}
              className="inline-flex h-10 cursor-pointer items-center justify-center rounded-full border border-white/20 px-3 text-xs font-semibold text-white transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              Copy Link
            </button>
          </div>
        ) : null}
      </div>

      {status ? (
        <p role="status" className="mt-2 text-xs text-white/70">
          {status}
        </p>
      ) : null}
    </div>
  );
}
