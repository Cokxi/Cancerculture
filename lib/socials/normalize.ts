import {
  SOCIAL_PLATFORMS,
  type PublicSocialLink,
  type SocialPlatform,
} from "./types";

type NormalizedSocialInput = {
  handle: string | null;
  profileUrl: string;
};

function isSocialPlatform(value: string): value is SocialPlatform {
  return SOCIAL_PLATFORMS.includes(
    value as SocialPlatform
  );
}

function normalizeHandleValue(input: string) {
  return input.trim().replace(/^@+/, "").replace(/^\/+|\/+$/g, "");
}

function buildDefaultUrl(
  platform: SocialPlatform,
  handle: string
) {
  switch (platform) {
    case "x":
      return `https://x.com/${handle}`;
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle.replace(/^@+/, "")}`;
    case "facebook":
      return `https://www.facebook.com/${handle}`;
  }
}

function normalizeUrlString(input: string) {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `https://${value}`;
}

function extractHandleFromUrl(
  platform: SocialPlatform,
  url: URL
) {
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  if (platform === "tiktok") {
    return normalizeHandleValue(segments[0]);
  }

  if (
    platform === "facebook" &&
    segments[0].toLowerCase() === "profile.php"
  ) {
    const id = url.searchParams.get("id");
    return id ? `id:${id}` : null;
  }

  return normalizeHandleValue(segments[0]);
}

export function parseSocialPlatform(
  value: string
): SocialPlatform | null {
  return isSocialPlatform(value) ? value : null;
}

export function normalizeSocialInput({
  platform,
  rawValue,
}: {
  platform: SocialPlatform;
  rawValue: string;
}): NormalizedSocialInput {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    throw new Error("Please enter a social handle or URL.");
  }

  const looksLikeUrl =
    /^https?:\/\//i.test(trimmed) ||
    /^[\w.-]+\.[A-Za-z]{2,}/.test(trimmed) ||
    trimmed.includes("/");

  const handleInput = normalizeHandleValue(trimmed);

  if (!looksLikeUrl && handleInput.length > 0) {
    return {
      handle:
        platform === "facebook" && handleInput.startsWith("id:")
          ? handleInput
          : `@${handleInput.replace(/^@+/, "")}`,
      profileUrl: buildDefaultUrl(platform, handleInput),
    };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(normalizeUrlString(trimmed));
  } catch {
    throw new Error("Please enter a valid social URL.");
  }

  const profileUrl = parsedUrl.toString();
  const extractedHandle = extractHandleFromUrl(
    platform,
    parsedUrl
  );

  return {
    handle:
      extractedHandle && !extractedHandle.startsWith("id:")
        ? `@${extractedHandle.replace(/^@+/, "")}`
        : extractedHandle,
    profileUrl,
  };
}

export function getSocialDisplayLabel(
  social: Pick<
    PublicSocialLink,
    "platform" | "handle" | "profile_url"
  >
) {
  if (social.handle) {
    if (
      social.platform === "facebook" &&
      social.handle.startsWith("id:")
    ) {
      return social.profile_url;
    }

    return social.handle;
  }

  try {
    const url = new URL(social.profile_url);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return path && path !== "/" ? `${host}${path}` : host;
  } catch {
    return social.profile_url;
  }
}
