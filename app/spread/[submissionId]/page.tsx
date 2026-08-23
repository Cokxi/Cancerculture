import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import SponsoredBanner from "@/app/components/SponsoredBanner";
import CommunityFeedDetailCloseButton from "@/app/spread/[submissionId]/CommunityFeedDetailCloseButton";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import {
  getCommunityFeedDetailMetadataSource,
  getCommunityFeedDetailPageData,
} from "@/lib/feed/communityFeedDetail.server";
import { createCommunityFeedMetadata } from "@/lib/feed/communityFeedMetadata";
import PublicPayoutDetails from "@/app/components/payouts/PublicPayoutDetails";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseSubmissionId(value: string) {
  const submissionId = Number(value);
  return Number.isSafeInteger(submissionId) && submissionId > 0
    ? submissionId
    : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}): Promise<Metadata> {
  const submissionId = parseSubmissionId((await params).submissionId);
  if (!submissionId) return createCommunityFeedMetadata(null);

  try {
    const source = await getCommunityFeedDetailMetadataSource(submissionId);
    return createCommunityFeedMetadata(source);
  } catch {
    return createCommunityFeedMetadata(null);
  }
}

function mediaStyle(
  width: number | null,
  height: number | null
): CSSProperties {
  return {
    aspectRatio: width && height ? `${width} / ${height}` : "4 / 3",
  };
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDateTime(value: string) {
  return `${dateTimeFormatter.format(new Date(value))} UTC`;
}

function DateTime({ value }: { value: string }) {
  return <time dateTime={value}>{formatDateTime(value)}</time>;
}

export default async function CommunityFeedDetailPage({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}) {
  const submissionId = parseSubmissionId((await params).submissionId);
  if (!submissionId) notFound();

  const pageData = await getCommunityFeedDetailPageData(submissionId);
  if (!pageData) notFound();
  const { detail } = pageData;
  const sponsor = await getCycleSponsoredMeta(
    pageData.cycleId,
    "spread_detail"
  );

  const hasDimensions = Boolean(detail.mediaWidth && detail.mediaHeight);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(120,53,15,0.22),transparent_42%),linear-gradient(to_bottom,#17110e,#090909)] text-white">
      <main
        data-hides-global-account
        className="relative z-[80] mx-auto flex min-h-screen w-full max-w-4xl items-start px-3 py-4 sm:px-6 sm:py-8"
      >
        <article
          aria-labelledby="spread-detail-title"
          className="relative w-full overflow-hidden rounded-3xl border border-white/10 bg-neutral-950/95 shadow-2xl shadow-black/60"
        >
          <h1 id="spread-detail-title" className="sr-only">
            Community meme detail
          </h1>
          <CommunityFeedDetailCloseButton />

          <div className="overflow-hidden bg-black/55">
            <div
              className="relative w-full overflow-hidden bg-neutral-950"
              style={mediaStyle(detail.mediaWidth, detail.mediaHeight)}
            >
              {detail.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- same-origin no-store detail media is reauthorized on every request.
                <img
                  src={detail.imageUrl}
                  alt="Community meme"
                  width={hasDimensions ? detail.mediaWidth ?? undefined : undefined}
                  height={hasDimensions ? detail.mediaHeight ?? undefined : undefined}
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
          </div>

          <div data-spread-detail-lower-content className="space-y-5 p-4 sm:p-6">
            <div data-spread-detail-sponsor-slot>
              {sponsor ? (
                <SponsoredBanner
                  bannerUrl={sponsor.bannerUrl}
                  companyName={sponsor.companyName}
                  clickUrl={sponsor.clickUrl}
                  impressionUrl={sponsor.impressionUrl}
                  measurementToken={sponsor.measurementToken}
                  format="feed"
                  label="Sponsored by"
                />
              ) : null}
            </div>

            <details className="group rounded-2xl border border-white/10 bg-black/45">
              <summary
                id="spread-detail-metadata-title"
                className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-xl font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--orange-main)] sm:px-6"
              >
                <span>Cycle and result</span>
                <span
                  aria-hidden="true"
                  className="text-2xl leading-none text-white/60 transition-transform group-open:rotate-180"
                >
                  ⌄
                </span>
              </summary>

              <div className="border-t border-white/10 px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
                {detail.state === "finalized" && detail.author ? (
                  <div className="mb-5 border-b border-white/10 pb-5">
                    <p className="mb-2 text-sm text-white/55">Submitted by</p>
                    <Link
                      href={`/profile/${encodeURIComponent(detail.author.publicProfileId)}`}
                      className="inline-flex min-h-12 items-center gap-3 rounded-xl pr-3 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
                    >
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-500/20 text-lg font-semibold text-orange-100">
                        {detail.author.avatarUrl ? (
                          <Image
                            src={detail.author.avatarUrl}
                            alt=""
                            width={48}
                            height={48}
                            unoptimized
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span aria-hidden="true">?</span>
                        )}
                      </span>
                      <span>
                        <span className="block font-semibold text-white">
                          {detail.author.displayName}
                        </span>
                        <span className="block text-xs text-white/55">
                          View public profile
                        </span>
                      </span>
                    </Link>
                  </div>
                ) : null}

                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-white/55">Cycle</dt>
                  <dd className="mt-1 font-semibold">#{detail.cycleNumber}</dd>
                </div>
                <div>
                  <dt className="text-white/55">Added to the Cycle</dt>
                  <dd className="mt-1 font-semibold">
                    <DateTime value={detail.createdAt} />
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-white/55">Cycle run</dt>
                  <dd className="mt-1 font-semibold">
                    {detail.cycleStartedAt ? (
                      <DateTime value={detail.cycleStartedAt} />
                    ) : (
                      "Start unavailable"
                    )}
                    {" – "}
                    {detail.cycleEndedAt ? (
                      <DateTime value={detail.cycleEndedAt} />
                    ) : detail.state === "live" ? (
                      "in progress"
                    ) : (
                      "End unavailable"
                    )}
                  </dd>
                </div>
                {detail.state === "finalized" ? (
                  <>
                    <div>
                      <dt className="text-white/55">Final rank</dt>
                      <dd className="mt-1 font-semibold">
                        #{detail.rankInCycle}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-white/55">Final votes</dt>
                      <dd className="mt-1 font-semibold">
                        {detail.finalVoteCount}
                      </dd>
                    </div>
                  </>
                ) : null}
                </dl>
                {detail.payout ? <PublicPayoutDetails payout={detail.payout} /> : null}
              </div>
            </details>

            {/* A reusable finalized comment thread can mount here after its own contract. */}
            <div data-spread-detail-community-slot aria-hidden="true" />
          </div>
        </article>
      </main>
    </div>
  );
}
