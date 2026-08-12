export const dynamic = "force-dynamic";

import {
  getCycleSponsoredMeta,
  type SponsoredCycleMeta,
} from "@/lib/cycles/sponsoredCycle";
import {
  DEFAULT_SUBMISSIONS_PER_USER,
  isValidSubmissionsPerUser,
} from "@/lib/cycles/submissionSettings";
import { supabaseAdmin } from "@/lib/db/admin";
import { requirePublicCycleNumber } from "@/lib/cycles/publicCycleNumber";
import { POST_VOTING_WRAPPING_UP_TEXT } from "@/lib/cycles/postVoting";
import CycleCountdown from "./CycleCountdown";
import SponsorImpressionTracker from "./SponsorImpressionTracker";

const RELEVANT_CYCLE_STATUSES = [
  "submission_open",
  "voting_open",
  "paused",
  "submission_closed",
  "voting_closed",
  "finalizing",
  "completed",
  "active",
  "finished",
] as const;

const CYCLE_HUD_SELECT = `
  id,
  public_number,
  status,
  theme,
  submission_ends_at,
  voting_ends_at,
  votes_per_user,
  submissions_per_user,
  ends_at,
  is_sponsored,
  sponsorship_id,
  sponsor_name_snapshot,
  sponsor_link_snapshot,
  sponsor_banner_url_snapshot
`;

type CycleHudStatus = (typeof RELEVANT_CYCLE_STATUSES)[number] | string;

type CycleHudRow = {
  id: number;
  public_number: number | null;
  status: CycleHudStatus;
  theme: string | null;
  submission_ends_at: string | null;
  voting_ends_at: string | null;
  votes_per_user: number | null;
  submissions_per_user: number | null;
  ends_at: string | null;
  is_sponsored: boolean | null;
  sponsorship_id: number | null;
  sponsor_name_snapshot: string | null;
  sponsor_link_snapshot: string | null;
  sponsor_banner_url_snapshot: string | null;
};

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVotesPerUser(value: number | null) {
  return Number.isInteger(value) && value !== null && value >= 1 && value <= 50
    ? value
    : 2;
}

function normalizeSubmissionsPerUser(value: number | null) {
  return isValidSubmissionsPerUser(value)
    ? value
    : DEFAULT_SUBMISSIONS_PER_USER;
}

function getCyclePriority(status: CycleHudStatus) {
  const index = RELEVANT_CYCLE_STATUSES.indexOf(
    status as (typeof RELEVANT_CYCLE_STATUSES)[number]
  );

  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function choosePreferredCycle(cycles: CycleHudRow[]) {
  return [...cycles].sort((a, b) => {
    const priorityDelta =
      getCyclePriority(a.status) - getCyclePriority(b.status);

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return b.id - a.id;
  })[0] ?? null;
}

function sponsorMetaFromSnapshot(
  cycle: CycleHudRow
): SponsoredCycleMeta | null {
  if (cycle.is_sponsored !== true) {
    return null;
  }

  const companyName = normalizeString(cycle.sponsor_name_snapshot);
  const sponsorLink = normalizeString(cycle.sponsor_link_snapshot);
  const bannerUrl = normalizeString(
    cycle.sponsor_banner_url_snapshot
  );

  if (!companyName && !sponsorLink && !bannerUrl) {
    return null;
  }

  return {
    sponsorshipId: cycle.sponsorship_id,
    enabled: true,
    companyName,
    sponsorLink,
    bannerR2Key: "",
    bannerUrl: bannerUrl || null,
  };
}

async function getPreferredCycle() {
  const relevantResult = await supabaseAdmin
    .from("voting_cycles")
    .select(CYCLE_HUD_SELECT)
    .in("status", RELEVANT_CYCLE_STATUSES)
    .order("id", { ascending: false })
    .limit(12);

  if (relevantResult.error) {
    console.error("[cycle hud][relevant cycles]", {
      code: relevantResult.error.code,
    });
    throw new Error("Cycle HUD data is unavailable");
  }

  const relevantCycles = (relevantResult.data ??
    []) as CycleHudRow[];
  const relevantCycle = choosePreferredCycle(relevantCycles);

  if (relevantCycle) {
    return relevantCycle;
  }

  const latestResult = await supabaseAdmin
    .from("voting_cycles")
    .select(CYCLE_HUD_SELECT)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestResult.error) {
    console.error("[cycle hud][latest cycle]", {
      code: latestResult.error.code,
    });
    throw new Error("Cycle HUD data is unavailable");
  }

  return (latestResult.data as CycleHudRow | null) ?? null;
}

