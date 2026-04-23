"use client";

import SponsoredBanner from "@/app/components/SponsoredBanner";
import ProfileLinkButton from "@/app/components/profile/ProfileLinkButton";
import SubmissionSocialLinks from "@/app/components/profile/SubmissionSocialLinks";
import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";
import type { SubmissionSocialLink } from "@/lib/socials/getSubmissionSocialLinks";
import { useEffect, useRef, useState } from "react";

type Winner = {
  id: number;
  submission_id: number;
  image_url: string;
  cycle_id: number;
  created_at: string;
  discord_username: string;
  public_profile_id: string | null;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
  vote_count: number | null;
  social_links: SubmissionSocialLink[];
};

export default function FameGrid({
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

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActive(null);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
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
                border-[var(--orange-dark)]/30
                bg-neutral-950
                transition
                duration-200
                group-hover:scale-[1.02]
                group-hover:shadow-xl
              "
            >
              <img
                src={getThumbUrl(winner.image_url)}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
              />

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
