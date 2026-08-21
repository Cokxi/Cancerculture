import {
  COMMUNITY_POLL_DURATIONS,
  type CommunityPollDurationHours,
} from "@/lib/communityPolls/types";

export const COMMUNITY_POLL_LIMITS = Object.freeze({
  questionMin: 10,
  questionMax: 300,
  contextMax: 3000,
  optionMin: 1,
  optionMax: 160,
  optionsMin: 2,
  optionsMax: 8,
  reasonMin: 10,
  reasonMax: 500,
});

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function text(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\r\n?/gu, "\n").trim()
    : "";
}

export function requireUuid(value: unknown, field: string) {
  const normalized = text(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

export function requirePositiveVersion(value: unknown) {
  const version = typeof value === "number" ? value : Number(text(value));
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("Poll version is invalid");
  }
  return version;
}

export function requireReason(value: unknown) {
  const reason = text(value);
  if (
    reason.length < COMMUNITY_POLL_LIMITS.reasonMin ||
    reason.length > COMMUNITY_POLL_LIMITS.reasonMax
  ) {
    throw new Error(
      `Reason must be ${COMMUNITY_POLL_LIMITS.reasonMin}-${COMMUNITY_POLL_LIMITS.reasonMax} characters`
    );
  }
  return reason;
}

export function validateCommunityPollDraft(input: {
  question?: unknown;
  context?: unknown;
  durationHours?: unknown;
  options?: unknown;
}) {
  const question = text(input.question);
  const context = text(input.context);
  const durationHours = Number(input.durationHours);
  const rawOptions = Array.isArray(input.options)
    ? input.options
    : typeof input.options === "string"
      ? input.options.split("\n")
      : [];
  const options = rawOptions.map(text).filter(Boolean);

  if (
    question.length < COMMUNITY_POLL_LIMITS.questionMin ||
    question.length > COMMUNITY_POLL_LIMITS.questionMax
  ) {
    throw new Error(
      `Question must be ${COMMUNITY_POLL_LIMITS.questionMin}-${COMMUNITY_POLL_LIMITS.questionMax} characters`
    );
  }
  if (context.length > COMMUNITY_POLL_LIMITS.contextMax) {
    throw new Error(
      `Context must be ${COMMUNITY_POLL_LIMITS.contextMax} characters or fewer`
    );
  }
  if (
    !COMMUNITY_POLL_DURATIONS.includes(
      durationHours as CommunityPollDurationHours
    )
  ) {
    throw new Error("Poll duration is invalid");
  }
  if (
    options.length < COMMUNITY_POLL_LIMITS.optionsMin ||
    options.length > COMMUNITY_POLL_LIMITS.optionsMax ||
    options.some(
      (option) =>
        option.length < COMMUNITY_POLL_LIMITS.optionMin ||
        option.length > COMMUNITY_POLL_LIMITS.optionMax
    ) ||
    new Set(options.map((option) => option.toLocaleLowerCase("en-US"))).size !==
      options.length
  ) {
    throw new Error("Provide 2-8 unique options of up to 160 characters each");
  }

  return Object.freeze({
    question,
    context,
    durationHours: durationHours as CommunityPollDurationHours,
    options: Object.freeze(options),
  });
}
