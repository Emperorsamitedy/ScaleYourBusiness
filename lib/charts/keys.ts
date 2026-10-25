// Keyboard stepping for every chart's crosshair — pure, so it is tested
// without a browser. Arrow keys move one position (the first press lands
// on the newest), Home and End jump, Escape lets go.

export function stepKey(
  key: string,
  at: number | null,
  n: number,
): { next: number | null; handled: boolean } {
  if (n <= 0) return { next: null, handled: false };
  const cur = at ?? n - 1;
  switch (key) {
    case "ArrowLeft":
      return { next: Math.max(0, cur - (at === null ? 0 : 1)), handled: true };
    case "ArrowRight":
      return { next: Math.min(n - 1, cur + (at === null ? 0 : 1)), handled: true };
    case "Home":
      return { next: 0, handled: true };
    case "End":
      return { next: n - 1, handled: true };
    case "Escape":
      return { next: null, handled: true };
    default:
      return { next: at, handled: false };
  }
}
