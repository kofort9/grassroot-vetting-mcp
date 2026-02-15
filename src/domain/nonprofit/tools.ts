// ============================================================================
// Local Data Entry Points
//
// Entry points using BMF + GivingTuesday XML data.
// Uses the same scoring engine — only the data source changes.
//
// Shared helper: resolveLocalProfile() does BMF lookup → GT filing index →
// XML extract → buildProfileFromLocal(). Public functions are thin wrappers.
// ============================================================================

import type {
  ToolResponse,
  ScreeningResult,
  NonprofitProfile,
  VettingThresholds,
  PortfolioFitConfig,
  CourtRecordsResult,
  Filing990Summary,
  RedFlagResult,
} from "./types.js";
import type { GtFilingIndexEntry, Xml990ExtractedData } from "./types/xml-990.js";
import type { IrsRevocationClient } from "../red-flags/irs-revocation-client.js";
import type { OfacSdnClient } from "../red-flags/ofac-sdn-client.js";
import type { CourtListenerClient } from "../red-flags/courtlistener-client.js";
import type { DiscoveryIndex } from "../../data-sources/discovery-index.js";
import type { Xml990Store } from "../../data-sources/xml-990-store.js";
import type { GivingTuesdayClient } from "../../data-sources/givingtuesday-client.js";
import type { ConcordanceIndex } from "../../data-sources/concordance.js";
import { Xml990Parser } from "./xml-parser.js";
import { buildProfileFromLocal, buildFilingsAdapter } from "./local-profile-builder.js";
import { runFullScreening, runRedFlagCheck } from "./scoring.js";
import { resolveThresholds } from "./sector-thresholds.js";
import { logDebug, logError } from "../../core/logging.js";

const ATTRIBUTION =
  "Data provided by IRS BMF + GivingTuesday Data Commons (ODbL 1.0)";

export interface LocalScreeningDeps {
  discoveryIndex: DiscoveryIndex;
  givingTuesdayClient: GivingTuesdayClient;
  xml990Store: Xml990Store;
  concordance: ConcordanceIndex;
  thresholds: VettingThresholds;
  irsClient: IrsRevocationClient;
  ofacClient: OfacSdnClient;
  portfolioFitConfig: PortfolioFitConfig;
  courtClient?: CourtListenerClient;
}

// ============================================================================
// Shared Helper: Resolve profile from local data
// ============================================================================

interface LocalProfileResolution {
  profile: NonprofitProfile;
  filings: GtFilingIndexEntry[];
  filingsAdapter: Filing990Summary[] | undefined;
}

/**
 * Resolve a NonprofitProfile from local data sources (BMF + GivingTuesday).
 *
 * Steps:
 * 1. BMF lookup via discoveryIndex.getByEin()
 * 2. Fetch GivingTuesday filing index
 * 3. Get or build latest XML extract (fetch+parse on cache miss)
 * 4. buildProfileFromLocal()
 * 5. buildRevenueDeclineAdapter()
 */
async function resolveLocalProfile(
  ein: string,
  deps: LocalScreeningDeps,
): Promise<ToolResponse<LocalProfileResolution>> {
  if (!ein) {
    return {
      success: false,
      error: "EIN parameter is required",
      attribution: ATTRIBUTION,
    };
  }

  // 1. BMF lookup
  const candidate = deps.discoveryIndex.getByEin(ein);
  if (!candidate) {
    return {
      success: false,
      error: `Organization not found in BMF index with EIN: ${ein}`,
      attribution: ATTRIBUTION,
    };
  }

  // 2. GivingTuesday filing index
  const filings = await deps.givingTuesdayClient.getFilingIndex(ein);

  // 3. Latest XML extract (fetch+parse on cache miss)
  let latestExtract = deps.xml990Store.getLatestExtract(ein);
  if (!latestExtract && filings.length > 0) {
    latestExtract = await fetchAndParseNthFiling(ein, filings, 0, deps);
  }

  // 4. Build profile
  const { profile } = buildProfileFromLocal(candidate, filings, latestExtract);

  // 5. Revenue decline adapter
  const filingsAdapter = buildRevenueDeclineAdapter(ein, filings, deps);

  return {
    success: true,
    data: { profile, filings, filingsAdapter },
    attribution: ATTRIBUTION,
  };
}

// ============================================================================
// Public Entry Points
// ============================================================================

/**
 * Screen a nonprofit using local data (BMF + GivingTuesday XML).
 * Resolves profile, then runs full screening pipeline.
 */
export async function screenNonprofitLocal(
  ein: string,
  deps: LocalScreeningDeps,
): Promise<ToolResponse<ScreeningResult>> {
  try {
    logDebug(`screenNonprofitLocal for EIN: ${ein}`);

    const resolved = await resolveLocalProfile(ein, deps);
    if (!resolved.success || !resolved.data) {
      return { success: false, error: resolved.error!, attribution: ATTRIBUTION };
    }

    const { profile, filingsAdapter } = resolved.data;
    const courtResult = await tryCourtLookup(deps, profile.name);

    const result = runFullScreening(
      profile,
      filingsAdapter,
      resolveThresholds(deps.thresholds, profile.ntee_code),
      deps.irsClient,
      deps.ofacClient,
      deps.portfolioFitConfig,
      courtResult,
    );

    return { success: true, data: result, attribution: ATTRIBUTION };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("screenNonprofitLocal failed:", message);
    return {
      success: false,
      error: `screenNonprofitLocal failed: ${message}`,
      attribution: ATTRIBUTION,
    };
  }
}

