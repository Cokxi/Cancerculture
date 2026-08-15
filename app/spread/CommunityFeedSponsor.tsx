"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import {
  isCommunityFeedSponsorPresentation,
  type CommunityFeedSponsorPresentation,
} from "@/lib/feed/communityFeedSponsor";
import {
  SPONSOR_VIEWPORT_DWELL_MS,
  SPONSOR_VIEWPORT_THRESHOLD,
} from "@/lib/sponsors/viewability";
import { useSponsorAnalytics } from "@/app/components/sponsors/SponsorAnalyticsProvider";

export default function CommunityFeedSponsor({
  feed,
  submissionId,
  cycleNumber,
}: {
  feed: CommunityFeedKind;
  submissionId: number;
  cycleNumber: number | null;
}) {
  const [presentation, setPresentation] =
    useState<CommunityFeedSponsorPresentation | null>(null);
  const [bannerReady, setBannerReady] = useState(false);
  const { consent, registerValidSponsorPresentation } = useSponsorAnalytics();
  const presentationRef =
    useRef<CommunityFeedSponsorPresentation | null>(null);
  const loadRef = useRef<HTMLSpanElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const refreshPresentation = useCallback(async (signal?: AbortSignal) => {
    const sponsorValue: unknown = await fetch(
      `/api/community-feed/sponsor/presentation/${submissionId}?${new URLSearchParams({
        feed,
        ...(cycleNumber === null ? {} : { cycle: String(cycleNumber) }),
      }).toString()}`,
      { cache: "no-store", signal }
    ).then((response) => response.json());
    if (
      isCommunityFeedSponsorPresentation(
        sponsorValue,
        feed,
        submissionId,
        cycleNumber
      )
    ) {
      const previous = presentationRef.current;
      if (
        !previous?.sponsored ||
        !sponsorValue.sponsored ||
        previous.bannerUrl !== sponsorValue.bannerUrl
      ) {
        setBannerReady(false);
      }
      presentationRef.current = sponsorValue;
      setPresentation(sponsorValue);
      return sponsorValue;
    }
    setBannerReady(false);
    presentationRef.current = null;
    setPresentation(null);
    return null;
  }, [cycleNumber, feed, submissionId]);

  useEffect(() => {
    const loadElement = loadRef.current;
    if (!loadElement) return;
    const controller = new AbortController();
    let loaded = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loaded) return;
        loaded = true;
        observer.disconnect();
        void refreshPresentation(controller.signal).catch(() => undefined);
      },
      { rootMargin: "800px 0px" }
    );
    observer.observe(loadElement);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [feed, refreshPresentation, submissionId]);

  useEffect(() => {
    const element = viewRef.current;
    if (
      !element ||
      !bannerReady ||
      !presentation?.sponsored ||
      !presentation.measurementToken
    ) {
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      registerValidSponsorPresentation();
      observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    bannerReady,
    presentation,
    registerValidSponsorPresentation,
  ]);

  useEffect(() => {
    const element = viewRef.current;
    if (
      !element ||
      !presentation?.sponsored ||
      !bannerReady ||
      !presentation.measurementToken ||
      consent !== "granted"
    ) {
      return;
    }

    let timer: number | null = null;
    let intersecting = false;
    let qualified = false;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const reset = () => {
      clear();
      qualified = false;
    };
    const start = async () => {
      clear();
      if (qualified || !intersecting || document.visibilityState !== "visible") {
        return;
      }
      if (
        !presentation.measurementTokenExpiresAt ||
        Date.parse(presentation.measurementTokenExpiresAt) <= Date.now() + 1_500
      ) {
        await refreshPresentation().catch(() => undefined);
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (!intersecting || document.visibilityState !== "visible") return;
        qualified = true;
        void fetch(presentation.impressionUrl, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: presentation.measurementToken }),
          keepalive: true,
        }).catch(() => undefined);
      }, SPONSOR_VIEWPORT_DWELL_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting =
          Boolean(entry) && entry.intersectionRatio >= SPONSOR_VIEWPORT_THRESHOLD;
        if (intersecting) void start();
        else reset();
      },
      { threshold: [SPONSOR_VIEWPORT_THRESHOLD] }
    );
    const visibility = () => {
      if (document.visibilityState === "visible") void start();
      else reset();
    };

    observer.observe(element);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clear();
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [bannerReady, consent, presentation, refreshPresentation]);

  if (!presentation) {
    return (
      <span
        ref={loadRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
      />
    );
  }
  if (!presentation.sponsored) return null;

  return (
    <aside
      ref={viewRef}
      aria-label={`Sponsored by ${presentation.companyName}`}
      className={
        bannerReady
          ? "border-t border-white/10 bg-orange-950/20 px-4 py-4 sm:px-5"
          : "hidden"
      }
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-orange-200/80">
        Sponsored Cycle by · {presentation.companyName}
      </div>
      <a
        href={presentation.clickUrl}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-xl border border-orange-200/15 bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- same-origin moderated sponsor media route */}
        <img
          src={presentation.bannerUrl}
          alt={`${presentation.companyName} sponsor banner`}
          decoding="async"
          onLoad={(event) => {
            const image = event.currentTarget;
            setBannerReady(
              image.naturalWidth > 0 &&
                image.naturalHeight > 0 &&
                image.naturalWidth === image.naturalHeight * 6
            );
          }}
          onError={() => setBannerReady(false)}
          className="aspect-[6/1] w-full object-contain"
        />
      </a>
    </aside>
  );
}
