import assert from "node:assert/strict";
import test from "node:test";
import {
  createSponsorViewabilityState,
  qualifySponsorView,
  shouldRunSponsorDwell,
  SPONSOR_VIEWPORT_DWELL_MS,
  SPONSOR_VIEWPORT_THRESHOLD,
  updateSponsorIntersection,
  updateSponsorPageVisibility,
} from "../../lib/sponsors/viewability.ts";

test("Sponsor viewability uses the confirmed 50 percent and 1000ms contract", () => {
  assert.equal(SPONSOR_VIEWPORT_THRESHOLD, 0.5);
  assert.equal(SPONSOR_VIEWPORT_DWELL_MS, 1_000);
});

test("mount, prefetch, background, and below-threshold visibility never qualify", () => {
  const mounted = createSponsorViewabilityState();
  assert.equal(shouldRunSponsorDwell(mounted), false);
  assert.equal(shouldRunSponsorDwell(updateSponsorIntersection(mounted, 0.49)), false);
  assert.equal(
    shouldRunSponsorDwell(
      updateSponsorPageVisibility(updateSponsorIntersection(mounted, 0.5), false),
    ),
    false,
  );
});

test("interruptions reset the full dwell and a fresh visible interval can qualify", () => {
  const visible = updateSponsorIntersection(createSponsorViewabilityState(), 0.5);
  assert.equal(shouldRunSponsorDwell(visible), true);
  assert.equal(qualifySponsorView(visible).qualified, true);

  const scrolledAway = updateSponsorIntersection(
    qualifySponsorView(visible),
    0.1,
  );
  assert.equal(scrolledAway.qualified, false);
  const returned = updateSponsorIntersection(scrolledAway, 0.8);
  assert.equal(shouldRunSponsorDwell(returned), true);

  const backgrounded = updateSponsorPageVisibility(returned, false);
  assert.equal(backgrounded.qualified, false);
  assert.equal(shouldRunSponsorDwell(backgrounded), false);
});
