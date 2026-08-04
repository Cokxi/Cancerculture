import "server-only";

import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/db/admin";
import type {
  AdminRulesContentState,
  PublishedRulesContent,
  RulesRevisionSummary,
} from "./types";
import { validateRulesContent } from "./validation";

export const RULES_CONTENT_CACHE_TAG = "public-content:rules";

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

function mapRevision(row: RevisionRow): RulesRevisionSummary {
  return Object.freeze({
    id: row.id,
    revisionNumber: row.revision_number,
    content: validateRulesContent(row.content),
    createdAt: row.created_at,
    createdBy: row.created_by_discord_user_id,
  });
}

async function loadRulesDocumentRow() {
  const { data, error } = await supabaseAdmin
    .from("content_documents")
    .select(
      "state_version, published_revision_id, draft_revision_id, updated_at, updated_by_discord_user_id"
    )
    .eq("key", "rules")
    .maybeSingle();

  if (error || !data || !data.published_revision_id) {
    console.error("[RULES_CONTENT] document query failed", {
      code: error?.code,
    });
    throw new Error("Rules content is not configured");
  }

  return data as DocumentRow;
}

async function loadRevisionRows(ids: number[]) {
  const { data, error } = await supabaseAdmin
    .from("content_revisions")
    .select(
      "id, revision_number, content, created_at, created_by_discord_user_id"
    )
    .eq("document_key", "rules")
    .in("id", ids);

  if (error) {
    console.error("[RULES_CONTENT] revision query failed", {
      code: error.code,
    });
    throw new Error("Rules content revisions are unavailable");
  }

  return (data ?? []) as RevisionRow[];
}

async function loadRulesMeta() {
  const { data, error } = await supabaseAdmin
    .from("rules_meta")
    .select("current_version, updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (
    error ||
    !data ||
    !Number.isSafeInteger(data.current_version) ||
    data.current_version <= 0 ||
    typeof data.updated_at !== "string" ||
    Number.isNaN(Date.parse(data.updated_at))
  ) {
    console.error("[RULES_CONTENT] rules meta query failed", {
      code: error?.code,
    });
    throw new Error("Rules version is not configured");
  }

  return Object.freeze({
    version: data.current_version as number,
    updatedAt: data.updated_at,
  });
}

async function loadPublishedRulesContent(): Promise<PublishedRulesContent> {
  const [documentRow, rulesMeta] = await Promise.all([
    loadRulesDocumentRow(),
    loadRulesMeta(),
  ]);
  const revisionRows = await loadRevisionRows([
    documentRow.published_revision_id as number,
  ]);
  const publishedRow = revisionRows.find(
    (row) => row.id === documentRow.published_revision_id
  );

  if (!publishedRow) {
    console.error("[RULES_CONTENT] published revision missing");
    throw new Error("Published Rules content is unavailable");
  }

  return Object.freeze({
    revision: mapRevision(publishedRow),
    rulesVersion: rulesMeta.version,
    rulesUpdatedAt: rulesMeta.updatedAt,
  });
}

export const getPublishedRulesContent = unstable_cache(
  loadPublishedRulesContent,
  ["published-rules-content-v1"],
  {
    tags: [RULES_CONTENT_CACHE_TAG],
    revalidate: 86_400,
  }
);

export async function getRulesContentForAdmin(): Promise<AdminRulesContentState> {
  const [documentRow, rulesMeta] = await Promise.all([
    loadRulesDocumentRow(),
    loadRulesMeta(),
  ]);
  const revisionIds = [
    documentRow.published_revision_id,
    documentRow.draft_revision_id,
  ].filter((value): value is number => typeof value === "number");
  const revisionRows = await loadRevisionRows(revisionIds);
  const revisionById = new Map(
    revisionRows.map((row) => [row.id, mapRevision(row)])
  );
  const published = revisionById.get(
    documentRow.published_revision_id as number
  );

  if (!published) {
    console.error("[RULES_CONTENT] admin published revision missing");
    throw new Error("Published Rules content is unavailable");
  }

  const draft = documentRow.draft_revision_id
    ? revisionById.get(documentRow.draft_revision_id)
    : null;

  if (documentRow.draft_revision_id && !draft) {
    console.error("[RULES_CONTENT] admin draft revision missing");
    throw new Error("Rules draft is unavailable");
  }

  return Object.freeze({
    stateVersion: documentRow.state_version,
    rulesVersion: rulesMeta.version,
    published,
    draft: draft ?? null,
    updatedAt: documentRow.updated_at,
    updatedBy: documentRow.updated_by_discord_user_id,
  });
}
