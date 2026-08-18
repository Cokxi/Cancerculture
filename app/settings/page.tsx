import Link from "next/link";

const categoryClassName =
  "group flex min-h-36 items-start justify-between gap-5 rounded-2xl border border-white/10 bg-black/35 p-5 text-left outline-none transition hover:border-[var(--orange-main)]/60 hover:bg-[var(--orange-main)]/5 focus-visible:ring-2 focus-visible:ring-[var(--orange-main)] sm:p-6";

export default function SettingsPage() {
  return (
    <section aria-labelledby="settings-categories-title">
      <h2 id="settings-categories-title" className="font-['Permanent_Marker'] text-2xl tracking-wide text-[var(--orange-main)]">
        Choose a settings category
      </h2>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Link href="/settings/notifications" className={categoryClassName}>
          <span>
            <span className="block font-['Permanent_Marker'] text-lg tracking-wide text-[var(--orange-main)]">Notifications</span>
            <span className="mt-2 block text-sm leading-relaxed text-white/65">
              Private account updates and optional per-device Web Push categories.
            </span>
            <span className="mt-3 block text-xs font-semibold uppercase tracking-wide text-orange-200/80">
              Discord sign-in required
            </span>
          </span>
          <span aria-hidden className="text-2xl text-[var(--orange-main)] transition group-hover:translate-x-1">›</span>
        </Link>
        <Link href="/settings/security" className={categoryClassName}>
          <span>
            <span className="block font-['Permanent_Marker'] text-lg tracking-wide text-[var(--orange-main)]">Security &amp; 2FA</span>
            <span className="mt-2 block text-sm leading-relaxed text-white/65">
              Authenticator setup, one-time recovery codes, verified backup email,
              factor replacement, and account recovery.
            </span>
            <span className="mt-3 block text-xs font-semibold uppercase tracking-wide text-orange-200/80">
              Discord sign-in required
            </span>
          </span>
          <span aria-hidden className="text-2xl text-[var(--orange-main)] transition group-hover:translate-x-1">›</span>
        </Link>
        <Link href="/settings/sponsor-analytics" className={categoryClassName}>
          <span>
            <span className="block font-['Permanent_Marker'] text-lg tracking-wide text-[var(--orange-main)]">Sponsor analytics</span>
            <span className="mt-2 block text-sm leading-relaxed text-white/65">
              Review or change optional sponsor-banner view and link-click
              measurement.
            </span>
            <span className="mt-3 block text-xs font-semibold uppercase tracking-wide text-emerald-200/80">
              Available without signing in
            </span>
          </span>
          <span aria-hidden className="text-2xl text-[var(--orange-main)] transition group-hover:translate-x-1">›</span>
        </Link>
      </div>
    </section>
  );
}
