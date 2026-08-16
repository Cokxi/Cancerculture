export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import {
  type StepUpPurpose,
  TwoFactorError,
  verifyStepUp,
} from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const PURPOSES = new Set<StepUpPurpose>([
  "factor_change",
  "factor_deactivation",
  "recovery_codes_replace",
  "backup_email_change",
  "sol_wallet_change",
]);

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (
      typeof body?.code !== "string" ||
      typeof body?.purpose !== "string" ||
      !PURPOSES.has(body.purpose as StepUpPurpose)
    ) {
      throw new TwoFactorError(400, "STEP_UP_INPUT_INVALID", "Invalid step-up input");
    }
    const result = await verifyStepUp({
      session: await requireSession(),
      code: body.code,
      purpose: body.purpose as StepUpPurpose,
    });
    return twoFactorJson({ verified: true, expiresAt: result.expiresAt });
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
