// ============================================================================
// ProPublica API Response Types (raw API shapes)
// ============================================================================

export interface ProPublicaSearchResponse {
  total_results: number;
  organizations: ProPublicaOrganization[];
}

export interface ProPublicaOrganization {
  ein: number;
  name: string;
  city: string;
  state: string;
  ntee_code: string | null;
  // Search results use `subseccd`, org detail uses `subsection_code`
  subseccd?: number; // 3 = 501(c)(3) - from search results
  subsection_code?: number; // 3 = 501(c)(3) - from org detail
  ruling_date: string; // YYYY-MM-DD format
  totrevenue?: number;
  totfuncexpns?: number;
  totassetsend?: number;
  pf_asset_val?: number;
}

export interface ProPublicaOrgDetailResponse {
  organization: ProPublicaOrganization;
  filings_with_data: ProPublica990Filing[];
}

export interface ProPublica990Filing {
  tax_prd: number; // Tax period as YYYYMM
  tax_prd_yr: number; // Tax year
  formtype: number; // 990, 990EZ, 990PF
  totrevenue: number;
  totfuncexpns: number;
  totassetsend: number;
  totliabend: number;
  pct_compnsatncurrofcr?: number;
  totcntrbgfts?: number;
  totprgmrevnue?: number;
  invstmntinc?: number;
  txexmptbndsproceeds?: number;
  royaltsinc?: number;
  grsrntsreal?: number;
  grsrntsprsnl?: number;
  raboression?: number;
  grsalesecur?: number;
  grsalesothr?: number;
  totnetassetend?: number;
  pdf_url?: string;
}

// ============================================================================
// Domain Types (cleaned up for tool responses)
// ============================================================================

export interface NonprofitSearchResult {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
}

export interface NonprofitAddress {
  city: string;
  state: string;
}

export interface Latest990Summary {
  tax_period: string;
  tax_year: number;
  form_type: string;
  total_revenue: number;
  total_expenses: number;
  total_assets: number;
  total_liabilities: number;
  overhead_ratio: number | null; // null when calculation not possible
  officer_compensation_ratio: number | null; // null when data unavailable
  program_revenue?: number;
  contributions?: number;
}

export interface NonprofitProfile {
  ein: string;
  name: string;
  address: NonprofitAddress;
  ruling_date: string;
  years_operating: number | null; // null when ruling date unavailable
  subsection: string;
  ntee_code: string;
  latest_990: Latest990Summary | null;
  filing_count: number;
}

// ============================================================================
// Tier 1 Check Types
// ============================================================================

export type CheckResult = "PASS" | "REVIEW" | "FAIL";

export interface Tier1Check {
  name: string;
  passed: boolean;
  result: CheckResult;
  detail: string;
  weight: number;
}

export interface Tier1Summary {
  headline: string;
  justification: string;
  key_factors: string[]; // Prefixed: "+" positive, "-" negative, "~" neutral/warning
  next_steps: string[];
}

export interface Tier1Result {
  ein: string;
  name: string;
  passed: boolean;
  gates: import("../gates/gate-types.js").GateLayerResult;
  gate_blocked: boolean;
  score: number | null; // null when gate-blocked
  summary: Tier1Summary;
  checks: Tier1Check[] | null; // null when gate-blocked
  recommendation: "PASS" | "REVIEW" | "REJECT";
  review_reasons: string[];
  red_flags: RedFlag[];
}

// ============================================================================
// Red Flag Types
// ============================================================================

export type RedFlagSeverity = "HIGH" | "MEDIUM";

export type RedFlagType =
  | "stale_990"
  | "low_fund_deployment"
  | "very_high_overhead"
  | "very_low_revenue"
  | "revenue_decline"
  | "too_new"
  | "high_officer_compensation"
  | "court_records";

export interface RedFlag {
  severity: RedFlagSeverity;
  type: RedFlagType;
  detail: string;
}

export interface RedFlagResult {
  ein: string;
  name: string;
  flags: RedFlag[];
  clean: boolean;
}

// ============================================================================
// Vetting Thresholds (Configurable via Environment Variables)
// ============================================================================

export interface VettingThresholds {
  // Check weights (4 checks x 25 = 100; 501c3 moved to gate layer)
  weightYearsOperating: number;
  weightRevenueRange: number;
  weightOverheadRatio: number;
  weightRecent990: number;

