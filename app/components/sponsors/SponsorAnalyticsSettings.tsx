"use client";

import { useEffect } from "react";
import { useSponsorAnalytics } from "@/app/components/sponsors/SponsorAnalyticsProvider";

const buttonClassName =
  "min-h-11 cursor-pointer rounded-lg border border-white/25 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:border-orange-300/70 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-55";

export default function SponsorAnalyticsSettings() {
  const {
    consent,
    errorMessage,
    loadConsent,
    loadState,
    saveConsent,
    saving,
  } = useSponsorAnalytics();

  useEffect(() => {
    void loadConsent();
  }, [loadConsent]);

  const consentChoiceLabel =
    loadState === "loading" || loadState === "idle"
      ? "Loading…"
      : consent === "granted"
        ? "On"
        : consent === "denied"
          ? "Off"
          : "Not chosen";

  return (
    <section
      aria-labelledby="sponsor-analytics-settings-title"
      aria-busy={loadState === "loading" || saving}
      className="rounded-2xl border border-white/10 bg-black/35 p-5 sm:p-6"
    >
      <h2 id="sponsor-analytics-settings-title" className="font-['Permanent_Marker'] text-xl tracking-wide text-[var(--orange-main)]">
        Sponsor analytics preference
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-white/70">
        Optional consent-based counts for qualified sponsor-banner views and
        sponsor-link clicks. Sponsor links work whether analytics is on or off.
        This setting is available without signing in.
      </p>
      <p className="mt-4 text-sm font-semibold text-white/85" role="status">
        Current choice: {consentChoiceLabel}
      </p>
      {errorMessage ? (
        <p className="mt-3 rounded-lg border border-red-300/25 bg-red-950/30 p-3 text-sm text-red-200" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <button
          type="button"
          aria-pressed={consent === "granted"}
          disabled={saving || loadState === "loading"}
          onClick={() => void saveConsent("granted")}
          className={`${buttonClassName} ${
            consent === "granted" ? "border-orange-300 bg-orange-500/15" : ""
          }`}
        >
          Allow analytics
        </button>
        <button
          type="button"
          aria-pressed={consent === "denied"}
          disabled={saving || loadState === "loading"}
          onClick={() => void saveConsent("denied")}
          className={`${buttonClassName} ${
            consent === "denied" ? "border-orange-300 bg-orange-500/15" : ""
          }`}
        >
          Continue without analytics
        </button>
        {loadState === "unavailable" ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void loadConsent()}
            className={buttonClassName}
          >
            Retry preference
          </button>
        ) : null}
      </div>
    </section>
  );
}
