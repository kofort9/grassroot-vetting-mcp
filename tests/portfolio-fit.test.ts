import { describe, it, expect } from "vitest";
import { checkPortfolioFit } from "../src/domain/gates/portfolio-fit.js";
import { makeProfile, makePortfolioFitConfig } from "./fixtures.js";

describe("Gate 4: checkPortfolioFit", () => {
  // ---- Disabled gate ----

  it("returns PASS when gate is disabled but still includes sub-checks for audit", () => {
    const config = makePortfolioFitConfig({ enabled: false });
    const profile = makeProfile({ ntee_code: "Z99" }); // Z is not in any allowlist
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
    expect(result.detail).toContain("disabled");
    expect(result.sub_checks).toHaveLength(3);
  });

  // ---- NTEE major category matching ----

  it("returns PASS for org in allowed NTEE major category", () => {
    const config = makePortfolioFitConfig({ allowedNteeCategories: ["P"] });
    const profile = makeProfile({ ntee_code: "P20" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
    expect(result.detail).toContain("P20");
  });

  // ---- Subcategory prefix matching ----

  it("returns PASS for org matching subcategory prefix N2", () => {
    const config = makePortfolioFitConfig({ allowedNteeCategories: ["N2"] });
    const profile = makeProfile({ ntee_code: "N20" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
  });

  it("returns FAIL for N60 when only N2 is allowed", () => {
    const config = makePortfolioFitConfig({ allowedNteeCategories: ["N2"] });
    const profile = makeProfile({ ntee_code: "N60" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("N60");
  });

  // ---- Specific code matching ----

  it("returns PASS for org matching specific code N63", () => {
    const config = makePortfolioFitConfig({ allowedNteeCategories: ["N63"] });
    const profile = makeProfile({ ntee_code: "N63" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
  });

  it("returns FAIL for N64 when only N63 is allowed", () => {
    const config = makePortfolioFitConfig({ allowedNteeCategories: ["N63"] });
    const profile = makeProfile({ ntee_code: "N64" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
  });

  // ---- Outside allowed categories ----

  it("returns FAIL for org outside allowed categories", () => {
    const config = makePortfolioFitConfig({
      allowedNteeCategories: ["A", "B"],
    });
    const profile = makeProfile({ ntee_code: "Z99" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("Z99");
    expect(result.detail).toContain("outside portfolio scope");
  });

  // ---- No NTEE code ----

  it("returns FAIL for org with empty NTEE code", () => {
    const config = makePortfolioFitConfig();
    const profile = makeProfile({ ntee_code: "" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("No NTEE classification");
  });

  it("returns FAIL for org with undefined NTEE code (null coercion)", () => {
    const config = makePortfolioFitConfig();
    const profile = makeProfile({ ntee_code: undefined as any });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("No NTEE classification");
  });

  // ---- EIN exclusion list ----

  it("EIN exclude list blocks even if NTEE matches", () => {
    const config = makePortfolioFitConfig({
      allowedNteeCategories: ["K"],
      excludedEins: ["953135649"],
    });
    const profile = makeProfile({ ein: "95-3135649", ntee_code: "K31" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("Excluded by platform policy");
  });

  // ---- EIN inclusion list ----

  it("EIN include list allows even if NTEE doesn't match", () => {
    const config = makePortfolioFitConfig({
      allowedNteeCategories: ["A"],
      includedEins: ["953135649"],
    });
    const profile = makeProfile({ ein: "95-3135649", ntee_code: "Z99" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
    expect(result.detail).toContain("Included by platform override");
  });

  // ---- EIN exclude wins over include ----

  it("EIN exclude wins over include when same EIN in both lists", () => {
    const config = makePortfolioFitConfig({
      excludedEins: ["953135649"],
      includedEins: ["953135649"],
    });
    const profile = makeProfile({ ein: "95-3135649", ntee_code: "K31" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("Excluded");
  });

  // ---- EIN normalization ----

  it("EIN normalization works — hyphens stripped for matching", () => {
    const config = makePortfolioFitConfig({
      excludedEins: ["953135649"], // stored without hyphen
    });
    const profile = makeProfile({ ein: "95-3135649" }); // profile has hyphen
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
  });

  // ---- EIN inclusion normalization ----

  it("EIN inclusion normalization works — hyphens stripped for matching", () => {
    const config = makePortfolioFitConfig({
      allowedNteeCategories: ["A"],
      includedEins: ["953135649"], // stored without hyphen
    });
    const profile = makeProfile({ ein: "95-3135649", ntee_code: "Z99" }); // profile has hyphen
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
    expect(result.detail).toContain("Included by platform override");
  });

  // ---- Defense-in-depth: empty string in allowlist ----

  it("empty string in allowedNteeCategories does not match everything", () => {
    const config = makePortfolioFitConfig({
      allowedNteeCategories: ["", "A"],
    });
    const profile = makeProfile({ ntee_code: "Z99" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("Z99");
  });

  // ---- Case-insensitive NTEE matching ----

  it("case-insensitive NTEE matching — lowercase p20 matches P", () => {
    const config = makePortfolioFitConfig({ allowedNteeCategories: ["P"] });
    const profile = makeProfile({ ntee_code: "p20" });
    const result = checkPortfolioFit(profile, config);
    expect(result.verdict).toBe("PASS");
  });

  // ---- Empty allowlist ----

  it("empty allowlist rejects everything except EIN includes", () => {
    const config = makePortfolioFitConfig({
      allowedNteeCategories: [],
      includedEins: ["111111111"],
    });

    // Regular org → rejected
    const profile1 = makeProfile({ ntee_code: "P20" });
    expect(checkPortfolioFit(profile1, config).verdict).toBe("FAIL");

    // Included EIN → passes
    const profile2 = makeProfile({ ein: "11-1111111", ntee_code: "P20" });
    expect(checkPortfolioFit(profile2, config).verdict).toBe("PASS");
  });

  // ---- Sub-checks always present ----

  it("always runs all 3 sub-checks for auditability", () => {
    const config = makePortfolioFitConfig({
      excludedEins: ["953135649"],
    });
    const profile = makeProfile({ ein: "95-3135649" });
    const result = checkPortfolioFit(profile, config);
    expect(result.sub_checks).toHaveLength(3);
    expect(result.sub_checks![0].label).toBe("EIN exclusion list");
    expect(result.sub_checks![1].label).toBe("EIN inclusion list");
    expect(result.sub_checks![2].label).toBe("NTEE category match");
  });
});
