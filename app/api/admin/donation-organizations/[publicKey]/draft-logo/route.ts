export const runtime = "nodejs";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { createNeutralCommunityFeedMediaResponse, proxyCommunityFeedMedia } from "@/lib/feed/communityFeedMedia";

const PUBLIC_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export async function GET(
  _request: Request,
  context: { params: Promise<{ publicKey: string }> }
) {
  try {
    const authorization = await requireDynamicTeamCapability(
      "donation_organizations.manage"
    );
    const { publicKey } = await context.params;
    if (!PUBLIC_KEY_PATTERN.test(publicKey) || publicKey.length > 80) {
      return createNeutralCommunityFeedMediaResponse();
    }
    const { data, error } = await supabaseAdmin.rpc(
      "get_donation_organization_draft_logo_source",
      {
        p_actor_discord_user_id: authorization.discord_user_id,
        p_public_key: publicKey,
      }
    );
    if (error || typeof data !== "string") {
      return createNeutralCommunityFeedMediaResponse();
    }
    return proxyCommunityFeedMedia({ storageKey: data });
  } catch {
    return new Response(null, {
      status: 403,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
}
