"use client";

import Image from "next/image";

export default function TelegramCell() {
  return (
    <a
      href="https://t.me/+ldoIPyhjtaw5NjM0"
      target="_blank"
      rel="noopener noreferrer"
      className="relative cursor-pointer"
    >
      <div className="relative">
        <Image
          src="/cell-right-v1.png"
          alt="Join our Telegram"
          width={600}
          height={600}
          className="
            w-[clamp(140px,18vw,340px)]
            h-auto
            animate-float-delayed
            transition-transform
            hover:scale-[1.03]
          "
        />

        {/* ICON – ALWAYS PRESENT, DELAYED PULSE */}
        <div
          className="
            absolute
            top-3
            left-1/2
            -translate-x-1/2
            -translate-y-[clamp(180%,20vh,240%)]

            z-10
            pointer-events-none
            animate-soft-pulse-delayed
          "
        >
          <img
            src="/icons/telegram-v2.png"
            alt="Telegram"
            className="
              w-6 h-6
              md:w-10 md:h-10
              object-contain
              drop-shadow-[0_4px_0_rgba(0,0,0,0.6)]
            "
          />
        </div>
      </div>
    </a>
  );
}