function getDisplayState({
  cycle,
  sponsoredMeta,
}: {
  cycle: CycleHudRow;
  sponsoredMeta: SponsoredCycleMeta | null;
}) {
  const themeFromCycle = normalizeString(cycle.theme);
  const displayTheme =
    sponsoredMeta?.enabled && sponsoredMeta.companyName.length > 0
      ? "Sponsored Cycle"
      : themeFromCycle || "Open Cycle";
  const perUserLimits = {
    votesPerUser: normalizeVotesPerUser(cycle.votes_per_user),
    submissionsPerUser: normalizeSubmissionsPerUser(
      cycle.submissions_per_user
    ),
  };

  switch (cycle.status) {
    case "submission_open": {
      const endAt = cycle.submission_ends_at;
      const endAtMs = endAt ? new Date(endAt).getTime() : null;

      return {
        displayTheme,
        displayStatus: "SUBMISSION OPEN",
        statusClassName: "text-green-400",
        timerLabel: "Submission phase ends in:",
        timerExpiredLabel: "Submission phase is ending…",
        timerEndAt: endAt,
        isTimerActive: Boolean(endAtMs && Number.isFinite(endAtMs)),
        ...perUserLimits,
      };
    }

    case "voting_open": {
      const endAt = cycle.voting_ends_at;
      const endAtMs = endAt ? new Date(endAt).getTime() : null;

      return {
        displayTheme,
        displayStatus: "VOTING OPEN",
        statusClassName: "text-green-400",
        timerLabel: "Voting phase ends in:",
        timerExpiredLabel: "Voting phase is ending…",
        timerEndAt: endAt,
        isTimerActive: Boolean(endAtMs && Number.isFinite(endAtMs)),
        ...perUserLimits,
      };
    }

    case "paused":
      return {
        displayTheme,
        displayStatus: "PAUSED",
        statusClassName: "text-red-500",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };

    case "submission_closed":
      return {
        displayTheme,
        displayStatus: "SUBMISSION CLOSED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };

    case "voting_closed":
      return {
        displayTheme,
        displayStatus: POST_VOTING_WRAPPING_UP_TEXT,
        statusClassName: "text-red-600",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };

    case "finalizing":
      return {
        displayTheme,
        displayStatus: "FINALIZING",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };

    case "completed":
      return {
        displayTheme,
        displayStatus: "COMPLETED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };

    case "finished":
      return {
        displayTheme,
        displayStatus: "FINALIZED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };

    case "active": {
      const endAt = cycle.ends_at;
      const endAtMs = endAt ? new Date(endAt).getTime() : null;

      return {
        displayTheme,
        displayStatus: "ACTIVE",
        statusClassName: "text-green-400",
        timerLabel: "Ends in:",
        timerExpiredLabel: "Cycle phase is ending…",
        timerEndAt: endAt,
        isTimerActive: Boolean(endAtMs && Number.isFinite(endAtMs)),
        ...perUserLimits,
      };
    }

    default:
      return {
        displayTheme,
        displayStatus: cycle.status?.toUpperCase() ?? "-",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerExpiredLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        ...perUserLimits,
      };
  }
}

export default async function CycleHud() {
  const cyclePromise = getPreferredCycle();
  const nextCycleThemePromise = supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", "next_cycle_theme");
  const cycle = await cyclePromise;
  const snapshotSponsorMeta = cycle
    ? sponsorMetaFromSnapshot(cycle)
    : null;
  const shouldUseSponsorFallback =
    cycle?.is_sponsored === true &&
    (!snapshotSponsorMeta ||
      snapshotSponsorMeta.companyName.length === 0 ||
      snapshotSponsorMeta.sponsorLink.length === 0);
  const fallbackSponsorMetaPromise =
    cycle && shouldUseSponsorFallback
      ? getCycleSponsoredMeta(cycle.id)
      : Promise.resolve(null);
  const [fallbackSponsorMeta, { data: configRows }] =
    await Promise.all([
      fallbackSponsorMetaPromise,
      nextCycleThemePromise,
    ]);
  const sponsoredMeta = snapshotSponsorMeta ?? fallbackSponsorMeta;
  const nextCycleTheme = normalizeString(
    configRows?.[0]?.value
  );

  const displayState = cycle
      ? getDisplayState({
        cycle,
        sponsoredMeta,
      })
    : null;

  if (!cycle || !displayState) return null;

  return (
    <div
      className="pointer-events-none flex w-full justify-center px-2"
    >
      <div className="inline-flex max-w-[88vw] flex-col gap-[2px] break-words text-left leading-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] sm:max-w-none">
        <div
          className="
            text-[1.55rem] tracking-wide
            text-[var(--orange-main)]
            font-['Permanent_Marker']
            pb-[2px]
            mb-[2px]
            border-b
            border-[rgba(0,0,0,0.35)]
          "
        >
          {displayState.displayTheme}
        </div>

        <div className="font-['Permanent_Marker']">
          <span className="text-[var(--orange-main)]">Cycle: </span>
          <span className="text-green-400">
            {requirePublicCycleNumber(cycle.public_number)}
          </span>
        </div>

        {sponsoredMeta?.enabled &&
          sponsoredMeta.companyName.length > 0 && (
            <div className="font-['Permanent_Marker'] text-[1.02rem] leading-tight">
              {sponsoredMeta.sponsorshipId ? (
                <SponsorImpressionTracker
                  sponsorshipId={sponsoredMeta.sponsorshipId}
                  surface="home_hud"
                />
              ) : null}
              <span className="text-[var(--orange-main)]">
                Presented by:{" "}
              </span>
              {sponsoredMeta.sponsorLink.length > 0 ? (
                <a
                  href={
                    sponsoredMeta.sponsorshipId
                      ? `/api/sponsor/click?sponsorshipId=${sponsoredMeta.sponsorshipId}&surface=home_hud`
                      : sponsoredMeta.sponsorLink
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="pointer-events-auto text-green-400 underline underline-offset-4 transition hover:text-green-300"
                >
                  {sponsoredMeta.companyName}
                </a>
              ) : (
                <span className="text-green-400">
                  {sponsoredMeta.companyName}
                </span>
              )}
            </div>
          )}

        <div className="font-['Permanent_Marker']">
          <span className="text-[var(--orange-main)]">Status: </span>
          <span className={displayState.statusClassName}>
            {displayState.displayStatus}
          </span>
        </div>

        {displayState.isTimerActive &&
        displayState.timerEndAt &&
        displayState.timerLabel &&
        displayState.timerExpiredLabel ? (
          <div className="font-['Permanent_Marker']">
            <CycleCountdown
              key={`${cycle.status}:${displayState.timerEndAt}`}
              endAt={displayState.timerEndAt}
              timerLabel={displayState.timerLabel}
              expiredLabel={displayState.timerExpiredLabel}
            />
          </div>
        ) : null}

        <div className="font-['Permanent_Marker'] text-xs">
          <span className="text-[var(--orange-main)]">
            Submissions per user:{" "}
          </span>
          <span className="text-green-400">
            {displayState.submissionsPerUser}
          </span>
        </div>

        <div className="font-['Permanent_Marker'] text-xs">
          <span className="text-[var(--orange-main)]">
            Votes per user:{" "}
          </span>
          <span className="text-green-400">
            {displayState.votesPerUser}
          </span>
        </div>

        {nextCycleTheme.length > 0 && (
          <div className="font-['Permanent_Marker'] text-xs">
            <span className="text-[var(--orange-main)]">
              Next Theme:{" "}
            </span>
            <span className="text-red-600">{nextCycleTheme}</span>
          </div>
        )}
      </div>
    </div>
  );
}
