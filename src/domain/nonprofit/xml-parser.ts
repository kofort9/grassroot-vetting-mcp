import { XMLParser } from "fast-xml-parser";
import { logDebug, logWarn } from "../../core/logging.js";
import type { ConcordanceIndex } from "../../data-sources/concordance.js";
import type {
  Xml990ExtractedData,
  PartIXData,
  PartVIData,
  PartVIIEntry,
  PartVIIIData,
} from "./types.js";

// Tags that can appear 0-N times (Part VII officers, Schedule I grantees, etc.)
const REPEATING_GROUP_TAGS = new Set([
  "Form990PartVIISectionAGrp",
  "RecipientTable",
  "OfficerDirectorTrusteeEmplGrp",
  "CompensationOfHghstPdEmplGrp",
  "ContractorCompensationGrp",
]);

// ============================================================================
// Type coercion functions
// ============================================================================

export function coerceNumeric(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const str = String(value).replace(/,/g, "").trim();
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

export function coerceBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  const str = String(value).toLowerCase().trim();
  if (["true", "1", "x", "yes"].includes(str)) return true;
  if (["false", "0", "", "no"].includes(str)) return false;
  return null;
}

export function coerceText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

// ============================================================================
// Variable name mappings for each Part
// These map our target fields to NOPDC concordance variable names.
// ============================================================================

const PART_IX_VARS: Record<string, string> = {
  totalExpenses: "F9_09_TOT_FUNC_EXPNS_TOT",
  programServicesExpenses: "F9_09_TOT_FUNC_EXPNS_PROGSRVC",
  managementAndGeneralExpenses: "F9_09_TOT_FUNC_EXPNS_MGMTGNRL",
  fundraisingExpenses: "F9_09_TOT_FUNC_EXPNS_FNDRSNG",
};

const PART_VI_VARS: Record<string, string> = {
  votingMembersCount: "F9_06_GVRN_NUM_VOTING_MMBRS",
  independentMembersCount: "F9_06_GVRN_NUM_IND_VOTING_MMBRS",
  familyOrBusinessRelationship: "F9_06_GVRN_FMLY_OR_BZNS_RLTNSHP",
  delegationOfMgmtDuties: "F9_06_GVRN_DLGT_MGMT_DUTIES",
  conflictOfInterestPolicy: "F9_06_POL_CNFLCT_INTRST_PLCY",
  whistleblowerPolicy: "F9_06_POL_WHSTLBLWR_PLCY",
  documentRetentionPolicy: "F9_06_POL_DOC_RTNTN_PLCY",
  compensationProcessCEO: "F9_06_POL_COMP_PROCESS_CEO",
  materialDiversionOfAssets: "F9_06_DSCL_MATRL_DVRSN",
};

const PART_VIII_VARS: Record<string, string> = {
  contributions: "F9_08_REV_CONTR_TOT",
  programServiceRevenue: "F9_08_REV_PROG_SRVC_TOT",
  investmentIncome: "F9_08_REV_INVST_INCM_TOT",
  otherRevenue: "F9_08_REV_OTH_TOT",
  totalRevenue: "F9_08_REV_TOT_TOT",
};

// Part VII uses repeating groups — handled separately

// ============================================================================
// Xml990Parser
// ============================================================================

export class Xml990Parser {
  private concordance: ConcordanceIndex;
  private xmlParser: XMLParser;

  constructor(concordance: ConcordanceIndex) {
    this.concordance = concordance;
    this.xmlParser = new XMLParser({
      processEntities: false, // P0: prevent XXE / billion laughs
      removeNSPrefix: true, // Strip XML namespace prefixes (real IRS filings use xmlns)
      ignoreAttributes: false,
      isArray: (tagName: string) => REPEATING_GROUP_TAGS.has(tagName),
      parseTagValue: false, // we handle type coercion ourselves
      trimValues: true,
    });
  }

