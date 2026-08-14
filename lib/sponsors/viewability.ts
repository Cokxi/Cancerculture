export const SPONSOR_VIEWPORT_THRESHOLD = 0.5;
export const SPONSOR_VIEWPORT_DWELL_MS = 1_000;

export type SponsorViewabilityState = {
  intersecting: boolean;
  pageVisible: boolean;
  qualified: boolean;
};

export function createSponsorViewabilityState(): SponsorViewabilityState {
  return {
    intersecting: false,
    pageVisible: true,
    qualified: false,
  };
}

export function shouldRunSponsorDwell(state: SponsorViewabilityState) {
  return state.intersecting && state.pageVisible && !state.qualified;
}

export function updateSponsorIntersection(
  state: SponsorViewabilityState,
  intersectionRatio: number
) {
  const intersecting = intersectionRatio >= SPONSOR_VIEWPORT_THRESHOLD;
  return {
    ...state,
    intersecting,
    qualified: intersecting ? state.qualified : false,
  };
}

export function updateSponsorPageVisibility(
  state: SponsorViewabilityState,
  pageVisible: boolean
) {
  return {
    ...state,
    pageVisible,
    qualified: pageVisible ? state.qualified : false,
  };
}

export function qualifySponsorView(
  state: SponsorViewabilityState
) {
  return shouldRunSponsorDwell(state)
    ? { ...state, qualified: true }
    : state;
}
