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

type CyclePreferences = {
  newCycleStarted: boolean;
  submissionPhaseEnds: boolean;
  votingPhaseEnds: boolean;
  cycleResultsReady: boolean;
  remind15Minutes: boolean;
  remind10Minutes: boolean;
  remind5Minutes: boolean;
};

const emptyCyclePreferences: CyclePreferences = {
  newCycleStarted: false,
  submissionPhaseEnds: false,
  votingPhaseEnds: false,
  cycleResultsReady: false,
  remind15Minutes: false,
  remind10Minutes: false,
  remind5Minutes: false,
};

type SettingsState = {
  status: "loading" | "anonymous" | "ready" | "unavailable";
  configurationAvailable: boolean;
  vapidPublicKey: string | null;
  active: boolean;
  pushCategories: Category[];
  cyclePreferences: CyclePreferences;
  inProductCategories: Category[];
};

const initialState: SettingsState = {
  status: "loading",
  configurationAvailable: false,
  vapidPublicKey: null,
  active: false,
  pushCategories: [],
  cyclePreferences: emptyCyclePreferences,
  inProductCategories: [],
};

function parseCyclePreferences(value: unknown): CyclePreferences {
  const item = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    newCycleStarted: item.newCycleStarted === true,
    submissionPhaseEnds: item.submissionPhaseEnds === true,
    votingPhaseEnds: item.votingPhaseEnds === true,
    cycleResultsReady: item.cycleResultsReady === true,
    remind15Minutes: item.remind15Minutes === true,
    remind10Minutes: item.remind10Minutes === true,
    remind5Minutes: item.remind5Minutes === true,
  };
}

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

async function pushActivationErrorMessage(error: unknown) {
  const brave = (navigator as Navigator & {
    brave?: { isBrave?: () => Promise<boolean> };
  }).brave;
  const isBrave = await brave?.isBrave?.().catch(() => false) ?? false;
  const isPushServiceFailure = error instanceof Error
    && (error.name === "AbortError" || /push service/iu.test(error.message));

  if (isBrave && isPushServiceFailure) {
    return "Brave's push service is disabled. Open brave://settings/privacy, enable Use Google services for push messaging, restart Brave, and try again.";
  }
  return error instanceof Error ? error.message : "Push could not be activated.";
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
        cyclePreferences: parseCyclePreferences(push.cyclePreferences),
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
      if (!("Notification" in window)) {
        throw new Error("This browser does not support notification permission.");
      }
      if (!window.isSecureContext) {
        throw new Error("Browser notifications require a secure connection.");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission === "denied") {
        throw new Error("Notifications are blocked for this site. The browser cannot ask again until you allow notifications in its site permissions.");
      }
      if (permission !== "granted") {
        throw new Error("The browser question was closed. Click Enable push notifications on this browser when you are ready.");
      }
      if (!state.configurationAvailable || !state.vapidPublicKey) {
        throw new Error("Browser permission is granted. Push delivery is not configured in this environment yet.");
      }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("This browser does not support Web Push on this device.");
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
      setMessage(await pushActivationErrorMessage(error));
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

  const updateCyclePreference = async (cyclePreferenceKey: string, enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/notifications/push-subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cyclePreferenceKey, enabled }),
      });
      if (!response.ok) throw new Error("Cycle Push preference could not be updated.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cycle Push preference could not be updated.");
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
            You can still ask this browser for notification permission. Delivery becomes active after Push is configured for this environment.
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void (state.active ? disablePush() : enablePush())}
          className="mt-4 min-h-11 cursor-pointer rounded-lg bg-orange-500 px-4 py-2 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-45"
        >
          {state.active ? "Disable push notifications on this browser" : "Enable push notifications on this browser"}
        </button>
        <div className="mt-5 space-y-3" aria-label="Push categories">
          <div className="rounded-xl border border-white/10 p-4">
            <h3 className="font-semibold">Cycles &amp; Voting</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/50">
              Choose each Cycle event separately. The 5, 10, and 15 minute options are freely combinable and apply to every enabled phase-end notification.
            </p>
            <div className="mt-4 space-y-3">
              {([
                ["new_cycle_started", "A new Cycle starts", state.cyclePreferences.newCycleStarted],
                ["submission_phase_ends", "Submission phase ends", state.cyclePreferences.submissionPhaseEnds],
                ["voting_phase_ends", "Voting phase ends", state.cyclePreferences.votingPhaseEnds],
                ["cycle_results_ready", "Cycle results are ready", state.cyclePreferences.cycleResultsReady],
              ] as const).map(([key, label, checked]) => (
                <div key={key} className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-white/10 px-3 py-2">
                  <span className="text-sm font-medium">{label}</span>
                  <SettingsSwitch
                    checked={checked}
                    disabled={busy || !state.active}
                    label={label}
                    onChange={(enabled) => void updateCyclePreference(key, enabled)}
                  />
                </div>
              ))}
            </div>
            <fieldset className="mt-4 border-t border-white/10 pt-4" disabled={busy || !state.active}>
              <legend className="text-sm font-semibold">Before an enabled phase ends</legend>
              <p className="mt-1 text-xs leading-relaxed text-white/50">
                With no time selected, one Push arrives when that phase ends. If you select any times, Push arrives only at those times and not again at the phase change.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {([
                  ["remind_15_minutes", "15 minutes before", state.cyclePreferences.remind15Minutes],
                  ["remind_10_minutes", "10 minutes before", state.cyclePreferences.remind10Minutes],
                  ["remind_5_minutes", "5 minutes before", state.cyclePreferences.remind5Minutes],
                ] as const).map(([key, label, checked]) => (
                  <label key={key} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || !state.active}
                      onChange={(event) => void updateCyclePreference(key, event.target.checked)}
                      className="h-4 w-4 accent-orange-500"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          {state.pushCategories
            .filter((category) => category.categoryKey !== "cycles_voting")
            .map((category) => (
              <div key={category.categoryKey} className="flex min-h-16 items-center justify-between gap-4 rounded-xl border border-white/10 px-4 py-3">
                <span>
                  <span className="block font-semibold">{category.displayName}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-white/50">{category.description}</span>
                </span>
                <SettingsSwitch
                  checked={category.enabled === true}
                  disabled={busy || !state.active}
                  label={`${category.displayName} push`}
                  onChange={(checked) => void updatePushCategory(category.categoryKey, checked)}
                />
              </div>
            ))}
        </div>
        {message ? <p className="mt-4 text-sm text-white/70" role="status">{message}</p> : null}
      </section>
    </div>
  );
}
