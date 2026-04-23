import { supabaseServer } from "@/lib/db/server";
import type { SocialPlatform } from "./types";

export type SubmissionSocialLink = {
  id: number;
  submission_id: number;
  platform: SocialPlatform;
  display_label: string;
  profile_url: string;
  is_verified_snapshot: boolean;
};

export async function getSubmissionSocialLinksBySubmissionIds(
  submissionIds: number[]
): Promise<Map<number, SubmissionSocialLink[]>> {
  const uniqueSubmissionIds = Array.from(
    new Set(
      submissionIds.filter((submissionId) =>
        Number.isInteger(submissionId)
      )
    )
  );

  if (uniqueSubmissionIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseServer
    .from("submission_social_links")
    .select(
      "id, submission_id, platform, display_label, profile_url, is_verified_snapshot"
    )
    .in("submission_id", uniqueSubmissionIds)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(
      "[getSubmissionSocialLinksBySubmissionIds]",
      error
    );
    return new Map();
  }

  const map = new Map<number, SubmissionSocialLink[]>();

  for (const row of (data ?? []) as SubmissionSocialLink[]) {
    const existing = map.get(row.submission_id) ?? [];
    existing.push(row);
    map.set(row.submission_id, existing);
  }

  return map;
}
