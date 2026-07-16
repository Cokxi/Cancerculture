export const dynamic = "force-dynamic";

import {
  getCycleSponsoredMeta,
  type SponsoredCycleMeta,
} from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import CycleCountdown from "./CycleCountdown";
import SponsorImpressionTracker from "./SponsorImpressionTracker";

const HOME_PERF_PREFIX = "[HOME_PERF]";
const HOME_PERF_JSON_PREFIX = "[HOME_PERF_JSON]";

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
  status,
  theme,
  submission_ends_at,
  voting_ends_at,
  results_published_at,
  archived_at,
  votes_per_user,
  paused_from_status,
  phase_pause_reason,
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
  status: CycleHudStatus;
  theme: string | null;
  submission_ends_at: string | null;
  voting_ends_at: string | null;
  results_published_at: string | null;
  archived_at: string | null;
  votes_per_user: number | null;
  paused_from_status: string | null;
  phase_pause_reason: string | null;
  ends_at: string | null;
  is_sponsored: boolean | null;
  sponsorship_id: number | null;
  sponsor_name_snapshot: string | null;
  sponsor_link_snapshot: string | null;
  sponsor_banner_url_snapshot: string | null;
};

type PerfMetrics = {
  cycleQueryMs: number;
  appConfigMs: number;
  sponsorshipMs: number;
};

function logHomeHudPerf(label: string, durationMs: number) {
  console.log(
    `${HOME_PERF_PREFIX} ${label}: ${durationMs.toFixed(1)}ms`
  );
}

function startHomeHudTimer(label: string) {
  const startedAt = performance.now();
  logHomeHudPerf(`${label} start`, 0);

  return () => {
    const durationMs = performance.now() - startedAt;
    logHomeHudPerf(label, durationMs);
    return durationMs;
  };
}

async function timeHomeHudAsync<T>(
  label: string,
  callback: () => Promise<T>,
  onDuration?: (durationMs: number) => void
) {
  const startedAt = performance.now();
  logHomeHudPerf(`${label} start`, 0);

  try {
    return await callback();
  } finally {
    const durationMs = performance.now() - startedAt;
    onDuration?.(durationMs);
    logHomeHudPerf(label, durationMs);
  }
}

