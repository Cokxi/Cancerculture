import type { Metadata } from "next";
import TwoFactorSettings from "@/app/components/auth/TwoFactorSettings";

export const metadata: Metadata = {
  title: "Security & 2FA | CancerCulture",
};

export default function SecuritySettingsPage() {
  return (
    <section aria-labelledby="security-settings-title" className="max-w-4xl">
      <h2 id="security-settings-title" className="text-2xl font-semibold text-white sm:text-3xl">
        Security &amp; two-factor authentication
      </h2>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/70 sm:text-base">
        Use this page for authenticator setup, recovery access, and factor
        management. Your Discord login and CancerCulture website session remain
        the account entry point.
      </p>
      <div className="mt-7">
        <TwoFactorSettings />
      </div>
    </section>
  );
}
