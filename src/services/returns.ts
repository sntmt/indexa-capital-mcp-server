/**
 * Return calculations over Indexa's base-100 performance series.
 */

/**
 * Computes cumulative return from base-100 values: last/first - 1.
 * Returns null when the series is too short or starts at zero.
 */
export function cumulativeReturn(values: number[] | undefined): number | null {
  if (!values || values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (!first) return null;
  return last / first - 1;
}
