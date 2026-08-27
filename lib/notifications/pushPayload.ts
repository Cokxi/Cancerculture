export const PUSH_PAYLOAD_CATALOG = Object.freeze({
  winner_claim_required: {
    categoryKey: "winners_claims",
    title: "Winner claim required",
    body: "Review and confirm your winner claim.",
  },
  winner_correction_ready: {
    categoryKey: "winners_claims",
    title: "Winner claim ready",
    body: "Review the full recipient and confirm your Claim within 24 hours.",
  },
  winner_donation_finalized: {
    categoryKey: "winners_claims",
    title: "Winner result finalized",
    body: "View your finalized winner result.",
  },
  winner_payout_sent: {
    categoryKey: "winners_claims",
    title: "Prize sent",
    body: "Your prize payout has been recorded as sent.",
  },
  donation_recipient_change_required: {
    categoryKey: "winners_claims",
    title: "Choose another charity",
    body: "Choose another charity within 24 hours.",
  },
  submission_disqualified: {
    categoryKey: "submission_moderation",
    title: "Submission disqualified",
    body: "View your moderation history for details.",
  },
  submission_reinstated: {
    categoryKey: "submission_moderation",
    title: "Submission restored",
    body: "View your moderation history for details.",
  },
  cycle_results_ready: {
    categoryKey: "cycles_voting",
    title: "Cycle results are ready",
    body: "View the finalized Cycle results.",
  },
  cycle_started: {
    categoryKey: "cycles_voting",
    title: "A new Cycle has started",
    body: "The Submission phase is now open.",
  },
  cycle_submission_ending_15m: {
    categoryKey: "cycles_voting",
    title: "Submission phase ends in 15 minutes",
    body: "Finish your Submission before the phase closes.",
  },
  cycle_submission_ending_10m: {
    categoryKey: "cycles_voting",
    title: "Submission phase ends in 10 minutes",
    body: "Finish your Submission before the phase closes.",
  },
  cycle_submission_ending_5m: {
    categoryKey: "cycles_voting",
    title: "Submission phase ends in 5 minutes",
    body: "Finish your Submission before the phase closes.",
  },
  cycle_submission_ended: {
    categoryKey: "cycles_voting",
    title: "Submission phase ended",
    body: "The Voting phase is now open.",
  },
  cycle_voting_ending_15m: {
    categoryKey: "cycles_voting",
    title: "Voting phase ends in 15 minutes",
    body: "Cast your vote before the phase closes.",
  },
  cycle_voting_ending_10m: {
    categoryKey: "cycles_voting",
    title: "Voting phase ends in 10 minutes",
    body: "Cast your vote before the phase closes.",
  },
  cycle_voting_ending_5m: {
    categoryKey: "cycles_voting",
    title: "Voting phase ends in 5 minutes",
    body: "Cast your vote before the phase closes.",
  },
  cycle_voting_ended: {
    categoryKey: "cycles_voting",
    title: "Voting phase ended",
    body: "Voting has closed. Results will follow.",
  },
  community_vote_announced: {
    categoryKey: "community_votes",
    title: "A Community Vote is open",
    body: "Cast your vote before the poll closes.",
  },
  wallet_issue_received: {
    categoryKey: "wallet_issues",
    title: "Wallet issue received",
    body: "Your winning-Submission report is ready for Team review.",
  },
  wallet_issue_correction_ready: {
    categoryKey: "wallet_issues",
    title: "Wallet correction ready",
    body: "Review the full recipient and confirm your Claim within 24 hours.",
  },
  wallet_issue_resolved: {
    categoryKey: "wallet_issues",
    title: "Wallet issue resolved",
    body: "Review the current recipient and confirm your Claim within 24 hours.",
  },
  comment_reply: {
    categoryKey: "comment_replies",
    title: "New comment reply",
    body: "You have a new reply.",
  },
  comment_mention: {
    categoryKey: "comment_mentions",
    title: "New comment mention",
    body: "You were mentioned.",
  },
} as const);

export type PushEventType = keyof typeof PUSH_PAYLOAD_CATALOG;

const EVENT_TYPES = new Set<string>(Object.keys(PUSH_PAYLOAD_CATALOG));
const IN_PRODUCT_ONLY_EVENT_TYPES = new Set<string>([
  "user_warning_issued",
  "user_warning_overruled",
  "user_warning_appeal_upheld",
]);
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;
const NOTIFICATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isPushEventType(value: string): value is PushEventType {
  return EVENT_TYPES.has(value);
}

export function isNotificationEventType(value: string) {
  return EVENT_TYPES.has(value) || IN_PRODUCT_ONLY_EVENT_TYPES.has(value);
}

export function getServiceWorkerPushAllowlist() {
  return Object.values(PUSH_PAYLOAD_CATALOG).map((content) => Object.freeze({
    categoryKey: content.categoryKey,
    title: content.title,
    body: content.body,
  }));
}

export function buildGenericPushPayload({
  eventType,
  categoryKey,
  notificationId,
}: {
  eventType: string;
  categoryKey: string;
  notificationId: string;
}) {
  const content = isPushEventType(eventType)
    ? PUSH_PAYLOAD_CATALOG[eventType]
    : null;
  if (
    !content ||
    !CATEGORY_PATTERN.test(categoryKey) ||
    content.categoryKey !== categoryKey ||
    !NOTIFICATION_ID_PATTERN.test(notificationId)
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
