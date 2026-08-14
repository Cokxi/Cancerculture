"use client";

import { useEffect, useRef } from "react";
import type { SponsorTrackingSurface } from "@/lib/sponsors/tracking";
import {
  SPONSOR_VIEWPORT_DWELL_MS,
  SPONSOR_VIEWPORT_THRESHOLD,
} from "@/lib/sponsors/viewability";

export default function SponsorImpressionTracker({
  sponsorshipId,
  surface,
  feedKind,
}: {
  sponsorshipId: number | null | undefined;
  surface: SponsorTrackingSurface;
  feedKind?: "live" | "top10" | "all" | "trash";
}) {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!sponsorshipId || !marker) return;

    let dwellTimer: number | null = null;
    let qualified = false;
    let intersecting = false;

    const clearDwell = () => {
      if (dwellTimer !== null) window.clearTimeout(dwellTimer);
      dwellTimer = null;
    };
    const reset = () => {
      clearDwell();
      qualified = false;
    };
    const evaluate = () => {
      clearDwell();
      if (
        qualified ||
        !intersecting ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (
          !intersecting ||
          document.visibilityState !== "visible"
        ) {
          return;
        }
        qualified = true;
        void fetch("/api/sponsor/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventType: "impression",
            feedKind,
            sponsorshipId,
            surface,
          }),
          keepalive: true,
        }).catch(() => undefined);
      }, SPONSOR_VIEWPORT_DWELL_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting =
          Boolean(entry) &&
          entry.intersectionRatio >= SPONSOR_VIEWPORT_THRESHOLD;
        if (!intersecting) reset();
        else evaluate();
      },
      { threshold: [SPONSOR_VIEWPORT_THRESHOLD] }
    );
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") reset();
      else evaluate();
    };

    observer.observe(marker);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearDwell();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [feedKind, sponsorshipId, surface]);

  return <span ref={markerRef} aria-hidden="true" className="absolute inset-0 pointer-events-none" />;
}
