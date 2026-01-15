"use client";

import Link from "next/link";
import HomeBlinkCell from "@/app/components/HomeBlinkCell";

export default function AboutCenterCell() {
  return (
    <div
      className="
        hidden
        lg:flex
        fixed
        bottom-10
        left-1/2
        -translate-x-1/2
        z-40
        flex-col
        items-center
        pointer-events-none
      "
    >
      <div
        className="
          mb-1
          text-orange-500
          font-[Permanent_Marker]
          text-sm
          animate-[pulse_4s_ease-in-out_infinite]
          pointer-events-auto
        "
      >
        HOME
      </div>

      <Link
        href="/"
        className="
          w-[clamp(120px,14vw,200px)]
          aspect-square
          pointer-events-auto
        "
      >
        <HomeBlinkCell />
      </Link>
    </div>
  );
}