  parse(
    xmlString: string,
    metadata: { formType: string; schemaVersion: string; ein: string; taxYear: number; objectId: string },
  ): Xml990ExtractedData {
    const parsed = this.xmlParser.parse(xmlString);

    // Navigate to the Return/ReturnData section
    const returnData = this.getReturnData(parsed);
    if (!returnData) {
      logWarn(`No ReturnData found in XML for EIN ${metadata.ein}`);
      return this.emptyExtract(metadata);
    }

    // Locate the form data node (IRS990, IRS990EZ, or IRS990PF)
    const form990 = (
      returnData["IRS990"] ??
      returnData["IRS990EZ"] ??
      returnData["IRS990PF"] ??
      null
    ) as Record<string, unknown> | null;

    const extract: Xml990ExtractedData = {
      ein: metadata.ein,
      taxYear: metadata.taxYear,
      objectId: metadata.objectId,
      formType: metadata.formType,
      schemaVersion: metadata.schemaVersion,
      partIX: this.extractPartIX(form990, metadata.schemaVersion),
      partVI: this.extractPartVI(form990, metadata.schemaVersion),
      partVII: this.extractPartVII(form990, metadata.schemaVersion),
      partVIII: this.extractPartVIII(form990, metadata.schemaVersion),
      extractedAt: new Date().toISOString(),
    };

    logDebug(
      `Parsed EIN ${metadata.ein} (schema ${metadata.schemaVersion}): ` +
      `IX=${extract.partIX ? "yes" : "null"} VI=${extract.partVI ? "yes" : "null"} ` +
      `VII=${extract.partVII.length} entries VIII=${extract.partVIII ? "yes" : "null"}`,
    );

    // Warn if a full 990 produced an empty extract — likely a schema version mismatch
    if (metadata.formType === "990" && Xml990Parser.isEmptyExtract(extract)) {
      logWarn(
        `Empty extract from full 990 for EIN ${metadata.ein} ` +
        `(schema ${metadata.schemaVersion}) — concordance may lack xpaths for this version`,
      );
    }

    return extract;
  }

  /**
   * Check if an extract contains no meaningful data.
   * Used to detect schema version mismatches and track extraction yield.
   */
  static isEmptyExtract(data: Xml990ExtractedData): boolean {
    return (
      data.partIX === null &&
      data.partVI === null &&
      data.partVII.length === 0 &&
      data.partVIII === null
    );
  }

  private extractPartIX(
    form990: Record<string, unknown> | null,
    schemaVersion: string,
  ): PartIXData | null {
    if (!form990) return null;

    const totalExpenses = this.resolveNumeric(form990, PART_IX_VARS.totalExpenses, schemaVersion);
    const programServicesExpenses = this.resolveNumeric(form990, PART_IX_VARS.programServicesExpenses, schemaVersion);
    const managementAndGeneralExpenses = this.resolveNumeric(form990, PART_IX_VARS.managementAndGeneralExpenses, schemaVersion);
    const fundraisingExpenses = this.resolveNumeric(form990, PART_IX_VARS.fundraisingExpenses, schemaVersion);

    // If all values are null, Part IX isn't present (likely 990-EZ)
    if (
      totalExpenses === null &&
      programServicesExpenses === null &&
      managementAndGeneralExpenses === null &&
      fundraisingExpenses === null
    ) {
      return null;
    }

    const total = totalExpenses ?? 0;
    const program = programServicesExpenses ?? 0;
    const admin = managementAndGeneralExpenses ?? 0;
    const fundraising = fundraisingExpenses ?? 0;
    const ratiosValid = total > 0;

    return {
      totalExpenses: total,
      programServicesExpenses: program,
      managementAndGeneralExpenses: admin,
      fundraisingExpenses: fundraising,
      programExpenseRatio: ratiosValid ? program / total : null,
      fundraisingRatio: ratiosValid ? fundraising / total : null,
      adminRatio: ratiosValid ? admin / total : null,
      ratiosValid,
    };
  }

