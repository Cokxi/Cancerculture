import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRulesContentJson,
  RULES_CONTENT_LIMITS,
  validateRulesContent,
} from "../../lib/content/rules/validation.ts";

function validDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    eyebrow: " Rules & Guidelines ",
    heading: "Simple rules.",
    introduction: "Keep the competition fair.",
    noticeTitle: "Current Rules",
    noticeBody: "Accept material changes before participating.",
    sections: [
      {
        id: "fair-play",
        title: "Fair Play",
        paragraphs: [" Do not manipulate votes. "],
        bullets: ["No self-voting"],
      },
    ],
    ...overrides,
  };
}

test("Rules content is normalized into a strict safe text document", () => {
  const result = validateRulesContent(validDocument());

  assert.equal(result.eyebrow, "Rules & Guidelines");
  assert.equal(result.sections[0].paragraphs[0], "Do not manipulate votes.");
  assert.equal(result.sections[0].bullets[0], "No self-voting");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sections), true);
  assert.equal(Object.isFrozen(result.sections[0]), true);
});

test("Rules content rejects unknown fields and unsupported schemas", () => {
  assert.throws(
    () => validateRulesContent({ ...validDocument(), html: "<b>unsafe</b>" }),
    /unsupported fields/u
  );
  assert.throws(
    () => validateRulesContent(validDocument({ schemaVersion: 2 })),
    /Unsupported Rules content schema/u
  );
  assert.throws(
    () =>
      validateRulesContent(
        validDocument({
          sections: [
            {
              ...validDocument().sections[0],
              href: "javascript:alert(1)",
            },
          ],
        })
      ),
    /unsupported fields/u
  );
});

test("section IDs are stable, unique, and sections cannot be empty", () => {
  const section = validDocument().sections[0];

  assert.throws(
    () =>
      validateRulesContent(
        validDocument({ sections: [{ ...section, id: "Fair Play" }] })
      ),
    /lowercase letters/u
  );
  assert.throws(
    () =>
      validateRulesContent(
        validDocument({ sections: [section, { ...section }] })
      ),
    /must be unique/u
  );
  assert.throws(
    () =>
      validateRulesContent(
        validDocument({
          sections: [{ ...section, paragraphs: [], bullets: [] }],
        })
      ),
    /needs a paragraph or bullet/u
  );
});

test("bounded text and collection limits fail closed", () => {
  const section = validDocument().sections[0];

  assert.throws(
    () =>
      validateRulesContent(
        validDocument({ heading: "x".repeat(RULES_CONTENT_LIMITS.heading + 1) })
      ),
    /characters or fewer/u
  );
  assert.throws(
    () =>
      validateRulesContent(
        validDocument({
          sections: Array.from(
            { length: RULES_CONTENT_LIMITS.sections + 1 },
            (_value, index) => ({ ...section, id: `section-${index + 1}` })
          ),
        })
      ),
    /between 1 and 30 sections/u
  );
});

test("JSON parsing rejects malformed and oversized payloads", () => {
  assert.deepEqual(
    parseRulesContentJson(JSON.stringify(validDocument())),
    validateRulesContent(validDocument())
  );
  assert.throws(() => parseRulesContentJson("{"), /invalid JSON/u);
  assert.throws(
    () => parseRulesContentJson("x".repeat(RULES_CONTENT_LIMITS.serialized + 1)),
    /payload is invalid/u
  );
});
