import { ProPublicaClient } from "./propublica-client.js";
import {
  NonprofitProfile,
  NonprofitSearchResult,
  SearchNonprofitResponse,
  ToolResponse,
  Tier1Result,
  RedFlagResult,
  Latest990Summary,
  VettingThresholds,
  ProPublicaOrgDetailResponse,
  ProPublica990Filing,
  CourtRecordsResult,
  PortfolioFitConfig,
} from "./types.js";
import { runTier1Checks, runRedFlagCheck } from "./scoring.js";
import { resolveThresholds } from "./sector-thresholds.js";
import { logDebug, logError } from "../../core/logging.js";
import type { IrsRevocationClient } from "../red-flags/irs-revocation-client.js";
import type { OfacSdnClient } from "../red-flags/ofac-sdn-client.js";
import type { CourtListenerClient } from "../red-flags/courtlistener-client.js";

const ATTRIBUTION =
  "Data provided by ProPublica Nonprofit Explorer (https://projects.propublica.org/nonprofits/)";

// Security: Input length limits to prevent DoS
const MAX_QUERY_LENGTH = 500;
const MAX_STATE_LENGTH = 2;
const MAX_CITY_LENGTH = 100;

// ============================================================================
// Tool Input Types
// ============================================================================

export interface SearchNonprofitInput {
  query: string;
  state?: string;
  city?: string;
}

export interface GetNonprofitProfileInput {
  ein: string;
}

export interface CheckTier1Input {
  ein: string;
}

export interface GetRedFlagsInput {
  ein: string;
}

// ============================================================================
// Shared Helper
// ============================================================================

function buildProfile(response: ProPublicaOrgDetailResponse): {
  profile: NonprofitProfile;
  filings: ProPublica990Filing[];
} {
  const org = response.organization;
  const filings = response.filings_with_data ?? [];
  const latestFiling = ProPublicaClient.getMostRecentFiling(filings);

  let latest990: Latest990Summary | null = null;
  if (latestFiling) {
    const overheadRatio = ProPublicaClient.calculateOverheadRatio(latestFiling);
    latest990 = {
      tax_period: ProPublicaClient.formatTaxPeriod(latestFiling.tax_prd),
      tax_year: latestFiling.tax_prd_yr,
      form_type: ProPublicaClient.getFormTypeName(latestFiling.formtype),
      total_revenue: latestFiling.totrevenue,
      total_expenses: latestFiling.totfuncexpns,
      total_assets: latestFiling.totassetsend,
      total_liabilities: latestFiling.totliabend,
      overhead_ratio: overheadRatio,
      officer_compensation_ratio: latestFiling.pct_compnsatncurrofcr ?? null,
      program_revenue: latestFiling.totprgmrevnue,
      contributions: latestFiling.totcntrbgfts,
    };
  }

  const yearsOperating = org.ruling_date
    ? ProPublicaClient.calculateYearsOperating(org.ruling_date)
    : null;

  const subsection = ProPublicaClient.getSubsection(org);
  const profile: NonprofitProfile = {
    ein: ProPublicaClient.formatEin(org.ein),
    name: org.name,
    address: {
      city: org.city || "",
      state: org.state || "",
    },
    ruling_date: org.ruling_date || "",
    years_operating: yearsOperating,
    subsection: subsection,
    ntee_code: org.ntee_code || "",
    latest_990: latest990,
    filing_count: filings.length,
  };

  return { profile, filings };
}

// ============================================================================
// Shared EIN Lookup Wrapper
// ============================================================================

/**
 * Wraps the common pattern: validate EIN → fetch org → build profile → run logic.
 * Handles try/catch, logging, attribution, and error responses uniformly.
 */
