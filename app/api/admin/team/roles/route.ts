export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireAdmin } from "@/lib/auth/guards";
import {
  parseTeamRoleMutationPayload,
  TeamRoleMutationPayloadError,
} from "@/lib/auth/teamRoleMutationPayload";
import {
  executeTeamRoleMutation,
  TeamRoleMutationError,
} from "@/lib/auth/teamRoleMutations";
import {
  requireSameOrigin,
  SameOriginError,
} from "@/lib/http/requireSameOrigin";

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    requireSameOrigin(request);
    const payload = parseTeamRoleMutationPayload(
      await request.json().catch(() => null)
    );
    const result = await executeTeamRoleMutation(
      admin.discord_user_id,
      payload
    );

    revalidatePath("/admin/team/roles");
    revalidatePath("/admin/users");

    return NextResponse.json({ success: true, result });
  } catch (error) {
    if (
      error instanceof TeamRoleMutationPayloadError ||
      error instanceof TeamRoleMutationError ||
      error instanceof SameOriginError
    ) {
      return NextResponse.json(
        {
          error: error.message,
          code:
            error instanceof TeamRoleMutationError
              ? error.code
              : "INVALID_REQUEST",
        },
        { status: error.status }
      );
    }

    const authStatus = getAuthErrorStatus(error);
    if (authStatus === 401 || authStatus === 403) {
      return NextResponse.json(
        {
          error:
            authStatus === 401
              ? "Authentication required"
              : "Admin access required",
          code:
            authStatus === 401
              ? "NOT_AUTHENTICATED"
              : "ADMIN_REQUIRED",
        },
        { status: authStatus }
      );
    }

    console.error("[TEAM_ROLE_MUTATION] unexpected failure", {
      errorName:
        error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error:
          "Team roles and permissions are temporarily unavailable.",
        code: "TEAM_ROLE_MUTATION_UNAVAILABLE",
      },
      { status: 503 }
    );
  }
}
