export type DelegatedUploadLogReason =
  | "access_denied"
  | "cycle_unavailable"
  | "service_unavailable"
  | "submission_limit"
  | "upload_blocked"
  | "upload_failed"
  | "validation_failed";

export function getDelegatedUploadLogReason(
  reason: string | null,
  status: string
): DelegatedUploadLogReason | null {
  if (status.trim().toLowerCase() === "success") {
    return null;
  }

  const normalizedReason = reason?.trim().toLowerCase() ?? "";

  if (["banned", "rules_not_accepted"].includes(normalizedReason)) {
    return "access_denied";
  }
  if (normalizedReason === "upload_blocked_for_cycle") {
    return "upload_blocked";
  }
  if (normalizedReason === "cycle_not_open") {
    return "cycle_unavailable";
  }
  if (
    ["duplicate_submission", "upload_limit_reached"].includes(
      normalizedReason
    )
  ) {
    return "submission_limit";
  }
  if (
    normalizedReason === "validation_failed" ||
    normalizedReason.startsWith("media_")
  ) {
    return "validation_failed";
  }
  if (
    normalizedReason === "dependency_unavailable" ||
    normalizedReason.startsWith("r2_") ||
    normalizedReason.includes("dependency") ||
    normalizedReason.includes("cleanup") ||
    normalizedReason === "upload_in_progress"
  ) {
    return "service_unavailable";
  }

  return "upload_failed";
}
