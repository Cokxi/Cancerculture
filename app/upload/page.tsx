import PageWrapper from "@/app/components/ui/PageWrapper";
import DesktopUpload from "@/app/components/upload/DesktopUpload";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";
import { getDiscordSyncDelayNotice } from "@/lib/auth/discordSyncDelayNotice";
import { getParticipationAccess } from "@/lib/auth/participationGuard";
import { getSessionState } from "@/lib/auth/sessionState";
import { getUserSocialSettings } from "@/lib/socials/getUserSocialSettings";
import {
  getUploadEligibility,
  UploadEligibilityDependencyError,
} from "@/lib/upload/getUploadEligibility";
import { getLatestCycleState } from "@/lib/cycles/currentCycle";
import { createParticipationAccessState } from "@/lib/eligibility/participation";
import type { UserSocialSettings } from "@/lib/socials/getUserSocialSettings";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const [sessionState, latestCycle] = await Promise.all([
    getSessionState(),
    getLatestCycleState(),
  ]);
  const emptySocialSettings: UserSocialSettings = {
    showSocialsOnSubmissions: false,
    socialCount: 0,
    verifiedSocialCount: 0,
    socialPlatforms: [],
  };
  let socialSettings = emptySocialSettings;
  let uploadEligibility: Awaited<
    ReturnType<typeof getUploadEligibility>
  > | null = null;
  let participationState = createParticipationAccessState();
  let showDiscordSyncDelayNotice = false;

  if (sessionState.status === "restricted") {
    participationState = createParticipationAccessState({
      authenticated: true,
      discordBanned: sessionState.reason === "discord_banned",
      websiteBanned: sessionState.reason === "website_banned",
    });
  } else if (sessionState.status === "dependency_unavailable") {
    participationState = createParticipationAccessState({
      authenticated: true,
      dependencyUnavailable: true,
    });
  } else if (sessionState.status === "authenticated") {
    try {
      const participationResult = await getParticipationAccess();
      const discordUserId = participationResult.session.discord_user_id;

      [uploadEligibility, socialSettings] = await Promise.all([
        getUploadEligibility({
          discordUserId,
          includeDiscordMembership: false,
        }),
        getUserSocialSettings(discordUserId),
      ]);
      participationState = uploadEligibility.isBanned
        ? createParticipationAccessState({
            authenticated: true,
            websiteBanned: true,
          })
        : participationResult.access;
      showDiscordSyncDelayNotice = await getDiscordSyncDelayNotice({
        authenticated: participationState.authenticated,
        participationEligible: participationState.participationEligible,
        membershipReason: participationResult.membership.reason,
        websiteBanned: participationState.websiteBanned,
        discordBanned: participationState.discordBanned,
        sessionValid: true,
        dependencyUnavailable:
          participationState.dependencyUnavailable,
      });
    } catch (error) {
      const authStatus = getAuthErrorStatus(error);
      const authCode = getAuthErrorCode(error)?.split(":")[0];

      if (
        !(error instanceof UploadEligibilityDependencyError) &&
        authStatus === null
      ) {
        throw error;
      }

      participationState =
        authStatus === 401
          ? createParticipationAccessState()
          : authStatus === 403
            ? createParticipationAccessState({
                authenticated: true,
                discordBanned: authCode === "DISCORD_BANNED",
                websiteBanned: authCode === "WEBSITE_BANNED",
              })
            : createParticipationAccessState({
                authenticated: true,
                dependencyUnavailable: true,
              });
    }
  }

  const phaseAllowsUploads =
    latestCycle?.status === "submission_open" ||
    latestCycle?.status === "active";

  return (
    <PageWrapper>
      <DesktopUpload
        hasActiveCycle={
          uploadEligibility
            ? Boolean(uploadEligibility.activeCycleId)
            : phaseAllowsUploads
        }
        showSupportLink
        forceSuccessState={uploadEligibility?.alreadyUploaded ?? false}
        socialSettings={socialSettings}
        participationState={participationState}
        showDiscordSyncDelayNotice={showDiscordSyncDelayNotice}
        currentCycleStatus={latestCycle?.status ?? null}
        pausedFromStatus={latestCycle?.paused_from_status ?? null}
      />
    </PageWrapper>
  );
}
