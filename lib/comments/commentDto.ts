export const COMMUNITY_COMMENT_PUBLIC_KEYS = [
  "author",
  "body",
  "createdAt",
  "edited",
  "editedAt",
  "mentions",
  "publicCommentId",
  "replyCount",
  "replyTargetPublicCommentId",
  "rootPublicCommentId",
  "submissionId",
  "tombstone",
  "version",
  "voteCounts",
] as const;

const AUTHOR_KEYS = [
  "displayName",
  "isBanned",
  "isCreator",
  "publicProfileId",
] as const;
const MENTION_KEYS = [
  "displayName",
  "endIndex",
  "startIndex",
  "targetPublicProfileId",
] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type CommunityCommentPublicDto = {
  publicCommentId: string;
  submissionId: number;
  rootPublicCommentId: string | null;
  replyTargetPublicCommentId: string | null;
  version: number;
  createdAt: string;
  edited: boolean;
  editedAt: string | null;
  tombstone: "author_deleted" | "team_removed" | null;
  body: string | null;
  author: {
    publicProfileId: string;
    displayName: string;
    isCreator: boolean;
    isBanned: boolean;
  };
  mentions: Array<{
    targetPublicProfileId: string;
    displayName: string;
    startIndex: number;
    endIndex: number;
  }>;
  replyCount: number;
  voteCounts: { up: number; down: number } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
}

function isUuidOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID_PATTERN.test(value));
}

function isTimestampOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && !Number.isNaN(new Date(value).getTime()))
  );
}

function invalid(): never {
  throw new Error("COMMUNITY_COMMENT_PUBLIC_DTO_INVALID");
}

export function parseCommunityCommentPublicDto(
  value: unknown
): CommunityCommentPublicDto {
  if (!isRecord(value) || !hasExactKeys(value, COMMUNITY_COMMENT_PUBLIC_KEYS)) {
    return invalid();
  }
  if (!isRecord(value.author) || !hasExactKeys(value.author, AUTHOR_KEYS)) {
    return invalid();
  }
  if (
    typeof value.publicCommentId !== "string" ||
    !UUID_PATTERN.test(value.publicCommentId) ||
    !Number.isSafeInteger(value.submissionId) ||
    (value.submissionId as number) <= 0 ||
    !isUuidOrNull(value.rootPublicCommentId) ||
    !isUuidOrNull(value.replyTargetPublicCommentId) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) <= 0 ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(new Date(value.createdAt).getTime()) ||
    typeof value.edited !== "boolean" ||
    !isTimestampOrNull(value.editedAt) ||
    !(
      value.tombstone === null ||
      value.tombstone === "author_deleted" ||
      value.tombstone === "team_removed"
    ) ||
    !(value.body === null || typeof value.body === "string") ||
    !Number.isSafeInteger(value.replyCount) ||
    (value.replyCount as number) < 0 ||
    !(
      value.voteCounts === null ||
      (isRecord(value.voteCounts) &&
        hasExactKeys(value.voteCounts, ["down", "up"]) &&
        Number.isSafeInteger(value.voteCounts.up) &&
        Number(value.voteCounts.up) >= 0 &&
        Number.isSafeInteger(value.voteCounts.down) &&
        Number(value.voteCounts.down) >= 0)
    ) ||
    typeof value.author.publicProfileId !== "string" ||
    !UUID_PATTERN.test(value.author.publicProfileId) ||
    typeof value.author.displayName !== "string" ||
    !value.author.displayName.trim() ||
    typeof value.author.isCreator !== "boolean" ||
    typeof value.author.isBanned !== "boolean" ||
    !Array.isArray(value.mentions)
  ) {
    return invalid();
  }

  for (const mention of value.mentions) {
    if (
      !isRecord(mention) ||
      !hasExactKeys(mention, MENTION_KEYS) ||
      typeof mention.targetPublicProfileId !== "string" ||
      !UUID_PATTERN.test(mention.targetPublicProfileId) ||
      typeof mention.displayName !== "string" ||
      !mention.displayName.trim() ||
      !Number.isSafeInteger(mention.startIndex) ||
      !Number.isSafeInteger(mention.endIndex) ||
      (mention.startIndex as number) < 0 ||
      (mention.endIndex as number) <= (mention.startIndex as number)
    ) {
      return invalid();
    }
  }

  if (
    value.tombstone !== null &&
    (value.body !== null || value.mentions.length !== 0 || value.voteCounts !== null)
  ) {
    return invalid();
  }
  if (value.tombstone === null && typeof value.body !== "string") {
    return invalid();
  }
  if (value.tombstone === null && value.voteCounts === null) {
    return invalid();
  }

  return value as CommunityCommentPublicDto;
}
