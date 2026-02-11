import { vi } from "vitest";
import type {
  NonprofitProfile,
  VettingThresholds,
  PortfolioFitConfig,
  ProPublica990Filing,
  Latest990Summary,
  IrsRevocationRow,
  IrsRevocationResult,
  OfacSdnRow,
  OfacSanctionsResult,
  CourtListenerCase,
  CourtRecordsResult,
  Tier1Result,
} from "../src/domain/nonprofit/types.js";
import { loadThresholds } from "../src/core/config.js";

/**
 * Canonical defaults from config.ts — single source of truth.
 * Importing loadThresholds() ensures tests always match production defaults.
 */
export const DEFAULT_THRESHOLDS: VettingThresholds = loadThresholds();

/**
 * Build thresholds with specific overrides (defaults are valid).
 * Moved here so config.test.ts and scoring.test.ts can share it.
 */
export function makeThresholds(
  overrides: Partial<VettingThresholds>,
): VettingThresholds {
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

/**
 * Build tax_prd for filing N years before the "most recent" year.
 * taxPrdOffset(0) = this year's recent, taxPrdOffset(1) = prior year.
 */
export function taxPrdOffset(yearsBack: number): number {
  const baseYear = new Date().getFullYear() - 1;
  return (baseYear - yearsBack) * 100 + 6;
}

/** A recent tax period string for test filings */
function recentTaxPeriod(): string {
  const now = new Date();
  // Use last year to ensure it counts as "recent"
  return `${now.getFullYear() - 1}-06`;
}

/** A recent tax period number (YYYYMM) for raw ProPublica filings */
function recentTaxPrd(): number {
  const now = new Date();
  return (now.getFullYear() - 1) * 100 + 6; // e.g., 202506
}

/**
 * Build a healthy 990 summary. Override any fields as needed.
 */
export function make990(
  overrides?: Partial<Latest990Summary>,
): Latest990Summary {
  return {
    tax_period: recentTaxPeriod(),
    tax_year: new Date().getFullYear() - 1,
    form_type: "990",
    total_revenue: 500_000,
    total_expenses: 400_000,
    total_assets: 1_000_000,
    total_liabilities: 200_000,
    overhead_ratio: 0.8,
    officer_compensation_ratio: null,
    ...overrides,
  };
}

/**
 * Build a healthy nonprofit profile that passes all Tier 1 checks.
 * Override any fields to create specific test scenarios.
 */
export function makeProfile(
  overrides?: Partial<NonprofitProfile>,
): NonprofitProfile {
  return {
    ein: "95-3135649",
    name: "Test Nonprofit",
    address: { city: "Los Angeles", state: "CA" },
    ruling_date: "2010-01-01",
    years_operating: 15,
    subsection: "03",
    ntee_code: "K31",
    latest_990: make990(),
    filing_count: 5,
    ...overrides,
  };
}

/**
 * Build a raw ProPublica 990 filing record.
 */
export function makeFiling(
  overrides?: Partial<ProPublica990Filing>,
): ProPublica990Filing {
  return {
    tax_prd: recentTaxPrd(),
    tax_prd_yr: new Date().getFullYear() - 1,
    formtype: 1,
    totrevenue: 500_000,
    totfuncexpns: 400_000,
    totassetsend: 1_000_000,
    totliabend: 200_000,
    ...overrides,
  };
}

// ============================================================================
// IRS Fixtures (merged from red-flag-vetting-mcp)
// ============================================================================

export function makeIrsRow(
  overrides?: Partial<IrsRevocationRow>,
): IrsRevocationRow {
  return {
    ein: "123456789",
    legalName: "REVOKED NONPROFIT INC",
    dba: "",
    city: "NEW YORK",
    state: "NY",
    zip: "10001",
    country: "US",
    exemptionType: "03",
    revocationDate: "2022-05-15",
    postingDate: "2022-06-01",
    reinstatementDate: "",
    ...overrides,
  };
}

export function makeCleanIrsResult(): IrsRevocationResult {
  return {
    found: false,
    revoked: false,
    detail:
      "EIN not found in IRS auto-revocation list (good — no revocation on record)",
  };
}

export function makeRevokedIrsResult(): IrsRevocationResult {
  return {
    found: true,
    revoked: true,
    detail:
      "Tax-exempt status REVOKED on 2022-05-15 — failed to file Form 990 for 3 consecutive years",
    revocationDate: "2022-05-15",
    legalName: "REVOKED NONPROFIT INC",
  };
}

// ============================================================================
// OFAC Fixtures (merged from red-flag-vetting-mcp)
// ============================================================================

export function makeOfacRow(overrides?: Partial<OfacSdnRow>): OfacSdnRow {
  return {
    entNum: "12345",
    name: "BAD ACTOR FOUNDATION",
    sdnType: "Entity",
    program: "SDGT",
    title: "",
    remarks: "",
    ...overrides,
  };
}

export function makeCleanOfacResult(): OfacSanctionsResult {
  return {
    found: false,
    detail: "No OFAC SDN matches found (good — not on sanctions list)",
    matches: [],
  };
}

export function makeMatchedOfacResult(): OfacSanctionsResult {
  return {
    found: true,
    detail:
      'OFAC SDN MATCH — 1 sanctioned entity/entities found matching "Bad Actor Foundation"',
    matches: [
      {
        entNum: "12345",
        name: "BAD ACTOR FOUNDATION",
        sdnType: "Entity",
        program: "SDGT",
        matchedOn: "primary",
      },
    ],
  };
}

// ============================================================================
// Court Fixtures (merged from red-flag-vetting-mcp)
// ============================================================================

export function makeCourtCase(
  overrides?: Partial<CourtListenerCase>,
): CourtListenerCase {
  return {
    id: 99001,
    caseName: "USA v. Test Nonprofit Inc",
    court: "SDNY",
    dateArgued: null,
    dateFiled: "2024-06-01",
    docketNumber: "1:24-cv-01234",
    absoluteUrl: "/docket/99001/usa-v-test-nonprofit-inc/",
    ...overrides,
  };
}

export function makeCleanCourtResult(): CourtRecordsResult {
  return {
    found: false,
    detail: "No federal court records found (good)",
    caseCount: 0,
    cases: [],
  };
}

export function makeFlaggedCourtResult(caseCount = 2): CourtRecordsResult {
  const cases = Array.from({ length: caseCount }, (_, i) =>
    makeCourtCase({ id: 99001 + i, caseName: `Case ${i + 1}` }),
  );
  return {
    found: true,
    detail: `${caseCount} federal court case(s) found`,
    caseCount,
    cases,
  };
}

// ============================================================================
// Mock Store Factory (for IRS/OFAC client tests)
// ============================================================================

export function makeMockStore() {
  return {
    lookupEin: vi.fn().mockReturnValue(undefined),
    lookupName: vi.fn().mockReturnValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi
      .fn()
      .mockResolvedValue({ irs_refreshed: true, ofac_refreshed: true }),
  };
}

// ============================================================================
// Mock Client Factories (for gate + scoring integration tests)
// ============================================================================

/** IRS client that returns "not found" (clean) by default */
export function makeMockIrsClient() {
  return {
    check: vi.fn().mockReturnValue(makeCleanIrsResult()),
  };
}

/** OFAC client that returns "no matches" (clean) by default */
export function makeMockOfacClient() {
  return {
    check: vi.fn().mockReturnValue(makeCleanOfacResult()),
  };
}

// ============================================================================
// Portfolio-Fit Config Factory
// ============================================================================

export function makePortfolioFitConfig(
  overrides?: Partial<PortfolioFitConfig>,
): PortfolioFitConfig {
  return {
    enabled: true,
    allowedNteeCategories: ["A", "B", "E", "K", "L", "P", "S"],
    excludedEins: [],
    includedEins: [],
    ...overrides,
  };
}

// ============================================================================
// Tier 1 Result Factory (for VettingStore tests)
// ============================================================================

export function makeTier1Result(overrides?: Partial<Tier1Result>): Tier1Result {
  return {
    ein: "95-3135649",
    name: "Test Nonprofit",
    passed: true,
    gates: { all_passed: true, gates: [] },
    gate_blocked: false,
    score: 85,
    summary: {
      headline: "PASS — Strong indicators",
      justification: "Test nonprofit passes all checks.",
      key_factors: ["+ Years operating: 15"],
      next_steps: ["Schedule site visit"],
    },
    checks: [],
    recommendation: "PASS",
    review_reasons: [],
    red_flags: [],
    ...overrides,
  };
}
