export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  getTwoFactorStatus,
} from "@/lib/twoFactor/service.server";
import {
  twoFactorErrorResponse,
  twoFactorJson,
} from "@/lib/twoFactor/http.server";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";

export async function GET() {
  try {
    return twoFactorJson({
      ...(await getTwoFactorStatus(await requireSession())),
      recoveryTurnstileSiteKey: getTurnstileClientSiteKey(),
    });
  } catch (error) {
    return twoFactorErrorResponse(error);
  }
}
