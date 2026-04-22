import { supabaseAdmin } from "@/lib/db/admin";

export type SubmissionPrivateData = {
  x_username: string | null;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
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