/**
 * Get a nonprofit profile using local data (BMF + GivingTuesday XML).
 * Thin wrapper around resolveLocalProfile().
 */
export async function getNonprofitProfileLocal(
  ein: string,
  deps: LocalScreeningDeps,
): Promise<ToolResponse<NonprofitProfile>> {
  try {
    logDebug(`getNonprofitProfileLocal for EIN: ${ein}`);

    const resolved = await resolveLocalProfile(ein, deps);
    if (!resolved.success || !resolved.data) {
      return { success: false, error: resolved.error!, attribution: ATTRIBUTION };
    }

    return { success: true, data: resolved.data.profile, attribution: ATTRIBUTION };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("getNonprofitProfileLocal failed:", message);
    return {
      success: false,
      error: `getNonprofitProfileLocal failed: ${message}`,
      attribution: ATTRIBUTION,
    };
  }
}

/**
 * Get red flags for a nonprofit using local data.
 *
 * Revenue decline fix: If filingsAdapter is undefined (only 1 XML cached)
 * but the GT filing index has 2+ entries, fetch+parse the second-most-recent
 * XML filing to enable revenue decline detection.
 */
export async function getRedFlagsLocal(
  ein: string,
  deps: LocalScreeningDeps,
): Promise<ToolResponse<RedFlagResult>> {
  try {
    logDebug(`getRedFlagsLocal for EIN: ${ein}`);

    const resolved = await resolveLocalProfile(ein, deps);
    if (!resolved.success || !resolved.data) {
      return { success: false, error: resolved.error!, attribution: ATTRIBUTION };
    }

    const { profile, filings } = resolved.data;
    let { filingsAdapter } = resolved.data;

    // Revenue decline fix: ensure 2+ XML extracts for decline detection
    if (!filingsAdapter && filings.length >= 2) {
      await fetchAndParseNthFiling(ein, filings, 1, deps);
      filingsAdapter = buildRevenueDeclineAdapter(ein, filings, deps);
    }

    const courtResult = await tryCourtLookup(deps, profile.name);

    const result = runRedFlagCheck(
      profile,
      filingsAdapter,
      resolveThresholds(deps.thresholds, profile.ntee_code),
      courtResult,
      deps.ofacClient,
    );

    return { success: true, data: result, attribution: ATTRIBUTION };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("getRedFlagsLocal failed:", message);
    return {
      success: false,
      error: `getRedFlagsLocal failed: ${message}`,
      attribution: ATTRIBUTION,
    };
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Non-blocking court record lookup. Returns undefined on failure.
 */
async function tryCourtLookup(
  deps: LocalScreeningDeps,
  orgName: string,
): Promise<CourtRecordsResult | undefined> {
  if (!deps.courtClient) return undefined;
  try {
    return await deps.courtClient.searchByOrgName(orgName);
  } catch (err) {
    logError(
      "Court record lookup failed (non-blocking):",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

/**
 * Sort filings by TaxYear desc, preferring full 990 over 990EZ/PF within the same year.
 */
function sortFilings(filings: GtFilingIndexEntry[]): GtFilingIndexEntry[] {
  return [...filings].sort((a, b) => {
    const yearDiff = parseInt(b.TaxYear, 10) - parseInt(a.TaxYear, 10);
    if (yearDiff !== 0) return yearDiff;
    // Within same year, prefer full 990 over EZ/PF
    const aIs990 = a.FormType === "990" ? 0 : 1;
    const bIs990 = b.FormType === "990" ? 0 : 1;
    if (aIs990 !== bIs990) return aIs990 - bIs990;
    return b.TaxPeriod.localeCompare(a.TaxPeriod);
  });
}

/**
 * Download and parse the Nth filing (0-indexed from sorted order).
 */
async function fetchAndParseNthFiling(
  ein: string,
  filings: GtFilingIndexEntry[],
  n: number,
  deps: LocalScreeningDeps,
): Promise<Xml990ExtractedData | null> {
  try {
    const ranked = sortFilings(filings);
    const target = ranked[n];
    if (!target) return null;

    // Skip if already extracted
    if (deps.xml990Store.hasExtract(ein, target.ObjectId)) return null;

    const xml = await deps.givingTuesdayClient.downloadXml(target);
    const parser = new Xml990Parser(deps.concordance);
    const extract = parser.parse(xml, {
      objectId: target.ObjectId,
      ein: target.EIN,
      formType: target.FormType,
      taxYear: parseInt(target.TaxYear, 10),
      schemaVersion: target.ReturnVersion,
    });

    if (extract) {
      deps.xml990Store.saveMetadata(target);
      deps.xml990Store.saveExtract(extract);
    }

    return extract;
  } catch (err) {
    logError(
      `Failed to fetch/parse XML for ${ein}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Build a Filing990Summary[] adapter from all available XML extracts
 * for the revenue decline check in detectRedFlags().
 */
function buildRevenueDeclineAdapter(
  ein: string,
  filings: GtFilingIndexEntry[],
  deps: LocalScreeningDeps,
): Filing990Summary[] | undefined {
  const allExtracts = deps.xml990Store.getAllExtracts(ein);
  if (allExtracts.length < 2) return undefined;

  const extractMap = new Map<string, Xml990ExtractedData>();
  for (const ex of allExtracts) {
    extractMap.set(ex.objectId, ex);
  }

  const adapted = buildFilingsAdapter(filings, extractMap);
  return adapted.length >= 2 ? adapted : undefined;
}
