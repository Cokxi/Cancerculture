import type { Metadata } from "next";
import SponsorAnalyticsSettings from "@/app/components/sponsors/SponsorAnalyticsSettings";

export const metadata: Metadata = {
  title: "Sponsor analytics | CancerCulture",
};

export default function SponsorAnalyticsSettingsPage() {
  return (
    <section aria-labelledby="sponsor-settings-page-title" className="max-w-3xl">
      <h2 id="sponsor-settings-page-title" className="font-['Permanent_Marker'] text-2xl tracking-wide text-[var(--orange-main)] sm:text-3xl">
        Sponsor analytics
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-white/70 sm:text-base">
        This privacy preference remains available to anonymous and signed-in
        visitors. It does not affect whether sponsor links work.
      </p>
      <div className="mt-7">
        <SponsorAnalyticsSettings />
      </div>
    </section>
  );
}
