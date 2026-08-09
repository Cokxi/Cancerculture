import "server-only";

export const REGISTERED_TEAM_CAPABILITY_KEYS = Object.freeze([
  "submissions.submission_phase.moderate",
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
  "submissions.reports.view",
  "submissions.reports.review",
  "submissions.reports.live.view",
  "submissions.reports.finalized.view",
  "submissions.reports.assign",
  "users.flag",
  "users.flag.create",
  "users.flag.view",
  "users.flag.review",
  "users.directory.basic.view",
  "users.directory.full.view",
  "users.disqualified_submissions.view",
  "users.upload_blocks.view",
  "users.website_bans.view",
  "users.website_bans.create",
  "users.website_bans.revoke",
  "logs.website_bans.view",
  "logs.uploads.view",
  "logs.avatar_uploads.view",
  "logs.votes.view",
  "logs.vote_refunds.view",
  "logs.submission_moderation.view",
  "logs.submission_reporters.view",
  "logs.submission_report_moderation.view",
  "logs.team_authorization.view",
  "cycles.logs.view",
  "cycles.manage",
  "votes.refund_disqualified",
  "rules.manage",
  "faq.manage",
  "homepage_content.manage",
  "sponsorships.reports.view",
  "winners.payouts.view",
] as const);

export type RegisteredTeamCapabilityKey =
  (typeof REGISTERED_TEAM_CAPABILITY_KEYS)[number];

export type TeamCapabilityRiskLevel =
  | "low"
  | "moderate"
  | "high"
  | "critical";

export const TEAM_CAPABILITY_LIFECYCLES = Object.freeze([
  "active",
  "staged",
  "deprecated",
] as const);

export type TeamCapabilityLifecycle =
  (typeof TEAM_CAPABILITY_LIFECYCLES)[number];

export type TeamCapabilityDefinition = Readonly<{
  key: RegisteredTeamCapabilityKey;
  displayName: string;
  description: string;
  category: string;
  includedActions: readonly string[];
  excludedActions: readonly string[];
  riskLevel: TeamCapabilityRiskLevel;
  lifecycle: TeamCapabilityLifecycle;
  assignableToNonAdmin: boolean;
  implementationVersion: number;
  definitionHash: string;
}>;

function defineCapability(
  definition: Omit<
    TeamCapabilityDefinition,
    "includedActions" | "excludedActions"
  > & {
    includedActions: readonly string[];
    excludedActions: readonly string[];
  }
): TeamCapabilityDefinition {
  return Object.freeze({
    ...definition,
    includedActions: Object.freeze([
      ...definition.includedActions,
    ]),
    excludedActions: Object.freeze([
      ...definition.excludedActions,
    ]),
  });
}

export const TEAM_CAPABILITY_REGISTRY: Readonly<
  Record<RegisteredTeamCapabilityKey, TeamCapabilityDefinition>
