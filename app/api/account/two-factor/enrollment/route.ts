export const runtime = "nodejs";

import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  readTwoFactorJson,
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { beginTotpEnrollment, TwoFactorError } from "@/lib/twoFactor/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await readTwoFactorJson(request);
    const intent = body?.intent;
    if (intent !== "initial" && intent !== "replacement" && intent !== "email_recovery") {
      throw new TwoFactorError(400, "ENROLLMENT_INTENT_INVALID", "Invalid enrollment intent");
    }
    if (intent === "email_recovery" && typeof body?.recoveryToken !== "string") {
      throw new TwoFactorError(400, "RECOVERY_TOKEN_REQUIRED", "Recovery token required");
    }
    const session = await requireSession();
    const { data } = await supabaseAdmin
      .from("user_logs")
      .select("current_discord_username")
      .eq("discord_user_id", session.discord_user_id)
      .maybeSingle();
    const result = await beginTotpEnrollment({
      session,
      intent,
      recoveryToken: typeof body?.recoveryToken === "string" ? body.recoveryToken : undefined,
      acknowledgeRecoveryResponsibility: body?.acknowledgeRecoveryResponsibility === true,
      accountLabel: data?.current_discord_username ?? "Account",
    });
    return twoFactorJson(result, 201);
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
