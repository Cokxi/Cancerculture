import "server-only";
import { createHash } from "node:crypto";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

const DISCORD_AVATAR_CDN_ORIGIN = "https://cdn.discordapp.com";
const DISCORD_AVATAR_FETCH_TIMEOUT_MS = 4_000;
const DISCORD_AVATAR_MAX_BYTES = 1024 * 1024;
const DISCORD_AVATAR_REVALIDATE_SECONDS = 60 * 60;

const PUBLIC_AVATAR_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
const PUBLIC_FALLBACK_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=3600";

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/u;
const DISCORD_AVATAR_HASH_PATTERN = /^(?:a_)?[a-f0-9]{32}$/u;

const NEUTRAL_AVATAR_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Avatar unavailable">
  <rect width="128" height="128" fill="#2a211d"/>
  <circle cx="64" cy="48" r="24" fill="#a64b1c"/>
  <path d="M24 116c4-25 19-38 40-38s36 13 40 38" fill="#a64b1c"/>
</svg>
`.trim();

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit & { next?: { revalidate: number } }
) => Promise<Response>;

function avatarResponseHeaders({
  contentType,
  cacheControl,
}: {
  contentType: string;
  cacheControl: string;
}) {
  return {
    "Cache-Control": cacheControl,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}

export function createNeutralPublicAvatarResponse(): Response {
  return new Response(NEUTRAL_AVATAR_SVG, {
    status: 200,
    headers: avatarResponseHeaders({
      contentType: "image/svg+xml; charset=utf-8",
      cacheControl: PUBLIC_FALLBACK_CACHE_CONTROL,
    }),
  });
}

export function getPublicProfileAvatarPath({
  publicProfileId,
  versionSource,
}: {
  publicProfileId: string;
  versionSource: string;
}): string {
  const path = `/profile/${encodeURIComponent(publicProfileId)}/avatar`;
  const opaqueVersion = createHash("sha256")
    .update(`${publicProfileId}:${versionSource}`)
    .digest("hex")
    .slice(0, 16);

  return `${path}?v=${opaqueVersion}`;
}

async function cancelUpstreamBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The public response remains the same neutral fallback.
  }
}

async function readBoundedImageBody(
  response: Response
): Promise<Uint8Array | null> {
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > DISCORD_AVATAR_MAX_BYTES) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }
  } catch {
    return null;
  }

  if (totalBytes === 0) {
    return null;
  }

  const imageBytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    imageBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return imageBytes;
}

async function proxyBoundedPublicImage({
  upstreamUrl,
  fetchImpl,
  timeoutMs,
}: {
  upstreamUrl: URL;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<Response> {
  try {
    const upstream = await fetchImpl(upstreamUrl, {
      cache: "force-cache",
      headers: {
        Accept: "image/png,image/jpeg,image/webp,image/gif",
      },
      next: { revalidate: DISCORD_AVATAR_REVALIDATE_SECONDS },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!upstream.ok) {
      await cancelUpstreamBody(upstream);
      return createNeutralPublicAvatarResponse();
    }

    const contentType =
      upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
      "";
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      await cancelUpstreamBody(upstream);
      return createNeutralPublicAvatarResponse();
    }

    const declaredLength = Number(
      upstream.headers.get("content-length") ?? "0"
    );
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > DISCORD_AVATAR_MAX_BYTES
    ) {
      await cancelUpstreamBody(upstream);
      return createNeutralPublicAvatarResponse();
    }

    const imageBytes = await readBoundedImageBody(upstream);
    if (!imageBytes) {
      return createNeutralPublicAvatarResponse();
    }

    return new Response(imageBytes.buffer as ArrayBuffer, {
      status: 200,
      headers: avatarResponseHeaders({
        contentType,
        cacheControl: PUBLIC_AVATAR_CACHE_CONTROL,
      }),
    });
  } catch {
    return createNeutralPublicAvatarResponse();
  }
}

export async function proxyPublicUploadedAvatar({
  discordUserId,
  avatarKey,
  fetchImpl = fetch,
  timeoutMs = DISCORD_AVATAR_FETCH_TIMEOUT_MS,
}: {
  discordUserId: string;
  avatarKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<Response> {
  if (
    !DISCORD_USER_ID_PATTERN.test(discordUserId) ||
    avatarKey !== `avatars/${discordUserId}.webp`
  ) {
    return createNeutralPublicAvatarResponse();
  }

  const publicImageUrl = getPublicImageUrl(avatarKey);

  try {
    const upstreamUrl = new URL(publicImageUrl ?? "");
    if (upstreamUrl.protocol !== "https:") {
      return createNeutralPublicAvatarResponse();
    }

    return proxyBoundedPublicImage({
      upstreamUrl,
      fetchImpl,
      timeoutMs,
    });
  } catch {
    return createNeutralPublicAvatarResponse();
  }
}

export async function proxyPublicDiscordAvatar({
  discordUserId,
  discordAvatar,
  fetchImpl = fetch,
  timeoutMs = DISCORD_AVATAR_FETCH_TIMEOUT_MS,
}: {
  discordUserId: string;
  discordAvatar: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<Response> {
  if (
    !DISCORD_USER_ID_PATTERN.test(discordUserId) ||
    !DISCORD_AVATAR_HASH_PATTERN.test(discordAvatar)
  ) {
    return createNeutralPublicAvatarResponse();
  }

  const upstreamUrl = new URL(
    `/avatars/${discordUserId}/${discordAvatar}.png`,
    DISCORD_AVATAR_CDN_ORIGIN
  );
  upstreamUrl.searchParams.set("size", "128");

  return proxyBoundedPublicImage({
    upstreamUrl,
    fetchImpl,
    timeoutMs,
  });
}
