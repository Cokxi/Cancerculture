"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
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
  actorRole,
  isAdmin,
  action,
  blockId,
  isActive,
  displayOrder,
}: {
  actorId: string;
  actorRole: string;
  isAdmin: boolean;
  action: string;
  blockId: number;
  isActive?: boolean;
  displayOrder?: number;
}) {
  try {
    await logAdminAction({
      actorType: isAdmin ? "admin" : "moderator",
      actorId,
      action,
      targetType: "homepage_info_block",
      targetId: blockId,
      meta: {
        is_active: isActive ?? null,
        display_order: displayOrder ?? null,
        authorization_capability: "homepage_content.manage",
        authorization_role: actorRole,
      },
    });
  } catch {
    console.error("[HOMEPAGE_INFO_BLOCKS] audit log failed");
  }
}

export async function createHomepageInfoBlockAction(
  formData: FormData
) {
  const authorization = await requireDynamicTeamCapability(
    "homepage_content.manage"
  );
  const values = validateHomepageInfoBlockFormData(formData);
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .insert({
      ...toDatabaseValues(values),
      created_by: authorization.discord_user_id,
      updated_by: authorization.discord_user_id,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Failed to create Homepage Info Box");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: authorization.discord_user_id,
    actorRole: authorization.role,
    isAdmin: authorization.isAdmin,
    action: "homepage_info_block_created",
    blockId: data.id,
    isActive: values.isActive,
    displayOrder: values.displayOrder,
  });
}

export async function updateHomepageInfoBlockAction(
  formData: FormData
) {
  const authorization = await requireDynamicTeamCapability(
    "homepage_content.manage"
  );
  const id = getInfoBlockId(formData);
  const values = validateHomepageInfoBlockFormData(formData);
  const { data, error } = await supabaseAdmin
    .from("homepage_info_blocks")
    .update({
      ...toDatabaseValues(values),
      updated_by: authorization.discord_user_id,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error("Homepage Info Box was not found");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: authorization.discord_user_id,
    actorRole: authorization.role,
    isAdmin: authorization.isAdmin,
    action: "homepage_info_block_updated",
    blockId: id,
    isActive: values.isActive,
    displayOrder: values.displayOrder,
  });
}

export async function setHomepageInfoBlockActiveAction(
  formData: FormData
) {
  const authorization = await requireDynamicTeamCapability(
    "homepage_content.manage"
  );
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
      updated_by: authorization.discord_user_id,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error("Homepage Info Box was not found");
  }

  invalidateHomepageInfoBlocks();
  await recordMutation({
    actorId: authorization.discord_user_id,
    actorRole: authorization.role,
    isAdmin: authorization.isAdmin,
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
  const authorization = await requireDynamicTeamCapability(
    "homepage_content.manage"
  );
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
    actorId: authorization.discord_user_id,
    actorRole: authorization.role,
    isAdmin: authorization.isAdmin,
    action: "homepage_info_block_deleted",
    blockId: id,
  });
}
