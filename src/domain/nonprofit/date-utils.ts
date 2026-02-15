// ============================================================================
// Shared Date & EIN Utilities
//
// Extracted as standalone utilities for reuse across profile builders
// and data source adapters.
// ============================================================================

/**
 * Format EIN with standard dash (XX-XXXXXXX format)
 */
export function formatEin(ein: string | number): string {
  const einStr = String(ein).replace(/[-\s]/g, "").padStart(9, "0");
  return `${einStr.slice(0, 2)}-${einStr.slice(2)}`;
}

/**
 * Parse ruling date to Date object.
 * Handles formats: YYYY-MM-DD, YYYY-MM, YYYYMM
 */
export function parseRulingDate(rulingDate: string): Date | null {
  if (!rulingDate) return null;

  // Handle YYYY-MM-DD format (from org detail endpoint)
  const matchFull = rulingDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (matchFull) {
    const [, year, month, day] = matchFull;
    return new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
    );
  }

  // Handle YYYY-MM format
  const match = rulingDate.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const [, year, month] = match;
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
  }

  // Handle YYYYMM format
  const match2 = rulingDate.match(/^(\d{4})(\d{2})$/);
  if (match2) {
    const [, year, month] = match2;
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
  }

  return null;
}

/**
 * Calculate years operating from ruling date
 */
export function calculateYearsOperating(rulingDate: string): number | null {
  const date = parseRulingDate(rulingDate);
  if (!date || isNaN(date.getTime())) return null;

  // Reject implausible dates: IRS has existed since 1913, future dates are invalid
  const year = date.getFullYear();
  if (year < 1913 || year > new Date().getFullYear()) return null;

  const now = new Date();
  const years =
    (now.getTime() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return Number.isFinite(years) && years >= 0 ? Math.floor(years) : null;
}

/**
 * Format tax period (YYYYMM number) to "YYYY-MM" string
 */
export function formatTaxPeriod(taxPrd: number): string {
  const str = String(taxPrd);
  const year = str.slice(0, 4);
  const month = str.slice(4, 6);
  return `${year}-${month}`;
}

/**
 * Calculate overhead ratio (expenses / revenue).
 * Returns null if calculation not possible.
 */
export function calculateOverheadRatio(
  revenue: number | undefined | null,
  expenses: number | undefined | null,
): number | null {
  if (
    typeof revenue !== "number" ||
    !Number.isFinite(revenue) ||
    revenue <= 0
  ) {
    return null;
  }
  if (typeof expenses !== "number" || !Number.isFinite(expenses)) {
    return null;
  }

  const ratio = expenses / revenue;
  return Number.isFinite(ratio) ? ratio : null;
}
