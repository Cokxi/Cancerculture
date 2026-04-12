import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { checkDiscordMembership } from "@/lib/discord";

export async function GET() {
  try {
    const { discord_user_id } = await requireSession();

    const member = await checkDiscordMembership(discord_user_id);

    if (!member.isMember) {
      return NextResponse.json({
        status: "NOT_IN_DISCORD",
      });
    }

    const joinedAt = new Date(member.joinedAt);
    const now = new Date();

    const diffMinutes =
      (now.getTime() - joinedAt.getTime()) / 1000 / 60;

    if (diffMinutes < 10) {
      return NextResponse.json({
        status: "COOLDOWN",
        joinedAt: member.joinedAt,
      });
    }

    return NextResponse.json({
      status: "OK",
    });
  } catch {
    return NextResponse.json(
      { status: "ERROR" },
      { status: 500 }
    );
  }
}