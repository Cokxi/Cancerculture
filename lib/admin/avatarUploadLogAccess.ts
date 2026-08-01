export type DelegatedAvatarUploadLogReason =
  | "cooldown_active"
  | "invalid_request"
  | "service_unavailable"
  | "upload_failed"
  | "validation_failed";

export function getDelegatedAvatarUploadLogReason(
  reason: string | null,
  status: string
): DelegatedAvatarUploadLogReason | null {
  if (status.trim().toLowerCase() === "success") {
    return null;
  }

  const normalizedReason = reason?.trim().toLowerCase() ?? "";

  if (normalizedReason === "cooldown") {
    return "cooldown_active";
  }
  if (normalizedReason === "missing_file") {
    return "invalid_request";
  }
  if (
    normalizedReason === "validation_failed" ||
    normalizedReason.startsWith("media_")
  ) {
    return "validation_failed";
  }
  if (
    normalizedReason.includes("dependency") ||
    normalizedReason.startsWith("r2_") ||
    normalizedReason.includes("storage") ||
    normalizedReason.includes("database") ||
    normalizedReason.includes("cleanup")
  ) {
    return "service_unavailable";
  }

  return "upload_failed";
}
