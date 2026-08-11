import { supabaseAdmin } from "@/lib/db/admin";

export type SubmissionPrivateData = {
  x_username: string | null;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
};

type SubmissionPrivateDataRow = SubmissionPrivateData & {
  id: number;
  submission_id: number;
};

export async function getSubmissionPrivateData(
  submissionId: number
): Promise<SubmissionPrivateData | null> {
  const { data, error } = await supabaseAdmin
    .from("submission_private_data")
    .select(
      "x_username, wallet_address, payout_choice, split_percent, charity"
    )
    .eq("submission_id", submissionId)
    .maybeSingle();

  if (error) {
    console.error(
      "[getSubmissionPrivateData]",
      error
    );
    return null;
  }

  return data;
}

export async function getSubmissionPrivateDataBatch(
  submissionIds: readonly number[]
): Promise<Map<number, SubmissionPrivateData>> {
  const boundedIds = Array.from(new Set(submissionIds)).slice(0, 20);
  if (boundedIds.length === 0) return new Map();

  const { data, error } = await supabaseAdmin
    .from("submission_private_data")
    .select(
      "id, submission_id, x_username, wallet_address, payout_choice, split_percent, charity"
    )
    .in("submission_id", boundedIds)
    .order("id", { ascending: false });

  if (error) {
    console.error("[getSubmissionPrivateDataBatch]", { code: error.code });
    return new Map();
  }

  const result = new Map<number, SubmissionPrivateData>();
  for (const row of (data ?? []) as SubmissionPrivateDataRow[]) {
    if (result.has(row.submission_id)) continue;
    result.set(row.submission_id, {
      x_username: row.x_username,
      wallet_address: row.wallet_address,
      payout_choice: row.payout_choice,
      split_percent: row.split_percent,
      charity: row.charity,
    });
  }

  return result;
}
