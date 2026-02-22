"use client";

import CenterAnimation from "@/app/components/CenterAnimation";

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
     
        <CenterAnimation />
    </div>
  );
}
