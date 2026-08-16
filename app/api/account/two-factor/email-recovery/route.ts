export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import {
  assertTwoFactorMutationRequest,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { requestFactorRecoveryEmail, TwoFactorError } from "@/lib/twoFactor/service.server";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    assertTwoFactorMutationRequest(request);
    const turnstile = await verifyTurnstileRequest(
      request,
      TURNSTILE_ACTIONS.twoFactorRecovery
    );
    if (turnstile.status === "rejected") {
      throw new TwoFactorError(400, turnstile.code, "Turnstile rejected");
    }
    if (turnstile.status !== "verified") {
      throw new TwoFactorError(503, "TURNSTILE_UNAVAILABLE", "Turnstile unavailable");
    }
    return twoFactorJson(
      await requestFactorRecoveryEmail(await requireSession()),
      202
    );
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
