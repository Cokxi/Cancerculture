import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { getDiscordMembershipEligibility } from "@/lib/eligibility/discordMembership";

export async function GET() {
  try {
    const { discord_user_id } = await requireSession();

    const membership =
      await getDiscordMembershipEligibility(discord_user_id);

    if (membership.isDiscordBanned) {
      return NextResponse.json({ status: "RESTRICTED" }, { status: 403 });
    }

    if (membership.dependencyUnavailable) {
      return NextResponse.json(
        { status: "UNAVAILABLE" },
        { status: 503 }
      );
    }

    if (!membership.membershipKnown) {
      return NextResponse.json({ status: "PENDING" });
    }

    if (!membership.isInDiscord) {
      return NextResponse.json({
        status: "NOT_IN_DISCORD",
      });
    }

    if (membership.joinedTooRecently) {
      return NextResponse.json({
        status: "COOLDOWN",
        joinedAt: membership.joinedAt,
        retryAfterMs: membership.retryAfterMs,
      });
    }

    return NextResponse.json({
      status: "OK",
    });
  } catch {
    return NextResponse.json(
      { status: "UNAVAILABLE" },
      { status: 503 }
    );
  }
}
