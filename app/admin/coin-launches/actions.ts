"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

const MAX_TEXT_LENGTH = 500;

function getRequiredText(formData: FormData, key: string) {
  const value = formData.get(key)?.toString().trim() ?? "";

  if (!value || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${key} is required and must be reasonably sized`);
  }

  return value;
}

function getOptionalText(formData: FormData, key: string) {
  const value = formData.get(key)?.toString().trim() ?? "";

  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${key} is too long`);
  }

  return value || null;
}

function getOptionalUrl(formData: FormData, key: string) {
  const value = getOptionalText(formData, key);

  if (!value) {
    return null;
  }

  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${key} must use http or https`);
  }

  return url.toString();
}

function getDisplayOrder(formData: FormData) {
  const value = Number(formData.get("display_order") ?? 100);

  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error("display_order must be an integer between 0 and 100000");
  }

  return value;
}

function getLaunchValues(formData: FormData) {
  const requestedActive = formData.get("is_active") === "on";
  const requestedPrimary = formData.get("is_primary") === "on";
  const isPrimary = requestedPrimary;

  return {
    chain: getRequiredText(formData, "chain"),
    platform: getRequiredText(formData, "platform"),
    token_symbol: getOptionalText(formData, "token_symbol"),
    contract_address: getOptionalText(formData, "contract_address"),
    launch_url: getOptionalUrl(formData, "launch_url"),
    explorer_url: getOptionalUrl(formData, "explorer_url"),
    is_active: requestedActive || isPrimary,
    is_primary: isPrimary,
    display_order: getDisplayOrder(formData),
    updated_at: new Date().toISOString(),
  };
}

async function unsetOtherPrimaryRows(exceptId: number) {
  const { error } = await supabaseAdmin
    .from("coin_launches")
    .update({
      is_primary: false,
      updated_at: new Date().toISOString(),
    })
    .eq("is_primary", true)
    .neq("id", exceptId);

  if (error) {
    throw new Error(`Failed to clear previous primary launch: ${error.message}`);
  }
}

function revalidateCoinLaunches() {
  revalidatePath("/admin/coin-launches");
  revalidatePath("/");
}

export async function createCoinLaunchAction(formData: FormData) {
  await requireAdmin();
  const values = getLaunchValues(formData);
  const { data, error } = await supabaseAdmin
    .from("coin_launches")
    .insert({ ...values, is_primary: false })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create coin launch");
  }

  if (values.is_primary) {
    await unsetOtherPrimaryRows(data.id);
    const { error: primaryError } = await supabaseAdmin
      .from("coin_launches")
      .update({ is_primary: true, is_active: true })
      .eq("id", data.id);

    if (primaryError) {
      throw new Error(`Failed to set primary launch: ${primaryError.message}`);
    }
  }

  revalidateCoinLaunches();
}

export async function updateCoinLaunchAction(formData: FormData) {
  await requireAdmin();
  const id = Number(formData.get("id"));

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid coin launch id");
  }

  const values = getLaunchValues(formData);

  if (values.is_primary) {
    const { data: target, error: targetError } = await supabaseAdmin
      .from("coin_launches")
      .update({ ...values, is_primary: false, is_active: true })
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (targetError || !target) {
      throw new Error(targetError?.message ?? "Coin launch not found");
    }

    await unsetOtherPrimaryRows(id);
    const { error: primaryError } = await supabaseAdmin
      .from("coin_launches")
      .update({ is_primary: true, is_active: true })
      .eq("id", id);

    if (primaryError) {
      throw new Error(`Failed to set primary launch: ${primaryError.message}`);
    }

    revalidateCoinLaunches();
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("coin_launches")
    .update(values)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message ?? "Coin launch not found");
  }

  revalidateCoinLaunches();
}
