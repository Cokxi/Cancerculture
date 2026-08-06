"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnstileAction } from "@/lib/turnstile/shared";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "dark";
      size: "flexible";
      "response-field": false;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      "timeout-callback": () => void;
    }
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export default function TurnstileWidget({
  action,
  siteKey,
  resetKey,
  onTokenChange,
}: {
  action: TurnstileAction;
  siteKey: string | null;
  resetKey: number;
  onTokenChange: (token: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenChangeRef = useRef(onTokenChange);
  const resetKeyRef = useRef(resetKey);
  const [statusRecord, setStatusRecord] = useState<{
    resetKey: number;
    status: "loading" | "ready" | "error";
  }>({ resetKey, status: "loading" });
  const status =
    statusRecord.resetKey === resetKey ? statusRecord.status : "loading";

  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    resetKeyRef.current = resetKey;
  }, [resetKey]);

  const clearToken = useCallback(() => {
    onTokenChangeRef.current(null);
  }, []);

  const renderWidget = useCallback(() => {
    if (
      !siteKey ||
      !containerRef.current ||
      !window.turnstile ||
      widgetIdRef.current
    ) {
      return;
    }

    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      action,
      theme: "dark",
      size: "flexible",
      "response-field": false,
      callback: (token) => {
        setStatusRecord({ resetKey: resetKeyRef.current, status: "ready" });
        onTokenChangeRef.current(token);
      },
      "expired-callback": () => {
        setStatusRecord({ resetKey: resetKeyRef.current, status: "loading" });
        clearToken();
      },
      "error-callback": () => {
        setStatusRecord({ resetKey: resetKeyRef.current, status: "error" });
        clearToken();
      },
      "timeout-callback": () => {
        setStatusRecord({ resetKey: resetKeyRef.current, status: "error" });
        clearToken();
      },
    });
  }, [action, clearToken, siteKey]);

  useEffect(() => {
    renderWidget();
  }, [renderWidget]);

  useEffect(() => {
    if (!widgetIdRef.current || !window.turnstile) return;

    window.turnstile.reset(widgetIdRef.current);
  }, [resetKey]);

  useEffect(
    () => () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
      clearToken();
    },
    [clearToken]
  );

  const retry = () => {
    if (!widgetIdRef.current || !window.turnstile) return;
    setStatusRecord({ resetKey: resetKeyRef.current, status: "loading" });
    clearToken();
    window.turnstile.reset(widgetIdRef.current);
  };

  if (!siteKey) {
    return (
      <p role="status" className="text-center text-sm text-red-300">
        Verification is temporarily unavailable.
      </p>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <Script
        id="cloudflare-turnstile-api"
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={renderWidget}
        onError={() =>
          setStatusRecord({
            resetKey: resetKeyRef.current,
            status: "error",
          })
        }
      />
      <div ref={containerRef} />
      <p className="sr-only" role="status" aria-live="polite">
        {status === "ready"
          ? "Verification complete."
          : status === "error"
            ? "Verification failed."
            : "Verification in progress."}
      </p>
      {status === "error" && (
        <button
          type="button"
          onClick={retry}
          className="mt-2 text-sm text-orange-300 underline underline-offset-4"
        >
          Retry verification
        </button>
      )}
    </div>
  );
}
