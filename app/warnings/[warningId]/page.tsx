export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth/sessionState";
import { loadOwnUserWarningDetail } from "@/lib/warnings/userWarningVisibility.server";

export const metadata: Metadata = {
  title: "Account Warning | CancerCulture",
  robots: { index: false, follow: false },
};

const categoryLabels = {
  spam: "Spam",
  hate_speech: "Hate speech",
  other: "Other",
} as const;

const statusLabels = {
  active: "Active",
  expired: "Expired",
  overruled: "Overruled",
} as const;

export default async function OwnWarningDetailPage({
  params,
}: {
  params: Promise<{ warningId: string }>;
}) {
  const { warningId } = await params;
  const returnPath = `/warnings/${encodeURIComponent(warningId)}`;
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${encodeURIComponent(returnPath)}`);
  }
  if (sessionState.status === "restricted") {
    redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  }
  if (sessionState.status === "dependency_unavailable") notFound();

  const warning = await loadOwnUserWarningDetail({
    sessionId: sessionState.session.session_id,
    publicWarningId: warningId,
  });
  if (!warning) notFound();

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <Link
        href="/notifications"
        className="text-sm font-semibold text-[var(--orange-main)] underline underline-offset-4"
      >
        Back to notifications
      </Link>
      <section className="mt-6 rounded-2xl border border-[var(--orange-main)]/55 bg-black/45 p-6 shadow-[0_24px_80px_rgba(255,90,31,0.12)]">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--orange-main)]">
          CancerCulture Team
        </p>
        <h1 className="mt-2 font-['Permanent_Marker'] text-4xl tracking-wide text-[var(--orange-main)]">
          Account Warning
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-white/65">
          This page shows the current effective status of a Warning issued for your account.
        </p>

        <dl className="mt-7 grid gap-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--orange-main)]/75">Category</dt>
            <dd className="mt-1 text-white">{categoryLabels[warning.category]}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--orange-main)]/75">Effective status</dt>
            <dd className="mt-1 text-white">{statusLabels[warning.effectiveStatus]}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--orange-main)]/75">Issued</dt>
            <dd className="mt-1 text-white">{new Date(warning.issuedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--orange-main)]/75">Effective expiry</dt>
            <dd className="mt-1 text-white">{new Date(warning.expiresAt).toLocaleString()}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-[var(--orange-main)]/75">Reason</dt>
            <dd className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-[var(--orange-main)]/25 bg-[var(--orange-main)]/5 p-4 text-sm leading-relaxed text-white/85">
              {warning.reason}
            </dd>
          </div>
        </dl>

        <p className="mt-7 text-xs leading-relaxed text-white/50">
          Team member identities and internal moderation or automatic-review details are not part of this view.
        </p>
      </section>
    </main>
  );
}