function timeHomeHudSync<T>(label: string, callback: () => T) {
  const startedAt = performance.now();
  logHomeHudPerf(`${label} start`, 0);

  try {
    return callback();
  } finally {
    logHomeHudPerf(label, performance.now() - startedAt);
  }
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

async function getPreferredCycle(metrics: PerfMetrics) {
  const relevantResult = await timeHomeHudAsync(
    "home CycleHud relevant phase cycle query",
    async () =>
      await supabaseAdmin
        .from("voting_cycles")
        .select(CYCLE_HUD_SELECT)
        .in("status", RELEVANT_CYCLE_STATUSES)
        .order("id", { ascending: false })
        .limit(12),
    (durationMs) => {
      metrics.cycleQueryMs += durationMs;
    }
  );

  const relevantCycles = (relevantResult.data ??
    []) as CycleHudRow[];
  const relevantCycle = timeHomeHudSync(
    "home CycleHud relevant cycle selection transform",
    () => choosePreferredCycle(relevantCycles)
  );

  if (relevantCycle) {
    timeHomeHudSync(
      "home active/open cycle loading (latest cycle fallback skipped)",
      () => null
    );
    return relevantCycle;
  }

  const latestResult = await timeHomeHudAsync(
    "home active/open cycle loading (latest cycle fallback query)",
    async () =>
      await supabaseAdmin
        .from("voting_cycles")
        .select(CYCLE_HUD_SELECT)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle(),
    (durationMs) => {
      metrics.cycleQueryMs += durationMs;
    }
  );

  return (latestResult.data as CycleHudRow | null) ?? null;
}

function getDisplayState({
  cycle,
  sponsoredMeta,
  nowMs,
}: {
  cycle: CycleHudRow;
  sponsoredMeta: SponsoredCycleMeta | null;
  nowMs: number;
}) {
  const themeFromCycle = normalizeString(cycle.theme);
  const displayTheme =
    sponsoredMeta?.enabled && sponsoredMeta.companyName.length > 0
      ? "Sponsored Cycle"
      : themeFromCycle || "Open Cycle";

  switch (cycle.status) {
    case "submission_open": {
      const endAt = cycle.submission_ends_at;
      const endAtMs = endAt ? new Date(endAt).getTime() : null;

      return {
        displayTheme,
        displayStatus: "SUBMISSION OPEN",
        statusClassName: "text-green-400",
        timerLabel: "Submission phase ends in:",
        timerEndAt: endAt,
        isTimerActive: Boolean(endAtMs && endAtMs > nowMs),
        votesPerUser:
          cycle.votes_per_user && cycle.votes_per_user !== 2
            ? cycle.votes_per_user
            : null,
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
        timerEndAt: endAt,
        isTimerActive: Boolean(endAtMs && endAtMs > nowMs),
        votesPerUser:
          cycle.votes_per_user && cycle.votes_per_user !== 2
            ? cycle.votes_per_user
            : null,
      };
    }

    case "paused":
      return {
        displayTheme,
        displayStatus: "PAUSED",
        statusClassName: "text-red-500",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser:
          cycle.votes_per_user && cycle.votes_per_user !== 2
            ? cycle.votes_per_user
            : null,
      };

    case "submission_closed":
      return {
        displayTheme,
        displayStatus: "SUBMISSION CLOSED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser: null,
      };

    case "voting_closed":
      return {
        displayTheme,
        displayStatus: "VOTING CLOSED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser: null,
      };

    case "finalizing":
      return {
        displayTheme,
        displayStatus: "FINALIZING",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser: null,
      };

    case "completed":
      return {
        displayTheme,
        displayStatus: "COMPLETED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser: null,
      };

    case "finished":
      return {
        displayTheme,
        displayStatus: "FINALIZED",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser: null,
      };

    case "active": {
      const endAt = cycle.ends_at;
      const endAtMs = endAt ? new Date(endAt).getTime() : null;

      return {
        displayTheme,
        displayStatus: "ACTIVE",
        statusClassName: "text-green-400",
        timerLabel: "Ends in:",
        timerEndAt: endAt,
        isTimerActive: Boolean(endAtMs && endAtMs > nowMs),
        votesPerUser: null,
      };
    }

    default:
      return {
        displayTheme,
        displayStatus: cycle.status?.toUpperCase() ?? "-",
        statusClassName: "text-red-600",
        timerLabel: null,
        timerEndAt: null,
        isTimerActive: false,
        votesPerUser: null,
      };
  }
}

export default async function CycleHud() {
  const metrics: PerfMetrics = {
    cycleQueryMs: 0,
    appConfigMs: 0,
    sponsorshipMs: 0,
  };
  const endHudTimer = startHomeHudTimer(
    "home CycleHud server render total"
  );

  timeHomeHudSync(
    "home CycleHud Supabase client creation check (module singleton/no per-render creation)",
    () => supabaseAdmin
  );
  timeHomeHudSync(
    "home CycleHud auth/session/user/team/admin check (not used)",
    () => null
  );

  const nowMs = timeHomeHudSync(
    "home CycleHud now timestamp transform",
    () => Date.parse(new Date().toISOString())
  );
  const cycle = await getPreferredCycle(metrics);
  const snapshotSponsorMeta = cycle
    ? timeHomeHudSync(
        "home CycleHud sponsor snapshot transform",
        () => sponsorMetaFromSnapshot(cycle)
      )
    : null;
  const shouldUseSponsorFallback =
    cycle?.is_sponsored === true &&
    (!snapshotSponsorMeta ||
      snapshotSponsorMeta.companyName.length === 0 ||
      snapshotSponsorMeta.sponsorLink.length === 0);
  const fallbackSponsorMeta =
    cycle && shouldUseSponsorFallback
      ? await timeHomeHudAsync(
          "home sponsor/cycle sponsorship loading",
          () => getCycleSponsoredMeta(cycle.id),
          (durationMs) => {
            metrics.sponsorshipMs += durationMs;
          }
        )
      : timeHomeHudSync(
          cycle
            ? "home sponsor/cycle sponsorship loading skipped (snapshot or no sponsor)"
            : "home sponsor/cycle sponsorship loading skipped (no cycle)",
          () => null
        );
  const sponsoredMeta = snapshotSponsorMeta ?? fallbackSponsorMeta;

  const { data: configRows } = await timeHomeHudAsync(
    "home cycle hud app_config loading (next_cycle_theme only)",
    async () =>
      await supabaseAdmin
        .from("app_config")
        .select("key,value")
        .eq("key", "next_cycle_theme"),
    (durationMs) => {
      metrics.appConfigMs += durationMs;
    }
  );

  const nextCycleTheme = timeHomeHudSync(
    "home CycleHud app_config next_cycle_theme transform",
    () => normalizeString(configRows?.[0]?.value)
  );

  const displayState = cycle
    ? timeHomeHudSync(
        "home CycleHud display state transform",
        () =>
          getDisplayState({
            cycle,
            sponsoredMeta,
            nowMs,
          })
      )
    : null;

  timeHomeHudSync(
    "home CycleHud render readiness transform",
    () => ({
      hasCycle: Boolean(cycle),
      status: cycle?.status ?? null,
      hasEndAt: Boolean(displayState?.timerEndAt),
      hasSponsor: Boolean(sponsoredMeta?.enabled),
      usedSponsorSnapshot: Boolean(snapshotSponsorMeta),
      usedSponsorFallback: Boolean(fallbackSponsorMeta),
    })
  );

  const totalMs = endHudTimer();

  console.log(
    `${HOME_PERF_JSON_PREFIX} ${JSON.stringify({
      component: "CycleHud",
      totalMs: Number(totalMs.toFixed(1)),
      cycleQueryMs: Number(metrics.cycleQueryMs.toFixed(1)),
      appConfigMs: Number(metrics.appConfigMs.toFixed(1)),
      sponsorshipMs: Number(metrics.sponsorshipMs.toFixed(1)),
      hasCycle: Boolean(cycle),
      status: cycle?.status ?? null,
      hasSponsor: Boolean(sponsoredMeta?.enabled),
      usedSponsorSnapshot: Boolean(snapshotSponsorMeta),
      usedSponsorFallback: Boolean(fallbackSponsorMeta),
    })}`
  );

  if (!cycle || !displayState) return null;

  return (
    <div
      className="
        absolute
        top-[150px]
        z-0
        left-0
        w-full
        flex
        justify-center
        pointer-events-none
      "
    >
      <div className="inline-flex flex-col text-left gap-[2px] leading-tight">
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
          <span className="text-green-400">{cycle.id}</span>
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

        {displayState.isTimerActive && displayState.timerEndAt && (
          <div className="font-['Permanent_Marker']">
            <span className="text-[var(--orange-main)]">
              {displayState.timerLabel}{" "}
            </span>
            <CycleCountdown endAt={displayState.timerEndAt} />
          </div>
        )}

        {displayState.votesPerUser ? (
          <div className="font-['Permanent_Marker'] text-xs">
            <span className="text-[var(--orange-main)]">
              Votes per user:{" "}
            </span>
            <span className="text-green-400">
              {displayState.votesPerUser}
            </span>
          </div>
        ) : null}

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