  // Years operating
  yearsPassMin: number; // >= this = PASS (default: 3)
  yearsReviewMin: number; // >= this = REVIEW (default: 1)

  // Revenue range ($)
  revenueFailMin: number; // < this = FAIL (default: 50000)
  revenuePassMin: number; // >= this = PASS lower bound (default: 100000)
  revenuePassMax: number; // <= this = PASS upper bound (default: 10000000)
  revenueReviewMax: number; // <= this = REVIEW upper bound (default: 50000000)

  // Expense-to-revenue ratio
  expenseRatioPassMin: number; // lower bound of healthy range (default: 0.70)
  expenseRatioPassMax: number; // upper bound of healthy range (default: 1.0)
  expenseRatioHighReview: number; // above passMax, up to this = REVIEW (default: 1.2)
  expenseRatioLowReview: number; // below passMin, down to this = REVIEW (default: 0.5)

  // 990 filing recency (years)
  filing990PassMax: number; // <= this = PASS (default: 2)
  filing990ReviewMax: number; // <= this = REVIEW (default: 3)

  // Score-based recommendation cutoffs
  scorePassMin: number; // >= this = PASS (default: 75)
  scoreReviewMin: number; // >= this = REVIEW (default: 50)

  // Red flag thresholds
  redFlagStale990Years: number; // 990 older than this = HIGH flag (default: 4)
  redFlagHighExpenseRatio: number; // above this = HIGH flag (default: 1.2)
  redFlagLowExpenseRatio: number; // below this = MEDIUM flag (default: 0.5)
  redFlagVeryLowRevenue: number; // below this = MEDIUM flag (default: 25000)
  redFlagRevenueDeclinePercent: number; // decline > this = MEDIUM flag (default: 0.2)
  redFlagTooNewYears: number; // operating < this = MEDIUM flag (default: 1)

  // Officer compensation thresholds (decimal: 0.40 = 40%)
  redFlagHighCompensation: number; // above this = HIGH flag (default: 0.40)
  redFlagModerateCompensation: number; // above this = MEDIUM flag (default: 0.25)
}

// ============================================================================
// IRS Revocation Types (merged from red-flag-vetting-mcp)
// ============================================================================

export interface IrsRevocationRow {
  ein: string;
  legalName: string;
  dba: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  exemptionType: string;
  revocationDate: string;
  postingDate: string;
  reinstatementDate: string;
}

export interface IrsRevocationResult {
  found: boolean;
  revoked: boolean;
  detail: string;
  revocationDate?: string;
  reinstatementDate?: string;
  legalName?: string;
}

// ============================================================================
// OFAC SDN Types (merged from red-flag-vetting-mcp)
// ============================================================================

export interface OfacSdnRow {
  entNum: string;
  name: string;
  sdnType: string;
  program: string;
  title: string;
  remarks: string;
}

export interface OfacAltRow {
  entNum: string;
  altNum: string;
  altType: string;
  altName: string;
  altRemarks: string;
}

export interface OfacMatch {
  entNum: string;
  name: string;
  sdnType: string;
  program: string;
  matchedOn: string; // 'primary' | 'alias'
}

export interface OfacSanctionsResult {
  found: boolean;
  detail: string;
  matches: OfacMatch[];
}

// ============================================================================
// CourtListener Types (merged from red-flag-vetting-mcp)
// ============================================================================

export interface CourtListenerCase {
  id: number;
  caseName: string;
  court: string;
  dateArgued: string | null;
  dateFiled: string | null;
  docketNumber: string;
  absoluteUrl: string;
}

export interface CourtRecordsResult {
  found: boolean;
  detail: string;
  caseCount: number;
  cases: CourtListenerCase[];
}

// ============================================================================
// Data Manifest (tracks CSV freshness)
// ============================================================================

export interface DataManifest {
  irs_revocation?: {
    downloaded_at: string;
    row_count: number;
  };
  ofac_sdn?: {
    downloaded_at: string;
    sdn_count: number;
    alt_count: number;
  };
}

// ============================================================================
// Tool Response Wrappers
// ============================================================================

export interface SearchNonprofitResponse {
  results: NonprofitSearchResult[];
  total: number;
  attribution: string;
}

export interface ToolResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  attribution: string;
}
