export type ModerationLogRow = {
  id: string;
  created_at: string;
  actor_role: string;
  actor_id: string;
  action: string;
  target_id: string;
  reason_code: string | null;
  reason_text: string | null;
  cycle_id: number;
  evidence: Record<string, unknown> | null;
};

export type ActorUser = {
  discord_user_id: string;
  current_discord_username: string | null;
};
