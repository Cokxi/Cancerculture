export const dynamic = "force-dynamic";

import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import CycleCountdown from "./CycleCountdown";
import SponsorImpressionTracker from "./SponsorImpressionTracker";

const HOME_PERF_PREFIX = "[HOME_PERF]";

function logHomeHudPerf(label: string, durationMs: number) {
  console.log(
    `${HOME_PERF_PREFIX} ${label}: ${durationMs.toFixed(1)}ms`
  );
}

function startHomeHudTimer(label: string) {
  const startedAt = performance.now();
  logHomeHudPerf(`${label} start`, 0);

  return () => {
    logHomeHudPerf(label, performance.now() - startedAt);
  };
}

async function timeHomeHudAsync<T>(
  label: string,
  callback: () => Promise<T>
) {
  const startedAt = performance.now();
  logHomeHudPerf(`${label} start`, 0);

  try {
    return await callback();
  } finally {
    logHomeHudPerf(label, performance.now() - startedAt);
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

export default async function CycleHud() {
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
  const { data: activeCycle } = await timeHomeHudAsync(
    "home active/open cycle loading (active cycle query)",
    async () =>
      await supabaseAdmin
        .from("voting_cycles")
        .select("id,status,theme")
        .eq("status", "active")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
  );

  const { data: latestCycle } = await timeHomeHudAsync(
    "home active/open cycle loading (latest cycle fallback query)",
    async () =>
      await supabaseAdmin
        .from("voting_cycles")
        .select("id,status,theme")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
  );
  const cycle = timeHomeHudSync(
    "home CycleHud cycle selection transform",
    () => activeCycle ?? latestCycle
  );
  const sponsoredMeta = cycle
    ? await timeHomeHudAsync(
        "home sponsor/cycle sponsorship loading",
        () => getCycleSponsoredMeta(cycle.id)
      )
    : timeHomeHudSync(
        "home sponsor/cycle sponsorship loading skipped (no cycle)",
        () => null
      );

  const { data: configRows } = await timeHomeHudAsync(
    "home cycle hud app_config loading",
    async () =>
      await supabaseAdmin
        .from("app_config")
        .select("key,value")
        .in("key", [
          "cycle_theme",
          "next_cycle_theme",
          "cycle_end_at",
        ])
  );

  const config = timeHomeHudSync(
    "home CycleHud app_config rows transform",
    () =>
      Object.fromEntries(
        (configRows ?? []).map((r) => [r.key, r.value])
      )
  );

  const {
    displayStatus,
    displayTheme,
    endAtMs,
    isTimerActive,
    statusClassName,
  } = timeHomeHudSync(
    "home CycleHud display state transform",
    () => {
      const transformedEndAtMs = config.cycle_end_at
        ? new Date(config.cycle_end_at).getTime()
        : null;
      const transformedIsTimerActive =
        cycle?.status === "active" &&
        transformedEndAtMs &&
        transformedEndAtMs > nowMs;
      const transformedDisplayTheme =
        sponsoredMeta?.enabled
          ? "Sponsored Cycle"
          : typeof config.cycle_theme === "string" &&
              config.cycle_theme.trim().length > 0
            ? config.cycle_theme.trim()
            : cycle?.theme ?? "Open Cycle";
      const transformedDisplayStatus =
        cycle?.status === "active"
          ? "ACTIVE"
          : cycle?.status === "finalizing"
            ? "FINALIZED"
            : cycle?.status === "finished"
              ? "FINALIZED"
              : cycle?.status?.toUpperCase() ?? "-";
      const transformedStatusClassName =
        cycle?.status === "active"
          ? "text-green-400"
          : cycle?.status === "finished"
            ? "text-red-600"
            : cycle?.status === "finalizing"
              ? "text-red-600"
              : "text-red-600";

      return {
        displayStatus: transformedDisplayStatus,
        displayTheme: transformedDisplayTheme,
        endAtMs: transformedEndAtMs,
        isTimerActive: transformedIsTimerActive,
        statusClassName: transformedStatusClassName,
      };
    }
  );

  timeHomeHudSync(
    "home CycleHud render readiness transform",
    () => ({
      hasCycle: Boolean(cycle),
      hasEndAt: Boolean(endAtMs),
      hasSponsor: Boolean(sponsoredMeta?.enabled),
    })
  );

  endHudTimer();

  if (!cycle) return null;

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
          {displayTheme}
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
          <span className={statusClassName}>{displayStatus}</span>
        </div>

        {isTimerActive && (
          <div className="font-['Permanent_Marker']">
            <span className="text-[var(--orange-main)]">
              Ends in:{" "}
            </span>
            <CycleCountdown endAt={config.cycle_end_at} />
          </div>
        )}

        {typeof config.next_cycle_theme === "string" &&
          config.next_cycle_theme.trim().length > 0 && (
            <div className="font-['Permanent_Marker'] text-xs">
              <span className="text-[var(--orange-main)]">
                Next Theme:{" "}
              </span>
              <span className="text-red-600">
                {config.next_cycle_theme.trim()}
              </span>
            </div>
          )}
      </div>
    </div>
  );
}
