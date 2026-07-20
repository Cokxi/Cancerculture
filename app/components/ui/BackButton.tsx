"use client";

import Link from "next/link";

type BackButtonProps = {
  href?: string;
  label?: string;
};

export default function BackButton({
  href = "/",
  label = "Back",
}: BackButtonProps) {
  return (
    <Link
      href={href}
      className="
        fixed
        top-4
        left-4
        z-[70]
        border
        border-orange-500/45
        bg-black/85
        text-orange-500
        px-3
        py-2
        rounded-full
        text-sm
        font-[var(--font-marker)]
        shadow-lg
        shadow-black/40
        hover:border-orange-400
        hover:bg-black
        transition
        cursor-pointer
      "
    >
      &larr; {label}
    </Link>
  );
}
