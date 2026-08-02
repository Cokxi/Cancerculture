import { NextResponse } from "next/server";
import { getResolvedTeamAreaNavigation } from "@/lib/admin/teamAreaNavigation.server";
import { createAccountNavigationState } from "@/lib/auth/accountNavigation";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import type { GlobalAccountViewState } from "@/lib/auth/globalAccount";
import { getSessionState } from "@/lib/auth/sessionState";
import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "Cache-Control": "no-store",
};

function accountResponse(state: GlobalAccountViewState) {
  return NextResponse.json(state, { headers: responseHeaders });
}

export async function GET() {
  try {
    const sessionState = await getSessionState();

    if (sessionState.status !== "authenticated") {
      return accountResponse({ kind: sessionState.status });
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
      hasVisibleTeamAreaItems: teamAccess.hasVisibleTeamAreaItems,
      teamAccessUnavailable: teamAccess.unavailable,
    });

    if (navigation.kind !== "authenticated") {
      return accountResponse({ kind: "dependency_unavailable" });
    }

    return accountResponse({
      kind: "authenticated",
      avatarUrl,
      displayName: account?.current_discord_username ?? "Account",
      navigation,
    });
  } catch (error) {
    console.error("[AUTH] global account state unavailable", error);
    return accountResponse({ kind: "dependency_unavailable" });
  }
}
