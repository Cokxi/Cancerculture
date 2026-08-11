import "server-only";

import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/db/admin";
import type {
  AdminHomepageInfoBlock,
  HomepageInfoBlock,
} from "./types";

export const HOMEPAGE_INFO_BLOCKS_CACHE_TAG =
  "homepage-info-blocks:active";

const PUBLIC_SELECT =
  "id, title, body, display_order, link_label, link_url";
const ADMIN_SELECT = `${PUBLIC_SELECT}, is_active, created_at, updated_at, created_by, updated_by`;

type PublicRow = {
  id: number;
  title: string | null;
  body: string;
  display_order: number;
  link_label: string | null;
  link_url: string | null;
};

type AdminRow = PublicRow & {
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

function mapPublicRow(row: PublicRow): HomepageInfoBlock {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    displayOrder: row.display_order,
    linkLabel: row.link_label,
    linkUrl: row.link_url,
  };
}

function mapAdminRow(row: AdminRow): AdminHomepageInfoBlock {
  return {
    ...mapPublicRow(row),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

async function loadActiveHomepageInfoBlocks() {
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .select(PUBLIC_SELECT)
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[HOMEPAGE_INFO_BLOCKS] public query failed");
    throw new Error("Failed to load Homepage Info");
  }

  return ((data ?? []) as PublicRow[]).map(mapPublicRow);
}

export const getActiveHomepageInfoBlocks = unstable_cache(
  loadActiveHomepageInfoBlocks,
  ["homepage-info-blocks-active-v2"],
  {
    tags: [HOMEPAGE_INFO_BLOCKS_CACHE_TAG],
    revalidate: 86_400,
  }
);

export async function getHomepageInfoBlocksForAdmin() {
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .select(ADMIN_SELECT)
    .order("display_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[HOMEPAGE_INFO_BLOCKS] admin query failed");
    throw new Error("Failed to load Homepage Info Boxes");
  }

  return ((data ?? []) as AdminRow[]).map(mapAdminRow);
}
