import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

type PublicCycleNumberRow = {
  id: number;
  public_number: number | null;
};

export function requirePublicCycleNumber(
  value: number | null | undefined
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error("PUBLIC_CYCLE_NUMBER_UNAVAILABLE");
  }

  return value as number;
}

export async function getPublicCycleNumberMap(
  cycleIds: readonly number[]
): Promise<ReadonlyMap<number, number>> {
  const uniqueCycleIds = Array.from(
    new Set(
      cycleIds.filter(
        (cycleId) => Number.isSafeInteger(cycleId) && cycleId > 0
      )
    )
  );

  if (uniqueCycleIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, public_number")
    .in("id", uniqueCycleIds);

  if (error) {
    console.error("[public cycle number][lookup]", {
      code: error.code,
    });
    throw new Error("PUBLIC_CYCLE_NUMBER_LOOKUP_FAILED");
  }

  const publicNumberByCycleId = new Map<number, number>();

  for (const row of (data ?? []) as PublicCycleNumberRow[]) {
    publicNumberByCycleId.set(
      row.id,
      requirePublicCycleNumber(row.public_number)
    );
  }

  if (publicNumberByCycleId.size !== uniqueCycleIds.length) {
    throw new Error("PUBLIC_CYCLE_NUMBER_UNAVAILABLE");
  }

  return publicNumberByCycleId;
}

export async function getPublicCycleNumber(cycleId: number) {
  const publicNumberByCycleId = await getPublicCycleNumberMap([cycleId]);
  return requirePublicCycleNumber(publicNumberByCycleId.get(cycleId));
}