> = Object.freeze({
  "submissions.submission_phase.moderate": defineCapability({
    key: "submissions.submission_phase.moderate",
    displayName: "Submission Phase Moderation",
    description:
      "Moderate submissions only during the currently permitted submission phase.",
    category: "Submission Moderation",
    includedActions: [
      "Disqualify submissions during the currently allowed submission phase.",
      "Reinstate submissions during the currently allowed submission phase.",
    ],
    excludedActions: [
      "Voting-phase moderation.",
      "Vote refunds.",
      "Public visibility changes.",
      "Legal review.",
      "Finalized or archived cycles.",
    ],
    riskLevel: "high",
    lifecycle: "deprecated",
    assignableToNonAdmin: false,
    implementationVersion: 2,
    definitionHash:
      "7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b",
  }),
  "submissions.submission_phase.disqualify": defineCapability({
    key: "submissions.submission_phase.disqualify",
    displayName: "Disqualify Submission-Phase Submissions",
    description:
      "Disqualify a submission only during the currently permitted submission phase.",
    category: "Submission Moderation",
    includedActions: [
      "Disqualify a submission during the currently allowed submission phase.",
    ],
    excludedActions: [
      "Reinstating submissions.",
      "Voting-phase moderation.",
      "Vote refunds.",
      "Public visibility changes.",
      "Legal review.",
      "Finalized or archived cycles and historical repairs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "3eec3024438e68d08891e147a1d770ad812af935732b6e60a804baa6a28b1732",
  }),
  "submissions.submission_phase.reinstate": defineCapability({
    key: "submissions.submission_phase.reinstate",
    displayName: "Reinstate Submission-Phase Submissions",
    description:
      "Reinstate a previously disqualified submission only during the currently permitted submission phase under the existing moderation policy.",
    category: "Submission Moderation",
    includedActions: [
      "Reinstate a previously disqualified submission during the currently allowed submission phase.",
    ],
    excludedActions: [
      "Disqualifying submissions.",
      "Voting-phase moderation.",
      "Vote refunds.",
      "Public visibility changes.",
      "Legal review.",
      "Finalized or archived cycles and historical repairs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "7c0cfbaf53b08c43633f75c025ccf729ae3dbc9d4320c90b11117415ee304dd2",
  }),
  "submissions.voting_phase.disqualify": defineCapability({
    key: "submissions.voting_phase.disqualify",
    displayName: "Disqualify Voting-Phase Submissions",
    description:
      "Disqualify a submission only during an open voting phase.",
    category: "Submission Moderation",
    includedActions: [
      "Disqualify a submission during the open voting phase.",
    ],
    excludedActions: [
      "Reinstating submissions.",
      "Submission-phase moderation.",
      "Vote refunds.",
      "Historical result repairs.",
      "Public visibility changes.",
      "Legal review.",
    ],
    riskLevel: "critical",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "cb6ad152ee22b164b6c864f26dcaab25f10be3483bfa5b1f3a7b265c66a142de",
  }),
  "submissions.voting_phase.reinstate": defineCapability({
    key: "submissions.voting_phase.reinstate",
    displayName: "Reinstate Voting-Phase Submissions",
    description:
      "Reinstate a previously disqualified submission only during an open voting phase under the voting-phase reinstatement policy.",
    category: "Submission Moderation",
    includedActions: [
      "Reinstate a previously disqualified submission during the open voting phase.",
    ],
    excludedActions: [
      "Disqualifying submissions.",
      "Submission-phase moderation.",
      "Vote refunds.",
      "Historical result repairs.",
      "Public visibility changes.",
      "Legal review.",
    ],
    riskLevel: "critical",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "4e4f1d199d4eb008d768676796bcf8ec34c2472c90d323fecbf7b247d7a36fe0",
  }),
  "submissions.reports.view": defineCapability({
    key: "submissions.reports.view",
    displayName: "View Submission Reports (Legacy)",
    description:
      "Legacy combined Submission Report queue and reporter-history permission retained only as a deprecated tombstone.",
    category: "Submission Moderation",
    includedActions: ["No active application actions."],
    excludedActions: [
      "Viewing Live Cycle or Finalized Cycle Report queues.",
      "Viewing reporter-centered or workflow Submission Report logs.",
      "Claiming, reviewing, releasing, reassigning, or closing Report Cases.",
    ],
    riskLevel: "high",
    lifecycle: "deprecated",
    assignableToNonAdmin: false,
    implementationVersion: 2,
    definitionHash:
      "1ac94f21aa019436dfae29e33349f7640fc3ea026586cb6c159c85b85245b1e9",
  }),
  "submissions.reports.review": defineCapability({
    key: "submissions.reports.review",
    displayName: "Review Submission Report Cases",
    description:
      "Claim, voluntarily return, and close Submission Report Cases under the exact current-area View capability while Admin override release remains owner-only.",
    category: "Submission Moderation",
    includedActions: [
      "Atomically claim an unassigned Case.",
      "Return an owned Case to the open queue without a note, or close an owned Case with an allowlisted outcome and required note.",
      "Use expected status, row version, latest Report cursor, and idempotency on every workflow mutation.",
    ],
    excludedActions: [
      "Reading any Report queue or detail without the exact current-area View capability.",
      "Force-releasing another reviewer's active claim; this remains Admin-only and is not delegable.",
      "Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 3,
    definitionHash:
      "490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a",
  }),
  "submissions.reports.live.view": defineCapability({
    key: "submissions.reports.live.view",
    displayName: "View Live Cycle Submission Reports",
    description:
      "View case-centered Submission Reports for current and pre-finalization Cycles without changing workflow or moderation state.",
    category: "Submission Moderation",
    includedActions: [
      "View bounded Live Cycle Report queue and Case summaries.",
      "View minimal Report summaries and one authorized full Report detail.",
      "Receive viewer-specific unread counts only for Live Cycle Reports.",
    ],
    excludedActions: [
      "Viewing Finalized Cycle Reports or reporter-centered and workflow logs.",
      "Claiming, reviewing, releasing, reassigning, or closing Report Cases.",
      "Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "a32d78f7a26954a5465cd1f1ba05e871d0cf62e69721a7fa4cd83353562fa4fa",
  }),
  "submissions.reports.finalized.view": defineCapability({
    key: "submissions.reports.finalized.view",
    displayName: "View Finalized Cycle Submission Reports",
    description:
      "View case-centered Submission Reports for finalized Cycles and safe unavailable-state fallbacks without changing workflow or moderation state.",
    category: "Submission Moderation",
    includedActions: [
      "View bounded Finalized Cycle Report queue and Case summaries.",
      "View minimal Report summaries and one authorized full Report detail.",
      "Receive viewer-specific unread counts only for Finalized Cycle Reports.",
    ],
    excludedActions: [
      "Viewing Live Cycle Reports or reporter-centered and workflow logs.",
      "Claiming, reviewing, releasing, reassigning, or closing Report Cases.",
      "Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "878dc43e7c22ec06a968fd6c7fa069f936688ef5da82db1caf80b7bf9c462a4f",
  }),
  "submissions.reports.assign": defineCapability({
    key: "submissions.reports.assign",
    displayName: "Reassign Submission Report Cases (Legacy)",
    description:
      "Legacy direct reassignment and delegated force-release permission retained only as a deprecated tombstone.",
    category: "Submission Moderation",
    includedActions: ["No active application actions."],
    excludedActions: [
      "Directly reassigning an actively claimed Report Case.",
      "Force-releasing another reviewer's active claim; Admin-only override release uses the canonical owner context.",
      "Claiming, voluntarily returning, reviewing, or closing Report Cases.",
    ],
    riskLevel: "high",
    lifecycle: "deprecated",
    assignableToNonAdmin: false,
    implementationVersion: 2,
    definitionHash:
      "7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6",
  }),
  "users.flag": defineCapability({
    key: "users.flag",
    displayName: "Flag Users (Legacy)",
    description:
      "Legacy combined user-flag permission retained only as a deprecated tombstone.",
    category: "User Moderation",
    includedActions: ["No active application actions."],
    excludedActions: [
      "Creating user flag cases.",
      "Viewing flagged-user lists or history.",
      "Reviewing or closing user flag cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "moderate",
    lifecycle: "deprecated",
    assignableToNonAdmin: false,
    implementationVersion: 2,
    definitionHash:
      "4ec252dadafc8d9e149df225825f850fd90666e444fff4edaca43bd5d02b553c",
  }),
  "users.flag.create": defineCapability({
    key: "users.flag.create",
    displayName: "Create User Flag Cases",
    description:
      "Create a new auditable user flag case for a known user only when no open or escalated case exists.",
    category: "User Moderation",
    includedActions: [
      "Create a new auditable user flag case for a known user when no active case exists.",
      "Read only whether the selected user has an active case and its status.",
    ],
    excludedActions: [
      "Viewing flagged-user lists or history.",
      "Reviewing or closing flag cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b",
  }),
  "users.flag.view": defineCapability({
    key: "users.flag.view",
    displayName: "View User Flag Cases",
    description:
      "View active user flag cases and bounded searchable closed-case history without changing case state.",
    category: "User Moderation",
    includedActions: [
      "View open and escalated user flag cases and their details.",
      "Search bounded closed-case history by Discord ID or username.",
      "View immutable actor snapshots and complete case event history.",
    ],
    excludedActions: [
      "Creating flag cases.",
      "Reviewing or closing flag cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e",
  }),
  "users.flag.review": defineCapability({
    key: "users.flag.review",
    displayName: "Review User Flag Cases",
    description:
      "Work open user flag cases and resolve, dismiss, or escalate them without access to escalated cases or history.",
    category: "User Moderation",
    includedActions: [
      "Load a narrow worklist containing only open user flag cases.",
      "Resolve, dismiss, or escalate an open user flag case.",
    ],
    excludedActions: [
      "General flagged-user lists or free history searches.",
      "Creating flag cases.",
      "Viewing or changing escalated cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869",
  }),
  "users.directory.basic.view": defineCapability({
    key: "users.directory.basic.view",
    displayName: "View Basic User Directory",
    description:
      "View the minimal redacted user directory used for selection and flagging.",
    category: "User Moderation",
    includedActions: [
      "View the minimal redacted user list used for selection and flagging.",
    ],
    excludedActions: [
      "Full user histories.",
      "Flag reasons.",
      "Ban or unban reasons.",
      "Social, session, vote, wallet, or sync data.",
    ],
    riskLevel: "low",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "5d0d0ab97601631a43f7ba87ba04d0007bf6534449774ac859f838e370cede48",
  }),
  "users.directory.full.view": defineCapability({
    key: "users.directory.full.view",
    displayName: "View Full User Directory",
    description:
      "View the extended user directory with identity history, activity timestamps, and aggregate participation statistics.",
    category: "User Moderation",
    includedActions: [
      "View current and known Discord names.",
      "View first-seen and last-seen timestamps.",
      "View aggregate submission and username-change statistics.",
      "Open the user's recent non-disqualified submission list without per-submission vote totals.",
    ],
    excludedActions: [
      "Viewing website-ban reasons or history.",
      "Creating or revoking website bans.",
      "Viewing flag reasons or flag history.",
      "Viewing vote, wallet, session, or infrastructure data.",
      "Viewing disqualified submission history or per-submission vote totals.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1",
  }),
  "users.disqualified_submissions.view": defineCapability({
    key: "users.disqualified_submissions.view",
    displayName: "View User Disqualification History",
    description:
      "View a redacted profile-oriented history of current and reinstated submission disqualifications without gaining moderation powers.",
    category: "User Moderation",
    includedActions: [
      "View current and reinstated submission disqualifications grouped by user and submission.",
      "View cycle, transition status, timestamps, broad reason category, and a safe thumbnail or destination when separately permitted.",
      "View the minimal current user identity needed to select and understand the affected profile.",
    ],
    excludedActions: [
      "Disqualifying, reinstating, hiding, restoring, exporting, or otherwise changing submissions.",
      "Viewing delegated free-text notes, exact reason codes, actor identities, evidence, object keys, request data, or before/after snapshots.",
      "Viewing votes, refund details, identity history, ban history, flag history, or unrelated logs.",
      "Publishing disqualification history on public profiles or exposing it to another ordinary user.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "0519db20cffc9d57d6feb8e54dca7633711cbebec26754ad986aac10685ce839",
  }),
  "users.upload_blocks.view": defineCapability({
    key: "users.upload_blocks.view",
    displayName: "View Cycle Upload Blocks",
    description:
      "View cycle-scoped automatic upload-abuse blocks and their bounded counters without changing them.",
    category: "User Moderation",
    includedActions: [
      "View cycle-scoped invalid-upload counters and active automatic blocks.",
      "View when a block was triggered and the last bounded error category.",
    ],
    excludedActions: [
      "Manually unblocking a user during the current cycle.",
      "Changing abuse thresholds or detection rules.",
      "Viewing raw network or infrastructure data.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "174c20de72228105c16c01b98a9da10f232ecdbe2f9e6c1f0b309a1c37479204",
  }),
  "users.website_bans.view": defineCapability({
    key: "users.website_bans.view",
    displayName: "View Active Website Bans",
    description:
      "View active website bans and their current moderation context without changing ban state.",
    category: "User Moderation",
    includedActions: [
      "View actively website-banned users.",
      "View the current ban reason, source, actor, and timestamp.",
    ],
    excludedActions: [
      "Creating or revoking website bans.",
      "Viewing the complete historical website-ban event log.",
      "Discord bans or team-member administration.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "4e8d362ef56b5f101e66ac6d3db552f505ecf6c4580dbefe36f397d4571e7388",
  }),
  "users.website_bans.create": defineCapability({
    key: "users.website_bans.create",
    displayName: "Create Website Bans",
    description:
      "Create an auditable website ban for a known non-team user with a required reason.",
    category: "User Moderation",
    includedActions: [
      "Create a website ban for a known user who is not a team member.",
      "Read only whether the selected user currently has an active website ban.",
    ],
    excludedActions: [
      "Revoking website bans.",
      "Banning active team members or Owner accounts.",
      "Discord bans, legal deletion, or historical data repair.",
    ],
    riskLevel: "critical",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "66118e044f0defc403ce7a63539a30156b4000bd0a05dbeeafe73a9661407470",
  }),
  "users.website_bans.revoke": defineCapability({
    key: "users.website_bans.revoke",
    displayName: "Revoke Website Bans",
    description:
      "Revoke an active website ban for a non-team user with a required auditable reason.",
    category: "User Moderation",
    includedActions: [
      "Revoke an active website ban for a user who is not a team member.",
      "Read the current website-ban state required for the action.",
    ],
    excludedActions: [
      "Creating website bans.",
      "Changing team membership or Owner access.",
      "Republishing submissions or repairing historical results.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "1a5b5dd1c07c638051dc76ea079561baff6b8204b17be017d04e186de6b09706",
  }),
  "logs.website_bans.view": defineCapability({
    key: "logs.website_bans.view",
    displayName: "View Website Ban History",
    description:
      "View the append-only website-ban and revocation event history without changing moderation state.",
    category: "Logs",
    includedActions: [
      "View immutable website-ban and revocation events.",
      "View event actors, timestamps, reasons, and state transitions.",
    ],
    excludedActions: [
      "Creating or revoking website bans.",
      "Viewing unrelated user, flag, vote, upload, or infrastructure logs.",
      "Deleting or rewriting moderation history.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "a3ce56bd99c5e3aa74ff1d863a8969b73cd23717cc9ced50a7c8c375cda743e3",
  }),
  "logs.uploads.view": defineCapability({
    key: "logs.uploads.view",
    displayName: "View Upload Logs",
    description:
      "View redacted submission-upload outcomes and their user, cycle, submission, and timestamp context.",
    category: "Logs",
    includedActions: [
      "View recent submission-upload success and failure outcomes.",
      "View the associated user, cycle, submission reference, timestamp, and redacted outcome category.",
    ],
    excludedActions: [
      "Viewing raw provider, storage, infrastructure, or internal error details.",
      "Viewing upload-abuse counters, thresholds, or manual unblock actions.",
      "Viewing avatar, vote, social, moderation, or other unrelated logs.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "3968acde89ace9d541824c1e010573c0d5b3be4b30f6b75b8e5a3dd543ad2a2b",
  }),
  "logs.avatar_uploads.view": defineCapability({
    key: "logs.avatar_uploads.view",
    displayName: "View Avatar Upload Logs",
    description:
      "View redacted avatar-upload outcomes and their user and timestamp context without storage details.",
    category: "Logs",
    includedActions: [
      "View recent avatar-upload success and failure outcomes.",
      "View the associated user, timestamp, and redacted outcome category.",
    ],
    excludedActions: [
      "Viewing raw provider, storage, infrastructure, or internal error details and avatar object keys.",
      "Changing avatars, cooldowns, upload protections, or user profile state.",
      "Viewing submission-upload, vote, social, moderation, or other unrelated logs.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "d9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813",
  }),
  "logs.votes.view": defineCapability({
    key: "logs.votes.view",
    displayName: "View Vote Logs",
    description:
      "View redacted individual vote outcomes and their user, cycle, submission, and timestamp context.",
    category: "Logs",
    includedActions: [
      "View recent accepted and rejected individual vote outcomes.",
      "View the associated user, cycle, submission reference, timestamp, and redacted outcome category.",
    ],
    excludedActions: [
      "Viewing raw internal policy, database, provider, or infrastructure error details.",
      "Viewing vote-cluster, network, device, abuse-detection, or hidden aggregate signals.",
      "Casting, changing, refunding, or moderating votes and viewing unrelated logs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "991f2ef3ae5b454d3b1fec1c8fbc15ed64f845049553c6ba1cd07fe3bc0c09da",
  }),
  "logs.vote_refunds.view": defineCapability({
    key: "logs.vote_refunds.view",
    displayName: "View Vote Refund History",
    description:
      "View the redacted append-only history of successful manual vote refunds, with individual refunded voters available only when Vote Logs access is also granted.",
    category: "Logs",
    includedActions: [
      "View successful manual vote refunds grouped by cycle attempt and submission.",
      "View each refunded submission's current thumbnail when available, submitter, refund actor, refunded vote count, broad reason category, and timestamp.",
      "View individual refunded voter identities only together with the separate View Vote Logs capability.",
    ],
    excludedActions: [
      "Executing vote refunds or changing submissions, cycles, or votes.",
      "Viewing individual refunded voters without the separate View Vote Logs capability.",
      "Viewing free-text audit notes unless the caller is Owner.",
      "Viewing original vote identifiers or timestamps, request hashes, idempotency data, or raw payloads.",
      "Viewing vote-attempt, cluster, network, device, abuse-detection, observation, or unrelated logs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 2,
    definitionHash:
      "f3e1102733e29e8338b95f831e89f9f09f7f7af70ce4dfcfce51cba450c358b2",
  }),
  "logs.submission_moderation.view": defineCapability({
    key: "logs.submission_moderation.view",
    displayName: "View Submission Moderation Logs",
    description:
      "View redacted submission-moderation actions and their actor, affected user, cycle, submission, and timestamp context.",
    category: "Logs",
    includedActions: [
      "View recent submission disqualification, reinstatement, legal-review, removal, and visibility-restoration actions.",
      "View the associated actor and affected user identities, cycle, submission reference, timestamp, and broad redacted reason category.",
    ],
    excludedActions: [
      "Viewing free-text moderation notes, exact reason codes, evidence, object keys, idempotency details, internal capability names, or before/after state snapshots.",
      "Disqualifying, reinstating, hiding, restoring, exporting, or otherwise changing submissions.",
      "Viewing flag, user, upload, vote, social-verification, website-ban, or other unrelated logs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "fc820ff4bea36171834588856c8f1ca09f0b0391d0b04ff6c0521fffa85d88e7",
  }),
  "logs.submission_reporters.view": defineCapability({
    key: "logs.submission_reporters.view",
    displayName: "View Submission Reporter User Logs",
    description:
      "View reporter-centered Submission Report history as neutral human-review context without a reporter score or workflow access.",
    category: "Submission Report Logs",
    includedActions: [
      "View a reporter-centered list and bounded Submission Report history.",
      "View neutral counts of Reports in Cases closed with action without attributing causality.",
    ],
    excludedActions: [
      "Viewing Live or Finalized Case queues, full Case workflow history, or unread badges.",
      "Claiming, reviewing, releasing, reassigning, or closing Report Cases.",
      "Viewing unrelated User Directory, moderation, vote, security, or infrastructure data.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846",
  }),
  "logs.submission_report_moderation.view": defineCapability({
    key: "logs.submission_report_moderation.view",
    displayName: "View Submission Report Moderation Logs",
    description:
      "View the append-only Submission Report workflow audit with server-side redaction and no Report free text.",
    category: "Submission Report Logs",
    includedActions: [
      "View allowlisted Case, Cycle, Submission, workflow event, outcome, actor display, role, and timestamp fields.",
      "View claim, release, recovery, reassignment, close, and Report-caused reopen history.",
    ],
    excludedActions: [
      "Viewing reporter comments, raw evidence, stable delegated actor identifiers, or security signals.",
      "Viewing Live or Finalized Case queues or reporter-centered User Logs.",
      "Claiming, reviewing, releasing, reassigning, closing, or performing underlying moderation actions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7",
  }),
  "logs.team_authorization.view": defineCapability({
    key: "logs.team_authorization.view",
    displayName: "View Team Authorization History",
    description:
      "View separately paginated team-membership and Roles & Permissions authorization events through a safe read-only projection.",
    category: "Logs",
    includedActions: [
      "View team enrollment, removal, role-assignment, and Owner-access changes with actor, target, timestamp, role-transition, and reason context.",
      "View role lifecycle and capability grant or revocation events with actor, affected role, capability, timestamp, and reason context.",
    ],
    excludedActions: [
      "Viewing raw before/after objects, request or idempotency data, row versions, batch identifiers, or other internal enforcement details.",
      "Adding or removing team members, changing team or Owner assignments, or managing role definitions and lifecycle.",
      "Viewing or changing the Roles & Permissions matrix, granting or revoking capabilities, or viewing unrelated logs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "69faf8e792eb9ee98366d3be382d6020ba46994b514c07c3ab2e970c716be1ba",
  }),
  "cycles.logs.view": defineCapability({
    key: "cycles.logs.view",
    displayName: "View Cycle Logs",
    description:
      "View paginated cycle start, finalization, and reset events through a safe read-only projection.",
    category: "Cycles",
    includedActions: [
      "View cycle start, finalization, and reset events with their cycle, current theme, actor, and timestamp context.",
      "Navigate the bounded server-paginated Cycle Logs history.",
    ],
    excludedActions: [
      "Viewing raw audit metadata, free-text reset reasons, sponsor data, storage cleanup details, scheduler data, or other infrastructure context.",
      "Starting, ending, finalizing, resetting, scheduling, or otherwise changing cycles, phases, themes, or settings.",
      "Managing winners, payouts, sponsors, submissions, or unrelated logs.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "915c24cf6a167040c8637e59ca27a28510c6299b2ea417ae770f86e992924beb",
  }),
  "cycles.manage": defineCapability({
    key: "cycles.manage",
    displayName: "Manage Cycles",
    description:
      "Operate the current cycle through hardened start, scheduling, phase, sponsorship, end-review, finalization, pause, and reset workflows.",
    category: "Cycles",
    includedActions: [
      "Create or reuse a clean draft and start normal or sponsored cycles.",
      "Set or clear current-phase timers, configure votes per user, pause or resume, and advance submission or voting phases.",
      "Perform exceptional submission disqualification or reinstatement after voting closes and before finalization.",
      "Finalize or reset the current cycle through confirmed auditable workflows.",
      "Manage the current and next cycle theme plus the sponsored-cycle draft.",
    ],
    excludedActions: [
      "Viewing Cycle Logs or unrelated logs without their separate capabilities.",
      "Managing roles, permissions, team membership, Owner access, or other administrative domains.",
      "Managing winner payouts, refunding votes, editing individual votes, repairing finalized history, or moderating open phases without their separate capabilities.",
      "Accessing raw secrets, storage credentials, scheduler credentials, or arbitrary media-cleanup work.",
    ],
    riskLevel: "critical",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710",
  }),
  "votes.refund_disqualified": defineCapability({
    key: "votes.refund_disqualified",
    displayName: "Refund Disqualified Submission Votes",
    description:
      "Selectively refund canonical votes from explicitly selected disqualified submissions only during the current open voting phase.",
    category: "Vote Moderation",
    includedActions: [
      "View current-voting disqualified submissions and the refundable vote counts required for this action.",
      "Select one or more disqualified submissions and atomically refund only their current canonical votes.",
      "Return one available vote slot per refunded vote under the cycle's unchanged votes-per-user setting.",
    ],
    excludedActions: [
      "Automatically refunding votes when a submission is disqualified or refunding every disqualified submission without explicit selection.",
      "Disqualifying or reinstating submissions, restoring refunded votes, changing vote limits, editing votes, or repairing historical cycles.",
      "Refunding eligible submissions or acting during paused, closed, finalizing, finished, draft, or historical cycle states.",
      "Viewing refund history, individual voter identities, raw vote logs, observation details, or abuse-detection signals.",
    ],
    riskLevel: "critical",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "bd49530c7905d71661f47b343ca8de9251d47c6c7712e84494563075ba8e68ab",
  }),
  "rules.manage": defineCapability({
    key: "rules.manage",
    displayName: "Manage Rules",
    description:
      "Create and edit the Rules draft, preview the pending revision, and publish validated Rules with an explicit material-change decision that atomically controls Rules acceptance.",
    category: "Content",
    includedActions: [
      "View the current published Rules and any pending draft in the Content area.",
      "Save validated ordered Rules sections as a versioned draft with optimistic concurrency.",
      "Publish the current draft and explicitly classify text-only changes as material or non-material.",
      "Automatically require a new Rules acceptance version when sections are added or removed.",
    ],
    excludedActions: [
      "Managing FAQ, Homepage Info Boxes, Coin Launch Links, or other content.",
      "Changing user acceptance records directly or bypassing rules_meta.",
      "Managing roles, permissions, team membership, or Owner access.",
      "Deleting or rewriting Rules revision, request, or publication history.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "d7097dece0897ddcd924010a9a8cd48f427512231eaf7da77a28005536720887",
  }),
  "faq.manage": defineCapability({
    key: "faq.manage",
    displayName: "Manage FAQ",
    description:
      "Edit FAQ content locally, preview the exact safe public rendering, and atomically save and publish one validated immutable revision.",
    category: "Content",
    includedActions: [
      "View the current published FAQ in the Content area.",
      "Edit ordered FAQ sections in browser-local state and preview them without creating a server draft.",
      "Atomically save and publish one validated immutable revision with optimistic concurrency and idempotency.",
      "Invalidate the public FAQ cache after a successful publication.",
    ],
    excludedActions: [
      "Creating or retaining a stored FAQ draft or a separate publish step.",
      "Managing Rules, Rules acceptance, rules_meta, Homepage Info Boxes, Coin Launch Links, or other content.",
      "Managing roles, permissions, team membership, or Owner access.",
      "Deleting or rewriting FAQ revision, request, publication, or audit history.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93",
  }),
  "homepage_content.manage": defineCapability({
    key: "homepage_content.manage",
    displayName: "Manage Homepage Info Boxes",
    description:
      "Create, edit, activate, deactivate, reorder, preview, and permanently delete the validated public Homepage Info Boxes.",
    category: "Content",
    includedActions: [
      "View all active and inactive Homepage Info Boxes, stored actor identifiers, and timestamps in the Content area.",
      "Create and edit validated titles, body text, display order, and optional internal or HTTPS links.",
      "Activate or deactivate boxes and preview the active public ordering.",
      "Permanently delete a box after explicit confirmation and invalidate the public Homepage cache after every successful mutation.",
    ],
    excludedActions: [
      "Managing Rules, FAQ, Coin Launch Links, or any other Homepage content.",
      "Using non-HTTPS external links, embedded credentials, unsafe rendering, or bypassing content validation.",
      "Managing roles, permissions, team membership, or Owner access.",
      "Viewing unrelated logs or mutating unrelated public content, cycles, users, submissions, sponsorships, or payouts.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "b9f5db882c8fa65f235ef2fe83f1cc90515761e21ea885e4ca80e58b2476957a",
  }),
  "sponsorships.reports.view": defineCapability({
    key: "sponsorships.reports.view",
    displayName: "View Sponsor Reports",
    description:
      "Review cycle sponsorship details and aggregate engagement reports, including a redacted JSON export.",
    category: "Sponsoring",
    includedActions: [
      "View sponsor name, linked website, cycle, active state, and sponsorship timing.",
      "View aggregate impressions, clicks, unique counts, click-through rate, and per-surface totals.",
      "Download the same report as a redacted JSON export.",
    ],
    excludedActions: [
      "Viewing raw viewer hashes, cookies, pseudonymous identifiers, or individual tracking events.",
      "Viewing banner storage keys, credentials, secrets, or infrastructure details.",
      "Creating or changing sponsor drafts, planned sponsorships, contacts, commercial terms, banners, links, or cycles.",
      "Viewing unrelated logs, winner payouts, or private user data.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "421c31be87cac7864a7fb6fad229e614befed4d38374f0fc05e285ffaa24d655",
  }),
  "winners.payouts.view": defineCapability({
    key: "winners.payouts.view",
    displayName: "View Winner Payouts",
    description:
      "Review finalized winner identities, prize shares, payout choices, charities, and required payout wallet addresses without changing payouts.",
    category: "Winner & Payouts",
    includedActions: [
      "View finalized winners grouped by cycle with theme, submission, identity, votes, and prize share.",
      "View payout choice, charity or split details, and wallet addresses only where a winner keeps part of the prize.",
      "Copy an existing payout wallet address exactly through the protected view.",
    ],
    excludedActions: [
      "Initiating, confirming, marking, changing, retrying, or otherwise managing payouts.",
      "Editing winners, rankings, votes, refunds, disqualifications, or finalized cycle history.",
      "Viewing non-winner private submission data, unrelated wallets, secrets, or infrastructure details.",
      "Viewing sponsor reports, unrelated logs, or managing team roles and permissions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "d482f10a0e15ea2f166f633e7cf8a27760987ea748fddc4b5c34aa6abde978e9",
  }),
});

export const ACTIVE_TEAM_CAPABILITY_KEYS = Object.freeze(
  REGISTERED_TEAM_CAPABILITY_KEYS.filter(
    (key) => TEAM_CAPABILITY_REGISTRY[key].lifecycle === "active"
  )
);

export function isRegisteredTeamCapabilityKey(
  value: unknown
): value is RegisteredTeamCapabilityKey {
  return (
    typeof value === "string" &&
    Object.hasOwn(TEAM_CAPABILITY_REGISTRY, value)
  );
}

export function getRegisteredTeamCapability(
  value: unknown
): TeamCapabilityDefinition | null {
  return isRegisteredTeamCapabilityKey(value)
    ? TEAM_CAPABILITY_REGISTRY[value]
    : null;
}
