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
        z-40
        bg-black/70
        text-orange-500
        px-3
        py-2
        rounded-full
        text-sm
        font-[Permanent_Marker]
        hover:bg-black
        transition
        cursor-pointer
      "
    >
      ← {label}
    </Link>
  );
}