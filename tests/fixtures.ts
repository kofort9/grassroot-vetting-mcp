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
  ScreeningResult,
  GtFilingIndexEntry,
  GivingTuesdayConfig,
  Xml990ExtractedData,
  PartIXData,
  PartVIData,
  PartVIIEntry,
  PartVIIIData,
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
 * Build a healthy nonprofit profile that passes all screening checks.
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
    address: "123 MAIN ST",
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
    fuzzyLookupName: vi.fn().mockReturnValue([]),
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
    fuzzyCheck: vi.fn().mockReturnValue({
      found: false,
      detail: "No fuzzy OFAC matches",
      matches: [],
    }),
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
// Screening Result Factory (for VettingStore tests)
// ============================================================================

export function makeScreeningResult(overrides?: Partial<ScreeningResult>): ScreeningResult {
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

// ============================================================================
// XML 990 Fixtures
// ============================================================================

export function makeGtFilingEntry(
  overrides?: Partial<GtFilingIndexEntry>,
): GtFilingIndexEntry {
  return {
    ObjectId: "202301234567890123_public",
    EIN: "131624100",
    FormType: "990",
    ReturnVersion: "2021v4.2",
    TaxYear: "2022",
    TaxPeriod: "2022-06-30",
    URL: "https://irs-990-efiler-data.s3.amazonaws.com/xml/202301234567890123_public.xml",
    OrganizationName: "MUSEUM OF MODERN ART",
    FileSizeBytes: "245000",
    FileSha256: "abc123def456",
    ...overrides,
  };
}

export function makeGivingTuesdayConfig(
  overrides?: Partial<GivingTuesdayConfig>,
): GivingTuesdayConfig {
  return {
    apiBaseUrl: "https://990-infrastructure.gtdata.org",
    rateLimitMs: 200,
    xmlCacheDir: "/tmp/test-xml-cache",
    maxXmlSizeBytes: 25 * 1024 * 1024,
    maxRetries: 1,
    retryBackoffMs: 100,
    ...overrides,
  };
}

export function makePartIXData(
  overrides?: Partial<PartIXData>,
): PartIXData {
  return {
    totalExpenses: 400_000,
    programServicesExpenses: 320_000,
    managementAndGeneralExpenses: 60_000,
    fundraisingExpenses: 20_000,
    programExpenseRatio: 0.8,
    fundraisingRatio: 0.05,
    adminRatio: 0.15,
    ratiosValid: true,
    ...overrides,
  };
}

export function makePartVIData(
  overrides?: Partial<PartVIData>,
): PartVIData {
  return {
    votingMembersCount: 12,
    independentMembersCount: 10,
    familyOrBusinessRelationship: false,
    delegationOfMgmtDuties: false,
    conflictOfInterestPolicy: true,
    whistleblowerPolicy: true,
    documentRetentionPolicy: true,
    compensationProcessCEO: true,
    materialDiversionOfAssets: false,
    ...overrides,
  };
}

export function makePartVIIEntry(
  overrides?: Partial<PartVIIEntry>,
): PartVIIEntry {
  return {
    name: "Jane Doe",
    title: "Executive Director",
    avgHoursPerWeek: 40,
    isTrusteeOrDirector: false,
    isOfficer: true,
    isKeyEmployee: true,
    reportableCompFromOrg: 150_000,
    reportableCompFromRelated: 0,
    otherCompensation: 25_000,
    ...overrides,
  };
}

export function makePartVIIIData(
  overrides?: Partial<PartVIIIData>,
): PartVIIIData {
  return {
    contributions: 300_000,
    programServiceRevenue: 150_000,
    investmentIncome: 30_000,
    otherRevenue: 20_000,
    totalRevenue: 500_000,
    contributionDependence: 0.6,
    programRevenueSelfSufficiency: 0.3,
    ratiosValid: true,
    ...overrides,
  };
}

export function makeXml990ExtractedData(
  overrides?: Partial<Xml990ExtractedData>,
): Xml990ExtractedData {
  return {
    ein: "131624100",
    taxYear: 2022,
    objectId: "202301234567890123_public",
    formType: "990",
    schemaVersion: "2021v4.2",
    partIX: makePartIXData(),
    partVI: makePartVIData(),
    partVII: [makePartVIIEntry()],
    partVIII: makePartVIIIData(),
    extractedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal 990 XML string for parser unit tests */
export function makeMinimal990Xml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Return xmlns="http://www.irs.gov/efile" returnVersion="2021v4.2">
  <ReturnData>
    <IRS990>
      <TotalFunctionalExpensesGrp>
        <TotalAmt>400000</TotalAmt>
        <ProgramServicesAmt>320000</ProgramServicesAmt>
        <ManagementAndGeneralAmt>60000</ManagementAndGeneralAmt>
        <FundraisingAmt>20000</FundraisingAmt>
      </TotalFunctionalExpensesGrp>
      <GoverningBodyVotingMembersCnt>12</GoverningBodyVotingMembersCnt>
      <NbrIndependentVotingMembersCnt>10</NbrIndependentVotingMembersCnt>
      <FamilyOrBusinessRlnInd>false</FamilyOrBusinessRlnInd>
      <DelegationOfMgmtDutiesInd>false</DelegationOfMgmtDutiesInd>
      <ConflictOfInterestPolicyInd>true</ConflictOfInterestPolicyInd>
      <WhistleblowerPolicyInd>true</WhistleblowerPolicyInd>
      <DocumentRetentionPolicyInd>true</DocumentRetentionPolicyInd>
      <CompensationProcessCEOInd>true</CompensationProcessCEOInd>
      <MaterialDiversionOrMisuseInd>false</MaterialDiversionOrMisuseInd>
      <Form990PartVIISectionAGrp>
        <PersonNm>JANE DOE</PersonNm>
        <TitleTxt>EXECUTIVE DIRECTOR</TitleTxt>
        <AverageHoursPerWeekRt>40</AverageHoursPerWeekRt>
        <IndividualTrusteeOrDirectorInd>false</IndividualTrusteeOrDirectorInd>
        <OfficerInd>true</OfficerInd>
        <KeyEmployeeInd>true</KeyEmployeeInd>
        <ReportableCompFromOrgAmt>150000</ReportableCompFromOrgAmt>
        <ReportableCompFromRltdOrgAmt>0</ReportableCompFromRltdOrgAmt>
        <OtherCompensationAmt>25000</OtherCompensationAmt>
      </Form990PartVIISectionAGrp>
      <TotalContributionsAmt>300000</TotalContributionsAmt>
      <ProgramServiceRevenueGrp>
        <TotalRevenueColumnAmt>150000</TotalRevenueColumnAmt>
      </ProgramServiceRevenueGrp>
      <InvestmentIncomeGrp>
        <TotalRevenueColumnAmt>30000</TotalRevenueColumnAmt>
      </InvestmentIncomeGrp>
      <OtherRevenueGrp>
        <TotalRevenueColumnAmt>20000</TotalRevenueColumnAmt>
      </OtherRevenueGrp>
      <CYTotalRevenueAmt>500000</CYTotalRevenueAmt>
    </IRS990>
  </ReturnData>
</Return>`;
}
