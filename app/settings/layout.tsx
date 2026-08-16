import type { Metadata } from "next";
import Link from "next/link";
import SettingsNavigation from "@/app/components/settings/SettingsNavigation";

export const metadata: Metadata = {
  title: "Settings | CancerCulture",
  description: "CancerCulture account, security, and privacy settings.",
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative z-10 min-h-screen px-4 pb-16 pt-24 text-white sm:px-6 sm:pt-28">
      <div className="mx-auto w-full max-w-5xl">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm font-semibold text-orange-300 outline-none hover:text-orange-200 focus-visible:ring-2 focus-visible:ring-orange-300"
        >
          ← Home
        </Link>
        <header className="mt-4 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-300/75">
            Account &amp; privacy
          </p>
          <h1 className="mt-2 font-[var(--font-marker)] text-4xl text-orange-400 sm:text-5xl">
            Settings
          </h1>
          <p className="mt-4 leading-relaxed text-white/70">
            Manage privacy preferences and, when signed in, the security of your
            CancerCulture account. These are normal pages, so direct links and
            browser back and forward navigation work as expected.
          </p>
        </header>
        <SettingsNavigation />
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}
