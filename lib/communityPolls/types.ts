export const COMMUNITY_POLL_DURATIONS = [24, 48, 72, 168] as const;

export type CommunityPollDurationHours =
  (typeof COMMUNITY_POLL_DURATIONS)[number];

export type CommunityPollOption = Readonly<{
  publicId: string;
  label: string;
  displayOrder: number;
  voteCount?: number;
  percentage?: number;
}>;

export type CommunityPoll = Readonly<{
  publicId: string;
  status: "draft" | "active" | "closed" | "aborted" | "replaced";
  rowVersion: number;
  question: string;
  context: string;
  durationHours: CommunityPollDurationHours;
  createdAt: string;
  activatedAt?: string;
  deadlineAt?: string;
  closedAt?: string;
  outcome?: "winner" | "runoff" | "no_result" | "aborted" | "replaced";
  rootPollPublicId?: string;
  parentPollPublicId?: string;
  replacementPollPublicId?: string;
  winningOptionPublicId?: string;
  participated: boolean;
  resultsVisible: boolean;
  votingOpen: boolean;
  totalVotes?: number;
  lastUpdatedAt?: string;
  options: readonly CommunityPollOption[];
}>;

export type CommunityPollIndex = Readonly<{
  serverNow: string;
  activePolls: readonly CommunityPoll[];
  historyPolls: readonly CommunityPoll[];
}>;

export type CommunityPollAdminEvent = Readonly<{
  eventId: number;
  pollPublicId: string;
  eventType:
    | "created"
    | "activated"
    | "announced"
    | "closed"
    | "aborted"
    | "replaced"
    | "replacement_created"
    | "runoff_created";
  actorDiscordUserId: string;
  actorRole: string;
  pollVersion: number;
  details: Readonly<Record<string, unknown>>;
  occurredAt: string;
}>;

export type CommunityPollAnnouncementState = Readonly<{
  pollPublicId: string;
  announcedAt: string;
}>;

export type CommunityPollManagement = Readonly<{
  serverNow: string;
  actorRole: string;
  polls: readonly CommunityPoll[];
  events: readonly CommunityPollAdminEvent[];
  announcements: readonly CommunityPollAnnouncementState[];
}>;

export type CurrentCommunityPollAnnouncement = Readonly<{
  pollPublicId: string;
  question: string;
  deadlineAt: string;
}>;
