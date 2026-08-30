import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export const DEFAULT_WARNING_EXPIRY_LIMIT = 100;
export const MAXIMUM_WARNING_EXPIRY_LIMIT = 500;

export type WarningExpiryProcessingResult = {
  processedTargets: number;
  expiredWarnings: number;
};

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseWarningExpiryLimit(requestUrl: string) {
  const searchParams = new URL(requestUrl).searchParams;
  if ([...searchParams.keys()].some((key) => key !== "limit")) {
    return null;
  }

  const values = searchParams.getAll("limit");
  if (values.length === 0) return DEFAULT_WARNING_EXPIRY_LIMIT;
  if (values.length !== 1 || !/^[1-9][0-9]*$/u.test(values[0])) return null;

  const limit = Number(values[0]);
  return Number.isSafeInteger(limit) && limit <= MAXIMUM_WARNING_EXPIRY_LIMIT
    ? limit
    : null;
}

export function parseWarningExpiryProcessingResult(
  value: unknown
): WarningExpiryProcessingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WARNING_EXPIRY_RESPONSE_INVALID");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "expiredWarnings" ||
    keys[1] !== "processedTargets" ||
    !isNonNegativeSafeInteger(record.processedTargets) ||
    !isNonNegativeSafeInteger(record.expiredWarnings)
  ) {
    throw new Error("WARNING_EXPIRY_RESPONSE_INVALID");
  }

  return {
    processedTargets: record.processedTargets,
    expiredWarnings: record.expiredWarnings,
  };
}

export async function processDueUserWarningExpiries(
  limit: number
): Promise<WarningExpiryProcessingResult> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAXIMUM_WARNING_EXPIRY_LIMIT
  ) {
    throw new Error("WARNING_EXPIRY_LIMIT_INVALID");
  }

  const { data, error } = await supabaseAdmin.rpc(
    "process_due_user_warning_expiries",
    { p_limit: limit }
  );

  if (error) {
    console.error("[WARNING_EXPIRY] processor RPC failed", {
      code: error.code,
    });
    throw new Error("WARNING_EXPIRY_DATABASE_UNAVAILABLE");
  }

  return parseWarningExpiryProcessingResult(data);
}
