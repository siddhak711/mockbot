/** Distance from the bottom, in pixels, that still counts as following the stream. */
export const SCROLL_PIN_PX = 48;

export function distanceFromBottom(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** True when the viewport is already at the latest content, within a small threshold. */
export function isPinnedToBottom(
  metrics: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  },
  threshold = SCROLL_PIN_PX,
): boolean {
  return distanceFromBottom(metrics) <= threshold;
}
