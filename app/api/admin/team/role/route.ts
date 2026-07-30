export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireAdmin } from "@/lib/auth/guards";
import {
  parseTeamRoleCompatibilityPayload,
  TeamRoleCompatibilityPayloadError,
} from "@/lib/auth/teamRoleCompatibilityPayload";
import {
  executeTeamRoleMutation,
  TeamRoleMutationError,
} from "@/lib/auth/teamRoleMutations";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  requireSameOrigin,
  SameOriginError,
} from "@/lib/http/requireSameOrigin";

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    requireSameOrigin(request);
    const payload = parseTeamRoleCompatibilityPayload(
      await request.json().catch(() => null)
    );
    const { data: member, error } = await supabaseAdmin
      .from("team_members")
      .select("role")
      .eq("discord_user_id", payload.targetDiscordId)
      .maybeSingle();

    if (error) {
      throw new TeamRoleMutationError(
        503,
        "Team roles and permissions are temporarily unavailable.",
        "TEAM_ROLE_MUTATION_UNAVAILABLE"
      );
    }

    if (!member) {
      throw new TeamRoleMutationError(
        404,
        "The requested team member no longer exists.",
        "TEAM_MEMBER_NOT_FOUND"
      );
    }

    if (member.role === "admin") {
      throw new TeamRoleMutationError(
        409,
        "Use the Owner Accounts area for Admin changes.",
        "ADMIN_ROLE_REQUIRES_OWNER_RPC"
      );
    }

    const result = await executeTeamRoleMutation(
      admin.discord_user_id,
      {
        operation: "set_member_non_admin_role",
        targetDiscordUserId: payload.targetDiscordId,
        newRoleKey: payload.targetRole,
        expectedPreviousRoleKey: member.role,
        reason: payload.reason,
        idempotencyKey: randomUUID(),
      }
    );

    revalidatePath("/admin/team/roles");
    revalidatePath("/admin/team/members");
    revalidatePath("/admin/team/authorization-history");
    revalidatePath("/admin/users");

    return NextResponse.json({
      success: true,
      result,
      canonicalEndpoint: "/api/admin/team/roles",
    });
  } catch (error) {
    if (
      error instanceof TeamRoleCompatibilityPayloadError ||
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
        },
        { status: authStatus }
      );
    }

    console.error("[TEAM_ROLE_COMPATIBILITY] unexpected failure", {
      errorName:
        error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error:
          "Team roles and permissions are temporarily unavailable.",
      },
      { status: 503 }
    );
  }
}
