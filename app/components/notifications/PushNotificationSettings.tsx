"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Category = {
  categoryKey: string;
  displayName: string;
  description: string;
  enabled?: boolean;
  requiredInProduct?: boolean;
  inProductEnabled?: boolean;
};

type SettingsState = {
  status: "loading" | "anonymous" | "ready" | "unavailable";
  configurationAvailable: boolean;
  vapidPublicKey: string | null;
  active: boolean;
  pushCategories: Category[];
  inProductCategories: Category[];
};

const initialState: SettingsState = {
  status: "loading",
  configurationAvailable: false,
  vapidPublicKey: null,
  active: false,
  pushCategories: [],
  inProductCategories: [],
};

function SettingsSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}: ${checked ? "on" : "off"}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? "border-orange-300 bg-[var(--orange-main)]"
          : "border-white/20 bg-white/15"
      }`}
    >
      <span
        aria-hidden
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function applicationServerKey(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/gu, "+").replace(/_/gu, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export default function PushNotificationSettings() {
  const [state, setState] = useState<SettingsState>(initialState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pushResponse, settingsResponse] = await Promise.all([
        fetch("/api/notifications/push-subscription", { cache: "no-store" }),
        fetch("/api/notifications/settings", { cache: "no-store" }),
      ]);
      if (pushResponse.status === 401 || settingsResponse.status === 401) {
        setState((current) => ({ ...current, status: "anonymous" }));
        return;
      }
      if (!pushResponse.ok || !settingsResponse.ok) throw new Error("unavailable");
      const push = await pushResponse.json() as Record<string, unknown>;
      const settings = await settingsResponse.json() as Record<string, unknown>;
      setState({
        status: "ready",
        configurationAvailable: push.configurationAvailable === true,
        vapidPublicKey: typeof push.vapidPublicKey === "string" ? push.vapidPublicKey : null,
        active: push.active === true,
        pushCategories: Array.isArray(push.categories) ? push.categories as Category[] : [],
        inProductCategories: Array.isArray(settings.categories) ? settings.categories as Category[] : [],
      });
    } catch {
      setState((current) => ({ ...current, status: "unavailable" }));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const enablePush = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (
        !state.configurationAvailable ||
        !state.vapidPublicKey ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        throw new Error("Push is not available on this device yet.");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") {
        throw new Error("Browser notification permission was not granted.");
      }
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration) {
        throw new Error("The CancerCulture app service worker is not ready.");
      }
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(state.vapidPublicKey),
      });
      const response = await fetch("/api/notifications/push-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      if (!response.ok) throw new Error("Push could not be activated.");
      setMessage("Push is active for this browser. Categories remain off until you enable them below.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Push could not be activated.");
    } finally {
      setBusy(false);
    }
  };

  const disablePush = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/notifications/push-subscription", { method: "DELETE" });
      if (!response.ok) throw new Error("Push could not be disabled.");
      const registration = "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration("/")
        : undefined;
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      setMessage("Push is disabled for this browser.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Push could not be disabled.");
    } finally {
      setBusy(false);
    }
  };

  const updatePushCategory = async (categoryKey: string, enabled: boolean) => {
    setBusy(true);
    try {
      const response = await fetch("/api/notifications/push-subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryKey, enabled }),
      });
      if (!response.ok) throw new Error("Category could not be updated.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Category could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const updateInProductCategory = async (categoryKey: string, inProductEnabled: boolean) => {
    setBusy(true);
    try {
      const response = await fetch("/api/notifications/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryKey, inProductEnabled }),
      });
      if (!response.ok) throw new Error("Preference could not be updated.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preference could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <p role="status">Loading notification settings…</p>;
  if (state.status === "anonymous") {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/35 p-6">
        <p className="text-white/70">Sign in to manage private account notifications.</p>
        <Link href="/api/auth/discord/login?state=/settings/notifications" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-orange-500 px-4 py-2 font-semibold text-black">
          Sign in with Discord
        </Link>
      </div>
    );
  }
  if (state.status === "unavailable") return <p role="status">Notification settings are temporarily unavailable.</p>;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-black/35 p-6" aria-labelledby="in-product-title">
        <h2 id="in-product-title" className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)]">In-app notifications</h2>
        <div className="mt-4 space-y-3">
          {state.inProductCategories.map((category) => (
            <div key={category.categoryKey} className="flex min-h-16 items-center justify-between gap-4 rounded-xl border border-white/10 px-4 py-3">
              <span>
                <span className="block font-semibold">{category.displayName}</span>
                <span className="mt-1 block text-xs leading-relaxed text-white/50">{category.description}</span>
              </span>
              <SettingsSwitch
                checked={category.inProductEnabled === true}
                disabled={busy}
                label={category.displayName}
                onChange={(checked) => void updateInProductCategory(category.categoryKey, checked)}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-black/35 p-6" aria-labelledby="push-title">
        <h2 id="push-title" className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)]">Web Push for this browser</h2>
        <p className="mt-2 text-sm text-white/65">
          Push is optional, disabled by default, and configured separately on every device.
        </p>
        {!state.configurationAvailable ? (
          <p className="mt-4 rounded-lg border border-amber-400/25 bg-amber-500/10 p-3 text-sm text-amber-100" role="status">
            Public Push activation is not available in this environment.
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy || !state.configurationAvailable}
          onClick={() => void (state.active ? disablePush() : enablePush())}
          className="mt-4 min-h-11 cursor-pointer rounded-lg bg-orange-500 px-4 py-2 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-45"
        >
          {state.active ? "Disable on this browser" : "Enable on this browser"}
        </button>
        {state.active ? (
          <div className="mt-5 space-y-3" aria-label="Push categories">
            {state.pushCategories.map((category) => (
              <div key={category.categoryKey} className="flex min-h-16 items-center justify-between gap-4 rounded-xl border border-white/10 px-4 py-3">
                <span>
                  <span className="block font-semibold">{category.displayName}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-white/50">{category.description}</span>
                </span>
                <SettingsSwitch
                  checked={category.enabled === true}
                  disabled={busy}
                  label={`${category.displayName} push`}
                  onChange={(checked) => void updatePushCategory(category.categoryKey, checked)}
                />
              </div>
            ))}
          </div>
        ) : null}
        {message ? <p className="mt-4 text-sm text-white/70" role="status">{message}</p> : null}
      </section>
    </div>
  );
}
