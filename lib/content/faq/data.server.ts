import "server-only";

import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/db/admin";
import type { AdminFaqContentState, FaqRevisionSummary } from "./types";
import { validateFaqContent } from "./validation";

export const FAQ_CONTENT_CACHE_TAG = "public-content:faq";

type DocumentRow = {
  state_version: number;
  published_revision_id: number | null;
  draft_revision_id: number | null;
  updated_at: string;
  updated_by_discord_user_id: string | null;
};

type RevisionRow = {
  id: number;
  revision_number: number;
  content: unknown;
  created_at: string;
  created_by_discord_user_id: string | null;
};

function mapRevision(row: RevisionRow): FaqRevisionSummary {
  return Object.freeze({
    id: row.id,
    revisionNumber: row.revision_number,
    content: validateFaqContent(row.content),
    createdAt: row.created_at,
    createdBy: row.created_by_discord_user_id,
  });
}

async function loadFaqDocumentRow() {
  const { data, error } = await supabaseAdmin
    .from("content_documents")
    .select(
      "state_version, published_revision_id, draft_revision_id, updated_at, updated_by_discord_user_id"
    )
    .eq("key", "faq")
    .maybeSingle();

  if (
    error ||
    !data ||
    !data.published_revision_id ||
    data.draft_revision_id !== null
  ) {
    console.error("[FAQ_CONTENT] document query failed", {
      code: error?.code,
    });
    throw new Error("FAQ content is not configured");
  }

  return data as DocumentRow;
}

async function loadFaqRevision(revisionId: number) {
  const { data, error } = await supabaseAdmin
    .from("content_revisions")
    .select(
      "id, revision_number, content, created_at, created_by_discord_user_id"
    )
    .eq("document_key", "faq")
    .eq("id", revisionId)
    .maybeSingle();

  if (error || !data) {
    console.error("[FAQ_CONTENT] published revision query failed", {
      code: error?.code,
    });
    throw new Error("Published FAQ content is unavailable");
  }

  return mapRevision(data as RevisionRow);
}

async function loadPublishedFaqContent(): Promise<FaqRevisionSummary> {
  const documentRow = await loadFaqDocumentRow();
  return loadFaqRevision(documentRow.published_revision_id as number);
}

export const getPublishedFaqContent = unstable_cache(
  loadPublishedFaqContent,
  ["published-faq-content-v2"],
  {
    tags: [FAQ_CONTENT_CACHE_TAG],
    revalidate: 86_400,
  }
);

export async function getFaqContentForAdmin(): Promise<AdminFaqContentState> {
  const documentRow = await loadFaqDocumentRow();
  const published = await loadFaqRevision(
    documentRow.published_revision_id as number
  );

  if (published.id !== documentRow.published_revision_id) {
    console.error("[FAQ_CONTENT] admin published revision mismatch");
    throw new Error("Published FAQ content is unavailable");
  }

  return Object.freeze({
    stateVersion: documentRow.state_version,
    published,
    updatedAt: documentRow.updated_at,
    updatedBy: documentRow.updated_by_discord_user_id,
  });
}
