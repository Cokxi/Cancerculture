"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  navigationMenuItemClassName,
  navigationTriggerBaseClassName,
} from "@/app/components/navigation/navigationButtonStyles";
import type {
  AccountNavigationItem,
  AccountNavigationState,
} from "@/lib/auth/accountNavigation";

type AuthenticatedNavigation = Extract<
  AccountNavigationState,
  { kind: "authenticated" }
>;

type AccountMenuProps = {
  avatarUrl: string | null;
  displayName: string;
  navigation: AuthenticatedNavigation;
  visibilityAction: {
    label: "Hide" | "Show always";
    onSelect: () => void;
  };
  settingsAction: {
    label: "Settings";
    onSelect: () => void;
  };
};

function supportsHoverInteraction() {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export default function AccountMenu({
  avatarUrl,
  displayName,
  navigation,
  settingsAction,
  visibilityAction,
}: AccountMenuProps) {
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

  const renderItem = (item: AccountNavigationItem) => {
    if (item.kind === "logout") {
      return (
        <form
          key={item.id}
          action="/api/auth/logout?returnTo=/"
          method="post"
          className="w-full"
        >
          <button
            type="submit"
            role="menuitem"
            className={navigationMenuItemClassName}
          >
            {item.label}
          </button>
        </form>
      );
    }

    return (
      <Link
        key={item.id}
        href={item.href}
        role="menuitem"
        className={navigationMenuItemClassName}
        onClick={() => closeMenu()}
      >
        {item.label}
      </Link>
    );
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
        onClick={() => setOpen((current) => !current)}
        className={`${navigationTriggerBaseClassName} max-w-[calc(100vw-1.5rem)] p-1.5 pr-3 sm:max-w-[13rem]`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-500/20">
          {avatarUrl ? (
            <span
              role="img"
              aria-label="Account avatar"
              className="h-full w-full bg-cover bg-center"
              style={{ backgroundImage: `url("${avatarUrl}")` }}
            />
          ) : (
            <span aria-hidden>?</span>
          )}
        </span>
        <span className="text-sm sm:hidden">Profile</span>
        <span
          className="hidden min-w-0 max-w-[8rem] truncate text-sm sm:inline"
          title={displayName}
        >
          {displayName}
        </span>
        <span
          aria-hidden
          className={`text-xs transition-transform ${open ? "rotate-180" : ""}`}
        >
          v
        </span>
        <span className="sr-only">Account menu</span>
      </button>

      {open ? (
        <div
          className="absolute right-0 top-full z-[80] w-56 max-w-[calc(100vw-1.5rem)] pt-2"
        >
          <div
            id={menuId}
            role="menu"
            aria-label="Account menu"
            onKeyDown={handleMenuKeyDown}
            className="flex min-w-[180px] flex-col rounded-xl border border-white/10 bg-black/95 p-2 shadow-2xl shadow-black/60 backdrop-blur"
          >
            <p className="break-words px-3 pb-2 pt-1 text-xs text-white/55">
              {displayName}
            </p>
            {navigation.teamAccessUnavailable ? (
              <p className="px-3 pb-2 text-xs text-amber-300/80" role="status">
                Team access temporarily unavailable
              </p>
            ) : null}
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
            <button
              type="button"
              role="menuitem"
              className={navigationMenuItemClassName}
              onClick={() => {
                visibilityAction.onSelect();
                closeMenu();
              }}
            >
              {visibilityAction.label}
            </button>
            {navigation.items.map(renderItem)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
