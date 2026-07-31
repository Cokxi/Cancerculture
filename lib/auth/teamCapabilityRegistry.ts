import "server-only";

export const REGISTERED_TEAM_CAPABILITY_KEYS = Object.freeze([
  "submissions.submission_phase.moderate",
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
  "users.flag",
  "users.flag.create",
  "users.flag.view",
  "users.flag.review",
  "users.directory.basic.view",
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
      "Create a new auditable user flag case for a known user when no other open case exists.",
    category: "User Moderation",
    includedActions: [
      "Create a new auditable user flag case for a known user.",
    ],
    excludedActions: [
      "Viewing flagged-user lists or history.",
      "Reviewing or closing flag cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "bf758cdf0fa93e88b27a40582916efbea56d5d25d708d02f9889ed3a3cbe5dbf",
  }),
  "users.flag.view": defineCapability({
    key: "users.flag.view",
    displayName: "View User Flag Cases",
    description:
      "View flagged-user lists, case details, and complete user flag history without changing case state.",
    category: "User Moderation",
    includedActions: [
      "View flagged-user lists, case details, and complete user flag history.",
    ],
    excludedActions: [
      "Creating flag cases.",
      "Reviewing or closing flag cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "8cbde5054432fc6630bbec66c68ce98393f6c37744eb8452b28ea67dfdbc431c",
  }),
  "users.flag.review": defineCapability({
    key: "users.flag.review",
    displayName: "Review User Flag Cases",
    description:
      "Load a specifically addressed user flag case and resolve or dismiss it without general list access.",
    category: "User Moderation",
    includedActions: [
      "Load and review a specifically addressed user flag case.",
      "Resolve or dismiss an open user flag case.",
    ],
    excludedActions: [
      "General flagged-user lists or free history searches.",
      "Creating flag cases.",
      "Website bans or other sanctions.",
    ],
    riskLevel: "high",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "d43a7db86453e3432b04b65bad4cb7b01555c77f18cd4c26bd58a626d5508dbe",
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
