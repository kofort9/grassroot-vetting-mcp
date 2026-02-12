import type {
  NonprofitProfile,
  PortfolioFitConfig,
} from "../nonprofit/types.js";
import type { GateCheckResult, GateSubCheck } from "./gate-types.js";
import { normalizeEin, matchesNteeCategory } from "./portfolio-fit-utils.js";

/**
 * Gate 4: Portfolio Fit
 *
 * Filters orgs by NTEE category (prefix matching) with EIN-level overrides.
 * This is platform-wide eligibility policy — not per-funder config.
 *
 * Three sub-checks run in order:
 *   A. EIN exclusion list (hard block, checked first, always wins)
 *   B. EIN inclusion list (hard allow, skips NTEE check)
 *   C. NTEE category match (prefix match against allowlist)
 *
 * All sub-checks always run for auditability, even when the gate is disabled.
 */
export function checkPortfolioFit(
  profile: NonprofitProfile,
  config: PortfolioFitConfig,
): GateCheckResult {
  const subChecks: GateSubCheck[] = [];
  const normalizedEin = normalizeEin(profile.ein);

  // Sub-check A: EIN exclusion list
  const excludedSet = new Set(config.excludedEins.map(normalizeEin));
  const isExcluded = excludedSet.has(normalizedEin);
  subChecks.push({
    label: "EIN exclusion list",
    passed: !isExcluded,
    detail: isExcluded
      ? "Excluded by platform policy"
      : "Not on exclusion list",
  });

  // Sub-check B: EIN inclusion list
  const includedSet = new Set(config.includedEins.map(normalizeEin));
  const isIncluded = includedSet.has(normalizedEin);
  subChecks.push({
    label: "EIN inclusion list",
    passed: true,
    detail: isIncluded
      ? "Included by platform override"
      : "Not on inclusion list (standard NTEE check applies)",
  });

  // Sub-check C: NTEE category match
  const nteeCode = (profile.ntee_code || "").toUpperCase();
  const nteeMatched = nteeCode
    ? matchesNteeCategory(nteeCode, config.allowedNteeCategories)
    : false;
  const nteeMissing = !nteeCode;

  subChecks.push({
    label: "NTEE category match",
    passed: nteeMatched || nteeMissing,
    detail: nteeMatched
      ? `NTEE code ${nteeCode} matches allowed categories`
      : nteeMissing
        ? "No NTEE code on file (unclassified)"
        : `NTEE category ${nteeCode} is outside portfolio scope`,
  });

  // Disabled gate = automatic pass (sub-checks still recorded for auditability)
  if (!config.enabled) {
    return {
      gate: "portfolio_fit",
      verdict: "PASS",
      detail: "Portfolio-fit gate disabled",
      sub_checks: subChecks,
    };
  }

  // Verdict logic:
  // 1. Excluded EIN → FAIL (always wins, even over inclusion)
  // 2. Included EIN → PASS (skips NTEE check)
  // 3. NTEE match → PASS
  // 4. No match → FAIL
  let verdict: "PASS" | "FAIL";
  let detail: string;

  if (isExcluded) {
    verdict = "FAIL";
    detail = "Excluded by platform policy";
  } else if (isIncluded) {
    verdict = "PASS";
    detail = "Included by platform override";
  } else if (!nteeCode) {
    verdict = "PASS";
    detail = "NTEE classification missing — portfolio fit unverified";
  } else if (nteeMatched) {
    verdict = "PASS";
    detail = `NTEE code ${nteeCode} is within portfolio scope`;
  } else {
    verdict = "FAIL";
    detail = `NTEE category ${nteeCode} is outside portfolio scope`;
  }

  return {
    gate: "portfolio_fit",
    verdict,
    detail,
    sub_checks: subChecks,
  };
}
