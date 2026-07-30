export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireTeamCapability } from "@/lib/auth/guards";
import { getUserDirectoryQuery } from "@/lib/admin/userDirectoryAccess";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";

type BasicUserDirectorySource = {
  discord_user_id: string;
  public_profile_id: string | null;
  current_discord_username: string | null;
  current_discord_handle: string | null;
  current_display_name: string | null;
  current_guild_nickname: string | null;
  flagged_for_review: boolean;
};

export async function GET() {
  try {
    
    const member = await requireTeamCapability(
      "canViewBasicUserDirectory"
    );
    const directoryQuery = getUserDirectoryQuery(member.role);

    const { data, error } = await supabaseAdmin
      .from(directoryQuery.relation)
      .select(directoryQuery.select)
      .order(directoryQuery.orderBy, { ascending: false });

    if (error) {
      console.error("USER LOGS LOAD ERROR", error);
      return NextResponse.json(
        { error: "Failed to load user logs" },
        { status: 500 }
      );
    }

    const basicUsers = (data ?? []) as unknown as
      BasicUserDirectorySource[];
    const users = directoryQuery.isAdminView
      ? data ?? []
      : basicUsers.map((user) => ({
          discord_user_id: user.discord_user_id,
          public_profile_id: user.public_profile_id,
          display_name: formatDiscordUserLabel(user),
          flagged_for_review: user.flagged_for_review,
        }));

    return NextResponse.json({ users });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
