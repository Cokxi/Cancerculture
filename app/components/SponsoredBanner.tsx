"use client";

import { useEffect, useRef, useState } from "react";
import SponsorImpressionTracker from "@/app/components/SponsorImpressionTracker";
import { useSponsorAnalytics } from "@/app/components/sponsors/SponsorAnalyticsProvider";

export default function SponsoredBanner({
  bannerUrl,
  companyName,
  clickUrl,
  impressionUrl,
  measurementToken,
  format = "detail",
  label,
  className = "",
}: {
  bannerUrl: string;
  companyName: string;
  clickUrl: string;
  impressionUrl: string;
  measurementToken: string;
  format?: "detail" | "feed";
  label?: string;
  className?: string;
}) {
  const [bannerReady, setBannerReady] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const { consent, registerValidSponsorPresentation } = useSponsorAnalytics();
  const aspectRatio = format === "feed" ? 6 : 2;
  const aspectClassName =
    format === "feed" ? "aspect-[6/1]" : "aspect-[2/1]";

  useEffect(() => {
    const banner = bannerRef.current;
    if (!bannerReady || !measurementToken || !banner) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      registerValidSponsorPresentation();
      observer.disconnect();
    });
    observer.observe(banner);
    return () => observer.disconnect();
  }, [bannerReady, measurementToken, registerValidSponsorPresentation]);

  return (
    <div ref={bannerRef} className={bannerReady ? "relative" : "hidden"}>
      <SponsorImpressionTracker
        enabled={bannerReady && consent === "granted"}
        impressionUrl={impressionUrl}
        measurementToken={measurementToken}
      />
      {label ? (
        <div className="mb-2 text-center font-['Permanent_Marker'] text-sm tracking-[0.08em] text-[var(--orange-dark)]">
          {label}
        </div>
      ) : null}
      <a
        href={clickUrl}
        target="_blank"
        rel="noreferrer"
        className="block"
      >
        <div
          className={`relative ${aspectClassName} overflow-hidden rounded-lg border border-white/10 bg-black/30 ${className}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- same-origin fail-closed Sponsor media route */}
          <img
            src={bannerUrl}
            alt={`${companyName} sponsor banner`}
            decoding="async"
            onLoad={(event) => {
              const image = event.currentTarget;
              setBannerReady(
                image.naturalWidth > 0 &&
                  image.naturalHeight > 0 &&
                  image.naturalWidth === image.naturalHeight * aspectRatio
              );
            }}
            onError={() => setBannerReady(false)}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
      </a>
    </div>
  );
}
