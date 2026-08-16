export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { AuthError } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  changeSolProfileWallet,
  getSolProfileWallet,
  SolProfileWalletError,
} from "@/lib/solana/profileWallet.server";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { TwoFactorError } from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function errorResponse(error: unknown) {
  if (error instanceof SolProfileWalletError) {
    return twoFactorJson({ error: error.code }, error.status);
  }
  if (error instanceof TwoFactorError || error instanceof AuthError) {
    return twoFactorErrorResponse(error);
  }
  console.error("[SOL_WALLET] request failed", { code: "UNEXPECTED_ERROR" });
  return twoFactorJson({ error: "SOL_WALLET_UNAVAILABLE" }, 503);
}

export async function GET() {
  try {
    return twoFactorJson(await getSolProfileWallet(await requireSession()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;

  try {
    const body = await readTwoFactorJson(request);
    const address = body?.address;
    const confirmation = body?.confirmation;
    if (
      typeof body?.operationId !== "string" ||
      !UUID_PATTERN.test(body.operationId) ||
      !Number.isSafeInteger(body?.expectedVersion) ||
      body.expectedVersion < 0 ||
      (address !== null && typeof address !== "string") ||
      (typeof address === "string" && address.length > 1024) ||
      confirmation !==
        (address === null
          ? "REMOVE SOL PROFILE WALLET"
          : "SAVE SOL PROFILE WALLET")
    ) {
      throw new SolProfileWalletError(400, "SOL_WALLET_INPUT_INVALID");
    }

    const result = await changeSolProfileWallet({
      session: await requireSession(),
      operationId: body.operationId,
      expectedVersion: body.expectedVersion,
      address,
    });
    return twoFactorJson(result);
  } catch (error) {
    return errorResponse(error);
  }
}
