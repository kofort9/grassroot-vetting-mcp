// ============================================================================
// Discovery Pipeline Types
// ============================================================================

/**
 * Raw row from IRS Exempt Organizations Business Master File (BMF).
 * Source: https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 *
 * ~1.8M rows, updated monthly. No financials — purely structural data.
 */
export interface BmfRow {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
  subsection: number; // 3 = 501(c)(3)
  ruling_date: string; // YYYYMM format
}

/**
 * A nonprofit surfaced by the discovery pipeline — ready for optional vetting.
 * Lighter than NonprofitProfile (no financials, no 990 data).
 */
export interface DiscoveryCandidate {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
  subsection: number;
  ruling_date: string;
}

/**
 * Filters for the discover_nonprofits tool.
 * All fields optional — omitted fields are not filtered.
 */
export interface DiscoveryFilters {
  state?: string; // 2-letter state code
  city?: string; // City name (case-insensitive)
  nteeCategories?: string[]; // NTEE prefix matching (e.g., ["B", "N2"])
  nteeExclude?: string[]; // NTEE prefixes to exclude
  subsection?: number; // Filter by subsection (default: 3 for 501(c)(3))
  minRulingYear?: number; // Org must have ruling date >= this year
  maxRulingYear?: number; // Org must have ruling date <= this year
  nameContains?: string; // Substring match on org name
  portfolioFitOnly?: boolean; // Apply platform portfolio-fit filter (default: true)
  limit?: number; // Max results (default: 100, max: 500)
  offset?: number; // Pagination offset (default: 0)
}

/**
 * Result from the discovery pipeline.
 */
export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  total: number; // Total matching (before limit/offset)
  filters_applied: string[]; // Human-readable list of active filters
  index_stats: {
    total_orgs: number;
    last_updated: string | null;
  };
}

/**
 * Discovery index configuration.
 */
export interface DiscoveryIndexConfig {
  dataDir: string; // Where to store discovery-index.db + manifest
  bmfRegions: string[]; // Which BMF region files to download (default: all 4)
  dataMaxAgeDays: number; // Staleness threshold for auto-refresh
  maxOrgsPerQuery: number; // Hard cap on query results
}

/**
 * Manifest for tracking discovery index freshness.
 */
export interface DiscoveryManifest {
  bmf_index?: {
    built_at: string;
    row_count: number;
    regions_loaded: string[];
    source_urls: string[];
  };
}
