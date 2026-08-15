"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import BaseOverlay from "@/app/components/overlay/BaseOverlay";

export type SponsorAnalyticsConsentStatus =
  | "unknown"
  | "granted"
  | "denied";

type SponsorAnalyticsContextValue = {
  consent: SponsorAnalyticsConsentStatus;
  openSettings: () => void;
  registerValidSponsorPresentation: () => void;
};

type ConsentLoadState = "idle" | "loading" | "ready" | "unavailable";

const SponsorAnalyticsContext =
  createContext<SponsorAnalyticsContextValue | null>(null);

const preferenceButtonClassName =
  "min-h-11 rounded-lg border border-white/25 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:border-orange-300/70 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-55";

function readConsentStatus(value: unknown): SponsorAnalyticsConsentStatus {
  if (
    value &&
    typeof value === "object" &&
    "status" in value &&
    (value.status === "granted" || value.status === "denied")
  ) {
    return value.status;
  }
  return "unknown";
}

export function SponsorAnalyticsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [consent, setConsent] =
    useState<SponsorAnalyticsConsentStatus>("unknown");
  const [loadState, setLoadState] = useState<ConsentLoadState>("idle");
  const [hasEncounteredSponsor, setHasEncounteredSponsor] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const consentRequestRef = useRef<Promise<SponsorAnalyticsConsentStatus> | null>(
    null
  );
  const consentStatusRef = useRef<SponsorAnalyticsConsentStatus>("unknown");
  const consentLoadedRef = useRef(false);

  const loadConsent = useCallback(() => {
    if (consentLoadedRef.current) {
      return Promise.resolve(consentStatusRef.current);
    }
    if (consentRequestRef.current) return consentRequestRef.current;

    setLoadState("loading");
    setErrorMessage(null);
    const request = fetch("/api/sponsor/consent", {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Consent request failed");
        const status = readConsentStatus(await response.json());
        consentStatusRef.current = status;
        consentLoadedRef.current = true;
        setConsent(status);
        setLoadState("ready");
        return status;
      })
      .catch(() => {
        consentStatusRef.current = "unknown";
        consentLoadedRef.current = false;
        setConsent("unknown");
        setLoadState("unavailable");
        setErrorMessage(
          "Sponsor analytics is unavailable right now and remains off."
        );
        return "unknown" as const;
      })
      .finally(() => {
        consentRequestRef.current = null;
      });

    consentRequestRef.current = request;
    return request;
  }, []);

  const registerValidSponsorPresentation = useCallback(() => {
    setHasEncounteredSponsor(true);
    void loadConsent();
  }, [loadConsent]);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    void loadConsent();
  }, [loadConsent]);

  const saveConsent = async (status: "granted" | "denied") => {
    if (saving) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const response = await fetch("/api/sponsor/consent", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const savedStatus = readConsentStatus(await response.json().catch(() => null));
      if (!response.ok || savedStatus !== status) {
        throw new Error("Consent preference was not saved");
      }
      consentStatusRef.current = status;
      consentLoadedRef.current = true;
      setConsent(status);
      setLoadState("ready");
    } catch {
      setErrorMessage(
        "Your choice could not be saved. The previous preference remains in effect."
      );
    } finally {
      setSaving(false);
    }
  };

  const contextValue = useMemo(
    () => ({ consent, openSettings, registerValidSponsorPresentation }),
    [consent, openSettings, registerValidSponsorPresentation]
  );

  const showConsentBar =
    hasEncounteredSponsor &&
    consent === "unknown" &&
    (loadState === "ready" || loadState === "unavailable");

  return (
    <SponsorAnalyticsContext.Provider value={contextValue}>
      {children}

      {showConsentBar ? (
        <aside
          aria-labelledby="sponsor-analytics-consent-title"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
        >
          <div className="pointer-events-auto mx-auto max-w-4xl rounded-2xl border border-orange-300/25 bg-black/95 p-4 text-white shadow-2xl shadow-black/70 backdrop-blur sm:p-5">
            <p
              id="sponsor-analytics-consent-title"
              className="font-semibold text-white"
            >
              Optional sponsor analytics
            </p>
            {loadState === "unavailable" ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm leading-relaxed text-white/70">
                  {errorMessage}
                </p>
                <button
                  type="button"
                  onClick={() => void loadConsent()}
                  className={preferenceButtonClassName}
                >
                  Try again
                </button>
              </div>
            ) : (
              <>
                <p className="mt-2 text-sm leading-relaxed text-white/70">
                  If you allow it, CancerCulture counts a view only after a
                  sponsor banner is at least 50% visible for one second in an
                  active tab, and counts sponsor-link clicks. Measurement uses a
                  pseudonymous identifier. Raw measurement data is kept for up
                  to 30 days and daily aggregate counts for up to 25 months.
                  Sponsors receive aggregate reports only. Sponsor links work
                  without analytics.
                </p>
                {errorMessage ? (
                  <p className="mt-2 text-sm text-red-200" role="alert">
                    {errorMessage}
                  </p>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveConsent("granted")}
                    className={preferenceButtonClassName}
                  >
                    Allow analytics
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveConsent("denied")}
                    className={preferenceButtonClassName}
                  >
                    Continue without analytics
                  </button>
                </div>
              </>
            )}
          </div>
        </aside>
      ) : null}

      {settingsOpen ? (
        <BaseOverlay size="compact" onClose={() => setSettingsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-settings-title"
            className="px-5 pb-7 pt-2 text-white sm:px-7"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
              Global preferences
            </p>
            <h2
              id="global-settings-title"
              className="mt-2 font-[var(--font-marker)] text-3xl text-orange-400"
            >
              Settings
            </h2>
            <div className="mt-6 rounded-xl border border-white/10 bg-black/30 p-4">
              <h3 className="font-semibold">Sponsor analytics</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/65">
                Optional consent-based counts for qualified sponsor-banner views
                and sponsor-link clicks. Sponsor links work either way.
              </p>
              <p className="mt-3 text-sm text-white/80" role="status">
                Current choice:{" "}
                {loadState === "loading"
                  ? "Loading..."
                  : consent === "granted"
                    ? "On"
                    : consent === "denied"
                      ? "Off"
                      : "Not chosen"}
              </p>
              {errorMessage ? (
                <p className="mt-2 text-sm text-red-200" role="alert">
                  {errorMessage}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={consent === "granted"}
                  disabled={saving || loadState === "loading"}
                  onClick={() => void saveConsent("granted")}
                  className={`${preferenceButtonClassName} ${
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
                  className={`${preferenceButtonClassName} ${
                    consent === "denied" ? "border-orange-300 bg-orange-500/15" : ""
                  }`}
                >
                  Continue without analytics
                </button>
                {loadState === "unavailable" ? (
                  <button
                    type="button"
                    onClick={() => void loadConsent()}
                    className={preferenceButtonClassName}
                  >
                    Retry preference
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        </BaseOverlay>
      ) : null}
    </SponsorAnalyticsContext.Provider>
  );
}

export function useSponsorAnalytics() {
  const context = useContext(SponsorAnalyticsContext);
  if (!context) {
    throw new Error(
      "useSponsorAnalytics must be inside SponsorAnalyticsProvider"
    );
  }
  return context;
}
