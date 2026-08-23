"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCommunityFeedCanonicalUrl,
} from "@/lib/feed/communityFeedDetail";
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
}: {
  submissionId: number;
  saved: boolean;
  savedStateKnown: boolean;
  accountState: SavedMemeAccountState;
  onSavedChange: (saved: boolean) => void;
}) {
  const router = useRouter();
  const [shareBusy, setShareBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const requestIdentityRef = useRef(0);
  const shareBusyRef = useRef(false);

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
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={shareBusy}
          aria-busy={shareBusy}
          onClick={shareNative}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-orange-500/35 px-4 py-2 text-sm font-semibold text-orange-100 transition hover:border-orange-400/70 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-wait disabled:opacity-60"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 5h5v5" />
            <path d="M10 14 19 5" />
            <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
          {shareBusy ? "Preparing..." : "Share"}
        </button>
        <button
          type="button"
          onClick={() => copyLink()}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/35 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
        >
          Copy Link
        </button>
        <button
          type="button"
          onClick={toggleSaved}
          disabled={saveBusy || accountState === "unavailable"}
          aria-pressed={savedStateKnown ? saved : false}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-orange-500/35 px-4 py-2 text-sm font-semibold text-orange-100 transition hover:border-orange-400/70 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-55"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 stroke-current ${savedStateKnown && saved ? "fill-current" : "fill-none"}`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
          </svg>
          {saveBusy
            ? "Saving..."
            : savedStateKnown && saved
              ? "Saved"
              : "Save"}
        </button>
      </div>

      {status ? (
        <p role="status" className="mt-2 text-xs text-white/70">
          {status}
        </p>
      ) : null}
    </div>
  );
}
