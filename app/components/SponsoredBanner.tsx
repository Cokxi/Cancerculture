"use client";

import Image from "next/image";
import SponsorImpressionTracker from "@/app/components/SponsorImpressionTracker";
import type { SponsorTrackingSurface } from "@/lib/sponsors/tracking";

export default function SponsoredBanner({
  bannerUrl,
  companyName,
  sponsorLink,
  sponsorshipId,
  surface,
  label,
  className = "",
}: {
  bannerUrl: string;
  companyName: string;
  sponsorLink?: string;
  sponsorshipId?: number | null;
  surface?: SponsorTrackingSurface;
  label?: string;
  className?: string;
}) {
  const trackedHref =
    sponsorshipId && surface
      ? `/api/sponsor/click?sponsorshipId=${sponsorshipId}&surface=${surface}`
      : sponsorLink;
  const bannerContent = (
    <>
      {sponsorshipId && surface ? (
        <SponsorImpressionTracker
          sponsorshipId={sponsorshipId}
          surface={surface}
        />
      ) : null}
      {label ? (
        <div className="mb-2 text-center font-['Permanent_Marker'] text-sm tracking-[0.08em] text-[var(--orange-dark)]">
          {label}
        </div>
      ) : null}
      <div
        className={`relative aspect-[2/1] overflow-hidden rounded-lg border border-white/10 bg-black/30 ${className}`}
      >
        <Image
          src={bannerUrl}
          alt={`${companyName} sponsor banner`}
          fill
          unoptimized
          className="object-cover"
        />
      </div>
    </>
  );

  if (trackedHref) {
    return (
      <a
        href={trackedHref}
        target="_blank"
        rel="noreferrer"
        className="block"
      >
        {bannerContent}
      </a>
    );
  }

  return bannerContent;
}
