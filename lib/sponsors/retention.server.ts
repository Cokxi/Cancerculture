import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type SponsorRetentionResult = {
  rawEventsDeleted: number;
  aggregatesDeleted: number;
};

function isNonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export async function pruneSponsorMeasurementRetention(): Promise<SponsorRetentionResult> {
  const { data, error } = await supabaseAdmin.rpc(
    "prune_sponsor_measurement_retention"
  );

  if (error) {
    console.error("[sponsor retention][rpc]", { code: error.code });
    throw new Error("Sponsor measurement retention could not be enforced");
  }

  if (
    !data ||
    typeof data !== "object" ||
    !("rawEventsDeleted" in data) ||
    !("aggregatesDeleted" in data) ||
    !isNonNegativeInteger(data.rawEventsDeleted) ||
    !isNonNegativeInteger(data.aggregatesDeleted)
  ) {
    throw new Error("Sponsor measurement retention returned an invalid response");
  }

  return {
    rawEventsDeleted: Number(data.rawEventsDeleted),
    aggregatesDeleted: Number(data.aggregatesDeleted),
  };
}
