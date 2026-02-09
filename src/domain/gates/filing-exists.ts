import type { NonprofitProfile } from "../nonprofit/types.js";
import type { GateCheckResult } from "./gate-types.js";

/**
 * Gate 3: 990 Tax Filing Exists
 *
 * At least one Form 990 must be on file. Without it, we have no data
 * to evaluate the organization in the scoring engine.
 */
export function checkFilingExists(profile: NonprofitProfile): GateCheckResult {
  const hasFiling = profile.filing_count > 0 && profile.latest_990 !== null;

  return {
    gate: "filing_exists",
    verdict: hasFiling ? "PASS" : "FAIL",
    detail: hasFiling
      ? `${profile.filing_count} 990 filing(s) on record`
      : "No 990 tax filings on record — cannot evaluate financials",
  };
}
