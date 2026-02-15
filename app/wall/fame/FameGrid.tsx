"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type Winner = {
  id: number;
  image_url: string;
  cycle_id: number;
  created_at: string;
  x_username: string;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
  vote_count: number | null;
};

export default function FameGrid({ winners }: { winners: Winner[] }) {
  const [active, setActive] = useState<Winner | null>(null);

  // ✅ ESC-Key schließt Modal
  useEffect(() => {
    if (!active) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActive(null);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active]);

  if (!winners || winners.length === 0) {
    return (
      <p className="text-center text-lg opacity-60">
        No winners yet.
      </p>
    );
  }

  return (
    <>
      {/* GRID */}
      <div
        className="
          grid
          grid-cols-2
          sm:grid-cols-3
          md:grid-cols-5
          lg:grid-cols-7
          gap-4
        "
      >
        {winners.map((w) => (
          <div
            key={w.id}
            onClick={() => setActive(w)}
            className="group cursor-pointer"
          >
            <div
              className="
                relative
                aspect-square
                overflow-hidden
                rounded-xl
                border-2
                border-white/20
                bg-neutral-900
                transition
                duration-200
                group-hover:scale-[1.02]
                group-hover:shadow-xl
              "
            >
              <Image
                src={w.image_url}
                alt="Winner image"
                fill
                className="object-cover"
              />

              {/* Date Overlay */}
              <div
                className="
                  absolute
                  inset-x-0
                  bottom-0
                  bg-gradient-to-t
                  from-black/70
                  to-transparent
                  p-2
                "
              >
                <div className="text-[11px] text-white/80">
                  {new Date(w.created_at).toLocaleDateString()}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* MODAL */}
      {active && (
        <div
          className="fixed inset-0 z-50 bg-black/90 overflow-auto p-6"
          onClick={() => setActive(null)}
        >
          <div
            className="
  relative
  mx-auto
  bg-black
  max-w-5xl
  w-full
  rounded-xl
  p-4
"

            onClick={(e) => e.stopPropagation()}
          >
            {/* ❌ CLOSE BUTTON */}
            <button
              onClick={() => setActive(null)}
              aria-label="Close"
              className="
                absolute
                top-3
                right-3
                z-10
                rounded-full
                bg-black/60
                hover:bg-black/80
                text-white
                w-9
                h-9
                flex
                items-center
                justify-center
                text-xl
              "
            >
              ×
            </button>

            <Image
              src={active.image_url}
              alt="Winner"
              width={1200}
              height={1200}
              className="
  object-contain
  w-auto
  h-auto
  max-w-none
  mx-auto
  rounded-lg
"

            />

            <div className="mt-4 text-white space-y-3">
              <div className="text-lg font-semibold">
                Round #{active.cycle_id}
              </div>

              <div className="text-sm opacity-80">
  {active.vote_count ?? 0} vote
  {active.vote_count === 1 ? "" : "s"}
</div>

              <div className="text-sm opacity-80 space-y-2">
                {active.x_username && (
                  <div>
                    <strong>X:</strong> @{active.x_username}
                  </div>
                )}

                <div className="text-xs opacity-70 break-all">
                  {active.wallet_address}
                </div>

                <div>
                  {active.payout_choice === "keep" && (
                    <span>Chose to keep the reward</span>
                  )}

                  {active.payout_choice === "donate" && (
                    <span>
                      Donated 100% to {active.charity}
                    </span>
                  )}

                  {active.payout_choice === "split" && (
                    <span>
                      Split {active.split_percent}% /{" "}
                      {active.charity}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
