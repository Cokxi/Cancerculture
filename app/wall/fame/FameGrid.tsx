"use client";

import SponsoredBanner from "@/app/components/SponsoredBanner";
import ProfileLinkButton from "@/app/components/profile/ProfileLinkButton";
import SubmissionSocialLinks from "@/app/components/profile/SubmissionSocialLinks";
import LoadMoreButton from "@/app/components/ui/LoadMoreButton";
import ModalCloseButton from "@/app/components/ui/ModalCloseButton";
import {
  SUBMISSION_PUBLIC_VISIBILITY,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import type { PublicPage } from "@/lib/pagination/publicPagination";
import { usePublicPagination } from "@/lib/pagination/usePublicPagination";
import { formatReason } from "@/lib/profile/formatReason";
import type { PublicWallItem } from "@/lib/walls/publicWallTypes";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type Winner = PublicWallItem;

function getVisibilityTitle(
  status: SubmissionPublicVisibilityStatus
) {
  if (status === SUBMISSION_PUBLIC_VISIBILITY.removed) {
    return "Image removed from public view";
  }

  if (status === SUBMISSION_PUBLIC_VISIBILITY.legalReview) {
    return "Image hidden pending legal review";
  }

  return "Image unavailable";
}

function VisibilityPlaceholder({
  winner,
  className = "",
}: {
  winner: Winner;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-lg bg-yellow-500/10 px-6 text-center text-white/80 ${className}`}
    >
      <div className="text-sm font-semibold">
        {getVisibilityTitle(winner.public_visibility_status)}
      </div>
      {winner.public_visibility_reason_code ? (
        <div className="mt-2 text-xs text-white/60">
          {formatReason(winner.public_visibility_reason_code)}
        </div>
      ) : null}
      {winner.public_visibility_reason_text ? (
        <div className="mt-1 text-xs text-white/60">
          {winner.public_visibility_reason_text}
        </div>
      ) : null}
    </div>
  );
}

export default function FameGrid({
  initialPage,
}: {
  initialPage: PublicPage<Winner>;
}) {
  const [active, setActive] = useState<Winner | null>(null);
  const [showOriginalSize, setShowOriginalSize] = useState(false);
  const lastTapRef = useRef(0);
  const getWinnerKey = useCallback(
    (winner: Winner) => winner.id,
    []
  );
  const fetchPage = useCallback(async (cursor: string) => {
    const response = await fetch(
      `/api/wall/fame?cursor=${encodeURIComponent(cursor)}`,
      { cache: "no-store" }
    );
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error ?? "LOAD_FAILED");
    }

    return data as PublicPage<Winner>;
  }, []);
  const {
    error,
    hasMore,
    isLoading,
    items: winners,
    loadMore,
  } = usePublicPagination({
    fetchPage,
    getKey: getWinnerKey,
    initialPage,
  });

  function handleToggleSize() {
    setShowOriginalSize((prev) => !prev);
  }

  function handleTouchStart() {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      handleToggleSize();
    }
    lastTapRef.current = now;
  }

  function getThumbUrl(imageUrl: string) {
    const url = new URL(imageUrl);
    return `${url.origin}/cdn-cgi/image/w=400,q=75${url.pathname}`;
  }

  useEffect(() => {
    if (!active) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActive(null);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active]);

  if (winners.length === 0 && !hasMore) {
    return (
      <p className="text-center text-lg opacity-60">
        No winners yet.
      </p>
    );
  }

  return (
    <>
      {winners.length > 0 ? (
        <div
        className="
          grid
          grid-cols-2
          sm:grid-cols-3
          md:grid-cols-5
          lg:grid-cols-7
          gap-4
        "
      >
        {winners.map((winner) => (
          <div
            key={winner.id}
            onClick={() => {
              setShowOriginalSize(false);
              setActive(winner);
            }}
            className="group cursor-pointer"
          >
            <div
              className="
                relative
                aspect-square
                overflow-hidden
                rounded-xl
                border-2
                border-[var(--orange-dark)]/30
                bg-neutral-950
                transition
                duration-200
                group-hover:scale-[1.02]
                group-hover:shadow-xl
              "
            >
              {winner.image_url ? (
                <img
                  src={getThumbUrl(winner.image_url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <VisibilityPlaceholder
                  winner={winner}
                  className="absolute inset-0 rounded-none px-3 text-sm"
                />
              )}

              <div
                className="
                  absolute
                  inset-x-0
                  bottom-0
                  bg-gradient-to-t
                  from-black/70
                  to-transparent
                  p-2
                "
              >
                <div className="text-[11px] text-white/80">
                  {winner.created_at
                    ? new Date(
                        winner.created_at
                      ).toLocaleDateString("en-GB")
                    : "Unknown"}
                </div>
              </div>
            </div>
          </div>
        ))}
        </div>
      ) : null}

      <LoadMoreButton
        error={error}
        hasMore={hasMore}
        isLoading={isLoading}
        onLoadMore={() => void loadMore()}
      />

      {active && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/90 p-6"
          onClick={() => setActive(null)}
        >
          <div
            className="relative mx-auto w-fit rounded-xl bg-black"
            onClick={(e) => e.stopPropagation()}
          >
            <ModalCloseButton onClick={() => setActive(null)} />

            {active.image_url ? (
              <img
                src={active.image_url}
                alt=""
                onDoubleClick={handleToggleSize}
                onTouchStart={handleTouchStart}
                className={
                  showOriginalSize
                    ? "mx-auto h-auto w-auto max-w-none rounded-lg"
                    : "mx-auto h-auto max-h-[75vh] w-auto max-w-[75vw] rounded-lg object-contain"
                }
              />
            ) : (
              <VisibilityPlaceholder
                winner={active}
                className="h-[60vh] w-[60vw] min-w-[280px]"
              />
            )}

            <div className="flex justify-center pb-2">
              <button
                onClick={handleToggleSize}
                className="cursor-pointer rounded-full bg-black/50 px-3 py-1 text-xs text-white hover:bg-black/70"
              >
                {showOriginalSize ? "Fit to Screen" : "Tap to Zoom"}
              </button>
            </div>

            <div className="mt-4 text-white">
              <div className="mb-3 flex justify-end">
                <span className="rounded-full bg-green-500/15 px-3 py-1 text-xs text-green-300">
                  Winner
                </span>
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_316px] md:items-start">
                <div className="space-y-3">
                  <div className="text-lg font-semibold">
                    Cycle #{active.cycle_id}
                  </div>

                  <div className="text-sm opacity-80">
                    {active.vote_count ?? 0} vote
                    {active.vote_count === 1 ? "" : "s"}
                  </div>

                  <div className="space-y-2 text-sm opacity-80">
                    <div>
                      <strong>User:</strong>{" "}
                      <ProfileLinkButton
                        currentUsername={active.discord_username}
                        profileId={active.public_profile_id}
                      />
                    </div>

                    <div className="break-all text-xs opacity-70">
                      <strong>Wallet:</strong>{" "}
                      {active.wallet_address
                        ? active.wallet_address
                        : active.payout_choice === "donate"
                        ? "No wallet required for full donation"
                        : "Not provided"}
                    </div>

                    <div>
                      {active.payout_choice === "keep" && (
                        <span>Chose to keep the reward</span>
                      )}

                      {active.payout_choice === "donate" && (
                        <span>
                          Donated 100% to {active.charity}
                        </span>
                      )}

                      {active.payout_choice === "split" &&
                        active.split_percent !== null && (
                          <div className="space-y-1">
                            <div>
                              {active.discord_username} receives {active.split_percent}%
                            </div>
                            <div>
                              {100 - active.split_percent}% goes to {active.charity}
                            </div>
                          </div>
                        )}
                    </div>
                  </div>

                </div>

                {active.sponsored_meta?.enabled &&
                active.sponsored_meta.bannerUrl ? (
                  <div className="md:pt-1">
                    <SponsoredBanner
                      bannerUrl={
                        active.sponsored_meta.bannerUrl
                      }
                      companyName={
                        active.sponsored_meta.companyName
                      }
                      sponsorLink={
                        active.sponsored_meta.sponsorLink
                      }
                      sponsorshipId={
                        active.sponsored_meta.sponsorshipId
                      }
                      surface="fame_modal"
                      label="Sponsored by:"
                    />
                  </div>
                ) : null}
              </div>

              {active.social_links.length > 0 && (
                <SubmissionSocialLinks
                  socials={active.social_links}
                  className="mx-auto mt-4 w-full max-w-md"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
