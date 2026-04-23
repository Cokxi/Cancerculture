import type { SocialPlatform } from "./types";

export const SOCIAL_PLATFORM_META: Record<
  SocialPlatform,
  {
    label: string;
    accentClass: string;
    iconText?: string;
    iconSrc?: string;
    iconSizeClass?: string;
  }
> = {
  x: {
    label: "X",
    accentClass:
      "border-white/20 bg-black text-white",
    iconText: "X",
  },
  instagram: {
    label: "Instagram",
    accentClass:
      "border-pink-400/30 bg-pink-500/15 text-pink-100",
    iconSrc:
      "https://cdn.cancerculture.fun/webp/social%20icons/instagram-logo-instagram-icon-transparent-free-png.webp",
    iconSizeClass: "h-5 w-5",
  },
  tiktok: {
    label: "TikTok",
    accentClass:
      "border-cyan-400/30 bg-cyan-500/15 text-cyan-100",
    iconSrc:
      "https://cdn.cancerculture.fun/webp/social%20icons/tiktok%20webp.webp",
    iconSizeClass: "h-4 w-4",
  },
  facebook: {
    label: "Facebook",
    accentClass:
      "border-blue-400/30 bg-blue-500/15 text-blue-100",
    iconSrc:
      "https://cdn.cancerculture.fun/webp/social%20icons/Facebook_Logo_2023.webp",
    iconSizeClass: "h-4 w-4",
  },
};

export function getPlatformLabel(platform: SocialPlatform) {
  return SOCIAL_PLATFORM_META[platform].label;
}
