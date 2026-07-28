"use client";

import Link from "next/link";
import { navigationTextTriggerClassName } from "@/app/components/navigation/navigationButtonStyles";

type BackButtonProps = {
  href?: string;
  label?: string;
};

export default function BackButton({
  href = "/",
  label = "Home",
}: BackButtonProps) {
  return (
    <Link
      href={href}
      className={`fixed left-4 top-4 z-[70] font-[var(--font-marker)] ${navigationTextTriggerClassName}`}
    >
      {label}
    </Link>
  );
}
