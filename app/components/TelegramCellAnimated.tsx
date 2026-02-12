"use client";

export default function TelegramCellAnimated() {
  return (
    <a
      href="https://t.me/+ldoIPyhjtaw5NjM0"
      target="_blank"
      rel="noopener noreferrer"
      className="relative cursor-pointer group"
    >
      {/* CELL */}
<div
  className="
    relative
    w-[400px]
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
    <source src="/cell.right.v1.webm" type="video/webm" />
  </video>



        {/* ICON */}
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

    group-hover:opacity-100
    group-hover:scale-100
  "
>

          <img
            src="/icons/telegram-v2.png"
            alt="X"
            className="w-6 h-6 md:w-10 md:h-10 drop-shadow-[0_4px_0_rgba(0,0,0,0.6)]"
          />
        </div>
      </div>
    </a>
  );
}
