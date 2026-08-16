"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigationItems = [
  { href: "/settings", label: "Overview" },
  { href: "/settings/security", label: "Security & 2FA" },
  { href: "/settings/sponsor-analytics", label: "Sponsor analytics" },
] as const;

const navigationClassName =
  "min-h-11 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:border-orange-300/60 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 aria-[current=page]:border-orange-300 aria-[current=page]:bg-orange-500/15";

export default function SettingsNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings navigation" className="mt-6 flex flex-wrap gap-3">
      {navigationItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          className={navigationClassName}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
