import axios, { AxiosInstance, AxiosError } from "axios";
import { ProPublicaConfig } from "../../core/config.js";
import { logDebug, logError, logWarn } from "../../core/logging.js";
import { RateLimiter } from "../../core/rate-limiter.js";
import {
  ProPublicaSearchResponse,
  ProPublicaOrgDetailResponse,
  ProPublicaOrganization,
  ProPublica990Filing,
} from "./types.js";

/**
 * ProPublica Nonprofit Explorer API client
 *
 * API Documentation: https://projects.propublica.org/nonprofits/api
 * No authentication required, but attribution is mandatory.
 */
export class ProPublicaClient {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor(config: ProPublicaConfig) {
    this.rateLimiter = new RateLimiter(config.rateLimitMs);

    this.client = axios.create({
      baseURL: config.apiBaseUrl,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "nonprofit-vetting-mcp/1.0",
      },
      timeout: 30000, // 30 second timeout
    });

    // Request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logDebug(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => Promise.reject(error),
    );

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => {
        logDebug(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error: AxiosError) => {
        if (error.response) {
          logError(
            `API Error: ${error.response.status} ${error.config?.url}`,
            error.response.data,
          );
        } else if (error.request) {
          logError("API Error: No response received", error.message);
        } else {
          logError("API Error:", error.message);
        }
        return Promise.reject(error);
      },
    );
  }

  /**
   * Search for nonprofits by name
   *
   * @param query - Search query (name or keywords)
   * @param state - Optional state filter (2-letter code)
   * @param city - Optional city filter
   * @returns Array of matching organizations
   */
  async search(
    query: string,
    state?: string,
    city?: string,
  ): Promise<ProPublicaSearchResponse> {
    await this.rateLimiter.waitIfNeeded();

    // Build query parameters
    const params: Record<string, string> = { q: query };
    if (state) params.state = state.toUpperCase();
    // Note: ProPublica API doesn't have a city parameter, but we filter client-side
    // if needed

    try {
      const response = await this.client.get<ProPublicaSearchResponse>(
        "/search.json",
        { params },
      );

      let results = response.data.organizations || [];

      // Client-side city filter if provided (case-insensitive)
      if (city && results.length > 0) {
        const cityLower = city.toLowerCase();
        results = results.filter(
          (org) => org.city && org.city.toLowerCase().includes(cityLower),
        );
      }

      return {
        total_results: results.length,
        organizations: results,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // No results found
        return { total_results: 0, organizations: [] };
      }
      throw error;
    }
  }

  /**
   * Get detailed organization information including 990 filings
   *
   * @param ein - Employer Identification Number (with or without dash)
   * @returns Organization details with filings
   * @throws Error if EIN format is invalid
   */
  async getOrganization(
    ein: string,
  ): Promise<ProPublicaOrgDetailResponse | null> {
    await this.rateLimiter.waitIfNeeded();

    // Normalize EIN - remove dashes and whitespace
    const normalizedEin = ein.replace(/[-\s]/g, "");

    // Validate EIN is exactly 9 digits (security: prevent path injection)
    if (!/^\d{9}$/.test(normalizedEin)) {
      throw new Error("Invalid EIN format: expected 9 digits");
    }

    try {
      const response = await this.client.get<ProPublicaOrgDetailResponse>(
        `/organizations/${normalizedEin}.json`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logWarn(`Organization not found: ${ein}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Format EIN with standard dash (XX-XXXXXXX format)
   */
  static formatEin(ein: string | number): string {
    const einStr = String(ein).replace(/[-\s]/g, "").padStart(9, "0");
    return `${einStr.slice(0, 2)}-${einStr.slice(2)}`;
  }

  /**
   * Get the most recent 990 filing from a list
   */
  static getMostRecentFiling(
    filings: ProPublica990Filing[],
  ): ProPublica990Filing | null {
    if (!filings || filings.length === 0) return null;

    // Sort by tax period descending
    const sorted = [...filings].sort((a, b) => b.tax_prd - a.tax_prd);
    return sorted[0];
  }

  /**
   * Calculate expense efficiency ratio from 990 data
   *
   * NOTE: This is NOT true overhead (admin/fundraising costs).
   * ProPublica summary data doesn't separate program vs admin expenses.
   * This calculates: Total Expenses / Total Revenue
   *
   * For pass-through orgs (food banks, etc.), high ratio is actually GOOD.
   * True overhead analysis requires parsing the full 990 PDF.
   *
   * Returns null if calculation not possible
   */
  static calculateOverheadRatio(filing: ProPublica990Filing): number | null {
    const revenue = filing.totrevenue;
    const expenses = filing.totfuncexpns;

    // Guard against missing, zero, or negative revenue
    if (
      typeof revenue !== "number" ||
      !Number.isFinite(revenue) ||
      revenue <= 0
    ) {
      return null;
    }
    // Guard against missing or non-finite expenses
    if (typeof expenses !== "number" || !Number.isFinite(expenses)) {
      return null;
    }

    const ratio = expenses / revenue;
    return Number.isFinite(ratio) ? ratio : null;
  }

  /**
   * Parse ruling date to Date object
   * Handles formats: YYYY-MM-DD, YYYY-MM, YYYYMM
   */
  static parseRulingDate(rulingDate: string): Date | null {
    if (!rulingDate) return null;

    // Handle YYYY-MM-DD format (from org detail endpoint)
    const matchFull = rulingDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (matchFull) {
      const [, year, month, day] = matchFull;
      return new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
      );
    }

    // Handle YYYY-MM format
    const match = rulingDate.match(/^(\d{4})-(\d{2})$/);
    if (match) {
      const [, year, month] = match;
      return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    }

    // Handle YYYYMM format
    const match2 = rulingDate.match(/^(\d{4})(\d{2})$/);
    if (match2) {
      const [, year, month] = match2;
      return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    }

    return null;
  }

  /**
   * Get subsection code from organization (handles both API field names)
   * Returns "03" for 501(c)(3), etc.
   */
  static getSubsection(org: ProPublicaOrganization): string {
    // Org detail uses subsection_code, search uses subseccd
    const code = org.subsection_code ?? org.subseccd;
    if (code === undefined || code === null) return "";
    return String(code).padStart(2, "0");
  }

  /**
   * Calculate years operating from ruling date
   */
  static calculateYearsOperating(rulingDate: string): number | null {
    const date = this.parseRulingDate(rulingDate);
    if (!date || isNaN(date.getTime())) return null;

    const now = new Date();
    const years =
      (now.getTime() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return Number.isFinite(years) ? Math.floor(years) : null;
  }

  /**
   * Format tax period (YYYYMM) to human-readable string
   */
  static formatTaxPeriod(taxPrd: number): string {
    const str = String(taxPrd);
    const year = str.slice(0, 4);
    const month = str.slice(4, 6);
    return `${year}-${month}`;
  }

  /**
   * Get form type name from formtype number
   * ProPublica uses: 0/1 = 990, 2 = 990EZ, 3 = 990PF
   */
  static getFormTypeName(formtype: number): string {
    if (formtype === 0 || formtype === 1 || formtype === 990) return "990";
    if (formtype === 2) return "990EZ";
    if (formtype === 3) return "990PF";
    return `Form ${formtype}`;
  }
}
