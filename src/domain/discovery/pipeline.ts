import type { PortfolioFitConfig } from "../nonprofit/types.js";
import type { DiscoveryFilters, DiscoveryResult } from "./types.js";
import type { DiscoveryIndex } from "../../data-sources/discovery-index.js";
import { matchesNteeCategory } from "../gates/portfolio-fit-utils.js";

const DEFAULT_SUBSECTION = 3; // 501(c)(3)
const DEFAULT_LIMIT = 100;

/**
 * Discovery Pipeline — applies platform business rules on top of the raw index.
 *
 * Flow: user filters → portfolio-fit NTEE scope → DiscoveryIndex.query() → results
 *
 * The pipeline's main value-add over raw index queries is:
 * 1. Applying portfolio-fit NTEE allowlist (same logic as Gate 4)
 * 2. Defaulting to 501(c)(3) subsection
 * 3. Providing a clean API for MCP tools
 */
export class DiscoveryPipeline {
  private index: DiscoveryIndex;
  private portfolioFitConfig: PortfolioFitConfig;

  constructor(index: DiscoveryIndex, portfolioFitConfig: PortfolioFitConfig) {
    this.index = index;
    this.portfolioFitConfig = portfolioFitConfig;
  }

  /**
   * Discover nonprofits matching the given filters.
   * Applies portfolio-fit NTEE scope by default (portfolioFitOnly defaults true).
   */
  discover(filters: DiscoveryFilters): DiscoveryResult {
    const resolvedFilters = this.resolveFilters(filters);

    // If user requested specific NTEE categories but none survived the
    // portfolio-fit intersection, return empty rather than unfiltered results.
    if (
      filters.nteeCategories &&
      filters.nteeCategories.length > 0 &&
      resolvedFilters.nteeCategories &&
      resolvedFilters.nteeCategories.length === 0
    ) {
      const stats = this.index.getStats();
      return {
        candidates: [],
        total: 0,
        filters_applied: [
          `ntee_include=[${filters.nteeCategories.join(",")}] (none within portfolio scope)`,
        ],
        index_stats: {
          total_orgs: stats.totalOrgs,
          last_updated: stats.lastUpdated,
        },
      };
    }

    return this.index.query(resolvedFilters);
  }

  /**
   * Resolve user-provided filters with platform defaults.
   * Merges portfolio-fit NTEE scope when portfolioFitOnly is true.
   */
  private resolveFilters(filters: DiscoveryFilters): DiscoveryFilters {
    const resolved: DiscoveryFilters = { ...filters };

    // Default to 501(c)(3). Subsection 0 means "all" (no filter).
    if (resolved.subsection === undefined) {
      resolved.subsection = DEFAULT_SUBSECTION;
    } else if (resolved.subsection === 0) {
      resolved.subsection = undefined;
    }

    // Default limit
    if (resolved.limit === undefined) {
      resolved.limit = DEFAULT_LIMIT;
    }

    // Apply portfolio-fit NTEE scope (default: true)
    const applyPortfolioFit = resolved.portfolioFitOnly !== false;

    if (applyPortfolioFit && this.portfolioFitConfig.enabled) {
      resolved.nteeCategories = this.mergeNteeFilters(
        resolved.nteeCategories,
        this.portfolioFitConfig.allowedNteeCategories,
      );

      // Portfolio-fit excluded NTEE categories (Q, T, V, X, Y, Z by default)
      // are added to nteeExclude — they're outside the platform scope.
      // Note: We don't need explicit exclude here because the allowlist is
      // already restrictive. Only add user-specified excludes.
    }

    return resolved;
  }

  /**
   * Merge user-specified NTEE filters with platform allowlist.
   *
   * If user specifies categories, intersect with platform allowlist.
   * If user doesn't specify, use the full platform allowlist.
   */
  private mergeNteeFilters(
    userCategories: string[] | undefined,
    platformAllowlist: string[],
  ): string[] {
    if (!userCategories || userCategories.length === 0) {
      // No user filter → use full platform allowlist
      return platformAllowlist;
    }

    // User specified categories → intersect with platform allowlist
    // Keep only user categories that match at least one platform prefix
    return userCategories.filter(
      (userCat) =>
        matchesNteeCategory(userCat, platformAllowlist) ||
        platformAllowlist.some((platformCat) =>
          platformCat.toUpperCase().startsWith(userCat.toUpperCase()),
        ),
    );
  }
}
