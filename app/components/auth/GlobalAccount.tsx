import Link from "next/link";
import AccountMenu from "@/app/components/auth/AccountMenu";
import { navigationTextTriggerClassName } from "@/app/components/navigation/navigationButtonStyles";
import { getResolvedTeamAreaNavigation } from "@/lib/admin/teamAreaNavigation.server";
import {
  createAccountNavigationState,
} from "@/lib/auth/accountNavigation";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import { getSessionState } from "@/lib/auth/sessionState";
import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export default async function GlobalAccount() {
  const sessionState = await getSessionState();

  if (sessionState.status === "anonymous") {
    return (
      <Link
        href="/api/auth/discord/login?state=/"
        className={navigationTextTriggerClassName}
      >
        Login with Discord
      </Link>
    );
  }

  if (sessionState.status === "dependency_unavailable") {
    return (
      <div
        className="rounded-full border border-white/10 bg-black/80 px-3 py-2 text-xs text-white/70"
        role="status"
      >
        Account temporarily unavailable
      </div>
    );
  }

  if (sessionState.status === "restricted") {
    return (
      <div className="flex items-center gap-3 rounded-full border border-red-400/30 bg-black/85 px-3 py-2 text-xs text-red-300">
        <span>Account restricted</span>
        <form action="/api/auth/logout?returnTo=/" method="post">
          <button
            type="submit"
            className="cursor-pointer underline underline-offset-2"
          >
            Logout
          </button>
        </form>
      </div>
    );
  }

  const discordUserId = sessionState.session.discord_user_id;
  const [accountResult, teamAccess] = await Promise.all([
    runAuthQueryWithTimeout(
      "global account profile lookup",
      supabaseAdmin
        .from("user_logs")
        .select(
          "avatar_key, avatar_updated_at, current_discord_username, discord_avatar"
        )
        .eq("discord_user_id", discordUserId)
        .maybeSingle()
    ).catch((error) => {
      console.error("[AUTH] global account profile unavailable", error);
      return { data: null, error: null };
    }),
    getResolvedTeamAreaNavigation()
      .then((navigation) => ({
        hasVisibleTeamAreaItems: navigation.length > 0,
        unavailable: false,
      }))
      .catch((error) => {
        const status = getAuthErrorStatus(error);
        if (status === 403) {
          return {
            hasVisibleTeamAreaItems: false,
            unavailable: false,
          };
        }
        if (status === 401 || status === 503) {
          return {
            hasVisibleTeamAreaItems: false,
            unavailable: true,
          };
        }
        throw error;
      }),
  ]);

  if (accountResult.error) {
    console.error("[AUTH] global account profile query failed", {
      code: accountResult.error.code,
    });
  }
  const account = accountResult.error ? null : accountResult.data;
  const avatarUrl = account?.avatar_key
    ? getPublicImageUrl(account.avatar_key) ?? null
    : account?.discord_avatar
      ? `https://cdn.discordapp.com/avatars/${discordUserId}/${account.discord_avatar}.png`
      : null;
  const navigation = createAccountNavigationState({
    sessionStatus: "authenticated",
    hasVisibleTeamAreaItems:
      teamAccess.hasVisibleTeamAreaItems,
    teamAccessUnavailable: teamAccess.unavailable,
  });

  if (navigation.kind !== "authenticated") return null;

  return (
    <AccountMenu
      avatarUrl={avatarUrl}
      displayName={account?.current_discord_username ?? "Account"}
      navigation={navigation}
    />
  );
}
