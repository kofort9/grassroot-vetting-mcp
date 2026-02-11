import type { DiscoveryFilters, DiscoveryResult } from "./types.js";
import type { DiscoveryPipeline } from "./pipeline.js";
import type { DiscoveryIndex } from "../../data-sources/discovery-index.js";

export interface DiscoverNonprofitsArgs {
  state?: string;
  city?: string;
  ntee_categories?: string[];
  ntee_exclude?: string[];
  subsection?: number;
  min_ruling_year?: number;
  max_ruling_year?: number;
  name_contains?: string;
  portfolio_fit_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface RefreshDiscoveryIndexResult {
  success: boolean;
  row_count?: number;
  duration_ms?: number;
  error?: string;
}

/**
 * Discover nonprofits from the IRS BMF index.
 * Maps MCP tool args (snake_case) to pipeline filters (camelCase).
 */
export function discoverNonprofits(
  pipeline: DiscoveryPipeline,
  args: DiscoverNonprofitsArgs,
): {
  success: boolean;
  data?: DiscoveryResult;
  error?: string;
  attribution: string;
} {
  const filters: DiscoveryFilters = {
    state: args.state,
    city: args.city,
    nteeCategories: args.ntee_categories,
    nteeExclude: args.ntee_exclude,
    subsection: args.subsection,
    minRulingYear: args.min_ruling_year,
    maxRulingYear: args.max_ruling_year,
    nameContains: args.name_contains,
    portfolioFitOnly: args.portfolio_fit_only,
    limit: args.limit,
    offset: args.offset,
  };

  const result = pipeline.discover(filters);

  return {
    success: true,
    data: result,
    attribution: "IRS Exempt Organizations Business Master File (BMF)",
  };
}

/**
 * Refresh (rebuild) the discovery index by downloading fresh BMF data.
 */
export async function refreshDiscoveryIndex(
  discoveryIndex: DiscoveryIndex,
): Promise<{
  success: boolean;
  data?: RefreshDiscoveryIndexResult;
  error?: string;
  attribution: string;
}> {
  try {
    const result = await discoveryIndex.buildIndex();
    return {
      success: true,
      data: {
        success: true,
        row_count: result.rowCount,
        duration_ms: result.duration,
      },
      attribution: "IRS Exempt Organizations Business Master File (BMF)",
    };
  } catch (err) {
    return {
      success: false,
      error: `Index refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      attribution: "IRS Exempt Organizations Business Master File (BMF)",
    };
  }
}
