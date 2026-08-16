import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { validateSolRecipientAddress } from "@/lib/solana/address";
import type { TwoFactorSession } from "@/lib/twoFactor/service.server";

export class SolProfileWalletError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "SolProfileWalletError";
    this.status = status;
    this.code = code;
  }
}

type RpcObject = Record<string, unknown>;

function asObject(value: unknown): RpcObject {
  return value && typeof value === "object" ? (value as RpcObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function rpcError(error: { message: string }) {
  const code =
    error.message.match(/[A-Z][A-Z0-9_]{4,}/u)?.[0] ??
    "SOL_WALLET_UNAVAILABLE";
  const status =
    code === "FRESH_STEP_UP_REQUIRED" ? 403 :
    code === "ACCOUNT_SESSION_INVALID" ? 401 :
    code === "SOL_WALLET_REQUEST_ID_REUSED" ? 409 :
    code.includes("INPUT_INVALID") ? 400 : 503;
  throw new SolProfileWalletError(status, code);
}

async function rpc(name: string, parameters: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error) rpcError(error);
  return asObject(data);
}

function membershipError(outcome: string): never {
  if (outcome === "membership_pending") {
    throw new SolProfileWalletError(403, "MEMBERSHIP_PENDING");
  }
  throw new SolProfileWalletError(403, "NOT_IN_DISCORD");
}

export async function getSolProfileWallet(session: TwoFactorSession) {
  const result = await rpc("get_account_sol_profile_wallet", {
    p_session_id: session.session_id,
  });
  const outcome = stringValue(result.outcome) ?? "";
  if (outcome === "membership_pending" || outcome === "not_member") {
    membershipError(outcome);
  }
  if (outcome !== "ok") {
    throw new SolProfileWalletError(503, "SOL_WALLET_UNAVAILABLE");
  }

  const factorActive = result.factorActive === true;
  return {
    factorActive,
    walletAddress: factorActive ? stringValue(result.walletAddress) : null,
    version: factorActive ? numberValue(result.version) ?? 0 : null,
    updatedAt: factorActive ? stringValue(result.updatedAt) : null,
  };
}

export async function changeSolProfileWallet({
  session,
  operationId,
  expectedVersion,
  address,
}: {
  session: TwoFactorSession;
  operationId: string;
  expectedVersion: number;
  address: string | null;
}) {
  const validation = address === null ? null : validateSolRecipientAddress(address);
  const normalizedAddress =
    validation?.ok === true ? validation.address : address?.trim() ?? null;
  const result = await rpc("change_account_sol_profile_wallet", {
    p_session_id: session.session_id,
    p_request_id: operationId,
    p_expected_version: expectedVersion,
    p_wallet_address: normalizedAddress,
  });
  const outcome = stringValue(result.outcome) ?? "";
  const reason = stringValue(result.reason) ?? "";

  if (outcome === "applied") {
    return {
      changed: true,
      version: numberValue(result.version),
      updatedAt: stringValue(result.updatedAt),
      idempotentReplay: result.idempotentReplay === true,
    };
  }
  if (outcome !== "rejected") {
    throw new SolProfileWalletError(503, "SOL_WALLET_UNAVAILABLE");
  }

  if (reason === "address_invalid") {
    throw new SolProfileWalletError(400, "SOL_WALLET_ADDRESS_INVALID");
  }
  if (reason === "stale_version") {
    throw new SolProfileWalletError(409, "SOL_WALLET_STALE");
  }
  if (reason === "no_change") {
    throw new SolProfileWalletError(409, "SOL_WALLET_NO_CHANGE");
  }
  if (reason === "membership_pending" || reason === "not_member") {
    membershipError(reason);
  }
  throw new SolProfileWalletError(503, "SOL_WALLET_UNAVAILABLE");
}
