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

type ConsentStatus = "unknown" | "granted" | "denied";

let sharedConsentRequest: Promise<ConsentStatus> | null = null;
const SPONSOR_CONSENT_CHANGED_EVENT = "sponsor-analytics-consent-changed";

function loadConsentStatus(signal: AbortSignal) {
  sharedConsentRequest ??= fetch("/api/sponsor/consent", {
    cache: "no-store",
    signal,
  })
    .then((response) => response.json())
    .then((value) =>
      value?.status === "granted" || value?.status === "denied"
        ? value.status
        : "unknown"
    )
    .catch(() => {
      sharedConsentRequest = null;
      return "unknown" as const;
    });
  return sharedConsentRequest;
}

export default function CommunityFeedSponsor({
  feed,
  submissionId,
}: {
  feed: CommunityFeedKind;
  submissionId: number;
}) {
  const [presentation, setPresentation] =
    useState<CommunityFeedSponsorPresentation | null>(null);
  const [consent, setConsent] = useState<ConsentStatus>("unknown");
  const loadRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const refreshPresentation = useCallback(async (signal?: AbortSignal) => {
    const sponsorValue: unknown = await fetch(
      `/api/community-feed/sponsor/presentation/${submissionId}?feed=${feed}`,
      { cache: "no-store", signal }
    ).then((response) => response.json());
    if (isCommunityFeedSponsorPresentation(sponsorValue, feed, submissionId)) {
      setPresentation(sponsorValue);
      return sponsorValue;
    }
    return null;
  }, [feed, submissionId]);

  useEffect(() => {
    const onConsentChanged = (event: Event) => {
      const status = (event as CustomEvent<ConsentStatus>).detail;
      if (status === "granted" || status === "denied") {
        setConsent(status);
      }
    };

    window.addEventListener(
      SPONSOR_CONSENT_CHANGED_EVENT,
      onConsentChanged
    );
    return () => {
      window.removeEventListener(
        SPONSOR_CONSENT_CHANGED_EVENT,
        onConsentChanged
      );
    };
  }, []);

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
        void Promise.all([
          refreshPresentation(controller.signal),
          loadConsentStatus(controller.signal),
        ]).then(([, consentValue]) => {
          setConsent(consentValue);
        }).catch(() => undefined);
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
      !presentation?.sponsored ||
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
  }, [consent, presentation, refreshPresentation]);

  if (!presentation) {
    return <div ref={loadRef} aria-hidden="true" className="h-px" />;
  }
  if (!presentation.sponsored) return null;

  const saveConsent = async (status: "granted" | "denied") => {
    try {
      const response = await fetch("/api/sponsor/consent", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (response.ok) {
        sharedConsentRequest = Promise.resolve(status);
        setConsent(status);
        window.dispatchEvent(
          new CustomEvent<ConsentStatus>(SPONSOR_CONSENT_CHANGED_EVENT, {
            detail: status,
          })
        );
      }
    } catch {}
  };

  return (
    <aside
      ref={viewRef}
      aria-label={`Sponsored by ${presentation.companyName}`}
      className="border-t border-white/10 bg-orange-950/20 px-4 py-4 sm:px-5"
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-orange-200/80">
        Sponsored Cycle · {presentation.companyName}
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
          loading="lazy"
          decoding="async"
          className="aspect-[2/1] w-full object-cover"
        />
      </a>
      {presentation.measurementToken && consent === "unknown" ? (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/70">
          <p className="font-semibold text-white/90">
            Optional sponsor analytics
          </p>
          <p className="mt-2 leading-relaxed">
            If you allow it, CancerCulture counts a view only after this sponsor
            placement is at least 50% visible for one second in an active tab,
            and counts real sponsor-link clicks. Measurement uses a pseudonymous
            identifier. Raw measurement data is kept for up to 30 days; daily
            aggregate counts for up to 25 months. Sponsors receive aggregate
            reports only. Sponsor links work without analytics. You can change
            your choice here at any time.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveConsent("granted")}
              className="min-h-11 rounded-lg border border-white/25 px-4 font-semibold text-white transition hover:border-orange-300/70 hover:bg-white/5"
            >
              Allow analytics
            </button>
            <button
              type="button"
              onClick={() => void saveConsent("denied")}
              className="min-h-11 rounded-lg border border-white/25 px-4 font-semibold text-white transition hover:border-orange-300/70 hover:bg-white/5"
            >
              Continue without analytics
            </button>
          </div>
        </div>
      ) : presentation.measurementToken && consent !== "unknown" ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/70">
          <p>
            Sponsor analytics: {consent === "granted" ? "On" : "Off"}.
            Sponsor links work either way.
          </p>
          <button
            type="button"
            onClick={() =>
              void saveConsent(
                consent === "granted" ? "denied" : "granted"
              )
            }
            className="min-h-11 rounded-lg border border-white/25 px-4 font-semibold text-white transition hover:border-orange-300/70 hover:bg-white/5"
          >
            {consent === "granted" ? "Turn off analytics" : "Allow analytics"}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
