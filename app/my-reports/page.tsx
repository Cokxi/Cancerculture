export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
import { getSessionState } from "@/lib/auth/sessionState";
import { loadOwnSubmissionReports } from "@/lib/reports/submissionReportOwn.server";
import OwnSubmissionReportsList from "./OwnSubmissionReportsList";

const MY_REPORTS_PATH = "/my-reports";

export default async function MyReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${MY_REPORTS_PATH}`);
  }
  if (sessionState.status === "restricted") {
    const code = sessionState.reason === "discord_banned"
      ? "DISCORD_BANNED"
      : "WEBSITE_BANNED";
    redirect(`/banned?code=${code}`);
  }
  if (sessionState.status === "dependency_unavailable") {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 text-white">
        <BackButton href="/" label="Home" />
        <div className="rounded-2xl border border-white/10 bg-black/70 p-8 text-center" role="status">
          Your reports are temporarily unavailable.
        </div>
      </main>
    );
  }

  const params = await searchParams;
  let page: Awaited<ReturnType<typeof loadOwnSubmissionReports>>;
  try {
    page = await loadOwnSubmissionReports({
      cursor: params.after ?? null,
      discordUserId: sessionState.session.discord_user_id,
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 400) {
      redirect(MY_REPORTS_PATH);
    }
    throw error;
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 text-white">
      <BackButton href="/" label="Home" />
      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-3xl font-['Permanent_Marker'] text-[var(--orange-dark)]">My Reports</h1>
        <p className="mt-3 max-w-3xl text-sm text-gray-300">
          This private view shows only reports sent by your account and a
          privacy-safe case outcome. An action shown here means the case led to
          an action after review; it does not claim that your individual report
          caused it.
        </p>
      </header>

      <OwnSubmissionReportsList reports={page.items} />

      {page.nextCursor ? (
        <div className="flex justify-center">
          <Link href={`${MY_REPORTS_PATH}?after=${encodeURIComponent(page.nextCursor)}`} className="cursor-pointer rounded-full border border-[var(--orange-dark)]/50 px-5 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10">
            View older reports
          </Link>
        </div>
      ) : null}
    </main>
  );
}
