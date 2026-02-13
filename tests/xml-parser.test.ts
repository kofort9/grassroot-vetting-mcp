import { describe, it, expect, beforeAll, vi } from "vitest";
import fsp from "fs/promises";
import { ConcordanceIndex } from "../src/data-sources/concordance.js";
import {
  Xml990Parser,
  coerceNumeric,
  coerceBoolean,
  coerceText,
} from "../src/domain/nonprofit/xml-parser.js";
import { makeMinimal990Xml } from "./fixtures.js";

// Minimal concordance CSV that maps our target variables to the XML tags
// used in makeMinimal990Xml()
const TEST_CONCORDANCE_CSV = `variable_name,description,scope,xpath,versions,current_version,rdb_relationship,form_part,data_type_simple
F9_09_TOT_FUNC_EXPNS_TOT,Total expenses,F990,"Return/ReturnData/IRS990/TotalFunctionalExpensesGrp/TotalAmt","2021v4.2",true,ONE,PART-09,numeric
F9_09_TOT_FUNC_EXPNS_PROGSRVC,Program expenses,F990,"Return/ReturnData/IRS990/TotalFunctionalExpensesGrp/ProgramServicesAmt","2021v4.2",true,ONE,PART-09,numeric
F9_09_TOT_FUNC_EXPNS_MGMTGNRL,Admin expenses,F990,"Return/ReturnData/IRS990/TotalFunctionalExpensesGrp/ManagementAndGeneralAmt","2021v4.2",true,ONE,PART-09,numeric
F9_09_TOT_FUNC_EXPNS_FNDRSNG,Fundraising expenses,F990,"Return/ReturnData/IRS990/TotalFunctionalExpensesGrp/FundraisingAmt","2021v4.2",true,ONE,PART-09,numeric
F9_06_GVRN_NUM_VOTING_MMBRS,Voting members count,F990,"Return/ReturnData/IRS990/GoverningBodyVotingMembersCnt","2021v4.2",true,ONE,PART-06,numeric
F9_06_GVRN_NUM_IND_VOTING_MMBRS,Independent voting members,F990,"Return/ReturnData/IRS990/NbrIndependentVotingMembersCnt","2021v4.2",true,ONE,PART-06,numeric
F9_06_GVRN_FMLY_OR_BZNS_RLTNSHP,Family/business relationship,F990,"Return/ReturnData/IRS990/FamilyOrBusinessRlnInd","2021v4.2",true,ONE,PART-06,checkbox
F9_06_GVRN_DLGT_MGMT_DUTIES,Delegation of mgmt duties,F990,"Return/ReturnData/IRS990/DelegationOfMgmtDutiesInd","2021v4.2",true,ONE,PART-06,checkbox
F9_06_POL_CNFLCT_INTRST_PLCY,Conflict of interest policy,F990,"Return/ReturnData/IRS990/ConflictOfInterestPolicyInd","2021v4.2",true,ONE,PART-06,checkbox
F9_06_POL_WHSTLBLWR_PLCY,Whistleblower policy,F990,"Return/ReturnData/IRS990/WhistleblowerPolicyInd","2021v4.2",true,ONE,PART-06,checkbox
F9_06_POL_DOC_RTNTN_PLCY,Document retention policy,F990,"Return/ReturnData/IRS990/DocumentRetentionPolicyInd","2021v4.2",true,ONE,PART-06,checkbox
F9_06_POL_COMP_PROCESS_CEO,Compensation process CEO,F990,"Return/ReturnData/IRS990/CompensationProcessCEOInd","2021v4.2",true,ONE,PART-06,checkbox
F9_06_DSCL_MATRL_DVRSN,Material diversion,F990,"Return/ReturnData/IRS990/MaterialDiversionOrMisuseInd","2021v4.2",true,ONE,PART-06,checkbox
F9_08_REV_CONTR_TOT,Total Contributions,F990,"Return/ReturnData/IRS990/TotalContributionsAmt","2021v4.2",true,ONE,PART-08,numeric
F9_08_REV_PROG_SRVC_TOT,Program service revenue,F990,"Return/ReturnData/IRS990/ProgramServiceRevenueGrp/TotalRevenueColumnAmt","2021v4.2",true,ONE,PART-08,numeric
F9_08_REV_INVST_INCM_TOT,Investment income,F990,"Return/ReturnData/IRS990/InvestmentIncomeGrp/TotalRevenueColumnAmt","2021v4.2",true,ONE,PART-08,numeric
F9_08_REV_OTH_TOT,Other revenue,F990,"Return/ReturnData/IRS990/OtherRevenueGrp/TotalRevenueColumnAmt","2021v4.2",true,ONE,PART-08,numeric
F9_08_REV_TOT_TOT,Total revenue,F990,"Return/ReturnData/IRS990/CYTotalRevenueAmt","2021v4.2",true,ONE,PART-08,numeric`;

