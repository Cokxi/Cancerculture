"use client";

import Link from "next/link";

export default function AnimatedCell() {
  return (
    <Link
      href="/"
      aria-label="Go to homepage"
      className="inline-flex items-center justify-center rounded-full cursor-pointer"
    >
      <video
        src="https://cdn.cancerculture.fun/webm/fame/fame.webm"
        width={48}
        height={48}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className="w-[48px] h-[48px] object-contain pointer-events-none"
      />
    </Link>
  );
}