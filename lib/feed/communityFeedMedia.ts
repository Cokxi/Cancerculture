import sharp from "sharp";

const COMMUNITY_FEED_MEDIA_TIMEOUT_MS = 4_000;
const COMMUNITY_FEED_MEDIA_MAX_BYTES = 4_000_000;
const COMMUNITY_FEED_MEDIA_CONTENT_TYPE = "image/webp";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const NEUTRAL_MEDIA_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900" role="img" aria-label="Media unavailable">
  <rect width="1200" height="900" fill="#211a17"/>
  <path d="M420 570l120-130 80 85 65-70 110 115H420z" fill="#70402c"/>
  <circle cx="720" cy="350" r="48" fill="#a64b1c"/>
</svg>
`.trim();

function responseHeaders(contentType: string) {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}

export function createNeutralCommunityFeedMediaResponse() {
  return new Response(NEUTRAL_MEDIA_SVG, {
    status: 200,
    headers: responseHeaders("image/svg+xml; charset=utf-8"),
  });
}

function isCanonicalStorageKey(storageKey: string) {
  if (
    storageKey.length === 0 ||
    storageKey.length > 1024 ||
    storageKey !== storageKey.trim() ||
    storageKey.startsWith("/") ||
    storageKey.includes("\\") ||
    storageKey.includes("?") ||
    storageKey.includes("#") ||
    storageKey.includes("://") ||
    /[\u0000-\u001f\u007f]/u.test(storageKey)
  ) {
    return false;
  }

  return storageKey
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function getExactR2MediaUrl(storageKey: string, configuredBase?: string) {
  if (!isCanonicalStorageKey(storageKey)) return null;

  try {
    const base = new URL(configuredBase ?? process.env.R2_PUBLIC_BASE_URL ?? "");
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return null;
    }

    const basePath = base.pathname.replace(/\/+$/u, "");
    const encodedKey = storageKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = new URL(base.origin);
    url.pathname = `${basePath}/${encodedKey}`;

    return url.origin === base.origin ? url : null;
  } catch {
    return null;
  }
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The public result remains the same neutral response.
  }
}

async function readBoundedBody(response: Response) {
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > COMMUNITY_FEED_MEDIA_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  if (totalBytes === 0) return null;

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function proxyCommunityFeedMedia({
  storageKey,
  fetchImpl = fetch,
  timeoutMs = COMMUNITY_FEED_MEDIA_TIMEOUT_MS,
  configuredBase,
  expectedDimensions,
}: {
  storageKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  configuredBase?: string;
  expectedDimensions?: { width: number; height: number };
}) {
  const upstreamUrl = getExactR2MediaUrl(storageKey, configuredBase);
  if (!upstreamUrl) return createNeutralCommunityFeedMediaResponse();

  try {
    const upstream = await fetchImpl(upstreamUrl, {
      cache: "no-store",
      headers: { Accept: COMMUNITY_FEED_MEDIA_CONTENT_TYPE },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!upstream.ok) {
      await cancelBody(upstream);
      return createNeutralCommunityFeedMediaResponse();
    }

    const contentType =
      upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
      "";
    const declaredLengthRaw = upstream.headers.get("content-length");
    const declaredLength =
      declaredLengthRaw === null ? null : Number(declaredLengthRaw);

    if (
      contentType !== COMMUNITY_FEED_MEDIA_CONTENT_TYPE ||
      (declaredLength !== null &&
        (!Number.isSafeInteger(declaredLength) ||
          declaredLength <= 0 ||
          declaredLength > COMMUNITY_FEED_MEDIA_MAX_BYTES))
    ) {
      await cancelBody(upstream);
      return createNeutralCommunityFeedMediaResponse();
    }

    const bytes = await readBoundedBody(upstream);
    if (!bytes) return createNeutralCommunityFeedMediaResponse();
    if (expectedDimensions) {
      try {
        const metadata = await sharp(bytes, {
          failOn: "error",
          limitInputPixels: 40_000_000,
        }).metadata();
        if (
          metadata.format !== "webp" ||
          metadata.width !== expectedDimensions.width ||
          metadata.height !== expectedDimensions.height
        ) {
          return createNeutralCommunityFeedMediaResponse();
        }
      } catch {
        return createNeutralCommunityFeedMediaResponse();
      }
    }

    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: responseHeaders(COMMUNITY_FEED_MEDIA_CONTENT_TYPE),
    });
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
