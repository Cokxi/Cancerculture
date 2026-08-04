import assert from "node:assert/strict";
import test from "node:test";
import {
  FAQ_CONTENT_LIMITS,
  parseFaqContentJson,
  validateFaqContent,
} from "../../lib/content/faq/validation.ts";

function validDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    eyebrow: " FAQ & Info ",
    heading: "Find answers fast.",
    introduction: "Help for common questions.",
    sections: [
      {
        id: "wallet",
        title: "Wallet help",
        paragraphs: [" Use https://example.com/help for support. "],
        bullets: ["Act before the cycle ends"],
      },
    ],
    ...overrides,
  };
}

test("FAQ content is normalized into a strict safe text document", () => {
  const result = validateFaqContent(validDocument());

  assert.equal(result.eyebrow, "FAQ & Info");
  assert.equal(
    result.sections[0].paragraphs[0],
    "Use https://example.com/help for support."
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sections), true);
  assert.equal(Object.isFrozen(result.sections[0]), true);
});

test("FAQ content rejects unknown fields and unsupported schemas", () => {
  assert.throws(
    () => validateFaqContent({ ...validDocument(), html: "<b>unsafe</b>" }),
    /unsupported fields/u
  );
  assert.throws(
    () => validateFaqContent(validDocument({ schemaVersion: 2 })),
    /Unsupported FAQ content schema/u
  );
  assert.throws(
    () =>
      validateFaqContent(
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

test("FAQ section IDs are stable, unique, and sections cannot be empty", () => {
  const section = validDocument().sections[0];

  assert.throws(
    () =>
      validateFaqContent(
        validDocument({ sections: [{ ...section, id: "Wallet Help" }] })
      ),
    /lowercase letters/u
  );
  assert.throws(
    () =>
      validateFaqContent(validDocument({ sections: [section, { ...section }] })),
    /must be unique/u
  );
  assert.throws(
    () =>
      validateFaqContent(
        validDocument({
          sections: [{ ...section, paragraphs: [], bullets: [] }],
        })
      ),
    /needs a paragraph or bullet/u
  );
});

test("FAQ bounded text, collections, and JSON parsing fail closed", () => {
  const section = validDocument().sections[0];

  assert.throws(
    () =>
      validateFaqContent(
        validDocument({ heading: "x".repeat(FAQ_CONTENT_LIMITS.heading + 1) })
      ),
    /characters or fewer/u
  );
  assert.throws(
    () =>
      validateFaqContent(
        validDocument({
          sections: Array.from(
            { length: FAQ_CONTENT_LIMITS.sections + 1 },
            (_value, index) => ({ ...section, id: `section-${index + 1}` })
          ),
        })
      ),
    /between 1 and 30 sections/u
  );
  assert.deepEqual(
    parseFaqContentJson(JSON.stringify(validDocument())),
    validateFaqContent(validDocument())
  );
  assert.throws(() => parseFaqContentJson("{"), /invalid JSON/u);
  assert.throws(
    () => parseFaqContentJson("x".repeat(FAQ_CONTENT_LIMITS.serialized + 1)),
    /payload is invalid/u
  );
});
