import type { NonprofitProfile } from "../nonprofit/types.js";
import type { IrsRevocationClient } from "../red-flags/irs-revocation-client.js";
import type { GateCheckResult, GateSubCheck } from "./gate-types.js";

/**
 * Gate 1: Verified 501(c)(3) Status
 *
 * Three sub-checks — all must pass:
 *   A. Classified as 501(c)(3) in IRS records (subsection === "03")
 *   B. Not on IRS revocation list
 *   C. Has IRS determination letter (ruling_date is truthy)
 *
 * Always runs all 3 sub-checks regardless of individual failures (auditability).
 */
export function checkVerified501c3(
  profile: NonprofitProfile,
  irsClient: IrsRevocationClient,
): GateCheckResult {
  const subChecks: GateSubCheck[] = [];

  // Sub-check A: 501(c)(3) classification
  const is501c3 = profile.subsection === "03";
  subChecks.push({
    label: "501(c)(3) classification",
    passed: is501c3,
    detail: is501c3
      ? "Classified as 501(c)(3) tax-exempt organization"
      : `Subsection code is "${profile.subsection}", not "03" (501(c)(3))`,
  });

  // Sub-check B: Not revoked
  const irsResult = irsClient.check(profile.ein);
  const notRevoked = !irsResult.revoked;
  subChecks.push({
    label: "IRS revocation check",
    passed: notRevoked,
    detail: irsResult.detail,
  });

  // Sub-check C: Has ruling date
  const hasRulingDate = Boolean(profile.ruling_date);
  subChecks.push({
    label: "IRS determination letter",
    passed: hasRulingDate,
    detail: hasRulingDate
      ? `IRS determination date: ${profile.ruling_date}`
      : "No IRS determination date on record",
  });

  const allPassed = subChecks.every((sc) => sc.passed);
  const failures = subChecks.filter((sc) => !sc.passed);

  return {
    gate: "verified_501c3",
    verdict: allPassed ? "PASS" : "FAIL",
    detail: allPassed
      ? "Valid 501(c)(3) status confirmed"
      : `Failed: ${failures.map((f) => f.label).join(", ")}`,
    sub_checks: subChecks,
  };
}
