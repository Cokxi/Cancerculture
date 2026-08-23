export const COMMUNITY_COMMENT_MAX_CHARACTERS = 10_000;
export const COMMUNITY_COMMENT_MAX_UTF8_BYTES = 40_000;
export const COMMUNITY_COMMENT_MAX_MENTION_OCCURRENCES = 100;

const PUBLIC_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOGNIZABLE_LINK_PATTERN =
  /(?:https?|ftp):\/\/[^\s<>()]+|www\.[^\s<>()]+|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62})\.)+(?:\p{L}{2,63})(?:\/[^\s<>()]*)?/giu;
const ACTIVE_SCHEME_PATTERN = /\b(?:data|javascript|mailto):/iu;
const ALLOWED_INTERNAL_PATH_PATTERN =
  /^\/(?:spread\/\d+|cycle-history|wall\/(?:fame|shame)|profile\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[?#][^\s<>()]*)?$/u;

export type CommunityCommentMentionInput = {
  targetPublicProfileId: string;
  startIndex: number;
  endIndex: number;
};

export class CommunityCommentTextError extends Error {
  public readonly code:
    | "TEXT_EMPTY"
    | "TEXT_TOO_LONG"
    | "TEXT_TOO_LARGE"
    | "EXTERNAL_LINK_REJECTED"
    | "MENTIONS_INVALID"
    | "MENTION_ONLY_REJECTED";

  constructor(
    code:
      | "TEXT_EMPTY"
      | "TEXT_TOO_LONG"
      | "TEXT_TOO_LARGE"
      | "EXTERNAL_LINK_REJECTED"
      | "MENTIONS_INVALID"
      | "MENTION_ONLY_REJECTED"
  ) {
    super(code);
    this.code = code;
    this.name = "CommunityCommentTextError";
  }
}

function isUnsafeControl(codePoint: number) {
  return (
    (codePoint >= 0 && codePoint <= 0x1f && codePoint !== 0x0a) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

export function normalizeCommunityCommentText(raw: string) {
  if (typeof raw !== "string") {
    throw new CommunityCommentTextError("TEXT_EMPTY");
  }

  const lineNormalized = raw.replace(/\r\n?/gu, "\n").normalize("NFC");
  let safe = "";
  for (const character of lineNormalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && !isUnsafeControl(codePoint)) {
      safe += character;
    }
  }

  const normalized = safe
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .replace(/\n{4,}/gu, "\n\n\n");

  if (!normalized) {
    throw new CommunityCommentTextError("TEXT_EMPTY");
  }
  if (Array.from(normalized).length > COMMUNITY_COMMENT_MAX_CHARACTERS) {
    throw new CommunityCommentTextError("TEXT_TOO_LONG");
  }
  if (
    new TextEncoder().encode(normalized).byteLength >
    COMMUNITY_COMMENT_MAX_UTF8_BYTES
  ) {
    throw new CommunityCommentTextError("TEXT_TOO_LARGE");
  }

  return normalized;
}

function stripTrailingSentencePunctuation(value: string) {
  return value.replace(/[.,!?;:]+$/gu, "");
}

export function isAllowlistedCommunityCommentInternalLink(value: string) {
  let parsed = value;
  if (value.startsWith("https://cancerculture.fun/")) {
    parsed = value.slice("https://cancerculture.fun".length);
  }
  return ALLOWED_INTERNAL_PATH_PATTERN.test(parsed);
}

export function assertCommunityCommentLinksAllowed(body: string) {
  if (ACTIVE_SCHEME_PATTERN.test(body)) {
    throw new CommunityCommentTextError("EXTERNAL_LINK_REJECTED");
  }

  for (const match of body.matchAll(RECOGNIZABLE_LINK_PATTERN)) {
    const candidate = stripTrailingSentencePunctuation(match[0]);
    if (!isAllowlistedCommunityCommentInternalLink(candidate)) {
      throw new CommunityCommentTextError("EXTERNAL_LINK_REJECTED");
    }
  }
}

function hasExactMentionKeys(value: Record<string, unknown>) {
  const keys = Object.keys(value).sort();
  return (
    keys.length === 3 &&
    keys[0] === "endIndex" &&
    keys[1] === "startIndex" &&
    keys[2] === "targetPublicProfileId"
  );
}

export function normalizeCommunityCommentMentions(
  body: string,
  input: unknown
): CommunityCommentMentionInput[] {
  if (
    !Array.isArray(input) ||
    input.length > COMMUNITY_COMMENT_MAX_MENTION_OCCURRENCES
  ) {
    throw new CommunityCommentTextError("MENTIONS_INVALID");
  }

  const characters = Array.from(body);
  const mentions = input.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !hasExactMentionKeys(candidate as Record<string, unknown>)
    ) {
      throw new CommunityCommentTextError("MENTIONS_INVALID");
    }

    const value = candidate as Record<string, unknown>;
    if (
      typeof value.targetPublicProfileId !== "string" ||
      !PUBLIC_PROFILE_ID_PATTERN.test(value.targetPublicProfileId) ||
      !Number.isSafeInteger(value.startIndex) ||
      !Number.isSafeInteger(value.endIndex)
    ) {
      throw new CommunityCommentTextError("MENTIONS_INVALID");
    }

    const startIndex = value.startIndex as number;
    const endIndex = value.endIndex as number;
    if (
      startIndex < 0 ||
      endIndex <= startIndex ||
      endIndex > characters.length ||
      characters[startIndex] !== "@"
    ) {
      throw new CommunityCommentTextError("MENTIONS_INVALID");
    }

    return {
      targetPublicProfileId: value.targetPublicProfileId,
      startIndex,
      endIndex,
    };
  });

  mentions.sort(
    (left, right) =>
      left.startIndex - right.startIndex || left.endIndex - right.endIndex
  );

  let previousEnd = 0;
  let remainder = "";
  for (const mention of mentions) {
    if (mention.startIndex < previousEnd) {
      throw new CommunityCommentTextError("MENTIONS_INVALID");
    }
    remainder += characters.slice(previousEnd, mention.startIndex).join("");
    previousEnd = mention.endIndex;
  }
  remainder += characters.slice(previousEnd).join("");

  if (!remainder.trim()) {
    throw new CommunityCommentTextError("MENTION_ONLY_REJECTED");
  }

  return mentions;
}

export function prepareCommunityCommentText(rawBody: string, mentions: unknown) {
  const normalizedBody = normalizeCommunityCommentText(rawBody);
  const normalizedMentions = normalizeCommunityCommentMentions(
    normalizedBody,
    mentions
  );
  return { normalizedBody, normalizedMentions };
}
