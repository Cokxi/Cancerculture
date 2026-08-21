"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import AccountMenu from "@/app/components/auth/AccountMenu";
import AnonymousAccountMenu from "@/app/components/auth/AnonymousAccountMenu";
import NotificationDrawer from "@/app/components/notifications/NotificationDrawer";
import {
  GLOBAL_ACCOUNT_HIDDEN_STORAGE_KEY,
  getGlobalAccountVisibilityAction,
  isGlobalAccountVisible,
  type GlobalAccountViewState,
} from "@/lib/auth/globalAccount";

const visibilityChangeEvent = "global-account-visibility-change";

function subscribeToHydration() {
  return () => undefined;
}

function subscribeToVisibilityPreference(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(visibilityChangeEvent, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(visibilityChangeEvent, onStoreChange);
  };
}

function getVisibilityPreferenceSnapshot() {
  return (
    window.localStorage.getItem(GLOBAL_ACCOUNT_HIDDEN_STORAGE_KEY) === "true"
  );
}

export default function GlobalAccount() {
  const pathname = usePathname();
  const [account, setAccount] = useState<GlobalAccountViewState | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  const hiddenOnSubpages = useSyncExternalStore(
    subscribeToVisibilityPreference,
    getVisibilityPreferenceSnapshot,
    () => false
  );

  const visible = isGlobalAccountVisible({ pathname, hiddenOnSubpages });

  useEffect(() => {
    if (!hydrated || !visible) return;

    const controller = new AbortController();
    fetch("/api/auth/account", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Account request failed");
        return (await response.json()) as GlobalAccountViewState;
      })
      .then(setAccount)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAccount({ kind: "dependency_unavailable" });
      });

    return () => controller.abort();
  }, [hydrated, pathname, visible]);

  if (!hydrated || !visible) return null;

  const setVisibilityPreference = () => {
    if (hiddenOnSubpages) {
      window.localStorage.removeItem(GLOBAL_ACCOUNT_HIDDEN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(GLOBAL_ACCOUNT_HIDDEN_STORAGE_KEY, "true");
    }

    window.dispatchEvent(new Event(visibilityChangeEvent));
  };

  const positionClassName =
    pathname === "/" ? "right-3 top-[74px] sm:right-5" : "right-4 top-4";

  return (
    <>
      <div
        data-global-account
        className={`fixed z-[70] ${positionClassName}`}
      >
      {!account ? (
        <div
          className="h-11 w-11 animate-pulse rounded-full border border-orange-500/30 bg-black/80"
          aria-label="Account loading"
        />
      ) : account.kind === "anonymous" ? (
        <AnonymousAccountMenu />
      ) : account.kind === "dependency_unavailable" ? (
        <div
          className="rounded-full border border-white/10 bg-black/80 px-3 py-2 text-xs text-white/70"
          role="status"
        >
          Account temporarily unavailable
        </div>
      ) : account.kind === "restricted" ? (
        <div className="flex items-center gap-3 rounded-full border border-red-400/30 bg-black/85 px-3 py-2 text-xs text-red-300">
          <span>Account restricted</span>
          <form action="/api/auth/logout?returnTo=/" method="post">
            <button
              type="submit"
              className="cursor-pointer underline underline-offset-2"
            >
              Logout
            </button>
          </form>
        </div>
      ) : (
        <AccountMenu
          avatarUrl={account.avatarUrl}
          displayName={account.displayName}
          unreadNotificationCount={account.unreadNotificationCount}
          onOpenNotifications={() => setNotificationsOpen(true)}
          navigation={account.navigation}
          visibilityAction={{
            label: getGlobalAccountVisibilityAction(hiddenOnSubpages),
            onSelect: setVisibilityPreference,
          }}
        />
      )}
      </div>
      {account?.kind === "authenticated" ? (
        <NotificationDrawer
          open={notificationsOpen}
          onClose={() => setNotificationsOpen(false)}
          onUnreadDelta={(delta) => {
            setAccount((current) => current?.kind === "authenticated"
              ? {
                  ...current,
                  unreadNotificationCount: Math.max(
                    0,
                    Math.min(999, current.unreadNotificationCount + delta)
                  ),
                }
              : current
            );
          }}
        />
      ) : null}
    </>
  );
}
