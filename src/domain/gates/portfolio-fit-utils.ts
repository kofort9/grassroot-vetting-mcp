/**
 * Check if an NTEE code matches allowed categories via prefix matching.
 * Returns true if any allowed prefix is a prefix of the NTEE code.
 */
export function matchesNteeCategory(
  nteeCode: string,
  allowedCategories: string[],
): boolean {
  const upper = nteeCode.toUpperCase();
  return allowedCategories.some(
    (prefix) => prefix && upper.startsWith(prefix.toUpperCase()),
  );
}

/**
 * Normalize an EIN by removing dashes and whitespace.
 */
export function normalizeEin(ein: string): string {
  return ein.replace(/[-\s]/g, "");
}
