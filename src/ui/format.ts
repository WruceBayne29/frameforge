/** Formats a number with a sensible number of significant digits for engineering display. */
export function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs < 1e-9) return '0';
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 100) return value.toFixed(Math.max(0, digits - 3));
  if (abs >= 10) return value.toFixed(Math.max(0, digits - 2));
  if (abs >= 1) return value.toFixed(Math.max(0, digits - 1));
  return value.toFixed(digits);
}

/** Formats a length in metres as millimetres. */
export function mm(value: number): string {
  return fmt(value * 1000, 3);
}
