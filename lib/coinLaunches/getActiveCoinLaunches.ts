import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type CoinLaunch = {
  id: number | null;
  chain: string;
  platform: string;
  tokenSymbol: string | null;
  contractAddress: string | null;
  launchUrl: string | null;
  explorerUrl: string | null;
  isActive: boolean;
  isPrimary: boolean;
  displayOrder: number;
};

type CoinLaunchRow = {
  id: number;
  chain: string;
  platform: string;
  token_symbol: string | null;
  contract_address: string | null;
  launch_url: string | null;
  explorer_url: string | null;
  is_active: boolean;
  is_primary: boolean;
  display_order: number;
};

function mapCoinLaunch(row: CoinLaunchRow): CoinLaunch {
  return {
    id: row.id,
    chain: row.chain,
    platform: row.platform,
    tokenSymbol: row.token_symbol,
    contractAddress: row.contract_address,
    launchUrl: row.launch_url,
    explorerUrl: row.explorer_url,
    isActive: row.is_active,
    isPrimary: row.is_primary,
    displayOrder: row.display_order,
  };
}

export async function getActiveCoinLaunches() {
  const { data, error } = await supabaseAdmin
    .from("coin_launches")
    .select(
      "id, chain, platform, token_symbol, contract_address, launch_url, explorer_url, is_active, is_primary, display_order"
    )
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("display_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[COIN_LAUNCHES] active launch query failed", error);
    throw new Error("Failed to load active coin launches");
  }

  return ((data ?? []) as CoinLaunchRow[]).map(mapCoinLaunch);
}

export async function getPrimaryCoinLaunch() {
  const launches = await getActiveCoinLaunches();
  return launches[0] ?? null;
}
