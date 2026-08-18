"use client";

import { useEffect, useId, useRef } from "react";
import NotificationList from "@/app/components/notifications/NotificationList";

type NotificationDrawerProps = {
  open: boolean;
  onClose: () => void;
  onUnreadDelta: (delta: number) => void;
};

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export default function NotificationDrawer({ open, onClose, onUnreadDelta }: NotificationDrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose, open]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-[100] transition-[visibility] ${open ? "visible" : "invisible delay-200"}`}
    >
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label="Close notifications"
        onClick={onClose}
        className={`absolute inset-0 cursor-default bg-black/65 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`absolute inset-y-0 left-0 flex h-dvh w-[calc(100vw-1rem)] max-w-[28rem] flex-col border-r border-white/15 bg-[#090909] shadow-2xl shadow-black/70 transition-transform duration-200 ease-out ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="font-['Permanent_Marker'] text-3xl text-[var(--orange-main)]">Notifications</h2>
            <p className="mt-1 text-sm text-white/55">Private updates for your account.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border border-white/20 text-xl text-white outline-none hover:border-orange-400/60 hover:text-orange-200 focus-visible:ring-2 focus-visible:ring-orange-400"
            aria-label="Close notifications"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {open ? (
            <NotificationList loadOnMount compact onNavigate={onClose} onUnreadDelta={onUnreadDelta} />
          ) : null}
        </div>
      </aside>
    </div>
  );
}
