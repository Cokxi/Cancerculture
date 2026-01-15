"use client";

import Image from "next/image";

export default function DiscordCell() {
  return (
    <a
      href="https://x.com/i/communities/1974188909858074899"
      target="_blank"
      rel="noopener noreferrer"
      className="relative cursor-pointer group"
    >
      {/* CELL */}
      <div className="relative">
        <Image
          src="/cell-left-v1.png"
          alt="Join our Discord"
          width={600}
          height={600}
          className="
            w-[clamp(140px,18vw,340px)]
            h-auto
            animate-float
            transition-transform
            hover:scale-[1.03]
          "
        />

          {/* ICON – ALWAYS PRESENT, SOFT PULSE */}
        <div
          className="
            absolute
            top-3
            left-1/2
            -translate-x-1/2
            -translate-y-[clamp(180%,20vh,240%)]

            z-10
            pointer-events-none
            animate-soft-pulse
          "
        >
          <img
            src="/icons/x-v2.png"
            alt="X"
            className="w-6 h-6 md:w-10 md:h-10 drop-shadow-[0_4px_0_rgba(0,0,0,0.6)]"
          />
        </div>
      </div>
    </a>
  );
}
