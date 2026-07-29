"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { logAdminAction } from "@/lib/audit/logAdminAction";
import { supabaseAdmin } from "@/lib/db/admin";
import { HOMEPAGE_INFO_BLOCKS_CACHE_TAG } from "@/lib/homepageInfoBlocks/data.server";
import { validateHomepageInfoBlockFormData } from "@/lib/homepageInfoBlocks/validation";

const ADMIN_PATH = "/admin/homepage-info-blocks";

function getInfoBlockId(formData: FormData) {
  const id = Number(formData.get("id"));

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid Homepage Info Box ID");
  }

  return id;
}

function toDatabaseValues(
  values: ReturnType<typeof validateHomepageInfoBlockFormData>
) {
  return {
    title: values.title,
    body: values.body,
    display_order: values.displayOrder,
    is_active: values.isActive,
    link_label: values.linkLabel,
    link_url: values.linkUrl,
  };
}

function invalidateHomepageInfoBlocks() {
  updateTag(HOMEPAGE_INFO_BLOCKS_CACHE_TAG);
  revalidatePath("/");
  revalidatePath(ADMIN_PATH);
}

async function recordMutation({
  actorId,
  action,
  blockId,
  isActive,
  displayOrder,
}: {
  actorId: string;
  action: string;
  blockId: number;
  isActive?: boolean;
  displayOrder?: number;
}) {
  try {
    await logAdminAction({
      actorType: "admin",
      actorId,
      action,
      targetType: "homepage_info_block",
      targetId: blockId,
      meta: {
        is_active: isActive ?? null,
        display_order: displayOrder ?? null,
      },
    });
  } catch {
    console.error("[HOMEPAGE_INFO_BLOCKS] audit log failed");
  }
}

export async function createHomepageInfoBlockAction(
  formData: FormData
) {
  const admin = await requireAdmin();
  const values = validateHomepageInfoBlockFormData(formData);
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .insert({
      ...toDatabaseValues(values),
      created_by: admin.discord_user_id,
      updated_by: admin.discord_user_id,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Failed to create Homepage Info Box");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: admin.discord_user_id,
    action: "homepage_info_block_created",
    blockId: data.id,
    isActive: values.isActive,
    displayOrder: values.displayOrder,
  });
}

export async function updateHomepageInfoBlockAction(
  formData: FormData
) {
  const admin = await requireAdmin();
  const id = getInfoBlockId(formData);
  const values = validateHomepageInfoBlockFormData(formData);
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .update({
      ...toDatabaseValues(values),
      updated_by: admin.discord_user_id,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error("Homepage Info Box was not found");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: admin.discord_user_id,
    action: "homepage_info_block_updated",
    blockId: id,
    isActive: values.isActive,
    displayOrder: values.displayOrder,
  });
}

export async function setHomepageInfoBlockActiveAction(
  formData: FormData
) {
  const admin = await requireAdmin();
  const id = getInfoBlockId(formData);
  const requestedValue = formData.get("is_active");

  if (requestedValue !== "true" && requestedValue !== "false") {
    throw new Error("Invalid Active status");
  }

  const isActive = requestedValue === "true";
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .update({
      is_active: isActive,
      updated_by: admin.discord_user_id,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error("Homepage Info Box was not found");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: admin.discord_user_id,
    action: isActive
      ? "homepage_info_block_activated"
      : "homepage_info_block_deactivated",
    blockId: id,
    isActive,
  });
}

export async function deleteHomepageInfoBlockAction(
  formData: FormData
) {
  const admin = await requireAdmin();
  const id = getInfoBlockId(formData);
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error("Homepage Info Box was not found");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: admin.discord_user_id,
    action: "homepage_info_block_deleted",
    blockId: id,
  });
}
