"use client";

import { useEffect, useRef } from "react";
import {
  SPONSOR_VIEWPORT_DWELL_MS,
  SPONSOR_VIEWPORT_THRESHOLD,
} from "@/lib/sponsors/viewability";

export default function SponsorImpressionTracker({
  enabled,
  impressionUrl,
  measurementToken,
}: {
  enabled: boolean;
  impressionUrl: string;
  measurementToken: string;
}) {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!enabled || !marker || !measurementToken) return;

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
      if (qualified || !intersecting || document.visibilityState !== "visible") {
        return;
      }
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (!intersecting || document.visibilityState !== "visible") return;
        qualified = true;
        void fetch(impressionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: measurementToken }),
          keepalive: true,
        }).catch(() => undefined);
      }, SPONSOR_VIEWPORT_DWELL_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting =
          Boolean(entry) &&
          entry.intersectionRatio >= SPONSOR_VIEWPORT_THRESHOLD;
        if (intersecting) evaluate();
        else reset();
      },
      { threshold: [SPONSOR_VIEWPORT_THRESHOLD] }
    );
    const visibility = () => {
      if (document.visibilityState === "visible") evaluate();
      else reset();
    };
    observer.observe(marker);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearDwell();
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, impressionUrl, measurementToken]);

  return (
    <span
      ref={markerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
    />
  );
}
