import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { requireTeamAreaAccess, TeamAccessError } from "@/lib/auth/teamAccess.server";
import { readTeamAuthorizationContextForDiscordUserId } from "@/lib/auth/teamAuthorization";
import { getTwoFactorStatus } from "@/lib/twoFactor/service.server";
import TeamAccessForm from "./TeamAccessForm";

export const dynamic = "force-dynamic";

export default async function TeamAccessPage() {
  try {
    const session = await requireSession();
    await readTeamAuthorizationContextForDiscordUserId(session.discord_user_id);
    try {
      await requireTeamAreaAccess(session);
      redirect("/admin");
    } catch (error) {
      if (
        !(error instanceof TeamAccessError) ||
        !["TEAM_TOTP_REQUIRED", "TEAM_SECURITY_CONTEXT_CHANGED"].includes(error.code)
      ) {
        throw error;
      }
    }
    const status = await getTwoFactorStatus(session);

    return (
      <main className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center px-4 py-12">
        <section className="w-full rounded-2xl border border-white/10 bg-black/45 p-6 shadow-2xl sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-200/80">
            Protected Team Area
          </p>
          <h1 className="mt-3 text-2xl font-bold text-white">Team verification required</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/70">
            Enter one current authenticator code to unlock Team Area pages and actions for 12 hours in this website session.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-white/55">
            A relevant change to the coarse browser or network security context requires verification again. CancerCulture does not store raw device, browser, or network information.
          </p>
          {status.active ? (
            <TeamAccessForm />
          ) : (
            <div className="mt-6 rounded-xl border border-red-300/25 bg-red-950/20 p-4">
              <p className="text-sm leading-relaxed text-red-100">
                Active two-factor authentication is mandatory for every Team Area member.
              </p>
              <Link href="/account" className="mt-3 inline-block font-semibold text-orange-200 underline">
                Open 2FA settings
              </Link>
            </div>
          )}
        </section>
      </main>
    );
  } catch (error) {
    if (error instanceof AuthError && error.code === "NOT_AUTHENTICATED") {
      redirect("/403");
    }
    const status = getAuthErrorStatus(error);
    if (status === 403) redirect("/403");
    if (status === 503) redirect("/503");
    throw error;
  }
}
