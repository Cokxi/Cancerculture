import "server-only";

export const REGISTERED_TEAM_CAPABILITY_KEYS = Object.freeze([
  "submissions.submission_phase.moderate",
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
  "users.flag",
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
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "89d9d8794cc2a15772f869cf6670802b89afd00b8adafbbd1229db1d6d29f116",
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
    lifecycle: "staged",
    assignableToNonAdmin: false,
    implementationVersion: 1,
    definitionHash:
      "c1353c1e75a0c9db90d798677deebd61f0a350e8c731fdc1ab2288f3da967cc0",
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
    lifecycle: "staged",
    assignableToNonAdmin: false,
    implementationVersion: 1,
    definitionHash:
      "a6c71a89139e91598e94ef77bd3951fd07f06d45ce76d7af0e2dd537c37ef889",
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
    lifecycle: "staged",
    assignableToNonAdmin: false,
    implementationVersion: 1,
    definitionHash:
      "0a502187ae8a63f322119c19f8c880bc745902e110afae1b8d4a46388b8f3275",
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
    lifecycle: "staged",
    assignableToNonAdmin: false,
    implementationVersion: 1,
    definitionHash:
      "01733447007f7df2532c87a9ecd19042a1d02a687123cebd4bf57f2a7df976fe",
  }),
  "users.flag": defineCapability({
    key: "users.flag",
    displayName: "Flag Users",
    description: "Internally flag a user for later review.",
    category: "User Moderation",
    includedActions: [
      "Internally mark a user for later review.",
    ],
    excludedActions: [
      "Read flag details for other users.",
      "Review or resolve flags.",
      "Manage website bans.",
      "Apply any other sanction.",
    ],
    riskLevel: "moderate",
    lifecycle: "active",
    assignableToNonAdmin: true,
    implementationVersion: 1,
    definitionHash:
      "802eb6c05cdeb7721a068262675b740f3208609eb0355632da09f607f5ec676b",
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
