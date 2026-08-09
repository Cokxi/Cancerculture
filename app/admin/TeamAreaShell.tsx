"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ResolvedTeamAreaNavigation } from "@/lib/admin/teamAreaNavigation";
import { findActiveTeamAreaItem } from "@/lib/admin/teamAreaNavigationState";

function NavigationGroups({
  navigation,
  pathname,
  onNavigate,
}: {
  navigation: ResolvedTeamAreaNavigation;
  pathname: string;
  onNavigate?: () => void;
}) {
  const activeItem = findActiveTeamAreaItem(navigation, pathname);
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(activeItem ? [activeItem.category.id] : [])
  );

  return (
    <div className="space-y-2">
      {navigation.map((category) => {
        const open = openCategories.has(category.id);
        const buttonId = `nav-${category.id}`;
        const listId = `nav-${category.id}-items`;
        return (
        <section key={category.id} aria-labelledby={buttonId}>
          <button
            id={buttonId}
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() =>
              setOpenCategories((current) => {
                const next = new Set(current);
                if (next.has(category.id)) next.delete(category.id);
                else next.add(category.id);
                return next;
              })
            }
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55 outline-none hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-orange-300"
          >
            <span>{category.title}</span>
            <span className="flex items-center gap-1">
              {category.badges?.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-red-200"
                >
                  {badge}
                </span>
              ))}
              <span aria-hidden="true">{open ? "−" : "+"}</span>
            </span>
          </button>
          <ul id={listId} hidden={!open} className="mt-1 space-y-0.5">
            {category.items.map((entry) => {
              const active =
                activeItem?.entry.id === entry.id;
              return (
                <li key={entry.id}>
                  <Link
                    href={entry.href!}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={`block rounded-lg px-2.5 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-orange-300 ${
                      active
                        ? "bg-orange-500/15 font-medium text-orange-200"
                        : "text-white/70 hover:bg-white/[0.07] hover:text-white"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span>{entry.title}</span>
                      {entry.badges?.length ? (
                        <span className="flex gap-1" aria-label={entry.badges.join(", ")}>
                          {entry.badges.map((badge) => (
                            <span
                              key={badge}
                              className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-200"
                            >
                              {badge}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )})}
    </div>
  );
}

export default function TeamAreaShell({
  navigation,
  children,
}: {
  navigation: ResolvedTeamAreaNavigation;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const breadcrumb = useMemo(
    () => findActiveTeamAreaItem(navigation, pathname),
    [navigation, pathname]
  );

  useEffect(() => {
    if (!mobileOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-neutral-950 text-white/90 md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden max-h-screen overflow-y-auto border-r border-white/10 bg-black/30 p-4 md:block">
        <div>
          <div className="mb-5 space-y-1 border-b border-white/10 pb-4">
            <Link
              href="/admin"
              aria-current={pathname === "/admin" ? "page" : undefined}
              className="block rounded-lg px-2 py-2 text-base font-semibold text-orange-300 outline-none hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-orange-300"
            >
              Team Area
            </Link>
            <Link
              href="/"
              className="block rounded-lg px-2 py-2 text-sm text-white/60 outline-none hover:bg-white/[0.07] hover:text-white focus-visible:ring-2 focus-visible:ring-orange-300"
            >
              Website Home
            </Link>
          </div>
          <nav aria-label="Team Area navigation">
            <NavigationGroups
              key={`desktop-${pathname}`}
              navigation={navigation}
              pathname={pathname}
            />
          </nav>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-neutral-950/95 px-4 py-3 backdrop-blur md:hidden">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/admin"
              aria-current={pathname === "/admin" ? "page" : undefined}
              className="rounded-md font-semibold text-orange-300 outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
            >
              Team Area
            </Link>
            <button
              type="button"
              aria-label="Open Team Area navigation"
              aria-expanded={mobileOpen}
              aria-controls="team-area-mobile-navigation"
              onClick={() => setMobileOpen(true)}
              className="cursor-pointer rounded-lg border border-white/15 px-3 py-2 text-sm outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-orange-300"
            >
              Menu
            </button>
          </div>
        </header>

        {mobileOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <button
              type="button"
              aria-label="Close Team Area navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute inset-0 cursor-default bg-black/70"
            />
            <aside
              id="team-area-mobile-navigation"
              aria-label="Team Area mobile navigation"
              aria-modal="true"
              role="dialog"
              className="absolute inset-y-0 right-0 w-[min(88vw,340px)] overflow-y-auto border-l border-white/10 bg-neutral-950 p-4 shadow-2xl"
            >
              <div className="mb-5 flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                <span className="font-semibold text-orange-300">Team Area</span>
                <button
                  type="button"
                  autoFocus
                  onClick={() => setMobileOpen(false)}
                  className="cursor-pointer rounded-lg px-3 py-2 text-sm outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-orange-300"
                >
                  Close
                </button>
              </div>
              <div className="mb-5 grid grid-cols-2 gap-2">
                <Link
                  href="/admin"
                  aria-current={pathname === "/admin" ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                  className="rounded-lg bg-orange-500/10 px-3 py-2 text-sm text-orange-200 outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                >
                  Team Area
                </Link>
                <Link
                  href="/"
                  onClick={() => setMobileOpen(false)}
                  className="rounded-lg bg-white/5 px-3 py-2 text-sm text-white/70 outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                >
                  Website Home
                </Link>
              </div>
              <nav aria-label="Team Area navigation">
                <NavigationGroups
                  key={`mobile-${pathname}`}
                  navigation={navigation}
                  pathname={pathname}
                  onNavigate={() => setMobileOpen(false)}
                />
              </nav>
            </aside>
          </div>
        ) : null}

        <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb" className="mb-5 text-sm text-white/50">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link
                  href="/admin"
                  className="rounded-sm outline-none hover:text-orange-300 focus-visible:ring-2 focus-visible:ring-orange-300"
                >
                  Team Area
                </Link>
              </li>
              {breadcrumb ? (
                <>
                  <li aria-hidden="true">/</li>
                  <li>{breadcrumb.category.title}</li>
                  <li aria-hidden="true">/</li>
                  <li className="text-white/80" aria-current="page">
                    {breadcrumb.entry.title}
                  </li>
                </>
              ) : null}
            </ol>
          </nav>
          {children}
        </main>
      </div>
    </div>
  );
}
