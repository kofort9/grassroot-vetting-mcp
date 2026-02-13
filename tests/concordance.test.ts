import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import { ConcordanceIndex } from "../src/data-sources/concordance.js";

// Sample concordance CSV content for testing
const SAMPLE_CSV = `variable_name,description,scope,xpath,versions,current_version,rdb_relationship,form_part,data_type_simple
F9_09_TOT_FUNC_EXPNS_TOT,Total functional expenses,F990,"Return/ReturnData/IRS990/TotalFunctionalExpensesGrp/TotalAmt","2013v3.0;2014v5.0;2021v4.2",true,ONE,PART-09,numeric
F9_09_TOT_FUNC_EXPNS_TOT,Total functional expenses (old),F990,"Return/ReturnData/IRS990/TotalFunctionalExpenses","2009v1.0;2010v3.0;2011v1.2",false,ONE,PART-09,numeric
F9_06_POL_CNFLCT_INTRST_PLCY,Conflict of interest policy,F990,"Return/ReturnData/IRS990/ConflictOfInterestPolicyInd","2013v3.0;2021v4.2",true,ONE,PART-06,checkbox
F9_07_COMP_PERSON_NM,Person name,F990,"Return/ReturnData/IRS990/Form990PartVIISectionAGrp/PersonNm","2021v4.2",true,MANY,PART-07,text
SCHED_I_RECIPIENT,Schedule I Recipient,IRS990ScheduleI,"Return/ReturnData/IRS990ScheduleI/RecipientTable/RecipientBusinessName","2021v4.2",true,MANY,PART-03,text
NON_990_FIELD,Some other form field,F1040,"Return/ReturnData/IRS1040/SomeField","2021v4.2",true,ONE,PART-01,numeric`;

describe("ConcordanceIndex", () => {
  const testCsvPath = "/tmp/test-concordance.csv";

  beforeEach(async () => {
    await fsp.writeFile(testCsvPath, SAMPLE_CSV);
  });

  afterEach(async () => {
    try {
      await fsp.unlink(testCsvPath);
    } catch {
      // ignore
    }
  });

  it("initializes from CSV file and loads entries", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    expect(index.isReady()).toBe(true);
  });

  it("throws if used before initialization", () => {
    const index = new ConcordanceIndex(testCsvPath);
    expect(() => index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT")).toThrow(
      "ConcordanceIndex not initialized",
    );
  });

  it("returns xpaths for a known variable", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const entries = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].xpath).toContain("TotalFunctionalExpenses");
  });

  it("returns version-specific xpaths when schema version provided", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    // 2021v4.2 should return the new xpath
    const newEntries = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT", "2021v4.2");
    expect(newEntries.length).toBe(1);
    expect(newEntries[0].xpath).toContain("TotalFunctionalExpensesGrp/TotalAmt");

    // 2009v1.0 should return the old xpath
    const oldEntries = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT", "2009v1.0");
    expect(oldEntries.length).toBe(1);
    expect(oldEntries[0].xpath).toContain("TotalFunctionalExpenses");
    expect(oldEntries[0].xpath).not.toContain("Grp");
  });

  it("falls back to current_version entries for unknown schema version", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const entries = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT", "9999v1.0");
    expect(entries.length).toBe(1);
    expect(entries[0].currentVersion).toBe(true);
  });

  it("returns empty array for unknown variable", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const entries = index.getXpaths("NONEXISTENT_VARIABLE");
    expect(entries).toEqual([]);
  });

  it("filters out non-990 forms (like F1040)", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const entries = index.getXpaths("NON_990_FIELD");
    expect(entries).toEqual([]);
  });

  it("includes IRS990Schedule entries", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const entries = index.getXpaths("SCHED_I_RECIPIENT");
    expect(entries.length).toBe(1);
  });

  it("correctly parses data types", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    expect(index.getDataType("F9_09_TOT_FUNC_EXPNS_TOT")).toBe("numeric");
    expect(index.getDataType("F9_06_POL_CNFLCT_INTRST_PLCY")).toBe("checkbox");
    expect(index.getDataType("F9_07_COMP_PERSON_NM")).toBe("text");
    expect(index.getDataType("UNKNOWN")).toBe("text"); // default
  });

  it("correctly parses relationship type", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const oneEntries = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT");
    expect(oneEntries[0].relationship).toBe("ONE");

    const manyEntries = index.getXpaths("F9_07_COMP_PERSON_NM");
    expect(manyEntries[0].relationship).toBe("MANY");
  });

  it("getVariablesByForm returns entries for a form part", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    const partIXVars = index.getVariablesByForm("PC", "PART-09");
    expect(partIXVars.length).toBeGreaterThan(0);
    expect(partIXVars.every((e) => e.formPart === "PART-09")).toBe(true);
  });

  it("throws on empty/malformed CSV with zero entries", async () => {
    const emptyCsv = "variable_name,description,scope,xpath,versions,current_version,rdb_relationship,form_part,data_type_simple\n";
    await fsp.writeFile(testCsvPath, emptyCsv);

    const index = new ConcordanceIndex(testCsvPath);
    await expect(index.initialize()).rejects.toThrow(
      "Concordance loaded 0 entries",
    );
  });

  it("throws on CSV with only non-990 forms (zero matching entries)", async () => {
    const non990Csv = `variable_name,description,scope,xpath,versions,current_version,rdb_relationship,form_part,data_type_simple
SOME_FIELD,A field,F1040,"Return/ReturnData/IRS1040/SomeField","2021v4.2",true,ONE,PART-01,numeric`;
    await fsp.writeFile(testCsvPath, non990Csv);

    const index = new ConcordanceIndex(testCsvPath);
    await expect(index.initialize()).rejects.toThrow(
      "Concordance loaded 0 entries",
    );
  });

  it("loads ALL entries including non-current versions", async () => {
    const index = new ConcordanceIndex(testCsvPath);
    await index.initialize();

    // We should have both old and new xpaths for this variable
    const allEntries = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT");
    // Without version filter, should return current_version entries
    expect(allEntries.length).toBeGreaterThanOrEqual(1);
    expect(allEntries.every((e) => e.currentVersion)).toBe(true);

    // But old version should still be accessible via version filter
    const old = index.getXpaths("F9_09_TOT_FUNC_EXPNS_TOT", "2009v1.0");
    expect(old.length).toBe(1);
    expect(old[0].currentVersion).toBe(false);
  });
});
