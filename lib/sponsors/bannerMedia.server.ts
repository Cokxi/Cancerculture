import "server-only";

import { createHash } from "node:crypto";
import sharp from "sharp";

export const SPONSOR_BANNER_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const SPONSOR_BANNER_MAX_INPUT_PIXELS = 40_000_000;
export const SPONSOR_BANNER_MAX_OUTPUT_BYTES = 4_000_000;

const ACCEPTED_FORMAT_BY_MIME = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export const SPONSOR_BANNER_ROLES = {
  detail: {
    width: 1200,
    height: 600,
    minimumWidth: 1200,
    minimumHeight: 600,
    keyPrefix: "sponsored-cycles/drafts/detail/",
  },
  feed: {
    width: 1800,
    height: 300,
    minimumWidth: 1800,
    minimumHeight: 300,
    keyPrefix: "sponsored-cycles/drafts/feed/",
  },
} as const;

export type SponsorBannerRole = keyof typeof SPONSOR_BANNER_ROLES;

export function isSponsorBannerRole(value: unknown): value is SponsorBannerRole {
  return value === "detail" || value === "feed";
}

export function getSponsorBannerStorageKey(
  role: SponsorBannerRole,
  operationId: string
) {
  return `${SPONSOR_BANNER_ROLES[role].keyPrefix}${operationId}.webp`;
}

export function isSponsorDetailBannerKey(value: unknown) {
  return (
    typeof value === "string" &&
    (/^sponsored-cycles\/drafts\/[0-9A-Fa-f-]{36}\.webp$/u.test(value) ||
      /^sponsored-cycles\/drafts\/detail\/[0-9A-Fa-f-]{36}\.webp$/u.test(
        value
      ))
  );
}

export function isSponsorFeedBannerKey(value: unknown) {
  return (
    typeof value === "string" &&
    /^sponsored-cycles\/drafts\/feed\/[0-9A-Fa-f-]{36}\.webp$/u.test(
      value
    )
  );
}

function orientedDimensions({
  width,
  height,
  orientation,
}: {
  width: number;
  height: number;
  orientation?: number;
}) {
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

export async function normalizeSponsorBanner({
  file,
  role,
}: {
  file: File;
  role: SponsorBannerRole;
}) {
  if (file.size <= 0 || file.size > SPONSOR_BANNER_MAX_INPUT_BYTES) {
    throw new Error("SPONSOR_BANNER_FILE_SIZE_INVALID");
  }

  const expectedFormat =
    ACCEPTED_FORMAT_BY_MIME[file.type as keyof typeof ACCEPTED_FORMAT_BY_MIME];
  if (!expectedFormat) throw new Error("SPONSOR_BANNER_FILE_TYPE_INVALID");

  const input = Buffer.from(await file.arrayBuffer());
  const image = sharp(input, {
    failOn: "error",
    limitInputPixels: SPONSOR_BANNER_MAX_INPUT_PIXELS,
  });
  const metadata = await image.metadata();
  if (
    metadata.format !== expectedFormat ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error("SPONSOR_BANNER_DECODE_INVALID");
  }

  const dimensions = orientedDimensions({
    width: metadata.width,
    height: metadata.height,
    orientation: metadata.orientation,
  });
  const spec = SPONSOR_BANNER_ROLES[role];
  if (
    dimensions.width < spec.minimumWidth ||
    dimensions.height < spec.minimumHeight ||
    dimensions.width * spec.height !== dimensions.height * spec.width
  ) {
    throw new Error(
      role === "detail"
        ? "SPONSOR_DETAIL_BANNER_DIMENSIONS_INVALID"
        : "SPONSOR_FEED_BANNER_DIMENSIONS_INVALID"
    );
  }

  const output = await image
    .rotate()
    .resize(spec.width, spec.height, { fit: "fill" })
    .webp({ quality: 82 })
    .toBuffer();
  if (output.byteLength > SPONSOR_BANNER_MAX_OUTPUT_BYTES) {
    throw new Error("SPONSOR_BANNER_OUTPUT_SIZE_INVALID");
  }

  return {
    bytes: output,
    sha256: createHash("sha256").update(output).digest("hex"),
    width: spec.width,
    height: spec.height,
  };
}
