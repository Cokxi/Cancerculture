import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { supabaseAdmin } from "@/lib/db/admin";
import { updateRulesVersion } from "./actions/updateRulesVersion";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  type TeamAuthorizationContext,
} from "@/lib/auth/teamAuthorization";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  let authorization: TeamAuthorizationContext;

  try {
    authorization = await getTeamAuthorizationContext();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);

    if (destination) {
      redirect(destination);
    }

    throw error;
  }

  const isAdmin = authorization.isAdmin;
  const canModerateSubmissions = hasResolvedTeamCapability(
    authorization,
    "submissions.submission_phase.moderate"
  );
  const canViewBasicUserDirectory = hasResolvedTeamCapability(
    authorization,
    "users.directory.basic.view"
  );
  const legalReviewCount = isAdmin
    ? (
        await supabaseAdmin
          .from("submissions")
          .select("id", { count: "exact", head: true })
          .eq("public_visibility_status", "legal_review")
      ).count ?? 0
    : 0;

  return (
    <div className="min-h-screen flex bg-neutral-950 text-white/90">
      <nav className="w-[220px] shrink-0 border-r border-white/10 p-4 text-sm">
        <ul className="space-y-2">
          <li className="mb-4">
            <Link
              href="/"
              className="block rounded px-2 py-1 text-orange-400 hover:bg-white/10"
            >
              Home
            </Link>
          </li>

          {isAdmin && (
            <li>
              <Link
                href="/admin/cycles"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Cycles
              </Link>
            </li>
          )}

          {isAdmin && (
            <li>
              <Link
                href="/admin/coin-launches"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Coin Launch Links
              </Link>
            </li>
          )}

          {isAdmin && (
            <li>
              <Link
                href="/admin/homepage-info-blocks"
                className="block cursor-pointer rounded px-2 py-1 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-orange-300 active:bg-white/5"
              >
                Homepage Info Boxes
              </Link>
            </li>
          )}

          {canModerateSubmissions && (
            <li>
              <Link
                href="/admin/moderation/submissions"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                <span>Moderation</span>
              </Link>
            </li>
          )}

          {canModerateSubmissions && (
            <li className="ml-3">
              <Link
                href="/admin/moderation/disqualified"
                className="block rounded px-2 py-1 text-yellow-300 hover:bg-white/10"
              >
                Disqualified Submissions
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/winners"
                className="block rounded px-2 py-1 text-green-300 hover:bg-white/10"
              >
                Winner Payouts
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/moderation/legal-review"
                className="flex items-center justify-between rounded px-2 py-1 text-yellow-200 hover:bg-white/10"
              >
                <span>Legal Review</span>
                {legalReviewCount > 0 ? (
                  <span className="rounded-full bg-yellow-500 px-2 py-0.5 text-[11px] font-semibold text-black">
                    {legalReviewCount}
                  </span>
                ) : null}
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="mt-4 text-xs uppercase text-white/50">
              Logs
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/flags"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Flagged Users
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/blocked"
                className="block rounded px-2 py-1 text-orange-300 hover:bg-white/10"
              >
                Blocked Users
              </Link>
            </li>
          )}

          {canViewBasicUserDirectory && (
            <li className="ml-3">
              <Link
                href="/admin/users"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                {isAdmin ? "User Logs" : "Users"}
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/cycles"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Cycle Logs
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/uploads"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Upload Logs
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/avatar-uploads"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Avatar Upload Logs
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/votes"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Vote Logs
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/socials"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                Social Logs
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/sponsors"
                className="block rounded px-2 py-1 text-orange-200 hover:bg-white/10"
              >
                Sponsor Reports
              </Link>
            </li>
          )}

          {isAdmin && (
            <li className="ml-3">
              <Link
                href="/admin/logs/moderation"
                className="block rounded px-2 py-1 hover:bg-white/10"
              >
                <span>Moderation Logs</span>
              </Link>
            </li>
          )}

          {isAdmin && (
            <>
              <li>
                <Link
                  href="/admin/bans"
                  className="block rounded px-2 py-1 text-red-400 hover:bg-white/10"
                >
                  Banned Users
                </Link>
              </li>

              <li>
                <Link
                  href="/admin/team/roles"
                  className="block rounded px-2 py-1 hover:bg-white/10"
                >
                  Team Roles &amp; Permissions
                </Link>
              </li>

              <li className="mt-6 border-t border-white/10 pt-4">
                <form action={updateRulesVersion}>
                  <button
                    type="submit"
                    className="w-full cursor-pointer rounded px-2 py-1 text-left text-yellow-300 hover:bg-white/10"
                  >
                    Update Rules
                  </button>
                </form>
              </li>
            </>
          )}
        </ul>
      </nav>

      <main className="flex-1 overflow-y-auto p-6">
        {children}
      </main>
    </div>
  );
}
