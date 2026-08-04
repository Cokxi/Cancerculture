import type {
  RulesContentDocument,
  RulesContentSection,
} from "./types";

export const RULES_CONTENT_LIMITS = Object.freeze({
  serialized: 100_000,
  eyebrow: 80,
  heading: 160,
  introduction: 2_000,
  noticeTitle: 160,
  noticeBody: 2_000,
  sections: 30,
  sectionId: 80,
  sectionTitle: 160,
  paragraphsPerSection: 30,
  paragraph: 2_000,
  bulletsPerSection: 40,
  bullet: 1_000,
});

const SECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCUMENT_KEYS = Object.freeze([
  "schemaVersion",
  "eyebrow",
  "heading",
  "introduction",
  "noticeTitle",
  "noticeBody",
  "sections",
]);
const SECTION_KEYS = Object.freeze([
  "id",
  "title",
  "paragraphs",
  "bullets",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string
) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();

  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${field} contains unsupported fields`);
  }
}

function normalizedText(
  value: unknown,
  field: string,
  maximumLength: number
) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be text`);
  }

  const normalized = value.replace(/\r\n?/g, "\n").trim();

  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  if (normalized.length > maximumLength) {
    throw new Error(`${field} must be ${maximumLength} characters or fewer`);
  }

  return normalized;
}

function normalizedTextArray(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumItemLength: number
) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${field} must contain at most ${maximumItems} items`);
  }

  return value.map((item, index) =>
    normalizedText(
      item,
      `${field} item ${index + 1}`,
      maximumItemLength
    )
  );
}

function validateSection(
  value: unknown,
  index: number
): RulesContentSection {
  if (!isRecord(value)) {
    throw new Error(`Section ${index + 1} is invalid`);
  }

  assertExactKeys(value, SECTION_KEYS, `Section ${index + 1}`);

  const id = normalizedText(
    value.id,
    `Section ${index + 1} ID`,
    RULES_CONTENT_LIMITS.sectionId
  );

  if (!SECTION_ID_PATTERN.test(id)) {
    throw new Error(
      `Section ${index + 1} ID must use lowercase letters, numbers, and single hyphens`
    );
  }

  const paragraphs = normalizedTextArray(
    value.paragraphs,
    `Section ${index + 1} paragraphs`,
    RULES_CONTENT_LIMITS.paragraphsPerSection,
    RULES_CONTENT_LIMITS.paragraph
  );
  const bullets = normalizedTextArray(
    value.bullets,
    `Section ${index + 1} bullets`,
    RULES_CONTENT_LIMITS.bulletsPerSection,
    RULES_CONTENT_LIMITS.bullet
  );

  if (paragraphs.length === 0 && bullets.length === 0) {
    throw new Error(`Section ${index + 1} needs a paragraph or bullet`);
  }

  return Object.freeze({
    id,
    title: normalizedText(
      value.title,
      `Section ${index + 1} title`,
      RULES_CONTENT_LIMITS.sectionTitle
    ),
    paragraphs: Object.freeze(paragraphs),
    bullets: Object.freeze(bullets),
  });
}

export function validateRulesContent(value: unknown): RulesContentDocument {
  if (!isRecord(value)) {
    throw new Error("Rules content must be an object");
  }

  assertExactKeys(value, DOCUMENT_KEYS, "Rules content");

  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported Rules content schema version");
  }

  if (
    !Array.isArray(value.sections) ||
    value.sections.length === 0 ||
    value.sections.length > RULES_CONTENT_LIMITS.sections
  ) {
    throw new Error(
      `Rules content must contain between 1 and ${RULES_CONTENT_LIMITS.sections} sections`
    );
  }

  const sections = value.sections.map(validateSection);
  const sectionIds = new Set(sections.map((section) => section.id));

  if (sectionIds.size !== sections.length) {
    throw new Error("Rules section IDs must be unique");
  }

  const document = Object.freeze({
    schemaVersion: 1 as const,
    eyebrow: normalizedText(
      value.eyebrow,
      "Rules eyebrow",
      RULES_CONTENT_LIMITS.eyebrow
    ),
    heading: normalizedText(
      value.heading,
      "Rules heading",
      RULES_CONTENT_LIMITS.heading
    ),
    introduction: normalizedText(
      value.introduction,
      "Rules introduction",
      RULES_CONTENT_LIMITS.introduction
    ),
    noticeTitle: normalizedText(
      value.noticeTitle,
      "Rules notice title",
      RULES_CONTENT_LIMITS.noticeTitle
    ),
    noticeBody: normalizedText(
      value.noticeBody,
      "Rules notice body",
      RULES_CONTENT_LIMITS.noticeBody
    ),
    sections: Object.freeze(sections),
  });

  if (JSON.stringify(document).length > RULES_CONTENT_LIMITS.serialized) {
    throw new Error("Rules content is too large");
  }

  return document;
}

export function parseRulesContentJson(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > RULES_CONTENT_LIMITS.serialized
  ) {
    throw new Error("Rules content payload is invalid");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Rules content payload is invalid JSON");
  }

  return validateRulesContent(parsed);
}
