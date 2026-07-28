"use client";

import { DISCORD_INVITE_URL } from "@/lib/discordInvite";

export default function TelegramCellAnimated() {
  return (
    <a
      href={DISCORD_INVITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block w-full cursor-pointer"
    >
     
<div
  className="
    relative
    w-full
    animate-float
    transition-transform
  "
>


  <video
    autoPlay
    loop
    muted
    playsInline
    preload="metadata"
    className="
  block
  w-full
  h-auto
  object-contain
  pointer-events-none
  scale-[1]
"


  >
    <source src="https://cdn.cancerculture.fun/webm/main.cells/cell.right.loop.webm" type="video/webm" />
  </video>



        
                  <div
  className="
    absolute
    top-3
    left-1/2
    -translate-x-1/2
    -translate-y-[clamp(180%,20vh,240%)]

    z-10
    pointer-events-none

    opacity-0
    scale-90
    transition-all duration-1500 ease-out

    group-hover:opacity-120
    group-hover:scale-120
  "
>

          <img
  src="https://cdn.cancerculture.fun/webp/icons/Discord.V1.webp"
            alt="X"
            className="w-6 h-6 md:w-10 md:h-10 drop-shadow-[0_4px_0_rgba(0,0,0,0.6)]"
          />
        </div>
      </div>
    </a>
  );
}
