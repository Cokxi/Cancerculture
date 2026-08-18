const PAYLOADS = {
  winner_claim_required: {
    title: "Winner claim required",
    body: "Review and confirm your winner claim.",
  },
  winner_correction_ready: {
    title: "Winner claim ready",
    body: "Review the full recipient and confirm your Claim within 24 hours.",
  },
  winner_donation_finalized: {
    title: "Winner result finalized",
    body: "View your finalized winner result.",
  },
  submission_disqualified: {
    title: "Submission disqualified",
    body: "View your moderation history for details.",
  },
  submission_reinstated: {
    title: "Submission restored",
    body: "View your moderation history for details.",
  },
  cycle_results_ready: {
    title: "Cycle results are ready",
    body: "View the finalized Cycle results.",
  },
  wallet_issue_received: {
    title: "Wallet issue received",
    body: "Your winning-Submission report is ready for Team review.",
  },
  wallet_issue_correction_ready: {
    title: "Wallet correction ready",
    body: "Review the full recipient and confirm your Claim within 24 hours.",
  },
  wallet_issue_resolved: {
    title: "Wallet issue resolved",
    body: "Review the current recipient and confirm your Claim within 24 hours.",
  },
} as const;

export function buildGenericPushPayload({
  eventType,
  categoryKey,
  notificationId,
}: {
  eventType: string;
  categoryKey: string;
  notificationId: string;
}) {
  const content = PAYLOADS[eventType as keyof typeof PAYLOADS];
  if (
    !content ||
    !/^[a-z][a-z0-9_]{2,63}$/u.test(categoryKey) ||
    !/^[0-9a-f-]{36}$/iu.test(notificationId)
  ) {
    throw new Error("PUSH_PAYLOAD_INVALID");
  }
  return Object.freeze({
    title: content.title,
    body: content.body,
    category: categoryKey,
    notificationId,
  });
}
