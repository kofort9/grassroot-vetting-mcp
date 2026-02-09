import type { OfacSdnClient } from "../red-flags/ofac-sdn-client.js";
import type { GateCheckResult } from "./gate-types.js";

/**
 * Gate 2: OFAC Sanctions Check
 *
 * Checks the org name against the OFAC SDN (Specially Designated Nationals) list.
 *
 * Entity-type filtering: only fail on Entity-type SDN matches.
 * Individual-type matches on an org name are likely false positives
 * (e.g., org "John Smith Foundation" matching individual "John Smith").
 *
 * NOTE: Officer-level OFAC checks are deferred — ProPublica API summary
 * doesn't expose officer names. When added, the entity-type filter must
 * be revisited.
 */
export function checkOfacSanctions(
  orgName: string,
  ofacClient: OfacSdnClient,
): GateCheckResult {
  const result = ofacClient.check(orgName);

  if (!result.found) {
    return {
      gate: "ofac_sanctions",
      verdict: "PASS",
      detail: result.detail,
    };
  }

  // Filter: only Entity-type matches count for org-name searches
  const entityMatches = result.matches.filter(
    (m) => m.sdnType.toLowerCase() === "entity",
  );

  if (entityMatches.length === 0) {
    return {
      gate: "ofac_sanctions",
      verdict: "PASS",
      detail: `OFAC name match found but all matches are Individual-type (likely false positive for org search). ${result.matches.length} match(es) filtered out.`,
    };
  }

  return {
    gate: "ofac_sanctions",
    verdict: "FAIL",
    detail: `OFAC SDN MATCH — ${entityMatches.length} Entity-type sanctioned match(es) for "${orgName}"`,
  };
}
