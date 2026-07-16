export type StaticImageInputFormat = "jpeg" | "png" | "webp";

export type StaticImageMediaProfile = {
  id: "submission" | "avatar";
  allowedInputFormats: readonly StaticImageInputFormat[];
  allowedBrowserMimeTypes: readonly string[];
  maxInputBytes: number;
  maxInputWidth: number;
  maxInputHeight: number;
  maxInputPixels: number;
  maxPages: 1;
  minInputWidth?: number;
  minInputHeight?: number;
  outputFormat: "webp";
  maxOutputBytes: number;
  maxOutputWidth: number;
  maxOutputHeight: number;
  maxOutputPixels: number;
  outputWidth?: number;
  outputHeight?: number;
  resizeFit: "inside" | "cover";
  allowUpscale: boolean;
  stripMetadata: true;
  qualityAttempts: readonly {
    quality: number;
    resizeScale: number;
  }[];
};

const STATIC_INPUT_FORMATS = ["jpeg", "png", "webp"] as const;
const STATIC_BROWSER_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const SUBMISSION_MEDIA_PROFILE = {
  id: "submission",
  allowedInputFormats: STATIC_INPUT_FORMATS,
  allowedBrowserMimeTypes: STATIC_BROWSER_MIME_TYPES,
  maxInputBytes: 4_000_000,
  maxInputWidth: 8_192,
  maxInputHeight: 20_000,
  maxInputPixels: 24_000_000,
  maxPages: 1,
  outputFormat: "webp",
  maxOutputBytes: 4_000_000,
  maxOutputWidth: 2_400,
  // WebP's format-level maximum dimension is 16,383 pixels.
  maxOutputHeight: 16_383,
  maxOutputPixels: 24_000_000,
  resizeFit: "inside",
  allowUpscale: false,
  stripMetadata: true,
  qualityAttempts: [
    { quality: 82, resizeScale: 1 },
    { quality: 74, resizeScale: 1 },
    { quality: 66, resizeScale: 1 },
    { quality: 60, resizeScale: 0.9 },
  ],
} as const satisfies StaticImageMediaProfile;

export const AVATAR_MEDIA_PROFILE = {
  id: "avatar",
  allowedInputFormats: STATIC_INPUT_FORMATS,
  allowedBrowserMimeTypes: STATIC_BROWSER_MIME_TYPES,
  maxInputBytes: 4_000_000,
  maxInputWidth: 4_096,
  maxInputHeight: 4_096,
  maxInputPixels: 16_000_000,
  maxPages: 1,
  minInputWidth: 256,
  minInputHeight: 256,
  outputFormat: "webp",
  maxOutputBytes: 1_000_000,
  maxOutputWidth: 512,
  maxOutputHeight: 512,
  maxOutputPixels: 512 * 512,
  outputWidth: 512,
  outputHeight: 512,
  resizeFit: "cover",
  allowUpscale: true,
  stripMetadata: true,
  qualityAttempts: [
    { quality: 82, resizeScale: 1 },
    { quality: 74, resizeScale: 1 },
    { quality: 66, resizeScale: 1 },
  ],
} as const satisfies StaticImageMediaProfile;

export const MEDIA_PROFILES = {
  submission: SUBMISSION_MEDIA_PROFILE,
  avatar: AVATAR_MEDIA_PROFILE,
} as const;

export type MediaValidationErrorCode =
  | "MEDIA_FILE_TOO_LARGE"
  | "MEDIA_FORMAT_UNSUPPORTED"
  | "MEDIA_MIME_MISMATCH"
  | "MEDIA_CORRUPT"
  | "MEDIA_ANIMATION_UNSUPPORTED"
  | "MEDIA_WIDTH_EXCEEDED"
  | "MEDIA_HEIGHT_EXCEEDED"
  | "MEDIA_PIXEL_LIMIT_EXCEEDED"
  | "MEDIA_DECOMPRESSION_LIMIT"
  | "MEDIA_OUTPUT_TOO_LARGE"
  | "MEDIA_SOURCE_TOO_SMALL";

