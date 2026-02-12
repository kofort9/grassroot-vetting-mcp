import type { PortfolioFitConfig } from "../nonprofit/types.js";

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

/**
 * Check if an org passes portfolio-fit criteria (NTEE + EIN overrides).
 * Used by both the gate (per-org vetting) and discovery pipeline (bulk filtering).
 *
 * Returns { passes: boolean, reason: string }
 */
export function matchesPortfolioFit(
  nteeCode: string,
  ein: string,
  config: PortfolioFitConfig,
): { passes: boolean; reason: string } {
  // Gate disabled = always passes
  if (!config.enabled) {
    return { passes: true, reason: "Portfolio-fit gate disabled" };
  }

  const normalizedEin = normalizeEin(ein);

  // EIN exclusion (checked first, always wins)
  const excludedSet = new Set(config.excludedEins.map(normalizeEin));
  if (excludedSet.has(normalizedEin)) {
    return { passes: false, reason: "Excluded by platform policy" };
  }

  // EIN inclusion (skips NTEE check)
  const includedSet = new Set(config.includedEins.map(normalizeEin));
  if (includedSet.has(normalizedEin)) {
    return { passes: true, reason: "Included by platform override" };
  }

  // NTEE category match
  if (!nteeCode) {
    return { passes: true, reason: "NTEE classification missing — portfolio fit unverified" };
  }

  if (matchesNteeCategory(nteeCode, config.allowedNteeCategories)) {
    return {
      passes: true,
      reason: `NTEE code ${nteeCode.toUpperCase()} is within portfolio scope`,
    };
  }

  return {
    passes: false,
    reason: `NTEE category ${nteeCode.toUpperCase()} is outside portfolio scope`,
  };
}
