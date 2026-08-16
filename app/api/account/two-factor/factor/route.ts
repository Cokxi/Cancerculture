export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { deactivateTotp, TwoFactorError } from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function DELETE(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (body?.confirmation !== "DISABLE TWO-FACTOR AUTHENTICATION") {
      throw new TwoFactorError(400, "FACTOR_DEACTIVATION_CONFIRMATION_REQUIRED", "Confirmation required");
    }
    await deactivateTotp(await requireSession());
    return twoFactorJson({ active: false });
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