  private extractPartVI(
    form990: Record<string, unknown> | null,
    schemaVersion: string,
  ): PartVIData | null {
    if (!form990) return null;

    const data: PartVIData = {
      votingMembersCount: this.resolveNumeric(form990, PART_VI_VARS.votingMembersCount, schemaVersion),
      independentMembersCount: this.resolveNumeric(form990, PART_VI_VARS.independentMembersCount, schemaVersion),
      familyOrBusinessRelationship: this.resolveBoolean(form990, PART_VI_VARS.familyOrBusinessRelationship, schemaVersion),
      delegationOfMgmtDuties: this.resolveBoolean(form990, PART_VI_VARS.delegationOfMgmtDuties, schemaVersion),
      conflictOfInterestPolicy: this.resolveBoolean(form990, PART_VI_VARS.conflictOfInterestPolicy, schemaVersion),
      whistleblowerPolicy: this.resolveBoolean(form990, PART_VI_VARS.whistleblowerPolicy, schemaVersion),
      documentRetentionPolicy: this.resolveBoolean(form990, PART_VI_VARS.documentRetentionPolicy, schemaVersion),
      compensationProcessCEO: this.resolveBoolean(form990, PART_VI_VARS.compensationProcessCEO, schemaVersion),
      materialDiversionOfAssets: this.resolveBoolean(form990, PART_VI_VARS.materialDiversionOfAssets, schemaVersion),
    };

    // If everything is null, Part VI wasn't present
    const hasAnyValue = Object.values(data).some((v) => v !== null);
    return hasAnyValue ? data : null;
  }

  private extractPartVII(
    form990: Record<string, unknown> | null,
    _schemaVersion: string,
  ): PartVIIEntry[] {
    if (!form990) return [];

    // Part VII officer compensation is a repeating group.
    // Try multiple known group tag names.
    const groupTags = [
      "Form990PartVIISectionAGrp",
      "OfficerDirectorTrusteeEmplGrp",
    ];

    let entries: unknown[] = [];
    for (const tag of groupTags) {
      const found = this.findNestedValue(form990, tag);
      if (found && Array.isArray(found) && found.length > 0) {
        entries = found;
        break;
      }
    }

    if (entries.length === 0) return [];

    return entries
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((entry) => this.parsePartVIIEntry(entry))
      .filter((e): e is PartVIIEntry => e !== null);
  }