describe("Type coercion functions", () => {
  describe("coerceNumeric", () => {
    it("converts valid numbers", () => {
      expect(coerceNumeric("123")).toBe(123);
      expect(coerceNumeric("1,234,567")).toBe(1234567);
      expect(coerceNumeric(42)).toBe(42);
      expect(coerceNumeric("  500  ")).toBe(500);
      expect(coerceNumeric("-100")).toBe(-100);
      expect(coerceNumeric("3.14")).toBeCloseTo(3.14);
    });

    it("returns null for non-numeric values", () => {
      expect(coerceNumeric(undefined)).toBeNull();
      expect(coerceNumeric(null)).toBeNull();
      expect(coerceNumeric("")).toBeNull();
      expect(coerceNumeric("abc")).toBeNull();
      expect(coerceNumeric(NaN)).toBeNull();
      expect(coerceNumeric(Infinity)).toBeNull();
    });
  });

  describe("coerceBoolean", () => {
    it("handles true-like values", () => {
      expect(coerceBoolean("true")).toBe(true);
      expect(coerceBoolean("1")).toBe(true);
      expect(coerceBoolean("X")).toBe(true);
      expect(coerceBoolean("x")).toBe(true);
      expect(coerceBoolean("yes")).toBe(true);
      expect(coerceBoolean("TRUE")).toBe(true);
    });

    it("handles false-like values", () => {
      expect(coerceBoolean("false")).toBe(false);
      expect(coerceBoolean("0")).toBe(false);
      expect(coerceBoolean("")).toBe(false);
      expect(coerceBoolean("no")).toBe(false);
    });

    it("returns null for missing or unknown values", () => {
      expect(coerceBoolean(undefined)).toBeNull();
      expect(coerceBoolean(null)).toBeNull();
      expect(coerceBoolean("maybe")).toBeNull();
    });
  });

  describe("coerceText", () => {
    it("trims and returns strings", () => {
      expect(coerceText("  hello  ")).toBe("hello");
      expect(coerceText(42)).toBe("42");
    });

    it("returns null for empty/missing values", () => {
      expect(coerceText(undefined)).toBeNull();
      expect(coerceText(null)).toBeNull();
      expect(coerceText("")).toBeNull();
      expect(coerceText("   ")).toBeNull();
    });
  });
});

