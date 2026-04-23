"use client";

import SponsoredBanner from "@/app/components/SponsoredBanner";
import ProfileLinkButton from "@/app/components/profile/ProfileLinkButton";
import SubmissionSocialLinks from "@/app/components/profile/SubmissionSocialLinks";
import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";
import { formatReason } from "@/lib/profile/formatReason";
import {
  SUBMISSION_PUBLIC_VISIBILITY,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import type { SubmissionSocialLink } from "@/lib/socials/getSubmissionSocialLinks";
import { useEffect, useRef, useState } from "react";

type Winner = {
  id: number;
  submission_id: number;
  image_url: string | null;
  cycle_id: number;
  created_at: string;
  discord_username: string;
  public_profile_id: string | null;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
  vote_count: number | null;
  public_visibility_status: SubmissionPublicVisibilityStatus;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
  social_links: SubmissionSocialLink[];
};

export default function ShameGrid({
  winners,
  sponsoredMetaByCycleId,
}: {
  winners: Winner[];
  sponsoredMetaByCycleId: Record<number, SponsoredCycleMeta | null>;
}) {
  const [active, setActive] = useState<Winner | null>(null);
  const [showOriginalSize, setShowOriginalSize] = useState(false);
  const lastTapRef = useRef(0);

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

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);

  if (!winners || winners.length === 0) {
    return (
      <p className="text-center text-lg opacity-60">
        No winners yet.
      </p>
    );
  }

  return (
    <>
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
                border-red-500/30
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
                <div className="absolute inset-0 flex items-center justify-center bg-red-500/10 px-3 text-center text-sm text-white/80">
                  Hidden pending legal review
                </div>
              )}

              <div
                className="
                  absolute
                  inset-x-0
                  bottom-0
                  bg-gradient-to-t
                  from-black/80
                  to-transparent
                  p-2
                "
              >
                <div className="text-[11px] text-red-200/70">
                  {new Date(winner.created_at).toLocaleDateString("en-GB")}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/90 p-6"
          onClick={() => setActive(null)}
        >
          <button
            onClick={() => setActive(null)}
            className="fixed top-4 right-4 z-[60] flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-2xl text-white hover:bg-black/80"
          >
            ×
          </button>

          <div
            className="relative mx-auto w-fit rounded-xl bg-black"
            onClick={(e) => e.stopPropagation()}
          >
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
              <div className="flex h-[60vh] w-[60vw] min-w-[280px] items-center justify-center rounded-lg bg-red-500/10 px-6 text-center text-white/80">
                Hidden pending legal review
              </div>
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
                    {active.public_visibility_status !==
                      SUBMISSION_PUBLIC_VISIBILITY.visible && (
                      <div className="rounded-lg bg-yellow-500/10 p-3 text-yellow-200">
                        <div className="font-semibold">
                          Temporarily hidden pending legal review
                        </div>
                        {active.public_visibility_reason_code && (
                          <div className="mt-1 text-xs">
                            {formatReason(
                              active.public_visibility_reason_code
                            )}
                          </div>
                        )}
                        {active.public_visibility_reason_text && (
                          <div className="mt-1 text-xs">
                            {active.public_visibility_reason_text}
                          </div>
                        )}
                      </div>
                    )}

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
                        <span>{active.discord_username} chose to keep the prize</span>
                      )}

                      {active.payout_choice === "donate" && (
                        <span>Still donated 100%</span>
                      )}

                      {active.payout_choice === "split" &&
                        active.split_percent !== null && (
                          <span>
                            Split {active.split_percent}% / {active.charity}
                          </span>
                        )}
                    </div>
                  </div>

                </div>

                {sponsoredMetaByCycleId[active.cycle_id]?.enabled &&
                sponsoredMetaByCycleId[active.cycle_id]?.bannerUrl ? (
                  <div className="md:pt-1">
                    <SponsoredBanner
                      bannerUrl={
                        sponsoredMetaByCycleId[active.cycle_id]
                          ?.bannerUrl ?? ""
                      }
                      companyName={
                        sponsoredMetaByCycleId[active.cycle_id]
                          ?.companyName ?? ""
                      }
                      sponsorLink={
                        sponsoredMetaByCycleId[active.cycle_id]
                          ?.sponsorLink ?? ""
                      }
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
