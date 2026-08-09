import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";

type JsonObject = Record<string, unknown>;

function submissionId(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function addVisibilitySafeSubmissionReportThumbnails<
  T extends JsonObject,
>(items: readonly T[]) {
  const ids = Array.from(
    new Set(
      items
        .map((item) => submissionId(item.submissionId))
        .filter((id): id is number => id !== null)
    )
  );
  const { data, error } = ids.length > 0
    ? await supabaseAdmin
        .from("submissions")
        .select("id, r2_key, is_disqualified, public_visibility_status")
        .in("id", ids)
    : { data: [], error: null };
  const keyById = new Map<number, string>();

  if (!error) {
    for (const row of data ?? []) {
      const id = submissionId(row.id);
      const key = text(row.r2_key);
      if (
        id !== null &&
        key &&
        row.is_disqualified !== true &&
        row.public_visibility_status === "visible"
      ) {
        keyById.set(id, key);
      }
    }
  }

  return Object.freeze(
    items.map((item) => {
      const id = submissionId(item.submissionId);
      const publicUrl = id === null
        ? undefined
        : getPublicImageUrl(keyById.get(id));
      return Object.freeze({
        ...item,
        thumbnailUrl: publicUrl
          ? getSubmissionThumbnailUrl(publicUrl)
          : null,
      });
    })
  );
}
