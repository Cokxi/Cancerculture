import type { Metadata } from "next";
import TwoFactorSettings from "@/app/components/auth/TwoFactorSettings";

export const metadata: Metadata = {
  title: "Security & 2FA | CancerCulture",
};

export default function SecuritySettingsPage() {
  return (
    <section aria-labelledby="security-settings-title" className="max-w-4xl">
      <h2 id="security-settings-title" className="font-['Permanent_Marker'] text-2xl tracking-wide text-[var(--orange-main)] sm:text-3xl">
        Security &amp; two-factor authentication
      </h2>
      <div className="mt-7">
        <TwoFactorSettings />
      </div>
    </section>
  );
}
