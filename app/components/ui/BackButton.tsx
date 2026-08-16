"use client";

import Link from "next/link";
import { navigationTextTriggerClassName } from "@/app/components/navigation/navigationButtonStyles";

type BackButtonProps = {
  href?: string;
  label?: string;
  nativeNavigation?: boolean;
};

export default function BackButton({
  href = "/",
  label = "Home",
  nativeNavigation = false,
}: BackButtonProps) {
  const className = `fixed left-4 top-4 z-[70] font-['Permanent_Marker'] ${navigationTextTriggerClassName}`;

  if (nativeNavigation) {
    return (
      <a href={href} className={className}>
        {label}
      </a>
    );
  }

  return (
    <Link
      href={href}
      className={className}
    >
      {label}
    </Link>
  );
}
