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

export default function ShameGrid({ winners }: { winners: Winner[] }) {
  const [active, setActive] = useState<Winner | null>(null);

  // ESC schließt Modal
  useEffect(() => {
    if (!active) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);

  if (!winners || winners.length === 0) {
    return (
      <p className="text-center text-lg opacity-60">
        No shame yet.
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
                border-red-500/30
                bg-neutral-950
                transition
                duration-200
                group-hover:scale-[1.02]
                group-hover:shadow-xl
              "
            >
              <Image
                src={w.image_url}
                alt="Shame image"
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
                  from-black/80
                  to-transparent
                  p-2
                "
              >
                <div className="text-[11px] text-red-200/70">
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
            className="relative mx-auto bg-black max-w-5xl w-full rounded-xl p-4"

            onClick={(e) => e.stopPropagation()}
          >
            {/* CLOSE */}
            <button
              onClick={() => setActive(null)}
              className="
                absolute
                top-3
                right-3
                w-9
                h-9
                rounded-full
                bg-black/60
                hover:bg-black/80
                text-white
                text-xl
                flex
                items-center
                justify-center
              "
            >
              ×
            </button>

            <Image
              src={active.image_url}
              alt="Shame"
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
              <div className="text-lg font-semibold text-red-400">
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
                    <span>Kept the prize</span>
                  )}

                  {active.payout_choice === "donate" && (
                    <span>Still donated 100%</span>
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
