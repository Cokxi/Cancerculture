"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { navigationTextTriggerClassName } from "@/app/components/navigation/navigationButtonStyles";

type InstallChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}

function isStandaloneDisplay() {
  const navigatorWithStandalone = navigator as Navigator & {
    standalone?: boolean;
  };

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

function isIosOrIpadOs() {
  return (
    /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isMobileLikeDisplay() {
  return window.matchMedia("(pointer: coarse)").matches || isIosOrIpadOs();
}

export default function PwaShell() {
  const pathname = usePathname();
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [mobileLike, setMobileLike] = useState(false);
  const [iosInstructionsOpen, setIosInstructionsOpen] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const refreshRequestedRef = useRef(false);

  useEffect(() => {
    const displayModeQuery = window.matchMedia("(display-mode: standalone)");
    const mobileQuery = window.matchMedia("(pointer: coarse)");

    const updatePresentation = () => {
      const nextStandalone = isStandaloneDisplay();
      setStandalone(nextStandalone);
      setMobileLike(isMobileLikeDisplay());
      document.documentElement.dataset.pwaDisplayMode = nextStandalone
        ? "standalone"
        : "browser";
    };

    const handleInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setInstallPrompt(promptEvent);
    };

    const handleInstalled = () => {
      setInstallPrompt(null);
      setIosInstructionsOpen(false);
      updatePresentation();
    };

    updatePresentation();
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    displayModeQuery.addEventListener("change", updatePresentation);
    mobileQuery.addEventListener("change", updatePresentation);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      displayModeQuery.removeEventListener("change", updatePresentation);
      mobileQuery.removeEventListener("change", updatePresentation);
      delete document.documentElement.dataset.pwaDisplayMode;
    };
  }, []);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    let installingWorker: ServiceWorker | null = null;

    const revealWaitingWorker = (worker: ServiceWorker | null) => {
      if (!disposed && worker && navigator.serviceWorker.controller) {
        setWaitingWorker(worker);
        setUpdateDismissed(false);
      }
    };

    const handleInstallingStateChange = () => {
      if (installingWorker?.state === "installed") {
        revealWaitingWorker(registration?.waiting ?? installingWorker);
      }
    };

    const handleUpdateFound = () => {
      installingWorker?.removeEventListener(
        "statechange",
        handleInstallingStateChange
      );
      installingWorker = registration?.installing ?? null;
      installingWorker?.addEventListener(
        "statechange",
        handleInstallingStateChange
      );
    };

    const handleControllerChange = () => {
      if (!refreshRequestedRef.current) return;
      refreshRequestedRef.current = false;
      window.location.reload();
    };

    const registerServiceWorker = async () => {
      try {
        registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        if (disposed) return;

        revealWaitingWorker(registration.waiting);
        registration.addEventListener("updatefound", handleUpdateFound);
      } catch {
        // The browser experience remains fully functional without PWA support.
      }
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange
    );

    if (document.readyState === "complete") {
      void registerServiceWorker();
    } else {
      window.addEventListener("load", registerServiceWorker, { once: true });
    }

    return () => {
      disposed = true;
      window.removeEventListener("load", registerServiceWorker);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange
      );
      registration?.removeEventListener("updatefound", handleUpdateFound);
      installingWorker?.removeEventListener(
        "statechange",
        handleInstallingStateChange
      );
    };
  }, []);

  const handleInstall = async () => {
    if (installPrompt) {
      const promptEvent = installPrompt;
      setInstallPrompt(null);
      await promptEvent.prompt();
      await promptEvent.userChoice;
      return;
    }

    if (isIosOrIpadOs()) setIosInstructionsOpen(true);
  };

  const handleUpdate = () => {
    if (!waitingWorker || updating) return;
    setUpdating(true);
    refreshRequestedRef.current = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  };

  const isAdminPath =
    pathname === "/admin" || pathname.startsWith("/admin/");
  const installAvailable =
    mobileLike &&
    !standalone &&
    !isAdminPath &&
    (installPrompt !== null || isIosOrIpadOs());
  const updateAvailable = waitingWorker !== null && !updateDismissed;

  return (
    <>
      {installAvailable && !updateAvailable ? (
        <button
          data-pwa-install
          type="button"
          onClick={() => void handleInstall()}
          className={`${navigationTextTriggerClassName} fixed left-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-40 sm:left-6 sm:bottom-6`}
        >
          Install app
        </button>
      ) : null}

      {iosInstructionsOpen ? (
        <div
          data-hides-global-account
          className="fixed inset-0 z-[110] flex items-end bg-black/60 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center sm:justify-center"
          role="presentation"
          onClick={() => setIosInstructionsOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="pwa-ios-install-title"
            className="w-full max-w-md rounded-2xl border border-orange-300/30 bg-black/95 p-5 text-white shadow-2xl shadow-black/70"
            onClick={(event) => event.stopPropagation()}
          >
            <h2
              id="pwa-ios-install-title"
              className="font-[var(--font-marker)] text-2xl text-orange-400"
            >
              Install CancerCulture
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/75">
              Open the browser Share menu, choose Add to Home Screen, then
              confirm Add. The exact menu wording can vary by browser language.
            </p>
            <button
              type="button"
              onClick={() => setIosInstructionsOpen(false)}
              className={`${navigationTextTriggerClassName} mt-5`}
            >
              Close
            </button>
          </section>
        </div>
      ) : null}

      {updateAvailable ? (
        <aside
          aria-labelledby="pwa-update-title"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[110] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
        >
          <div className="pointer-events-auto mx-auto max-w-xl rounded-2xl border border-orange-300/30 bg-black/95 p-4 text-white shadow-2xl shadow-black/70 backdrop-blur sm:p-5">
            <p id="pwa-update-title" className="font-semibold text-orange-300">
              CancerCulture update ready
            </p>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              Finish anything you are editing first. The app reloads only if
              you choose Update now.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={updating}
                onClick={handleUpdate}
                className={navigationTextTriggerClassName}
              >
                {updating ? "Updating..." : "Update now"}
              </button>
              <button
                type="button"
                disabled={updating}
                onClick={() => setUpdateDismissed(true)}
                className={navigationTextTriggerClassName}
              >
                Later
              </button>
            </div>
          </div>
        </aside>
      ) : null}
    </>
  );
}
