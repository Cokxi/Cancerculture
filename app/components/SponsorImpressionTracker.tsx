"use client";

import { useEffect, useRef } from "react";
import type { SponsorTrackingSurface } from "@/lib/sponsors/tracking";

export default function SponsorImpressionTracker({
  sponsorshipId,
  surface,
}: {
  sponsorshipId: number | null | undefined;
  surface: SponsorTrackingSurface;
}) {
  const hasTrackedRef = useRef(false);

  useEffect(() => {
    if (!sponsorshipId || hasTrackedRef.current) {
      return;
    }

    hasTrackedRef.current = true;

    void fetch("/api/sponsor/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventType: "impression",
        sponsorshipId,
        surface,
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, [sponsorshipId, surface]);

  return null;
}
