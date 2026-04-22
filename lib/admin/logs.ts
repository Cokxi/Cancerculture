import { supabaseAdmin } from "@/lib/db/admin";

export type UploadLogRow = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  status: string;
  reason: string | null;
  discord_user_id: string | null;
  submission_id: number | null;
};

export type VoteLogRow = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  submission_id: number | null;
  discord_user_id: string | null;
  status: string;
  reason: string | null;
};

export type AvatarUploadLogRow = UploadLogRow;

export async function getUploadLogs() {
  return supabaseAdmin
    .from("upload_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(400);
}

export async function getVoteLogs() {
  return supabaseAdmin
    .from("vote_logs")
    .select(
      "id, created_at, cycle_id, submission_id, discord_user_id, status, reason"
    )
    .order("created_at", { ascending: false })
    .limit(300);
}

export async function getAvatarUploadLogs() {
  return supabaseAdmin
    .from("avatar_upload_logs")
    .select(
      "id, created_at, discord_user_id, status, reason, avatar_key, cooldown_until"
    )
    .order("created_at", { ascending: false })
    .limit(400)
    .then(({ data, error }) => ({
      data:
        data?.map((log) => ({
          ...log,
          cycle_id: null,
          submission_id: null,
        })) ?? [],
      error,
    }));
}
