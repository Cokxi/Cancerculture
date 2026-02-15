import { updateNextTheme } from "./updateNextTheme";
import { updateCycleTimer } from "./updateCycleTimer";

export default function CycleHudControls() {
  return (
    <div
      className="
        mt-10
        p-5
        rounded-xl
        bg-[var(--orange-main)]
        text-white
        flex flex-col gap-4
        max-w-md
      "
    >
      <span className="font-['Permanent_Marker'] text-sm tracking-wide">
        CYCLE HUD
      </span>

      {/* 🔮 NEXT THEME */}
      <form action={updateNextTheme} className="flex flex-col gap-2">
        <input
          name="next_cycle_theme"
          placeholder="Next cycle theme"
          className="
            px-3 py-2
            rounded-md
            bg-white/90
            text-black
            placeholder-black/50
            outline-none
          "
        />

        <button
          type="submit"
          className="
            py-2
            rounded-md
            bg-black/70
            hover:bg-black
            transition
            font-['Permanent_Marker']
          "
        >
          SAVE NEXT THEME
        </button>
      </form>

      {/* ⏱️ TIMER */}
      <form action={updateCycleTimer} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            name="timer_hours"
            type="number"
            min="0"
            placeholder="h"
            className="w-20 px-3 py-2 rounded-md bg-white/90 text-black"
          />

          <input
            name="timer_minutes"
            type="number"
            min="0"
            placeholder="m"
            className="w-20 px-3 py-2 rounded-md bg-white/90 text-black"
          />
        </div>

        <button
          type="submit"
          className="
            py-2
            rounded-md
            bg-black/70
            hover:bg-black
            transition
            font-['Permanent_Marker']
          "
        >
          SET TIMER
        </button>
      </form>
    </div>
  );
}
