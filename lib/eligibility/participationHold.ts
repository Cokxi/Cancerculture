import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export class ParticipationHoldDependencyError extends Error {
  constructor() {
    super("Participation availability could not be verified");
    this.name = "ParticipationHoldDependencyError";
  }
}

export async function getParticipationHold(discordUserId: string) {
  const { data, error } = await supabaseAdmin.rpc(
    "get_user_participation_hold",
    { p_discord_user_id: discordUserId }
  );

  if (
    error ||
    !data ||
    typeof data !== "object" ||
    typeof (data as { held?: unknown }).held !== "boolean"
  ) {
    console.error("[participation hold][dependency]", {
      code: error?.code ?? "INVALID_RESULT",
    });
    throw new ParticipationHoldDependencyError();
  }

  return (data as { held: boolean }).held;
}
