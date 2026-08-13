export const MEDIA_CLEANUP_ENVIRONMENT_HEADER =
  "x-cancerculture-media-cleanup-environment";

export type MediaCleanupEnvironment = "dev" | "live";

const SUPABASE_PROJECT_ENVIRONMENTS = new Map<string, MediaCleanupEnvironment>([
  ["gceljiuydyiwkomymuqh", "dev"],
  ["nrxfuvsfezfqcwfmpxxl", "live"],
]);

export function resolveWebsiteMediaCleanupEnvironment(
  supabaseUrl: string | undefined
): MediaCleanupEnvironment | null {
  if (!supabaseUrl) return null;

  try {
    const hostname = new URL(supabaseUrl).hostname.toLowerCase();
    const projectRef = hostname.split(".")[0] ?? "";
    return SUPABASE_PROJECT_ENVIRONMENTS.get(projectRef) ?? null;
  } catch {
    return null;
  }
}

export function isMatchingMediaCleanupEnvironment({
  requested,
  website,
}: {
  requested: string | null;
  website: MediaCleanupEnvironment | null;
}) {
  return website !== null && requested === website;
}
