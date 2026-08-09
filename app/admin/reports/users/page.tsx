export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadSubmissionReporterProfiles } from "@/lib/reports/submissionReportTeam.server";

function text(value: unknown, fallback = "-") { return typeof value === "string" && value ? value : fallback; }

export default async function SubmissionReporterProfilesPage() {
  let profiles: Awaited<ReturnType<typeof loadSubmissionReporterProfiles>>;
  try { profiles = await loadSubmissionReporterProfiles(); }
  catch (error) { const destination = getTeamPageAccessRedirect(error); if (destination) redirect(destination); throw error; }
  return (
    <main className="space-y-6 p-6 text-white">
      <BackButton href="/admin/reports" label="Submission Reports" />
      <header><h1 className="text-3xl font-semibold">Reporter User Logs</h1><p className="mt-2 max-w-3xl text-sm text-white/60">Reporter-centered history, independent of User Directory rights. This is human-review context, never a score.</p></header>
      {profiles.length === 0 ? <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-white/60">No reporter history is available.</div> : <div className="space-y-3">{profiles.map((profile) => <Link key={text(profile.publicProfileId)} href={`/admin/reports/users/${text(profile.publicProfileId)}`} className="block cursor-pointer rounded-xl border border-white/10 bg-black/40 p-5 hover:border-orange-300/40"><div className="font-semibold text-orange-200">{text(profile.label, "Reporter")}</div><div className="mt-2 text-xs text-white/60">{String(profile.reportCount)} reports · {String(profile.actionTakenCaseCount)} in cases closed with action · latest {text(profile.latestReportAt)}</div></Link>)}</div>}
    </main>
  );
}
