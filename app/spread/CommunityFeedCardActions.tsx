"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCommunityFeedDetailHref,
  getCommunityFeedDetailMediaPath,
} from "@/lib/feed/communityFeedDetail";

export type SavedMemeAccountState =
  | "unknown"
  | "authenticated"
  | "anonymous"
  | "unavailable";

function shareText(url: string) {
  return `Found this meme on CancerCulture: ${url}`;
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

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

function fileExtension(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/gif") return "gif";
  return "webp";
}

async function loadShareFile(submissionId: number) {
  const response = await fetch(
    getCommunityFeedDetailMediaPath(submissionId),
    { cache: "no-store" },
  );
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size === 0 || blob.size > 10_000_000) {
    return null;
  }
  return new File(
    [blob],
    `cancerculture-meme-${submissionId}.${fileExtension(blob.type)}`,
    { type: blob.type },
  );
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
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const requestIdentityRef = useRef(0);

  function canonicalUrl() {
    return new URL(
      getCommunityFeedDetailHref(submissionId),
      window.location.origin,
    ).toString();
  }

  async function copyLink(message = "Meme link copied.") {
    try {
      await copyToClipboard(canonicalUrl());
      setStatus(message);
    } catch {
      setStatus("Could not copy the meme link. Please copy it from the address bar.");
    }
  }

  function directShare(target: "whatsapp" | "telegram") {
    const url = canonicalUrl();
    const text = shareText(url);
    const targetUrl =
      target === "whatsapp"
        ? `https://wa.me/?text=${encodeURIComponent(text)}`
        : `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Found this meme on CancerCulture")}`;
    openExternal(targetUrl);
    setStatus(`Opened ${target === "whatsapp" ? "WhatsApp" : "Telegram"} sharing.`);
  }

  async function shareWithApps(target: "all" | "signal") {
    if (typeof navigator.share !== "function") {
      await copyLink(
        target === "signal"
          ? "Meme link copied. Paste it into Signal."
          : "Meme link copied.",
      );
      return;
    }

    setShareBusy(true);
    setStatus(null);
    const url = canonicalUrl();
    const baseShareData: ShareData = {
      title: "CancerCulture meme",
      text: "Found this meme on CancerCulture",
      url,
    };

    try {
      const file = await loadShareFile(submissionId).catch(() => null);
      const fileShareData: ShareData | null = file
        ? { ...baseShareData, files: [file] }
        : null;
      const data =
        fileShareData &&
        typeof navigator.canShare === "function" &&
        navigator.canShare(fileShareData)
          ? fileShareData
          : baseShareData;
      await navigator.share(data);
      setStatus("The meme was handed to your share menu.");
      setShareOpen(false);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStatus("Sharing did not complete. You can still copy the link.");
      }
    } finally {
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
          aria-expanded={shareOpen}
          aria-controls={`share-menu-${submissionId}`}
          onClick={() => {
            setShareOpen((open) => !open);
            setStatus(null);
          }}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-orange-500/35 px-4 py-2 text-sm font-semibold text-orange-100 transition hover:border-orange-400/70 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 5h5v5" />
            <path d="M10 14 19 5" />
            <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
          Share
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

      {shareOpen ? (
        <div
          id={`share-menu-${submissionId}`}
          className="mt-3 rounded-2xl border border-orange-500/30 bg-neutral-950 p-3 shadow-2xl"
        >
          <p className="text-sm font-semibold text-white">Share this meme</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <button type="button" onClick={() => directShare("whatsapp")} className="min-h-11 cursor-pointer rounded-xl bg-white/5 px-3 py-2 text-sm text-white transition hover:bg-white/10">WhatsApp</button>
            <button type="button" onClick={() => directShare("telegram")} className="min-h-11 cursor-pointer rounded-xl bg-white/5 px-3 py-2 text-sm text-white transition hover:bg-white/10">Telegram</button>
            <button type="button" disabled={shareBusy} onClick={() => shareWithApps("signal")} className="min-h-11 cursor-pointer rounded-xl bg-white/5 px-3 py-2 text-sm text-white transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60">Signal</button>
            <button type="button" disabled={shareBusy} onClick={() => shareWithApps("all")} className="min-h-11 cursor-pointer rounded-xl bg-orange-500/15 px-3 py-2 text-sm text-orange-100 transition hover:bg-orange-500/25 disabled:cursor-wait disabled:opacity-60">
              {shareBusy ? "Preparing..." : "More apps"}
            </button>
            <button type="button" onClick={() => copyLink()} className="min-h-11 cursor-pointer rounded-xl bg-white/5 px-3 py-2 text-sm text-white transition hover:bg-white/10">Copy link</button>
          </div>
        </div>
      ) : null}

      {status ? (
        <p role="status" className="mt-2 text-xs text-white/70">
          {status}
        </p>
      ) : null}
    </div>
  );
}
