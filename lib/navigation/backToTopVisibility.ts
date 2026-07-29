export const BACK_TO_TOP_SCROLL_THRESHOLD_PX = 480;
export const BACK_TO_TOP_MIN_SCROLL_RANGE_PX = 160;

type BackToTopVisibilityInput = {
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
};

export function shouldShowBackToTop({
  scrollY,
  scrollHeight,
  viewportHeight,
}: BackToTopVisibilityInput) {
  const scrollRange = Math.max(0, scrollHeight - viewportHeight);

  return (
    scrollRange >= BACK_TO_TOP_MIN_SCROLL_RANGE_PX &&
    scrollY >= BACK_TO_TOP_SCROLL_THRESHOLD_PX
  );
}