describe("Xml990Parser", () => {
  const testCsvPath = "/tmp/test-parser-concordance.csv";
  let concordance: ConcordanceIndex;
  let parser: Xml990Parser;

  beforeAll(async () => {
    await fsp.writeFile(testCsvPath, TEST_CONCORDANCE_CSV);
    concordance = new ConcordanceIndex(testCsvPath);
    await concordance.initialize();
    parser = new Xml990Parser(concordance);
  });

  it("parses a minimal 990 XML and extracts Part IX", () => {
    const xml = makeMinimal990Xml();
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(result.partIX).not.toBeNull();
    expect(result.partIX!.totalExpenses).toBe(400000);
    expect(result.partIX!.programServicesExpenses).toBe(320000);
    expect(result.partIX!.managementAndGeneralExpenses).toBe(60000);
    expect(result.partIX!.fundraisingExpenses).toBe(20000);
    expect(result.partIX!.ratiosValid).toBe(true);
    expect(result.partIX!.programExpenseRatio).toBeCloseTo(0.8);
    expect(result.partIX!.fundraisingRatio).toBeCloseTo(0.05);
    expect(result.partIX!.adminRatio).toBeCloseTo(0.15);
  });

  it("parses Part VI governance flags", () => {
    const xml = makeMinimal990Xml();
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(result.partVI).not.toBeNull();
    expect(result.partVI!.votingMembersCount).toBe(12);
    expect(result.partVI!.independentMembersCount).toBe(10);
    expect(result.partVI!.conflictOfInterestPolicy).toBe(true);
    expect(result.partVI!.whistleblowerPolicy).toBe(true);
    expect(result.partVI!.documentRetentionPolicy).toBe(true);
    expect(result.partVI!.materialDiversionOfAssets).toBe(false);
    expect(result.partVI!.familyOrBusinessRelationship).toBe(false);
  });

  it("parses Part VII officer compensation", () => {
    const xml = makeMinimal990Xml();
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(result.partVII).toHaveLength(1);
    expect(result.partVII[0].name).toBe("JANE DOE");
    expect(result.partVII[0].title).toBe("EXECUTIVE DIRECTOR");
    expect(result.partVII[0].reportableCompFromOrg).toBe(150000);
    expect(result.partVII[0].isOfficer).toBe(true);
    expect(result.partVII[0].isKeyEmployee).toBe(true);
  });

  it("parses Part VIII revenue", () => {
    const xml = makeMinimal990Xml();
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(result.partVIII).not.toBeNull();
    expect(result.partVIII!.contributions).toBe(300000);
    expect(result.partVIII!.totalRevenue).toBe(500000);
    expect(result.partVIII!.ratiosValid).toBe(true);
    expect(result.partVIII!.contributionDependence).toBeCloseTo(0.6);
  });

  it("returns null ratios when total is zero (division-by-zero safety)", () => {
    // Create XML with zero expenses
    const xml = makeMinimal990Xml()
      .replace("<TotalAmt>400000</TotalAmt>", "<TotalAmt>0</TotalAmt>")
      .replace("<ProgramServicesAmt>320000</ProgramServicesAmt>", "<ProgramServicesAmt>0</ProgramServicesAmt>")
      .replace("<ManagementAndGeneralAmt>60000</ManagementAndGeneralAmt>", "<ManagementAndGeneralAmt>0</ManagementAndGeneralAmt>")
      .replace("<FundraisingAmt>20000</FundraisingAmt>", "<FundraisingAmt>0</FundraisingAmt>");

    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(result.partIX).not.toBeNull();
    expect(result.partIX!.ratiosValid).toBe(false);
    expect(result.partIX!.programExpenseRatio).toBeNull();
    expect(result.partIX!.fundraisingRatio).toBeNull();
    expect(result.partIX!.adminRatio).toBeNull();
  });

  it("returns empty extract for XML with no ReturnData", () => {
    const xml = '<?xml version="1.0"?><Empty></Empty>';
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(result.partIX).toBeNull();
    expect(result.partVI).toBeNull();
    expect(result.partVII).toEqual([]);
    expect(result.partVIII).toBeNull();
  });

  it("isEmptyExtract detects all-null extracts", () => {
    const emptyResult = parser.parse('<?xml version="1.0"?><Empty></Empty>', {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(Xml990Parser.isEmptyExtract(emptyResult)).toBe(true);
  });

  it("isEmptyExtract returns false for valid extracts", () => {
    const xml = makeMinimal990Xml();
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(Xml990Parser.isEmptyExtract(result)).toBe(false);
  });

  it("logs warning when full 990 produces empty extract", async () => {
    const logging = await import("../src/core/logging.js");
    const warnSpy = vi.spyOn(logging, "logWarn");

    // Parse XML with empty IRS990 element — all parts will be null
    parser.parse('<?xml version="1.0"?><Return><ReturnData><IRS990></IRS990></ReturnData></Return>', {
      formType: "990",
      schemaVersion: "9999v1.0", // Unknown version — nothing will resolve
      ein: "131624100",
      taxYear: 2022,
      objectId: "test_obj",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Empty extract from full 990"),
    );
    warnSpy.mockRestore();
  });

  it("populates metadata fields correctly", () => {
    const xml = makeMinimal990Xml();
    const result = parser.parse(xml, {
      formType: "990",
      schemaVersion: "2021v4.2",
      ein: "131624100",
      taxYear: 2022,
      objectId: "obj_123",
    });

    expect(result.ein).toBe("131624100");
    expect(result.taxYear).toBe(2022);
    expect(result.objectId).toBe("obj_123");
    expect(result.formType).toBe("990");
    expect(result.schemaVersion).toBe("2021v4.2");
    expect(result.extractedAt).toBeTruthy();
  });
});
