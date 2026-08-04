import type { FaqContentDocument, FaqContentSection } from "./types";

export const FAQ_CONTENT_LIMITS = Object.freeze({
  serialized: 100_000,
  eyebrow: 80,
  heading: 160,
  introduction: 2_000,
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
    normalizedText(item, `${field} item ${index + 1}`, maximumItemLength)
  );
}

function validateSection(value: unknown, index: number): FaqContentSection {
  if (!isRecord(value)) {
    throw new Error(`Section ${index + 1} is invalid`);
  }

  assertExactKeys(value, SECTION_KEYS, `Section ${index + 1}`);
  const id = normalizedText(
    value.id,
    `Section ${index + 1} ID`,
    FAQ_CONTENT_LIMITS.sectionId
  );

  if (!SECTION_ID_PATTERN.test(id)) {
    throw new Error(
      `Section ${index + 1} ID must use lowercase letters, numbers, and single hyphens`
    );
  }

  const paragraphs = normalizedTextArray(
    value.paragraphs,
    `Section ${index + 1} paragraphs`,
    FAQ_CONTENT_LIMITS.paragraphsPerSection,
    FAQ_CONTENT_LIMITS.paragraph
  );
  const bullets = normalizedTextArray(
    value.bullets,
    `Section ${index + 1} bullets`,
    FAQ_CONTENT_LIMITS.bulletsPerSection,
    FAQ_CONTENT_LIMITS.bullet
  );

  if (paragraphs.length === 0 && bullets.length === 0) {
    throw new Error(`Section ${index + 1} needs a paragraph or bullet`);
  }

  return Object.freeze({
    id,
    title: normalizedText(
      value.title,
      `Section ${index + 1} title`,
      FAQ_CONTENT_LIMITS.sectionTitle
    ),
    paragraphs: Object.freeze(paragraphs),
    bullets: Object.freeze(bullets),
  });
}

export function validateFaqContent(value: unknown): FaqContentDocument {
  if (!isRecord(value)) {
    throw new Error("FAQ content must be an object");
  }

  assertExactKeys(value, DOCUMENT_KEYS, "FAQ content");

  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported FAQ content schema version");
  }

  if (
    !Array.isArray(value.sections) ||
    value.sections.length === 0 ||
    value.sections.length > FAQ_CONTENT_LIMITS.sections
  ) {
    throw new Error(
      `FAQ content must contain between 1 and ${FAQ_CONTENT_LIMITS.sections} sections`
    );
  }

  const sections = value.sections.map(validateSection);
  const sectionIds = new Set(sections.map((section) => section.id));

  if (sectionIds.size !== sections.length) {
    throw new Error("FAQ section IDs must be unique");
  }

  const document = Object.freeze({
    schemaVersion: 1 as const,
    eyebrow: normalizedText(
      value.eyebrow,
      "FAQ eyebrow",
      FAQ_CONTENT_LIMITS.eyebrow
    ),
    heading: normalizedText(
      value.heading,
      "FAQ heading",
      FAQ_CONTENT_LIMITS.heading
    ),
    introduction: normalizedText(
      value.introduction,
      "FAQ introduction",
      FAQ_CONTENT_LIMITS.introduction
    ),
    sections: Object.freeze(sections),
  });

  if (JSON.stringify(document).length > FAQ_CONTENT_LIMITS.serialized) {
    throw new Error("FAQ content is too large");
  }

  return document;
}

export function parseFaqContentJson(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > FAQ_CONTENT_LIMITS.serialized
  ) {
    throw new Error("FAQ content payload is invalid");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("FAQ content payload is invalid JSON");
  }

  return validateFaqContent(parsed);
}
