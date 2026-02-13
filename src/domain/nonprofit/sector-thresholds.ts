import { VettingThresholds } from "./types.js";
import { loadThresholds, validateThresholds } from "../../core/config.js";

/**
 * Partial threshold overrides keyed by NTEE major category (first letter).
 *
 * These adjust the base thresholds for sectors where financial norms differ
 * substantially from the generic defaults. Only override fields that need
 * sector-specific values — all others inherit from the base thresholds.
 *
 * Sources for initial calibration:
 * - A (Arts/Culture): Very low revenue threshold is lower than base.
 * - E (Health): Larger organizations with higher compensation norms.
 * - K (Food/Agriculture): Small food banks and pantries are common; lower PASS floor.
 * - L (Housing/Shelter): Small shelters operate on tight budgets.
 * - O (Youth Development): After-school and mentoring programs often run lean.
 * - P (Human Services): Broad category with many small grassroots orgs.
 * - S (Community Improvement): Neighborhood orgs, mutual aid, civic groups.
 */
const SECTOR_OVERRIDES: Record<string, Partial<VettingThresholds>> = {
  // A = Arts, Culture, and Humanities
  A: {
    redFlagVeryLowRevenue: 15_000,
  },

  // E = Health – General and Rehabilitative
  E: {
    revenuePassMax: 50_000_000,
    revenueReviewMax: 100_000_000,
    redFlagHighCompensation: 0.5,
    redFlagModerateCompensation: 0.35,
  },

  // K = Food, Agriculture, and Nutrition
  K: {
    revenueFailMin: 10_000,
    revenuePassMin: 25_000,
    redFlagVeryLowRevenue: 8_000,
  },

  // L = Housing, Shelter
  L: {
    revenueFailMin: 15_000,
    revenuePassMin: 30_000,
    redFlagVeryLowRevenue: 10_000,
  },

  // O = Youth Development
  O: {
    revenueFailMin: 10_000,
    revenuePassMin: 25_000,
    redFlagVeryLowRevenue: 8_000,
  },

  // P = Human Services
  P: {
    revenueFailMin: 15_000,
    revenuePassMin: 30_000,
    redFlagVeryLowRevenue: 10_000,
  },

  // S = Community Improvement, Capacity Building
  S: {
    revenueFailMin: 10_000,
    revenuePassMin: 25_000,
    redFlagVeryLowRevenue: 8_000,
  },
};

/**
 * Extract the NTEE major category (first letter) from an NTEE code.
 * Returns undefined if the code is empty or invalid.
 */
function getNteeMajorCategory(nteeCode: string): string | undefined {
  if (!nteeCode) return undefined;
  const firstChar = nteeCode.charAt(0).toUpperCase();
  if (firstChar >= "A" && firstChar <= "Z") return firstChar;
  return undefined;
}

/**
 * Resolve final thresholds by merging sector-specific overrides onto the base.
 *
 * Priority: base thresholds ← sector overrides (if NTEE code matches)
 *
 * All sector overrides are validated at module load time (see bottom of file).
 */
export function resolveThresholds(
  base: VettingThresholds,
  nteeCode: string,
): VettingThresholds {
  const category = getNteeMajorCategory(nteeCode);
  if (!category) return base;

  const overrides = SECTOR_OVERRIDES[category];
  if (!overrides) return base;

  return { ...base, ...overrides };
}

/**
 * Get the list of supported NTEE major categories with sector overrides.
 * Useful for documentation and debugging.
 */
export function getSupportedSectors(): string[] {
  return Object.keys(SECTOR_OVERRIDES).sort();
}

// Validate all sector overrides at module load time.
// Throws on invalid — caught at startup, not per-request.
const _baseForValidation = loadThresholds();
for (const [, overrides] of Object.entries(SECTOR_OVERRIDES)) {
  validateThresholds({ ..._baseForValidation, ...overrides });
}
