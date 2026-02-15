// ============================================================================
// Local Profile Builder
//
// Constructs a NonprofitProfile from BMF (DiscoveryCandidate) +
// GivingTuesday filing index + XML 990 extract — all local data.
// ============================================================================

import type { DiscoveryCandidate } from "../discovery/types.js";
import type {
  GtFilingIndexEntry,
  Xml990ExtractedData,
} from "./types/xml-990.js";
import type {
  NonprofitProfile,
  Latest990Summary,
} from "./types/profile.js";
import type { Filing990Summary } from "./types/filings.js";
import {
  formatEin,
  calculateYearsOperating,
  calculateOverheadRatio,
} from "./date-utils.js";

export interface LocalProfileResult {
  profile: NonprofitProfile;
  filingEntries: GtFilingIndexEntry[];
}

/**
 * Build a NonprofitProfile from local data sources.
 *
 * @param candidate  - BMF org record (structural data)
 * @param filings    - GivingTuesday filing index entries for this EIN
 * @param extract    - Parsed XML 990 extract (latest filing), or null if none
 */
export function buildProfileFromLocal(
  candidate: DiscoveryCandidate,
  filings: GtFilingIndexEntry[],
  extract: Xml990ExtractedData | null,
): LocalProfileResult {
  let latest990: Latest990Summary | null = null;

  if (extract) {
    const revenue = extract.partVIII?.totalRevenue ?? 0;
    const expenses = extract.partIX?.totalExpenses ?? 0;
    const overheadRatio = calculateOverheadRatio(revenue, expenses);
    const officerCompRatio = computeOfficerCompensationRatio(extract);

    // Map TaxPeriod from GivingTuesday format ("2022-06-30") to "YYYY-MM"
    const matchingFiling = filings.find(
      (f) => f.ObjectId === extract.objectId,
    );
    const taxPeriod = formatGtTaxPeriod(
      matchingFiling?.TaxPeriod,
      extract.taxYear,
    );

    latest990 = {
      tax_period: taxPeriod,
      tax_year: extract.taxYear,
      form_type: extract.formType,
      total_revenue: revenue,
      total_expenses: expenses,
      total_assets: 0, // Part X not yet parsed (BON-82)
      total_liabilities: 0, // Part X not yet parsed (BON-82)
      overhead_ratio: overheadRatio,
      officer_compensation_ratio: officerCompRatio,
      program_revenue: extract.partVIII?.programServiceRevenue,
      contributions: extract.partVIII?.contributions,
    };
  }

  const yearsOperating = candidate.ruling_date
    ? calculateYearsOperating(candidate.ruling_date)
    : null;

  const profile: NonprofitProfile = {
    ein: formatEin(candidate.ein),
    name: candidate.name,
    address: {
      city: candidate.city || "",
      state: candidate.state || "",
    },
    ruling_date: candidate.ruling_date || "",
    years_operating: yearsOperating,
    subsection: String(candidate.subsection).padStart(2, "0"),
    ntee_code: candidate.ntee_code || "",
    latest_990: latest990,
    filing_count: filings.length,
  };

  return { profile, filingEntries: filings };
}

/**
 * Build a minimal Filing990Summary[] adapter for the revenue decline check
 * in detectRedFlags(). Only populates the fields used by that check:
 * `tax_prd` (YYYYMM number) and `totrevenue`.
 */
export function buildFilingsAdapter(
  filings: GtFilingIndexEntry[],
  extracts: Map<string, Xml990ExtractedData>,
): Filing990Summary[] {
  return filings
    .map((f): Filing990Summary | null => {
      const extract = extracts.get(f.ObjectId);
      if (!extract) return null;

      // Convert TaxPeriod "2022-06-30" → YYYYMM number (202206)
      const taxPrdNum = gtTaxPeriodToYYYYMM(f.TaxPeriod);
      if (taxPrdNum === null) return null;

      return {
        tax_prd: taxPrdNum,
        tax_prd_yr: extract.taxYear,
        formtype: extract.formType === "990" ? 0 : extract.formType === "990EZ" ? 2 : 3,
        totrevenue: extract.partVIII?.totalRevenue ?? 0,
        totfuncexpns: extract.partIX?.totalExpenses ?? 0,
        totassetsend: 0,
        totliabend: 0,
      };
    })
    .filter((f): f is Filing990Summary => f !== null)
    .sort((a, b) => b.tax_prd - a.tax_prd);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Compute officer compensation ratio from XML Part VII.
 * Sum reportableCompFromOrg for all officers / total expenses.
 */
function computeOfficerCompensationRatio(
  extract: Xml990ExtractedData,
): number | null {
  const totalExpenses = extract.partIX?.totalExpenses;
  if (!totalExpenses || totalExpenses <= 0) return null;

  const officers = extract.partVII.filter(
    (e) => e.isOfficer || e.isTrusteeOrDirector || e.isKeyEmployee,
  );
  if (officers.length === 0) return null;

  const totalComp = officers.reduce(
    (sum, e) => sum + (e.reportableCompFromOrg ?? 0),
    0,
  );
  if (totalComp <= 0) return null;

  const ratio = totalComp / totalExpenses;
  return Number.isFinite(ratio) ? ratio : null;
}

/**
 * Convert GivingTuesday TaxPeriod ("2022-06-30") to YYYYMM number (202206).
 */
function gtTaxPeriodToYYYYMM(taxPeriod: string | undefined): number | null {
  if (!taxPeriod) return null;
  const match = taxPeriod.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return parseInt(match[1] + match[2], 10);
}

/**
 * Format GivingTuesday TaxPeriod to "YYYY-MM" for NonprofitProfile.
 * Falls back to tax year if TaxPeriod is unavailable.
 */
function formatGtTaxPeriod(
  taxPeriod: string | undefined,
  taxYear: number,
): string {
  if (taxPeriod) {
    const match = taxPeriod.match(/^(\d{4})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}`;
  }
  return `${taxYear}-12`;
}
