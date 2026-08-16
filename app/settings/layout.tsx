import type { Metadata } from "next";
import SettingsNavigation from "@/app/components/settings/SettingsNavigation";
import BackButton from "@/app/components/ui/BackButton";

export const metadata: Metadata = {
  title: "Settings | CancerCulture",
  description: "CancerCulture account, security, and privacy settings.",
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BackButton href="/" label="Home" />
      <main className="relative z-10 min-h-screen px-4 pb-16 pt-24 text-white sm:px-6 sm:pt-28">
        <div className="mx-auto w-full max-w-5xl">
          <header className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--orange-main)]/75">
              Account &amp; privacy
            </p>
            <h1 className="mt-2 font-['Permanent_Marker'] text-4xl text-[var(--orange-main)] sm:text-5xl">
              Settings
            </h1>
          </header>
          <SettingsNavigation />
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </>
  );
}
