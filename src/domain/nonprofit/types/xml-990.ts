// ============================================================================
// XML 990 Types — IRS e-file XML data extracted via GivingTuesday API
// ============================================================================

// ---------------------------------------------------------------------------
// Concordance (NOPDC Master Concordance CSV)
// ---------------------------------------------------------------------------

export interface ConcordanceEntry {
  xpath: string;
  variableName: string;
  relationship: "ONE" | "MANY";
  formType: string; // PC, EZ, PF
  formPart: string; // PART-06, PART-09, etc.
  dataType: "text" | "numeric" | "date" | "checkbox";
  versions: string[];
  currentVersion: boolean;
}

// ---------------------------------------------------------------------------
// GivingTuesday API
// ---------------------------------------------------------------------------

export interface GivingTuesdayConfig {
  apiBaseUrl: string;
  rateLimitMs: number;
  xmlCacheDir: string;
  maxXmlSizeBytes: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export interface GtApiResponse {
  statusCode: number;
  body: {
    query: string;
    no_results: number;
    results: GtFilingIndexEntry[];
  };
}

export interface GtFilingIndexEntry {
  ObjectId: string;
  EIN: string;
  FormType: string; // "990", "990EZ", "990PF"
  ReturnVersion: string; // "2021v4.2"
  TaxYear: string;
  TaxPeriod: string; // "2022-06-30"
  URL: string; // S3 direct link to XML
  OrganizationName: string;
  FileSizeBytes: string;
  FileSha256: string;
}

// ---------------------------------------------------------------------------
// Extracted XML Data
// ---------------------------------------------------------------------------

export interface Xml990ExtractedData {
  ein: string;
  taxYear: number;
  objectId: string;
  formType: string;
  schemaVersion: string;
  partIX: PartIXData | null;
  partVI: PartVIData | null;
  partVII: PartVIIEntry[];
  partVIII: PartVIIIData | null;
  extractedAt: string;
}

export interface PartIXData {
  totalExpenses: number;
  programServicesExpenses: number;
  managementAndGeneralExpenses: number;
  fundraisingExpenses: number;
  programExpenseRatio: number | null;
  fundraisingRatio: number | null;
  adminRatio: number | null;
  ratiosValid: boolean;
}

export interface PartVIData {
  votingMembersCount: number | null;
  independentMembersCount: number | null;
  familyOrBusinessRelationship: boolean | null;
  delegationOfMgmtDuties: boolean | null;
  conflictOfInterestPolicy: boolean | null;
  whistleblowerPolicy: boolean | null;
  documentRetentionPolicy: boolean | null;
  compensationProcessCEO: boolean | null;
  materialDiversionOfAssets: boolean | null;
}

export interface PartVIIEntry {
  name: string;
  title: string;
  avgHoursPerWeek: number | null;
  isTrusteeOrDirector: boolean;
  isOfficer: boolean;
  isKeyEmployee: boolean;
  reportableCompFromOrg: number;
  reportableCompFromRelated: number;
  otherCompensation: number;
}

export interface PartVIIIData {
  contributions: number;
  programServiceRevenue: number;
  investmentIncome: number;
  otherRevenue: number;
  totalRevenue: number;
  contributionDependence: number | null;
  programRevenueSelfSufficiency: number | null;
  ratiosValid: boolean;
}
