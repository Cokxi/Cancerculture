"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  navigationMenuItemClassName,
  navigationTextTriggerClassName,
} from "@/app/components/navigation/navigationButtonStyles";

type AnonymousAccountMenuProps = {
  settingsAction: {
    label: "Settings";
    onSelect: () => void;
  };
};

function supportsHoverInteraction() {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export default function AnonymousAccountMenu({
  settingsAction,
}: AnonymousAccountMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const getMenuItems = () =>
    Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]'
      ) ?? []
    );

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!open) return;

    const firstItem = getMenuItems()[0];
    requestAnimationFrame(() => firstItem?.focus());

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const items = getMenuItems();
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + offset + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => {
        if (supportsHoverInteraction()) setOpen(true);
      }}
      onMouseLeave={() => {
        if (supportsHoverInteraction()) closeMenu();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (supportsHoverInteraction()) {
            setOpen(true);
            return;
          }
          setOpen((current) => !current);
        }}
        className={navigationTextTriggerClassName}
      >
        Login
        <span
          aria-hidden
          className={`text-xs transition-transform ${open ? "rotate-180" : ""}`}
        >
          v
        </span>
        <span className="sr-only">Account menu</span>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-[80] w-56 max-w-[calc(100vw-1.5rem)] pt-2">
          <div
            id={menuId}
            role="menu"
            aria-label="Account menu"
            onKeyDown={handleMenuKeyDown}
            className="flex min-w-[180px] flex-col rounded-xl border border-white/10 bg-black/95 p-2 shadow-2xl shadow-black/60 backdrop-blur"
          >
            <Link
              href="/api/auth/discord/login?state=/"
              role="menuitem"
              className={navigationMenuItemClassName}
              onClick={() => closeMenu()}
            >
              Login with Discord
            </Link>
            <button
              type="button"
              role="menuitem"
              className={navigationMenuItemClassName}
              onClick={() => {
                settingsAction.onSelect();
                closeMenu();
              }}
            >
              {settingsAction.label}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
