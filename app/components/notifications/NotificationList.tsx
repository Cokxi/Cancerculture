"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { OwnerNotification } from "@/lib/notifications/ownerNotifications.server";

type NotificationListProps = {
  initialItems?: readonly OwnerNotification[];
  initialNextCursor?: string | null;
  loadOnMount?: boolean;
  compact?: boolean;
  onNavigate?: () => void;
  onUnreadDelta?: (delta: number) => void;
};

export default function NotificationList({
  initialItems = [],
  initialNextCursor = null,
  loadOnMount = false,
  compact = false,
  onNavigate,
  onUnreadDelta,
}: NotificationListProps) {
  const [items, setItems] = useState<readonly OwnerNotification[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(loadOnMount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const loadPage = async (cursor: string | null, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(`/api/notifications${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Notifications could not be loaded.");
      const page = await response.json() as {
        items?: OwnerNotification[];
        nextCursor?: string | null;
      };
      if (!Array.isArray(page.items)) throw new Error("Notifications could not be loaded.");
      setItems((current) => replace ? page.items ?? [] : [...current, ...(page.items ?? [])]);
      setNextCursor(typeof page.nextCursor === "string" ? page.nextCursor : null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Notifications could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!loadOnMount) return;
    void loadPage(null, true);
  }, [loadOnMount]);

  const openNotification = async (notification: OwnerNotification) => {
    if (!notification.readAt) {
      try {
        const response = await fetch(`/api/notifications/${notification.id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (response.ok) {
          const now = new Date().toISOString();
          setItems((current) => current.map((item) =>
            item.id === notification.id ? { ...item, readAt: now } : item
          ));
          onUnreadDelta?.(-1);
        }
      } catch {
        // The protected destination remains available if read acknowledgement fails.
      }
    }
    onNavigate?.();
    router.push(`/notifications/open/${notification.id}`);
  };

  const markAllRead = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/notifications/read-all", { method: "POST" });
      if (!response.ok) throw new Error("Notifications could not be marked as read.");
      const result = await response.json() as { updatedCount?: number; readAt?: string };
      if (!Number.isSafeInteger(result.updatedCount) || typeof result.readAt !== "string") {
        throw new Error("Notifications could not be marked as read.");
      }
      setItems((current) => current.map((item) => ({
        ...item,
        readAt: item.readAt ?? result.readAt ?? new Date().toISOString(),
      })));
      onUnreadDelta?.(-(result.updatedCount ?? 0));
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : "Notifications could not be marked as read.");
    } finally {
      setBusy(false);
    }
  };

  const unreadCount = items.filter((item) => !item.readAt).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-white/50">
          Read notifications are automatically removed from this view after 3 days.
        </p>
        {unreadCount > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void markAllRead()}
            className="min-h-11 cursor-pointer rounded-lg border border-white/20 px-3 py-2 text-sm font-semibold text-white/80 outline-none hover:border-orange-400/60 hover:text-orange-100 focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Mark all as read
          </button>
        ) : null}
      </div>

      {error ? <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-100">{error}</p> : null}
      {loading && items.length === 0 ? <p role="status" className="py-8 text-center text-white/60">Loading notifications…</p> : null}
      {!loading && items.length === 0 ? <p className="py-10 text-center text-white/60">No notifications yet.</p> : null}

      {items.length > 0 ? (
        <ul className={compact ? "divide-y divide-white/10" : "space-y-3"} aria-label="Notifications">
          {items.map((notification) => (
            <li
              key={notification.id}
              className={compact
                ? `py-5 first:pt-1 ${notification.readAt ? "" : "border-l-2 border-orange-400 pl-4"}`
                : `rounded-2xl border p-5 ${notification.readAt ? "border-white/10 bg-black/35" : "border-orange-400/45 bg-orange-500/10"}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 break-words font-semibold text-white">{notification.title}</p>
                  {!notification.readAt ? <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-semibold text-orange-100">New</span> : null}
                </div>
                <p className="mt-1 break-words text-sm leading-relaxed text-white/65">{notification.body}</p>
                <time className="mt-3 block text-xs text-white/45" dateTime={notification.createdAt}>
                  {new Date(notification.createdAt).toLocaleString()}
                </time>
                <button
                  type="button"
                  onClick={() => void openNotification(notification)}
                  className="mt-4 min-h-11 cursor-pointer rounded-lg border border-orange-400/50 px-4 py-2 text-sm font-semibold text-orange-200 outline-none hover:bg-orange-500/10 focus-visible:ring-2 focus-visible:ring-orange-400"
                >
                  {notification.actionLabel}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {nextCursor ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadPage(nextCursor, false)}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-white/15 px-4 py-2 text-sm text-white/80 hover:border-orange-400/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Loading…" : "Older notifications"}
        </button>
      ) : null}
    </div>
  );
}
