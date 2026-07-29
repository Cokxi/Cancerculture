import assert from "node:assert/strict";
import test from "node:test";
import {
  HOMEPAGE_INFO_BLOCK_LIMITS,
  validateHomepageInfoBlockInput,
} from "../../lib/homepageInfoBlocks/validation.ts";

const validInput = (overrides = {}) => ({
  title: "About",
  body: "First paragraph.\n\nSecond paragraph.",
  displayOrder: "100",
  isActive: "on",
  linkLabel: "",
  linkUrl: "",
  ...overrides,
});

test("valid Homepage Info values normalize without losing line breaks", () => {
  assert.deepEqual(validateHomepageInfoBlockInput(validInput()), {
    title: "About",
    body: "First paragraph.\n\nSecond paragraph.",
    displayOrder: 100,
    isActive: true,
    linkLabel: null,
    linkUrl: null,
  });
});

test("empty and oversized content is rejected", () => {
  assert.throws(
    () => validateHomepageInfoBlockInput(validInput({ body: " \n " })),
    /Body is required/
  );
  assert.throws(
    () =>
      validateHomepageInfoBlockInput(
        validInput({
          title: "x".repeat(HOMEPAGE_INFO_BLOCK_LIMITS.title + 1),
        })
      ),
    /Title must be/
  );
  assert.throws(
    () =>
      validateHomepageInfoBlockInput(
        validInput({
          body: "x".repeat(HOMEPAGE_INFO_BLOCK_LIMITS.body + 1),
        })
      ),
    /Body must be/
  );
});

test("Display Order must use the bounded Coin Launch integer semantics", () => {
  for (const displayOrder of [
    "",
    "-1",
    "1.5",
    "abc",
    String(HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMax + 1),
  ]) {
    assert.throws(
      () =>
        validateHomepageInfoBlockInput(
          validInput({ displayOrder })
        ),
      /Display order/
    );
  }
});

test("Link label and URL must be supplied as a pair", () => {
  assert.throws(
    () =>
      validateHomepageInfoBlockInput(
        validInput({ linkLabel: "Rules", linkUrl: "" })
      ),
    /provided together/
  );
  assert.throws(
    () =>
      validateHomepageInfoBlockInput(
        validInput({ linkLabel: "", linkUrl: "/rules" })
      ),
    /provided together/
  );
});

test("only safe internal paths and HTTPS links are accepted", () => {
  const internal = validateHomepageInfoBlockInput(
    validInput({ linkLabel: "Rules", linkUrl: "/rules#conduct" })
  );
  const external = validateHomepageInfoBlockInput(
    validInput({
      linkLabel: "Sponsor",
      linkUrl: "https://example.com/info",
    })
  );

  assert.equal(internal.linkUrl, "/rules#conduct");
  assert.equal(external.linkUrl, "https://example.com/info");

  for (const linkUrl of [
    "javascript:alert(1)",
    "data:text/html,test",
    "http://example.com",
    "//example.com",
    "/\\example.com",
    "https://user:pass@example.com",
  ]) {
    assert.throws(() =>
      validateHomepageInfoBlockInput(
        validInput({ linkLabel: "Unsafe", linkUrl })
      )
    );
  }
});

test("HTML-looking body remains plain text for React to escape", () => {
  const body = "<script>alert('x')</script>\n<strong>text</strong>";
  const values = validateHomepageInfoBlockInput(
    validInput({ body })
  );

  assert.equal(values.body, body);
});
