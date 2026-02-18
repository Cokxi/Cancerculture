"use client";

import { useEffect, useState, useRef } from "react";

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
  const [showOriginalSize, setShowOriginalSize] = useState(false);
const lastTapRef = useRef(0);

function handleToggleSize() {
  setShowOriginalSize(prev => !prev);
}

function handleTouchStart() {
  const now = Date.now();
  if (now - lastTapRef.current < 300) {
    handleToggleSize();
  }
  lastTapRef.current = now;
}

  function getThumbUrl(imageUrl: string) {
  const url = new URL(imageUrl);
  return `${url.origin}/cdn-cgi/image/w=400,q=75${url.pathname}`;
}

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
            onClick={() => {
  setShowOriginalSize(false);
  setActive(w);
}}

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
              <img
  src={getThumbUrl(w.image_url)}
  alt=""
  loading="lazy"
  decoding="async"
  className="absolute inset-0 w-full h-full object-cover"
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
        className="fixed inset-0 z-50 bg-black/90 overflow-y-auto overscroll-contain p-6"

          onClick={() => setActive(null)}
        >
      <button
  onClick={() => setActive(null)}
  className="fixed top-4 right-4 z-[60] text-white text-2xl bg-black/60 rounded-full w-10 h-10 flex items-center justify-center hover:bg-black/80"
>
  ×
</button>
    
          <div
  className="relative mx-auto w-fit bg-black rounded-xl"


            onClick={(e) => e.stopPropagation()}
          >
            

            <img
  src={active.image_url}
  alt=""
  onDoubleClick={handleToggleSize}
  onTouchStart={handleTouchStart}
  className={
    showOriginalSize
      ? "w-auto h-auto max-w-none mx-auto rounded-lg"
      : "w-auto h-auto max-w-[75vw] max-h-[75vh] object-contain mx-auto rounded-lg"
  }
/>
<div className="flex justify-center pb-2">
  <button
    onClick={handleToggleSize}
    className="text-xs bg-black/50 text-white px-3 py-1 rounded-full hover:bg-black/70"
  >
    {showOriginalSize ? "Fit to Screen" : "Tap to Zoom"}
  </button>
</div>



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
