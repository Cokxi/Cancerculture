"use client";

import Image from "next/image";

export default function SponsoredBanner({
  bannerUrl,
  companyName,
  sponsorLink,
  className = "",
}: {
  bannerUrl: string;
  companyName: string;
  sponsorLink?: string;
  className?: string;
}) {
  const bannerContent = (
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
  );

  if (sponsorLink) {
    return (
      <a
        href={sponsorLink}
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