  private extractPartVIII(
    form990: Record<string, unknown> | null,
    schemaVersion: string,
  ): PartVIIIData | null {
    if (!form990) return null;

    const contributions = this.resolveNumeric(form990, PART_VIII_VARS.contributions, schemaVersion);
    const programServiceRevenue = this.resolveNumeric(form990, PART_VIII_VARS.programServiceRevenue, schemaVersion);
    const investmentIncome = this.resolveNumeric(form990, PART_VIII_VARS.investmentIncome, schemaVersion);
    const otherRevenue = this.resolveNumeric(form990, PART_VIII_VARS.otherRevenue, schemaVersion);
    const totalRevenue = this.resolveNumeric(form990, PART_VIII_VARS.totalRevenue, schemaVersion);

    if (
      contributions === null &&
      programServiceRevenue === null &&
      investmentIncome === null &&
      otherRevenue === null &&
      totalRevenue === null
    ) {
      return null;
    }

    const total = totalRevenue ?? 0;
    const contribs = contributions ?? 0;
    const progRev = programServiceRevenue ?? 0;
    const ratiosValid = total > 0;

    return {
      contributions: contribs,
      programServiceRevenue: progRev,
      investmentIncome: investmentIncome ?? 0,
      otherRevenue: otherRevenue ?? 0,
      totalRevenue: total,
      contributionDependence: ratiosValid ? contribs / total : null,
      programRevenueSelfSufficiency: ratiosValid ? progRev / total : null,
      ratiosValid,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private resolveNumeric(
    obj: Record<string, unknown>,
    variableName: string,
    schemaVersion: string,
  ): number | null {
    const value = this.resolveVariable(obj, variableName, schemaVersion);
    return coerceNumeric(value);
  }

  private resolveBoolean(
    obj: Record<string, unknown>,
    variableName: string,
    schemaVersion: string,
  ): boolean | null {
    const value = this.resolveVariable(obj, variableName, schemaVersion);
    return coerceBoolean(value);
  }

  private resolveVariable(
    obj: Record<string, unknown>,
    variableName: string,
    schemaVersion: string,
  ): unknown {
    const entries = this.concordance.getXpaths(variableName, schemaVersion);

    for (const entry of entries) {
      const value = this.walkXpath(obj, entry.xpath);
      if (value !== undefined && value !== null) {
        return value;
      }
    }

    // Direct tag fallback: try the last segment of each xpath
    for (const entry of entries) {
      const segments = entry.xpath.split("/").filter(Boolean);
      const lastSegment = segments[segments.length - 1];
      if (lastSegment) {
        const value = this.findNestedValue(obj, lastSegment);
        if (value !== undefined && value !== null) {
          return value;
        }
      }
    }

    return undefined;
  }

  private walkXpath(obj: unknown, xpath: string): unknown {
    // Convert xpath like "/Return/ReturnData/IRS990/TotalFunctionalExpensesGrp/TotalAmt"
    // into segments and walk the object tree
    const segments = xpath
      .split("/")
      .filter(Boolean)
      // Skip the Return/ReturnData/IRS990 prefix — we're already inside form990
      .filter(
        (s) =>
          s !== "Return" &&
          s !== "ReturnData" &&
          !s.startsWith("IRS990"),
      );

    let current: unknown = obj;
    for (const segment of segments) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }

  private findNestedValue(
    obj: unknown,
    tagName: string,
    maxDepth: number = 4,
  ): unknown {
    if (obj === null || obj === undefined || typeof obj !== "object" || maxDepth <= 0) {
      return undefined;
    }

    const record = obj as Record<string, unknown>;
    if (tagName in record) {
      return record[tagName];
    }

    // BFS into nested objects (skip arrays to avoid false positives)
    for (const value of Object.values(record)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const found = this.findNestedValue(value, tagName, maxDepth - 1);
        if (found !== undefined) return found;
      }
    }

    return undefined;
  }

  private parsePartVIIEntry(
    entry: Record<string, unknown>,
  ): PartVIIEntry | null {
    // Extract name — could be nested in PersonNm, BusinessName, etc.
    const name =
      coerceText(entry["PersonNm"]) ??
      coerceText(entry["BusinessName"]?.toString()) ??
      coerceText(this.findNestedValue(entry, "BusinessNameLine1Txt")) ??
      "";

    if (!name) return null;

    return {
      name,
      title: coerceText(entry["TitleTxt"]) ?? coerceText(entry["Title"]) ?? "",
      avgHoursPerWeek: coerceNumeric(
        entry["AverageHoursPerWeekRt"] ?? entry["AverageHoursPerWeek"],
      ),
      isTrusteeOrDirector:
        coerceBoolean(
          entry["IndividualTrusteeOrDirectorInd"] ??
          entry["TrusteeOrDirector"],
        ) ?? false,
      isOfficer:
        coerceBoolean(entry["OfficerInd"] ?? entry["Officer"]) ?? false,
      isKeyEmployee:
        coerceBoolean(
          entry["KeyEmployeeInd"] ?? entry["KeyEmployee"],
        ) ?? false,
      reportableCompFromOrg: coerceNumeric(
        entry["ReportableCompFromOrgAmt"] ??
        entry["ReportableCompFromOrganization"],
      ) ?? 0,
      reportableCompFromRelated: coerceNumeric(
        entry["ReportableCompFromRltdOrgAmt"] ??
        entry["ReportableCompFromRelatedOrgs"],
      ) ?? 0,
      otherCompensation: coerceNumeric(
        entry["OtherCompensationAmt"] ?? entry["OtherCompensation"],
      ) ?? 0,
    };
  }

  private getReturnData(
    parsed: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const ret =
      (parsed["Return"] as Record<string, unknown>) ??
      (parsed as Record<string, unknown>);
    return (ret["ReturnData"] as Record<string, unknown>) ?? null;
  }

  private emptyExtract(metadata: {
    ein: string;
    taxYear: number;
    objectId: string;
    formType: string;
    schemaVersion: string;
  }): Xml990ExtractedData {
    return {
      ein: metadata.ein,
      taxYear: metadata.taxYear,
      objectId: metadata.objectId,
      formType: metadata.formType,
      schemaVersion: metadata.schemaVersion,
      partIX: null,
      partVI: null,
      partVII: [],
      partVIII: null,
      extractedAt: new Date().toISOString(),
    };
  }
}
