"use client";

import { getSocialDisplayLabel } from "@/lib/socials/normalize";
import { SOCIAL_PLATFORM_META } from "@/lib/socials/platforms";
import Image from "next/image";
import type {
  PublicSocialLink,
  SocialPlatform,
} from "@/lib/socials/types";

export function SocialPlatformBadge({
  platform,
}: {
  platform: SocialPlatform;
}) {
  const meta = SOCIAL_PLATFORM_META[platform];

  return (
    <span
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-2 text-[11px] font-bold uppercase tracking-[0.18em] ${meta.accentClass}`}
      title={meta.label}
    >
      {meta.iconSrc ? (
        <Image
          src={meta.iconSrc}
          alt={`${meta.label} icon`}
          width={20}
          height={20}
          className={`${meta.iconSizeClass ?? "h-4 w-4"} object-contain`}
        />
      ) : (
        meta.iconText
      )}
    </span>
  );
}

export function SocialVerificationBadge({
  isVerified,
}: {
  isVerified: boolean;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${
        isVerified
          ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
          : "border-yellow-400/40 bg-yellow-500/10 text-yellow-200"
      }`}
    >
      {isVerified ? "Verified" : "Unverified"}
    </span>
  );
}

export function SocialLinkRow({
  social,
  showStatus = true,
}: {
  social: PublicSocialLink;
  showStatus?: boolean;
}) {
  return (
    <a
      href={social.profile_url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-3 transition hover:border-[var(--orange-dark)]/40 hover:bg-white/5"
    >
      <SocialPlatformBadge platform={social.platform} />

      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-white">
          {getSocialDisplayLabel(social)}
        </div>
        <div className="truncate text-xs text-gray-400">
          {SOCIAL_PLATFORM_META[social.platform].label}
        </div>
      </div>

      {showStatus ? (
        <SocialVerificationBadge
          isVerified={social.is_verified}
        />
      ) : null}
    </a>
  );
}
