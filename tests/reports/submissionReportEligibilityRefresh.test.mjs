import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(
  new URL("../../app/components/SubmissionReportPanel.tsx", import.meta.url),
  "utf8",
);

test("background eligibility refreshes keep the verified report form mounted", () => {
  assert.match(panel, /loadingEligibility && !eligibility/u);
  assert.match(panel, /eligibilityError && !eligibility/u);
  assert.doesNotMatch(panel, /\{loadingEligibility \? \(/u);
  assert.doesNotMatch(panel, /\) : eligibilityError \? \(/u);
});
