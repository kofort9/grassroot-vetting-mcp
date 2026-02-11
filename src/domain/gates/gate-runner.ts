import type {
  NonprofitProfile,
  PortfolioFitConfig,
} from "../nonprofit/types.js";
import type { IrsRevocationClient } from "../red-flags/irs-revocation-client.js";
import type { OfacSdnClient } from "../red-flags/ofac-sdn-client.js";
import type { GateLayerResult } from "./gate-types.js";
import { checkVerified501c3 } from "./verified-501c3.js";
import { checkOfacSanctions } from "./ofac-sanctions.js";
import { checkFilingExists } from "./filing-exists.js";
import { checkPortfolioFit } from "./portfolio-fit.js";

/**
 * Run all pre-screen gates.
 *
 * All 4 gates always run for audit completeness — OFAC, filing, and
 * portfolio-fit checks are local lookups (no API cost), so there's
 * no reason to skip them.
 * The `blocking_gate` field reports the first gate that failed.
 */
export function runPreScreenGates(
  profile: NonprofitProfile,
  irsClient: IrsRevocationClient,
  ofacClient: OfacSdnClient,
  portfolioFitConfig: PortfolioFitConfig,
): GateLayerResult {
  const gate1 = checkVerified501c3(profile, irsClient);
  const gate2 = checkOfacSanctions(profile.name, ofacClient);
  const gate3 = checkFilingExists(profile);
  const gate4 = checkPortfolioFit(profile, portfolioFitConfig);

  const gates = [gate1, gate2, gate3, gate4];
  const firstFailure = gates.find((g) => g.verdict === "FAIL");

  return {
    all_passed: !firstFailure,
    gates,
    blocking_gate: firstFailure?.gate,
  };
}
