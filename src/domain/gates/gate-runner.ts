import type { NonprofitProfile } from "../nonprofit/types.js";
import type { IrsRevocationClient } from "../red-flags/irs-revocation-client.js";
import type { OfacSdnClient } from "../red-flags/ofac-sdn-client.js";
import type { GateLayerResult } from "./gate-types.js";
import { checkVerified501c3 } from "./verified-501c3.js";
import { checkOfacSanctions } from "./ofac-sanctions.js";
import { checkFilingExists } from "./filing-exists.js";

/**
 * Run all pre-screen gates.
 *
 * All 3 gates always run for audit completeness — OFAC and filing checks
 * are local lookups (no API cost), so there's no reason to skip them.
 * The `blocking_gate` field reports the first gate that failed.
 */
export function runPreScreenGates(
  profile: NonprofitProfile,
  irsClient: IrsRevocationClient,
  ofacClient: OfacSdnClient,
): GateLayerResult {
  const gate1 = checkVerified501c3(profile, irsClient);
  const gate2 = checkOfacSanctions(profile.name, ofacClient);
  const gate3 = checkFilingExists(profile);

  const gates = [gate1, gate2, gate3];
  const firstFailure = gates.find((g) => g.verdict === "FAIL");

  return {
    all_passed: !firstFailure,
    gates,
    blocking_gate: firstFailure?.gate,
  };
}
