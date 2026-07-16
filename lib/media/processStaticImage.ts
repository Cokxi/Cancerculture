import "server-only";

import sharp, { type Metadata } from "sharp";
import type {
  MediaValidationErrorCode,
  StaticImageInputFormat,
  StaticImageMediaProfile,
} from "@/lib/media/profiles";

export class MediaValidationError extends Error {
  code: MediaValidationErrorCode;
  status: number;

  constructor(code: MediaValidationErrorCode, status = 422) {
    super(code);
    this.name = "MediaValidationError";
    this.code = code;
    this.status = status;
  }
}

export type ProcessedStaticImage = {
  buffer: Buffer;
  format: "webp";
  width: number;
  height: number;
  inputFormat: StaticImageInputFormat;
};

function isPixelLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /pixel limit|input image exceeds/i.test(message);
}

function throwDecodeError(error: unknown): never {
  if (isPixelLimitError(error)) {
    throw new MediaValidationError("MEDIA_DECOMPRESSION_LIMIT");
  }
  throw new MediaValidationError("MEDIA_CORRUPT");
}

function getOrientedDimensions(metadata: Metadata) {
  if (!metadata.width || !metadata.height) {
    throw new MediaValidationError("MEDIA_CORRUPT");
  }

  const swapsAxes =
    metadata.orientation !== undefined &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8;
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function assertInputMetadata(
  metadata: Metadata,
  profile: StaticImageMediaProfile,
  claimedMimeType?: string | null
) {
  const format = metadata.format as StaticImageInputFormat | undefined;
  if (!format || !profile.allowedInputFormats.includes(format)) {
    throw new MediaValidationError("MEDIA_FORMAT_UNSUPPORTED");
  }

  const pages = metadata.pages ?? 1;
  if (pages > profile.maxPages || (metadata.pageHeight ?? 0) > 0) {
    throw new MediaValidationError("MEDIA_ANIMATION_UNSUPPORTED");
  }

  const expectedMime = `image/${format}`;
  const normalizedClaim = claimedMimeType?.toLowerCase().trim();
  if (
    normalizedClaim &&
    normalizedClaim !== expectedMime &&
    !(format === "jpeg" && normalizedClaim === "image/jpg")
  ) {
    throw new MediaValidationError("MEDIA_MIME_MISMATCH");
  }

  const { width, height } = getOrientedDimensions(metadata);
  if (width > profile.maxInputWidth) {
    throw new MediaValidationError("MEDIA_WIDTH_EXCEEDED");
  }
  if (height > profile.maxInputHeight) {
    throw new MediaValidationError("MEDIA_HEIGHT_EXCEEDED");
  }
  if (width * height > profile.maxInputPixels) {
    throw new MediaValidationError("MEDIA_PIXEL_LIMIT_EXCEEDED");
  }
  if (
    (profile.minInputWidth && width < profile.minInputWidth) ||
    (profile.minInputHeight && height < profile.minInputHeight)
  ) {
    throw new MediaValidationError("MEDIA_SOURCE_TOO_SMALL");
  }

  return { format, width, height };
}

function getSubmissionOutputDimensions(
  width: number,
  height: number,
  profile: StaticImageMediaProfile,
  resizeScale: number
) {
  const baseScale = Math.min(
    1,
    profile.maxOutputWidth / width,
    profile.maxOutputHeight / height,
    Math.sqrt(profile.maxOutputPixels / (width * height))
  );
  const scale = baseScale * resizeScale;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export async function processStaticImage({
  input,
  claimedMimeType,
  profile,
}: {
  input: Buffer;
  claimedMimeType?: string | null;
  profile: StaticImageMediaProfile;
}): Promise<ProcessedStaticImage> {
  if (input.byteLength > profile.maxInputBytes) {
    throw new MediaValidationError("MEDIA_FILE_TOO_LARGE", 413);
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input, {
      animated: false,
      failOn: "error",
      limitInputPixels: profile.maxInputPixels,
      pages: 1,
      sequentialRead: true,
    }).metadata();
  } catch (error) {
    throwDecodeError(error);
  }

  const inputInfo = assertInputMetadata(metadata, profile, claimedMimeType);

  for (const attempt of profile.qualityAttempts) {
    const dimensions =
      profile.resizeFit === "cover"
        ? {
            width: profile.outputWidth ?? profile.maxOutputWidth,
            height: profile.outputHeight ?? profile.maxOutputHeight,
          }
        : getSubmissionOutputDimensions(
            inputInfo.width,
            inputInfo.height,
            profile,
            attempt.resizeScale
          );

    try {
      const { data, info } = await sharp(input, {
        animated: false,
        failOn: "error",
        limitInputPixels: profile.maxInputPixels,
        pages: 1,
        sequentialRead: true,
      })
        .rotate()
        .resize(dimensions.width, dimensions.height, {
          fit: profile.resizeFit,
          position: "centre",
          withoutEnlargement: !profile.allowUpscale,
        })
        .webp({ effort: 4, quality: attempt.quality, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });

      if (
        info.width > profile.maxOutputWidth ||
        info.height > profile.maxOutputHeight ||
        info.width * info.height > profile.maxOutputPixels
      ) {
        throw new MediaValidationError("MEDIA_PIXEL_LIMIT_EXCEEDED");
      }

      if (data.byteLength <= profile.maxOutputBytes) {
        return {
          buffer: data,
          format: "webp",
          width: info.width,
          height: info.height,
          inputFormat: inputInfo.format,
        };
      }
    } catch (error) {
      if (error instanceof MediaValidationError) throw error;
      throwDecodeError(error);
    }
  }

  throw new MediaValidationError("MEDIA_OUTPUT_TOO_LARGE", 413);
}
