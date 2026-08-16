export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import {
  confirmRecoveryEmail,
  removeRecoveryEmail,
  requestRecoveryEmailVerification,
  TwoFactorError,
} from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (typeof body?.email !== "string") {
      throw new TwoFactorError(400, "RECOVERY_EMAIL_INVALID", "Invalid recovery email");
    }
    return twoFactorJson(
      await requestRecoveryEmailVerification({
        session: await requireSession(),
        email: body.email,
      }),
      202
    );
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (typeof body?.token !== "string" || body.token.length > 256) {
      throw new TwoFactorError(400, "RECOVERY_TOKEN_INVALID", "Invalid recovery token");
    }
    return twoFactorJson({
      verified: true,
      ...(await confirmRecoveryEmail(await requireSession(), body.token)),
    });
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    if (body?.confirmation !== "REMOVE BACKUP EMAIL") {
      throw new TwoFactorError(400, "RECOVERY_EMAIL_REMOVAL_CONFIRMATION_REQUIRED", "Confirmation required");
    }
    await removeRecoveryEmail(await requireSession());
    return twoFactorJson({ removed: true });
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
