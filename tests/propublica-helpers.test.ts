import { describe, it, expect } from "vitest";
import { ProPublicaClient } from "../src/domain/nonprofit/propublica-client.js";
import { makeFiling } from "./fixtures.js";

// ============================================================================
// formatEin
// ============================================================================

describe("ProPublicaClient.formatEin", () => {
  it("formats 9-digit number with dash", () => {
    expect(ProPublicaClient.formatEin(953135649)).toBe("95-3135649");
  });

  it("formats string without dash", () => {
    expect(ProPublicaClient.formatEin("953135649")).toBe("95-3135649");
  });

  it("formats string already with dash (strips and re-formats)", () => {
    expect(ProPublicaClient.formatEin("95-3135649")).toBe("95-3135649");
  });

  it("pads short EINs with leading zeros", () => {
    expect(ProPublicaClient.formatEin(12345)).toBe("00-0012345");
  });

  it("handles string with spaces", () => {
    expect(ProPublicaClient.formatEin("95 3135649")).toBe("95-3135649");
  });
});

// ============================================================================
// getMostRecentFiling
// ============================================================================

describe("ProPublicaClient.getMostRecentFiling", () => {
  it("returns the filing with highest tax_prd", () => {
    const filings = [
      makeFiling({ tax_prd: 202206, tax_prd_yr: 2022 }),
      makeFiling({ tax_prd: 202306, tax_prd_yr: 2023 }),
      makeFiling({ tax_prd: 202106, tax_prd_yr: 2021 }),
    ];
    const result = ProPublicaClient.getMostRecentFiling(filings);
    expect(result?.tax_prd).toBe(202306);
  });

  it("returns null for empty array", () => {
    expect(ProPublicaClient.getMostRecentFiling([])).toBeNull();
  });

  it("returns null for undefined/null", () => {
    expect(
      ProPublicaClient.getMostRecentFiling(null as unknown as []),
    ).toBeNull();
  });

  it("returns single filing", () => {
    const filings = [makeFiling({ tax_prd: 202206, tax_prd_yr: 2022 })];
    expect(ProPublicaClient.getMostRecentFiling(filings)?.tax_prd).toBe(202206);
  });
});

// ============================================================================
// calculateOverheadRatio
// ============================================================================

describe("ProPublicaClient.calculateOverheadRatio", () => {
  const baseFiling = makeFiling();

  it("calculates expenses / revenue", () => {
    expect(ProPublicaClient.calculateOverheadRatio(baseFiling)).toBe(0.8);
  });

  it("returns null for zero revenue", () => {
    expect(
      ProPublicaClient.calculateOverheadRatio(makeFiling({ totrevenue: 0 })),
    ).toBeNull();
  });

  it("returns null for negative revenue", () => {
    expect(
      ProPublicaClient.calculateOverheadRatio(makeFiling({ totrevenue: -100 })),
    ).toBeNull();
  });

  it("returns null for NaN revenue", () => {
    expect(
      ProPublicaClient.calculateOverheadRatio(makeFiling({ totrevenue: NaN })),
    ).toBeNull();
  });

  it("returns null for non-finite expenses", () => {
    expect(
      ProPublicaClient.calculateOverheadRatio(
        makeFiling({ totfuncexpns: Infinity }),
      ),
    ).toBeNull();
  });

  it("handles zero expenses (ratio = 0)", () => {
    expect(
      ProPublicaClient.calculateOverheadRatio(makeFiling({ totfuncexpns: 0 })),
    ).toBe(0);
  });

  it("handles expenses > revenue (ratio > 1)", () => {
    const ratio = ProPublicaClient.calculateOverheadRatio(
      makeFiling({ totfuncexpns: 600_000 }),
    );
    expect(ratio).toBe(1.2);
  });
});

// ============================================================================
// parseRulingDate
// ============================================================================

describe("ProPublicaClient.parseRulingDate", () => {
  it("parses YYYY-MM-DD format", () => {
    const date = ProPublicaClient.parseRulingDate("2010-01-15");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getFullYear()).toBe(2010);
    expect(date!.getMonth()).toBe(0); // January
    expect(date!.getDate()).toBe(15);
  });

  it("parses YYYY-MM format", () => {
    const date = ProPublicaClient.parseRulingDate("2010-06");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getFullYear()).toBe(2010);
    expect(date!.getMonth()).toBe(5); // June
  });

  it("parses YYYYMM format", () => {
    const date = ProPublicaClient.parseRulingDate("201006");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getFullYear()).toBe(2010);
    expect(date!.getMonth()).toBe(5);
  });

  it("returns null for empty string", () => {
    expect(ProPublicaClient.parseRulingDate("")).toBeNull();
  });

  it("returns null for invalid format", () => {
    expect(ProPublicaClient.parseRulingDate("not-a-date")).toBeNull();
  });
});

// ============================================================================
// getSubsection
// ============================================================================

describe("ProPublicaClient.getSubsection", () => {
  const baseOrg = {
    ein: 123,
    name: "Test",
    city: "",
    state: "",
    ntee_code: null,
    ruling_date: "",
  };

  it("reads subsection_code from org detail", () => {
    expect(
      ProPublicaClient.getSubsection({ ...baseOrg, subsection_code: 3 }),
    ).toBe("03");
  });

  it("falls back to subseccd from search results", () => {
    expect(ProPublicaClient.getSubsection({ ...baseOrg, subseccd: 6 })).toBe(
      "06",
    );
  });

  it("pads single digit to two chars", () => {
    const result = ProPublicaClient.getSubsection({
      ...baseOrg,
      subsection_code: 3,
    });
    expect(result).toBe("03");
    expect(result).toHaveLength(2);
  });

  it("returns empty string when both fields missing", () => {
    expect(ProPublicaClient.getSubsection(baseOrg)).toBe("");
  });
});

// ============================================================================
// formatTaxPeriod
// ============================================================================

describe("ProPublicaClient.formatTaxPeriod", () => {
  it("formats YYYYMM number to YYYY-MM string", () => {
    expect(ProPublicaClient.formatTaxPeriod(202306)).toBe("2023-06");
  });

  it("handles December", () => {
    expect(ProPublicaClient.formatTaxPeriod(202312)).toBe("2023-12");
  });

  it("handles January", () => {
    expect(ProPublicaClient.formatTaxPeriod(202301)).toBe("2023-01");
  });
});

// ============================================================================
// getFormTypeName
// ============================================================================

describe("ProPublicaClient.getFormTypeName", () => {
  it("returns 990 for formtype 0", () => {
    expect(ProPublicaClient.getFormTypeName(0)).toBe("990");
  });

  it("returns 990 for formtype 1", () => {
    expect(ProPublicaClient.getFormTypeName(1)).toBe("990");
  });

  it("returns 990 for formtype 990", () => {
    expect(ProPublicaClient.getFormTypeName(990)).toBe("990");
  });

  it("returns 990EZ for formtype 2", () => {
    expect(ProPublicaClient.getFormTypeName(2)).toBe("990EZ");
  });

  it("returns 990PF for formtype 3", () => {
    expect(ProPublicaClient.getFormTypeName(3)).toBe("990PF");
  });

  it("returns generic label for unknown formtype", () => {
    expect(ProPublicaClient.getFormTypeName(99)).toBe("Form 99");
  });
});
