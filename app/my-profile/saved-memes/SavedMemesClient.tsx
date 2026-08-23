"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import LoadMoreButton from "@/app/components/ui/LoadMoreButton";
import {
  getCommunityFeedDetailHref,
  getCommunityFeedDetailMediaPath,
} from "@/lib/feed/communityFeedDetail";

type Item = {
  bookmarkId: number;
  submissionId: number;
  savedAt: string;
  available: boolean;
  cycleNumber: number | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
};

type Cursor = { savedAt: string; bookmarkId: number };
type Page = { items: Item[]; nextCursor: Cursor | null };

function formatSavedAt(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function isPage(value: unknown): value is Page {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.items) &&
    (page.nextCursor === null ||
      (typeof page.nextCursor === "object" && page.nextCursor !== null));
}

export default function SavedMemesClient({
  initialPage,
  preview = false,
}: {
  initialPage: Page;
  preview?: boolean;
}) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      beforeSavedAt: nextCursor.savedAt,
      beforeBookmarkId: String(nextCursor.bookmarkId),
    });
    try {
      const response = await fetch(`/api/account/saved-memes?${params}`, {
        cache: "no-store",
      });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok || !isPage(value)) throw new Error("LOAD_FAILED");
      setItems((current) => {
        const known = new Set(current.map((item) => item.bookmarkId));
        return [...current, ...value.items.filter((item) => !known.has(item.bookmarkId))];
      });
      setNextCursor(value.nextCursor);
    } catch {
      setError("Could not load more saved memes. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function remove(submissionId: number) {
    if (removingId !== null) return;
    setRemovingId(submissionId);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/account/saved-memes/${submissionId}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const value: unknown = await response.json().catch(() => null);
      const result = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
      if (!response.ok || result.submissionId !== submissionId || result.saved !== false) {
        throw new Error("REMOVE_FAILED");
      }
      setItems((current) => current.filter((item) => item.submissionId !== submissionId));
      setStatus("Removed from saved memes.");
    } catch {
      setError("Could not remove this saved meme. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className={preview ? "" : "mt-10"} aria-label="Saved memes">
      {status ? <p role="status" className="mb-4 text-center text-sm text-green-300">{status}</p> : null}
      {error ? <p role="alert" className="mb-4 text-center text-sm text-red-300">{error}</p> : null}

      {items.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <article key={item.bookmarkId} className="overflow-hidden rounded-2xl border-2 border-orange-500/35 bg-black/70 p-1">
              {item.available ? (
                <Link href={getCommunityFeedDetailHref(item.submissionId)} className="block overflow-hidden rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
                  <div className="relative aspect-[4/3] bg-neutral-950">
                    <Image
                      src={getCommunityFeedDetailMediaPath(item.submissionId)}
                      alt="Saved community meme"
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                </Link>
              ) : (
                <div className="grid aspect-[4/3] place-items-center rounded-xl bg-neutral-950 px-6 text-center">
                  <div>
                    <div aria-hidden="true" className="text-3xl text-white/25">⊘</div>
                    <p className="mt-2 text-sm font-semibold text-white/70">
                      Meme no longer publicly available
                    </p>
                    <p className="mt-1 text-xs text-white/45">
                      The private bookmark remains until you remove it.
                    </p>
                  </div>
                </div>
              )}

              <div className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/50">
                  <span>{item.available && item.cycleNumber ? `Cycle #${item.cycleNumber}` : `Submission #${item.submissionId}`}</span>
                  <time dateTime={item.savedAt}>Saved {formatSavedAt(item.savedAt)} UTC</time>
                </div>
                <button
                  type="button"
                  disabled={removingId === item.submissionId}
                  onClick={() => remove(item.submissionId)}
                  className="mt-3 min-h-11 cursor-pointer rounded-full border border-orange-500/35 px-4 py-2 text-sm text-orange-100 transition hover:bg-orange-500/10 disabled:cursor-wait disabled:opacity-60"
                >
                  {removingId === item.submissionId ? "Removing..." : "Remove from saved"}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-black/50 p-8 text-center text-white/65">
          You have not saved any public memes yet.
        </div>
      )}

      {preview ? null : (
        <LoadMoreButton
          hasMore={nextCursor !== null}
          isLoading={loading}
          error={error}
          onLoadMore={() => void loadMore()}
        />
      )}
    </section>
  );
}