async function withEinLookup<T>(
  client: ProPublicaClient,
  ein: string,
  toolName: string,
  fn: (profile: NonprofitProfile, filings: ProPublica990Filing[]) => Promise<T>,
): Promise<ToolResponse<T>> {
  try {
    if (!ein) {
      return {
        success: false,
        error: "EIN parameter is required",
        attribution: ATTRIBUTION,
      };
    }

    logDebug(`${toolName} for EIN: ${ein}`);
    const response = await client.getOrganization(ein);

    if (!response) {
      return {
        success: false,
        error: `Organization not found with EIN: ${ein}`,
        attribution: ATTRIBUTION,
      };
    }

    const { profile, filings } = buildProfile(response);
    return {
      success: true,
      data: await fn(profile, filings),
      attribution: ATTRIBUTION,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${toolName} failed:`, message);
    return {
      success: false,
      error: `${toolName} failed: ${message}`,
      attribution: ATTRIBUTION,
    };
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * search_nonprofit - Search for nonprofits by name
 */
export async function searchNonprofit(
  client: ProPublicaClient,
  input: SearchNonprofitInput,
): Promise<ToolResponse<SearchNonprofitResponse>> {
  try {
    if (!input.query || input.query.trim().length === 0) {
      return {
        success: false,
        error: "Query parameter is required",
        attribution: ATTRIBUTION,
      };
    }

    // Security: Validate input lengths to prevent DoS
    if (input.query.length > MAX_QUERY_LENGTH) {
      return {
        success: false,
        error: `Query too long (max ${MAX_QUERY_LENGTH} characters)`,
        attribution: ATTRIBUTION,
      };
    }
    if (input.state && input.state.length > MAX_STATE_LENGTH) {
      return {
        success: false,
        error: `State must be 2-letter code`,
        attribution: ATTRIBUTION,
      };
    }
    if (input.city && input.city.length > MAX_CITY_LENGTH) {
      return {
        success: false,
        error: `City too long (max ${MAX_CITY_LENGTH} characters)`,
        attribution: ATTRIBUTION,
      };
    }

    logDebug(`Searching for nonprofits: "${input.query}"`);

    const response = await client.search(input.query, input.state, input.city);

    const results: NonprofitSearchResult[] = response.organizations.map(
      (org) => ({
        ein: ProPublicaClient.formatEin(org.ein),
        name: org.name,
        city: org.city || "",
        state: org.state || "",
        ntee_code: org.ntee_code || "",
      }),
    );

    return {
      success: true,
      data: {
        results,
        total: response.total_results,
        attribution: ATTRIBUTION,
      },
      attribution: ATTRIBUTION,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("searchNonprofit failed:", message);
    return {
      success: false,
      error: `Search failed: ${message}`,
      attribution: ATTRIBUTION,
    };
  }
}

/**
 * get_nonprofit_profile - Get detailed profile for a nonprofit
 */
export async function getNonprofitProfile(
  client: ProPublicaClient,
  input: GetNonprofitProfileInput,
): Promise<ToolResponse<NonprofitProfile>> {
  return withEinLookup(
    client,
    input.ein,
    "getNonprofitProfile",
    async (profile) => profile,
  );
}

/**
 * check_tier1 - Run Tier 1 vetting checks (gates → scoring → red flags)
 */
export async function checkTier1(
  client: ProPublicaClient,
  input: CheckTier1Input,
  thresholds: VettingThresholds,
  irsClient: IrsRevocationClient,
  ofacClient: OfacSdnClient,
  portfolioFitConfig: PortfolioFitConfig,
  courtClient?: CourtListenerClient,
): Promise<ToolResponse<Tier1Result>> {
  return withEinLookup(
    client,
    input.ein,
    "checkTier1",
    async (profile, filings) => {
      let courtResult: CourtRecordsResult | undefined;
      if (courtClient) {
        try {
          courtResult = await courtClient.searchByOrgName(profile.name);
        } catch (err) {
          logError(
            "Court record lookup failed (non-blocking):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return runTier1Checks(
        profile,
        filings,
        resolveThresholds(thresholds, profile.ntee_code),
        irsClient,
        ofacClient,
        portfolioFitConfig,
        courtResult,
      );
    },
  );
}

/**
 * get_red_flags - Get red flags for a nonprofit
 */
export async function getRedFlags(
  client: ProPublicaClient,
  input: GetRedFlagsInput,
  thresholds: VettingThresholds,
  courtClient?: CourtListenerClient,
  ofacClient?: OfacSdnClient,
): Promise<ToolResponse<RedFlagResult>> {
  return withEinLookup(
    client,
    input.ein,
    "getRedFlags",
    async (profile, filings) => {
      let courtResult: CourtRecordsResult | undefined;
      if (courtClient) {
        try {
          courtResult = await courtClient.searchByOrgName(profile.name);
        } catch (err) {
          logError(
            "Court record lookup failed (non-blocking):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return runRedFlagCheck(
        profile,
        filings,
        resolveThresholds(thresholds, profile.ntee_code),
        courtResult,
        ofacClient,
      );
    },
  );
}