export const COUNTABLE_SUBMISSION_MEDIA_ERROR_CODES = [
  "MEDIA_FILE_TOO_LARGE",
  "MEDIA_FORMAT_UNSUPPORTED",
  "MEDIA_MIME_MISMATCH",
  "MEDIA_CORRUPT",
  "MEDIA_ANIMATION_UNSUPPORTED",
  "MEDIA_WIDTH_EXCEEDED",
  "MEDIA_HEIGHT_EXCEEDED",
  "MEDIA_PIXEL_LIMIT_EXCEEDED",
  "MEDIA_DECOMPRESSION_LIMIT",
  "MEDIA_OUTPUT_TOO_LARGE",
] as const satisfies readonly MediaValidationErrorCode[];

export function isCountableSubmissionMediaErrorCode(
  code: string
): code is (typeof COUNTABLE_SUBMISSION_MEDIA_ERROR_CODES)[number] {
  return (COUNTABLE_SUBMISSION_MEDIA_ERROR_CODES as readonly string[]).includes(
    code
  );
}

export function getBrowserMediaPreflightError(
  file: Pick<File, "size" | "type">,
  profile: StaticImageMediaProfile
): MediaValidationErrorCode | null {
  if (file.size > profile.maxInputBytes) {
    return "MEDIA_FILE_TOO_LARGE";
  }

  if (
    file.type &&
    !profile.allowedBrowserMimeTypes.includes(file.type.toLowerCase())
  ) {
    return "MEDIA_FORMAT_UNSUPPORTED";
  }

  return null;
}

export function getBrowserDimensionPreflightError(
  width: number,
  height: number,
  profile: StaticImageMediaProfile
): MediaValidationErrorCode | null {
  if (width > profile.maxInputWidth) return "MEDIA_WIDTH_EXCEEDED";
  if (height > profile.maxInputHeight) return "MEDIA_HEIGHT_EXCEEDED";
  if (width * height > profile.maxInputPixels) {
    return "MEDIA_PIXEL_LIMIT_EXCEEDED";
  }
  if (
    (profile.minInputWidth && width < profile.minInputWidth) ||
    (profile.minInputHeight && height < profile.minInputHeight)
  ) {
    return "MEDIA_SOURCE_TOO_SMALL";
  }
  return null;
}

export const MEDIA_VALIDATION_MESSAGES: Record<
  MediaValidationErrorCode,
  string
> = {
  MEDIA_FILE_TOO_LARGE: "The file is larger than 4 MB.",
  MEDIA_FORMAT_UNSUPPORTED: "Use a static JPEG, PNG, or WebP image.",
  MEDIA_MIME_MISMATCH: "The file contents do not match the selected image type.",
  MEDIA_CORRUPT: "The image is damaged or cannot be decoded.",
  MEDIA_ANIMATION_UNSUPPORTED: "Animated or multi-page images are not supported.",
  MEDIA_WIDTH_EXCEEDED: "The image is too wide.",
  MEDIA_HEIGHT_EXCEEDED: "The image is too tall.",
  MEDIA_PIXEL_LIMIT_EXCEEDED: "The image contains too many pixels.",
  MEDIA_DECOMPRESSION_LIMIT: "The image exceeds the safe decode limit.",
  MEDIA_OUTPUT_TOO_LARGE: "The processed image is still larger than 4 MB.",
  MEDIA_SOURCE_TOO_SMALL: "The image is too small for a clear avatar.",
};

export async function preflightBrowserImage(
  file: File,
  profile: StaticImageMediaProfile
) {
  const basicError = getBrowserMediaPreflightError(file, profile);
  if (basicError) return basicError;

  try {
    const bitmap = await createImageBitmap(file);
    const dimensionError = getBrowserDimensionPreflightError(
      bitmap.width,
      bitmap.height,
      profile
    );
    bitmap.close();
    return dimensionError;
  } catch {
    return "MEDIA_CORRUPT" satisfies MediaValidationErrorCode;
  }
}
