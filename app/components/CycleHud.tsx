export const dynamic = "force-dynamic";

import { supabaseAdmin } from "@/lib/db/admin";
import CycleCountdown from "./CycleCountdown";

export default async function CycleHud() {
  // 🔥 aktiven Cycle holen
  const { data: cycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id,status,theme")
    .order("id", { ascending: false })
.limit(1)
.maybeSingle();


  // 🔥 config holen
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
  endAtMs > Date.now();



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
      
      {/* 🔥 THEME */}
      <div
  className="
    text-[1.4rem] tracking-wide
    text-[var(--orange-main)]
    font-['Permanent_Marker']
    pb-[2px]
    mb-[2px]
    border-b
    border-[rgba(0,0,0,0.35)]
  "
>
  🔥 {cycle.theme ?? "Open Round"}
</div>


      {/* 🎮 CYCLE */}
      <div className="font-['Permanent_Marker']">
        <span className="text-[var(--orange-main)]">Round: </span>
        <span className="text-green-400">{cycle.id}</span>
      </div>

      {/* 🟢 STATUS */}
      <div className="font-['Permanent_Marker']">
        <span className="text-[var(--orange-main)]">Status: </span>
        <span
          className={
            cycle.status === "active"
              ? "text-green-400"
              : "text-red-600"
          }
        >
          {cycle.status?.toUpperCase()}
        </span>
      </div>

    

      {/* 🔮 Timer */}
      {isTimerActive && (
  <div className="font-['Permanent_Marker']">
    <span className="text-[var(--orange-main)]">
      Ends in:{" "}
    </span>
    <CycleCountdown endAt={config.cycle_end_at} />
  </div>
)}

{/* 🔮 NEXT THEME */}
{config.next_cycle_theme && (
  <div className="font-['Permanent_Marker'] text-xs">
    <span className="text-[var(--orange-main)]">
      Next Theme:{" "}
    </span>
    <span className="text-red-600">
      {config.next_cycle_theme}
    </span>
  </div>
)}


    </div>
  </div>
);}
