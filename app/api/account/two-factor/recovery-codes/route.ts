export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { replaceRecoveryCodes, TwoFactorError } from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (body?.confirmation !== "REPLACE RECOVERY CODES") {
      throw new TwoFactorError(400, "RECOVERY_CODE_REPLACEMENT_CONFIRMATION_REQUIRED", "Confirmation required");
    }
    return twoFactorJson({ recoveryCodes: await replaceRecoveryCodes(await requireSession()) });
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
