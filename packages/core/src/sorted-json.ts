/**
 * Serialises owned state the same way every time: object keys sorted, two-space
 * indent, trailing newline. Diffs of owned files then show only real changes.
 */
export const toSortedJson = (value: unknown): string =>
  `${JSON.stringify(
    value,
    (_key, inner: unknown) =>
      inner !== null && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : inner,
    2,
  )}\n`;
