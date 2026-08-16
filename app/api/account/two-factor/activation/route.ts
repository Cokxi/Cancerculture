export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { activateTotpEnrollment, TwoFactorError } from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (typeof body?.enrollmentId !== "string" || typeof body?.code !== "string") {
      throw new TwoFactorError(400, "ACTIVATION_INPUT_INVALID", "Invalid activation input");
    }
    return twoFactorJson(
      await activateTotpEnrollment({
        session: await requireSession(),
        enrollmentId: body.enrollmentId,
        code: body.code,
      })
    );
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
