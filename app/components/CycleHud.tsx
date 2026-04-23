export const dynamic = "force-dynamic";

import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import CycleCountdown from "./CycleCountdown";

export default async function CycleHud() {
  const nowMs = Date.parse(new Date().toISOString());
  const { data: activeCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id,status,theme")
    .eq("status", "active")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: latestCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id,status,theme")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cycle = activeCycle ?? latestCycle;
  const sponsoredMeta = cycle
    ? await getCycleSponsoredMeta(cycle.id)
    : null;

  const { data: configRows } = await supabaseAdmin
    .from("app_config")
    .select("key,value")
    .in("key", ["cycle_theme", "next_cycle_theme", "cycle_end_at"]);

  const config = Object.fromEntries(
    (configRows ?? []).map((r) => [r.key, r.value])
  );
  const endAtMs = config.cycle_end_at
    ? new Date(config.cycle_end_at).getTime()
    : null;

  const isTimerActive =
    cycle?.status === "active" &&
    endAtMs &&
    endAtMs > nowMs;
  const displayTheme =
    sponsoredMeta?.enabled
      ? "Sponsored Cycle"
      : typeof config.cycle_theme === "string" &&
          config.cycle_theme.trim().length > 0
        ? config.cycle_theme.trim()
        : cycle?.theme ?? "Open Cycle";
  const displayStatus =
    cycle?.status === "active"
      ? "ACTIVE"
      : cycle?.status === "finalizing"
        ? "FINALIZED"
        : cycle?.status === "finished"
          ? "FINALIZED"
          : cycle?.status?.toUpperCase() ?? "-";
  const statusClassName =
    cycle?.status === "active"
      ? "text-green-400"
      : cycle?.status === "finished"
        ? "text-red-600"
      : cycle?.status === "finalizing"
          ? "text-red-600"
          : "text-red-600";

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
              <span className="text-[var(--orange-main)]">
                Presented by:{" "}
              </span>
              {sponsoredMeta.sponsorLink.length > 0 ? (
                <a
                  href={sponsoredMeta.sponsorLink}
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
