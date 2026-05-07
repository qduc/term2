/**
 * Calculates the starting index for a viewport window, centering on the
 * selected index while ensuring the visible range stays within bounds.
 */
export function calculateViewportStart(totalItems: number, selectedIndex: number, maxVisible: number): number {
  if (totalItems <= maxVisible) {
    return 0;
  }

  const half = Math.floor(maxVisible / 2);

  if (selectedIndex <= half) {
    return 0;
  } else if (selectedIndex >= totalItems - half) {
    return totalItems - maxVisible;
  } else {
    return selectedIndex - half;
  }
}
