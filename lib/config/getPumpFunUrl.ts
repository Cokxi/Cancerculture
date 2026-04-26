import "server-only";

import { supabaseServer } from "@/lib/db/server";

const DEFAULT_PUMPFUN_URL = "https://pump.fun/";

export async function getPumpFunUrl() {
  const { data, error } = await supabaseServer
    .from("app_config")
    .select("value")
    .eq("key", "pumpfun_url")
    .maybeSingle();

  const value = data?.value?.trim();

  if (error || !value) {
    return DEFAULT_PUMPFUN_URL;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return DEFAULT_PUMPFUN_URL;
    }

    return url.toString();
  } catch {
    return DEFAULT_PUMPFUN_URL;
  }
}
