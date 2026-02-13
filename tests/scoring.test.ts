import { describe, it, expect, vi } from "vitest";
import {
  checkYearsOperating,
  checkRevenueRange,
  checkSpendRate,
  checkRecent990,
  calculateScore,
  getRecommendation,
  detectRedFlags,
  runTier1Checks,
  runRedFlagCheck,
} from "../src/domain/nonprofit/scoring.js";
import {
  resolveThresholds,
  getSupportedSectors,
} from "../src/domain/nonprofit/sector-thresholds.js";
import { validateThresholds } from "../src/core/config.js";
import {
  DEFAULT_THRESHOLDS,
  makeProfile,
  make990,
  makeFiling,
  taxPrdOffset,
  makeMockIrsClient,
  makeMockOfacClient,
  makePortfolioFitConfig,
  makeRevokedIrsResult,
  makeFlaggedCourtResult,
} from "./fixtures.js";

const t = DEFAULT_THRESHOLDS;

// ============================================================================
// checkYearsOperating
// ============================================================================

describe("checkYearsOperating", () => {
  it.each([
    [10, "PASS"],
    [3, "PASS"], // boundary
    [2, "REVIEW"],
    [1, "REVIEW"], // boundary
    [0, "FAIL"],
    [-1, "FAIL"], // data anomaly
  ] as const)("%d years → %s", (years, expected) => {
    const result = checkYearsOperating(
      makeProfile({ years_operating: years }),
      t,
    );
    expect(result.result).toBe(expected);
  });

  it("fails for null years (no ruling date)", () => {
    const result = checkYearsOperating(
      makeProfile({ years_operating: null }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).toContain("No ruling date");
  });
});

// ============================================================================
// checkRevenueRange
// ============================================================================

describe("checkRevenueRange", () => {
  it.each([
    [500_000, "PASS"], // middle of range
    [100_000, "PASS"], // well within range
    [50_000, "PASS"], // lower boundary
    [10_000_000, "PASS"], // upper boundary
    [75_000, "PASS"], // now in PASS range ($50K-$10M)
    [35_000, "REVIEW"], // small but viable ($25K-$50K)
    [30_000_000, "REVIEW"], // larger org
    [15_000, "FAIL"], // too small
    [60_000_000, "FAIL"], // outside scope
  ] as const)("$%d revenue → %s", (revenue, expected) => {
    const result = checkRevenueRange(
      makeProfile({ latest_990: make990({ total_revenue: revenue }) }),
      t,
    );
    expect(result.result).toBe(expected);
  });

  // --- Edge cases from the truthiness bug fix ---

  it("fails for $0 revenue (not falsy pass-through)", () => {
    const result = checkRevenueRange(
      makeProfile({ latest_990: make990({ total_revenue: 0 }) }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).toBe("Zero revenue reported");
  });

  it("fails for negative revenue", () => {
    const result = checkRevenueRange(
      makeProfile({ latest_990: make990({ total_revenue: -50_000 }) }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).toContain("Negative revenue");
  });

  it("fails for null revenue", () => {
    const result = checkRevenueRange(
      makeProfile({
        latest_990: make990({ total_revenue: null as unknown as number }),
      }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).toContain("No revenue data");
  });

  it("fails for undefined revenue (no 990)", () => {
    const result = checkRevenueRange(makeProfile({ latest_990: null }), t);
    expect(result.result).toBe("FAIL");
  });
});

// ============================================================================
// checkSpendRate
// ============================================================================

describe("checkSpendRate", () => {
  it.each([
    [0.8, "PASS"], // healthy
    [0.7, "PASS"], // within range
    [1.0, "PASS"], // within range
    [1.1, "PASS"], // now in PASS range (passMax=1.3)
    [0.6, "PASS"], // lower boundary (passMin=0.6)
    [1.2, "PASS"], // now in PASS range
    [1.3, "PASS"], // upper boundary (passMax=1.3)
    [0.5, "REVIEW"], // low review (lowReview=0.4)
    [NaN, "REVIEW"], // data corruption treated as missing
    [1.5, "REVIEW"], // high review boundary (uses >)
    [0.3, "FAIL"], // very low deployment (< 0.4)
    [0.35, "FAIL"], // below low review threshold
    [-0.5, "FAIL"], // data anomaly
    [1.6, "FAIL"], // above high review (> 1.5)
  ] as const)("ratio %d → %s", (ratio, expected) => {
    const result = checkSpendRate(
      makeProfile({ latest_990: make990({ overhead_ratio: ratio }) }),
      t,
    );
    expect(result.result).toBe(expected);
  });

  it("reviews for null ratio (missing data)", () => {
    const result = checkSpendRate(
      makeProfile({ latest_990: make990({ overhead_ratio: null }) }),
      t,
    );
    expect(result.result).toBe("REVIEW");
    expect(result.detail).toContain("missing data");
  });

  it("reviews when no 990 at all", () => {
    const result = checkSpendRate(makeProfile({ latest_990: null }), t);
    expect(result.result).toBe("REVIEW");
  });

  it("fails for negative ratio with data anomaly message", () => {
    const result = checkSpendRate(
      makeProfile({ latest_990: make990({ overhead_ratio: -0.5 }) }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).toContain("Negative");
    expect(result.detail).toContain("data anomaly");
  });

  it("returns spend_rate as check name", () => {
    const result = checkSpendRate(makeProfile(), t);
    expect(result.name).toBe("spend_rate");
  });
});

// ============================================================================
// checkRecent990
// ============================================================================

describe("checkRecent990", () => {
  it("passes for recent filing (last year)", () => {
    const result = checkRecent990(makeProfile(), t);
    expect(result.result).toBe("PASS");
  });

  it("fails when filing_count is 0", () => {
    const result = checkRecent990(makeProfile({ filing_count: 0 }), t);
    expect(result.result).toBe("FAIL");
    expect(result.detail).toContain("No 990 filings");
  });

  it("fails when no latest_990", () => {
    const result = checkRecent990(
      makeProfile({ latest_990: null, filing_count: 0 }),
      t,
    );
    expect(result.result).toBe("FAIL");
  });

  it("fails for very old filing (2015)", () => {
    const result = checkRecent990(
      makeProfile({ latest_990: make990({ tax_period: "2015-06" }) }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).toContain("too stale");
  });

  it("fails for malformed tax_period without NaN in detail", () => {
    const result = checkRecent990(
      makeProfile({ latest_990: make990({ tax_period: "bad-data" }) }),
      t,
    );
    expect(result.result).toBe("FAIL");
    expect(result.detail).not.toContain("NaN");
    expect(result.detail).toContain("could not be parsed");
  });
});

// ============================================================================
// calculateScore
// ============================================================================

describe("calculateScore", () => {
  it("returns 100 when all checks pass", () => {
    const checks = [
      {
        name: "a",
        passed: true,
        result: "PASS" as const,
        detail: "",
        weight: 30,
      },
      {
        name: "b",
        passed: true,
        result: "PASS" as const,
        detail: "",
        weight: 15,
      },
      {
        name: "c",
        passed: true,
        result: "PASS" as const,
        detail: "",
        weight: 20,
      },
      {
        name: "d",
        passed: true,
        result: "PASS" as const,
        detail: "",
        weight: 20,
      },
      {
        name: "e",
        passed: true,
        result: "PASS" as const,
        detail: "",
        weight: 15,
      },
    ];
    expect(calculateScore(checks)).toBe(100);
  });

  it("returns 0 when all checks fail", () => {
    const checks = [
      {
        name: "a",
        passed: false,
        result: "FAIL" as const,
        detail: "",
        weight: 30,
      },
      {
        name: "b",
        passed: false,
        result: "FAIL" as const,
        detail: "",
        weight: 15,
      },
      {
        name: "c",
        passed: false,
        result: "FAIL" as const,
        detail: "",
        weight: 20,
      },
      {
        name: "d",
        passed: false,
        result: "FAIL" as const,
        detail: "",
        weight: 20,
      },
      {
        name: "e",
        passed: false,
        result: "FAIL" as const,
        detail: "",
        weight: 15,
      },
    ];
    expect(calculateScore(checks)).toBe(0);
  });

  it("gives 50% weight for REVIEW results", () => {
    const checks = [
      {
        name: "a",
        passed: false,
        result: "REVIEW" as const,
        detail: "",
        weight: 20,
      },
    ];
    expect(calculateScore(checks)).toBe(10);
  });

  it("rounds to nearest integer", () => {
    const checks = [
      {
        name: "a",
        passed: true,
        result: "PASS" as const,
        detail: "",
        weight: 30,
      },
      {
        name: "b",
        passed: false,
        result: "REVIEW" as const,
        detail: "",
        weight: 15,
      },
      {
        name: "c",
        passed: false,
        result: "FAIL" as const,
        detail: "",
        weight: 20,
      },
    ];
    // 30 + 7.5 + 0 = 37.5 -> 38
    expect(calculateScore(checks)).toBe(38);
  });

  it("handles empty checks array", () => {
    expect(calculateScore([])).toBe(0);
  });
});

// ============================================================================
// getRecommendation
// ============================================================================

describe("getRecommendation", () => {
  it("returns PASS for score >= 75 with no flags", () => {
    expect(getRecommendation(85, [], t)).toBe("PASS");
  });

  it("returns PASS at exactly 75 (boundary)", () => {
    expect(getRecommendation(75, [], t)).toBe("PASS");
  });

  it("returns REVIEW for score 50-74", () => {
    expect(getRecommendation(65, [], t)).toBe("REVIEW");
  });

  it("returns REVIEW at exactly 50 (boundary)", () => {
    expect(getRecommendation(50, [], t)).toBe("REVIEW");
  });

  it("returns REJECT for score < 50", () => {
    expect(getRecommendation(30, [], t)).toBe("REJECT");
  });

  it("returns REJECT when HIGH severity flag exists regardless of score", () => {
    const highFlag = {
      severity: "HIGH" as const,
      type: "stale_990" as const,
      detail: "test",
    };
    expect(getRecommendation(95, [highFlag], t)).toBe("REJECT");
  });

  it("downgrades PASS to REVIEW on MEDIUM flags", () => {
    const medFlag = {
      severity: "MEDIUM" as const,
      type: "too_new" as const,
      detail: "test",
    };
    expect(getRecommendation(85, [medFlag], t)).toBe("REVIEW");
  });

  it("MEDIUM flag + score in REVIEW range stays REVIEW", () => {
    const medFlag = {
      severity: "MEDIUM" as const,
      type: "too_new" as const,
      detail: "test",
    };
    expect(getRecommendation(60, [medFlag], t)).toBe("REVIEW");
  });

  it("MEDIUM flag + score below REVIEW range stays REJECT", () => {
    const medFlag = {
      severity: "MEDIUM" as const,
      type: "too_new" as const,
      detail: "test",
    };
    expect(getRecommendation(40, [medFlag], t)).toBe("REJECT");
  });

  it("multiple MEDIUM flags + PASS score → REVIEW", () => {
    const flags = [
      { severity: "MEDIUM" as const, type: "too_new" as const, detail: "test" },
      { severity: "MEDIUM" as const, type: "very_low_revenue" as const, detail: "test" },
    ];
    expect(getRecommendation(85, flags, t)).toBe("REVIEW");
  });

  it("HIGH + MEDIUM flags → REJECT (HIGH takes precedence)", () => {
    const flags = [
      { severity: "HIGH" as const, type: "stale_990" as const, detail: "test" },
      { severity: "MEDIUM" as const, type: "too_new" as const, detail: "test" },
    ];
    expect(getRecommendation(85, flags, t)).toBe("REJECT");
  });
});

// ============================================================================
// detectRedFlags
// ============================================================================

describe("detectRedFlags", () => {
  it("returns empty array for clean profile", () => {
    const profile = makeProfile();
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toEqual([]);
  });

  it("flags organization less than 1 year old (MEDIUM)", () => {
    const profile = makeProfile({ years_operating: 0 });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "too_new", severity: "MEDIUM" }),
    );
  });

  it("does NOT flag org at exactly 1 year", () => {
    const profile = makeProfile({ years_operating: 1 });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "too_new" }),
    );
  });

  it("flags stale 990 older than 4 years (HIGH)", () => {
    const profile = makeProfile({
      latest_990: make990({ tax_period: "2018-06" }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "stale_990", severity: "HIGH" }),
    );
  });

  it("flags very high expense ratio > 1.5 (HIGH)", () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 1.6 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "very_high_overhead", severity: "HIGH" }),
    );
  });

  it("does NOT flag ratio at exactly 1.5 (boundary uses >)", () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 1.5 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "very_high_overhead" }),
    );
  });

  it("flags low fund deployment < 0.4 (MEDIUM)", () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 0.3 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "low_fund_deployment",
        severity: "MEDIUM",
      }),
    );
  });

  it("does NOT flag ratio at exactly 0.4 (boundary uses <)", () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 0.4 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "low_fund_deployment" }),
    );
  });

  it("flags very low revenue under $25K (MEDIUM)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 10_000 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "very_low_revenue", severity: "MEDIUM" }),
    );
  });

  it("does NOT flag null revenue as very low (guards null, not just undefined)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: null as unknown as number }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "very_low_revenue" }),
    );
  });

  // --- $0 revenue truthiness edge case (bug #1 from cleanup) ---

  it("flags $0 revenue as very low (not skipped by falsy check)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 0 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "very_low_revenue" }),
    );
  });

  // --- Revenue decline ---

  it("flags >20% revenue decline year-over-year (MEDIUM)", () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 350_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    // 30% decline > 20% threshold
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "revenue_decline", severity: "MEDIUM" }),
    );
  });

  it("does not flag 15% decline (below threshold)", () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 425_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "revenue_decline" }),
    );
  });

  it("does not flag revenue increase", () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 800_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "revenue_decline" }),
    );
  });

  it("handles single filing (no decline check possible)", () => {
    const flags = detectRedFlags(makeProfile(), [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "revenue_decline" }),
    );
  });

  it("handles previous revenue of 0 (avoids division by zero)", () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 100_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 0 }),
    ];
    // Should not throw, and should not flag decline (can't calculate % from 0)
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "revenue_decline" }),
    );
  });

  it("skips revenue decline check when filings are >18 months apart", () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 200_000 }),
      makeFiling({ tax_prd: taxPrdOffset(3), totrevenue: 500_000 }), // 3 years ago
    ];
    // 60% decline, but filings are ~36 months apart — skip
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "revenue_decline" }),
    );
  });

  // --- Officer compensation ratio — size-tiered thresholds ---

  // Large org ($2M revenue): high=0.4, moderate=0.25 (base thresholds)
  it("large org: flags compensation > 40% as HIGH", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 2_000_000, officer_compensation_ratio: 0.45 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
  });

  it("large org: flags compensation > 25% as MEDIUM", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 2_000_000, officer_compensation_ratio: 0.3 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "MEDIUM",
      }),
    );
  });

  // Medium org ($500K revenue): high=max(0.5,0.4)=0.5, moderate=max(0.3,0.25)=0.3
  it("medium org: 50% comp is MEDIUM not HIGH (size-tier raises threshold)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 500_000, officer_compensation_ratio: 0.5 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "MEDIUM",
      }),
    );
  });

  it("medium org: 55% comp is HIGH", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 500_000, officer_compensation_ratio: 0.55 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
  });

  it("medium org: 35% comp is MEDIUM", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 500_000, officer_compensation_ratio: 0.35 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "MEDIUM",
      }),
    );
  });

  // Small org ($100K revenue): high=max(0.6,0.4)=0.6, moderate=max(0.4,0.25)=0.4
  it("small org: 50% comp is MEDIUM not HIGH (size-tier raises threshold)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 100_000, officer_compensation_ratio: 0.5 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "MEDIUM",
      }),
    );
  });

  it("small org: 65% comp is HIGH", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 100_000, officer_compensation_ratio: 0.65 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
  });

  it("does NOT flag compensation at exactly boundary (uses >)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 2_000_000, officer_compensation_ratio: 0.4 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
  });

  it("does NOT flag compensation at exactly moderate boundary (uses >)", () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 2_000_000, officer_compensation_ratio: 0.25 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "high_officer_compensation" }),
    );
  });

  it("does NOT flag compensation at 20% (below moderate threshold)", () => {
    const profile = makeProfile({
      latest_990: make990({ officer_compensation_ratio: 0.2 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "high_officer_compensation" }),
    );
  });

  it("does NOT flag when officer_compensation_ratio is null", () => {
    const profile = makeProfile({
      latest_990: make990({ officer_compensation_ratio: null }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "high_officer_compensation" }),
    );
  });

  it("does NOT flag when officer_compensation_ratio is 0", () => {
    const profile = makeProfile({
      latest_990: make990({ officer_compensation_ratio: 0 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "high_officer_compensation" }),
    );
  });

  it("does NOT flag when officer_compensation_ratio is negative (data anomaly)", () => {
    const profile = makeProfile({
      latest_990: make990({ officer_compensation_ratio: -0.001 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "high_officer_compensation" }),
    );
  });

  // --- OFAC fuzzy matching ---

  it("flags ofac_near_match as HIGH when similarity >= 0.95", () => {
    const mockOfacClient = {
      ...makeMockOfacClient(),
      fuzzyCheck: vi.fn().mockReturnValue({
        found: true,
        detail: '1 near-match(es) on OFAC SDN list',
        matches: [
          {
            entNum: "999",
            name: "ALMOST IDENTICAL ORG",
            sdnType: "Entity",
            program: "SDGT",
            matchedOn: "primary",
            similarity: 0.97,
          },
        ],
      }),
    };
    const flags = detectRedFlags(
      makeProfile(),
      [makeFiling()],
      t,
      undefined,
      mockOfacClient as any,
    );
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "ofac_near_match", severity: "HIGH" }),
    );
    expect(flags.find((f) => f.type === "ofac_near_match")!.detail).toContain(
      "97.0%",
    );
  });

  it("flags ofac_near_match as MEDIUM when similarity 0.85-0.95", () => {
    const mockOfacClient = {
      ...makeMockOfacClient(),
      fuzzyCheck: vi.fn().mockReturnValue({
        found: true,
        detail: '1 near-match(es) on OFAC SDN list',
        matches: [
          {
            entNum: "999",
            name: "SOMEWHAT SIMILAR ORG",
            sdnType: "Entity",
            program: "SDGT",
            matchedOn: "primary",
            similarity: 0.90,
          },
        ],
      }),
    };
    const flags = detectRedFlags(
      makeProfile(),
      [makeFiling()],
      t,
      undefined,
      mockOfacClient as any,
    );
    expect(flags).toContainEqual(
      expect.objectContaining({ type: "ofac_near_match", severity: "MEDIUM" }),
    );
  });

  it("does NOT flag ofac_near_match when fuzzyCheck returns no matches", () => {
    const mockOfacClient = {
      ...makeMockOfacClient(),
      fuzzyCheck: vi.fn().mockReturnValue({
        found: false,
        detail: "No fuzzy OFAC matches",
        matches: [],
      }),
    };
    const flags = detectRedFlags(
      makeProfile(),
      [makeFiling()],
      t,
      undefined,
      mockOfacClient as any,
    );
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "ofac_near_match" }),
    );
  });

  it("does NOT flag ofac_near_match when ofacClient is not provided", () => {
    const flags = detectRedFlags(makeProfile(), [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "ofac_near_match" }),
    );
  });

  // --- Revenue decline: negative revenue guard ---

  it("does not flag decline when latest revenue is negative (data anomaly)", () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: -50_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "revenue_decline" }),
    );
  });
});

// ============================================================================
// runTier1Checks (integration)
// ============================================================================

describe("runTier1Checks", () => {
  it("returns PASS for a clean healthy profile", () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.recommendation).toBe("PASS");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.gate_blocked).toBe(false);
    expect(result.gates.all_passed).toBe(true);
    expect(result.red_flags).toHaveLength(0);
    expect(result.checks).toHaveLength(4);
    expect(result.summary.headline).toBe("Approved for Tier 2 Vetting");
  });

  it("returns REJECT when IRS revocation gate fails", () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient();
    irsClient.check.mockReturnValue(makeRevokedIrsResult());
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.recommendation).toBe("REJECT");
    expect(result.passed).toBe(false);
    expect(result.gate_blocked).toBe(true);
    expect(result.score).toBeNull();
    expect(result.checks).toBeNull();
  });

  it("returns REJECT for non-501(c)(3) (gate failure)", () => {
    const profile = makeProfile({ subsection: "04" });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.recommendation).toBe("REJECT");
    expect(result.gate_blocked).toBe(true);
    expect(result.score).toBeNull();
  });

  it("returns REJECT for bare minimum profile (no filings = gate 3 fail)", () => {
    const profile = makeProfile({
      years_operating: null,
      ruling_date: "",
      latest_990: null,
      filing_count: 0,
    });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.recommendation).toBe("REJECT");
    // Gate 1 passes (subsection 03 + not revoked + has ruling_date... wait, ruling_date is '')
    // Actually Gate 1 sub-check C will fail (no ruling date)
    expect(result.gate_blocked).toBe(true);
    expect(result.score).toBeNull();
  });

  // --- review_reasons field ---

  it("has empty review_reasons for a clean PASS profile", () => {
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      makeProfile(),
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );
    expect(result.review_reasons).toEqual([]);
  });

  it("includes REVIEW check details in review_reasons", () => {
    // Profile with 2 years operating -> REVIEW on years check
    const profile = makeProfile({ years_operating: 2 });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.review_reasons.length).toBeGreaterThan(0);
    expect(
      result.review_reasons.some((r) => r.includes("newer organization")),
    ).toBe(true);
  });

  it("includes FAIL check details in review_reasons (scoring FAIL, not gate)", () => {
    // Revenue too low -> scoring FAIL, not a gate failure
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 10_000 }),
    });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.review_reasons.some((r) => r.includes("too small"))).toBe(
      true,
    );
  });

  it("includes HIGH red flag details prefixed with RED FLAG:", () => {
    // Stale 990 triggers HIGH red flag
    const profile = makeProfile({
      latest_990: make990({ tax_period: "2018-06" }),
    });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.review_reasons.some((r) => r.startsWith("RED FLAG:"))).toBe(
      true,
    );
  });

  it("includes court records in red flags when provided", () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const courtResult = makeFlaggedCourtResult(3);
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
      courtResult,
    );

    expect(result.red_flags).toContainEqual(
      expect.objectContaining({ type: "court_records", severity: "HIGH" }),
    );
  });

  it("gate-blocked results have gate failure in review_reasons", () => {
    const profile = makeProfile({ subsection: "04" });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(
      profile,
      [makeFiling()],
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.review_reasons.some((r) => r.includes("Gate failure"))).toBe(
      true,
    );
  });
});

// ============================================================================
// runRedFlagCheck
// ============================================================================

describe("runRedFlagCheck", () => {
  it("returns clean=true for healthy profile", () => {
    const profile = makeProfile();
    const result = runRedFlagCheck(profile, [makeFiling()], t);

    expect(result.clean).toBe(true);
    expect(result.flags).toHaveLength(0);
    expect(result.ein).toBe("95-3135649");
    expect(result.name).toBe("Test Nonprofit");
  });

  it("returns clean=false when flags exist", () => {
    // Use a stale 990 to trigger a red flag (gate-handled flags removed)
    const profile = makeProfile({
      latest_990: make990({ tax_period: "2018-06" }),
    });
    const result = runRedFlagCheck(profile, [makeFiling()], t);

    expect(result.clean).toBe(false);
    expect(result.flags.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// resolveThresholds (sector-specific)
// ============================================================================

describe("resolveThresholds", () => {
  it("returns base thresholds unchanged for unknown NTEE code", () => {
    const resolved = resolveThresholds(t, "Z99");
    expect(resolved).toEqual(t);
  });

  it("returns base thresholds for empty NTEE code", () => {
    const resolved = resolveThresholds(t, "");
    expect(resolved).toEqual(t);
  });

  it("lowers revenuePassMin and revenueFailMin for K (Food/Agriculture)", () => {
    const resolved = resolveThresholds(t, "K31");
    expect(resolved.revenuePassMin).toBe(25_000);
    expect(resolved.revenueFailMin).toBe(10_000);
    expect(resolved.redFlagVeryLowRevenue).toBe(8_000);
  });

  it("overrides only redFlagVeryLowRevenue for A (Arts)", () => {
    const resolved = resolveThresholds(t, "A70");
    expect(resolved.redFlagVeryLowRevenue).toBe(15_000);
    // All other fields stay at base
    expect(resolved.revenueFailMin).toBe(t.revenueFailMin);
    expect(resolved.revenuePassMin).toBe(t.revenuePassMin);
    expect(resolved.expenseRatioPassMin).toBe(t.expenseRatioPassMin);
    expect(resolved.expenseRatioPassMax).toBe(t.expenseRatioPassMax);
  });

  it("overrides revenue and compensation for E (Health)", () => {
    const resolved = resolveThresholds(t, "E32");
    expect(resolved.revenuePassMax).toBe(50_000_000);
    expect(resolved.revenueReviewMax).toBe(100_000_000);
    expect(resolved.redFlagHighCompensation).toBe(0.5);
    expect(resolved.redFlagModerateCompensation).toBe(0.35);
    // Non-overridden fields stay at base
    expect(resolved.weightYearsOperating).toBe(t.weightYearsOperating);
  });

  it("is case-insensitive on NTEE code", () => {
    const resolved = resolveThresholds(t, "a70");
    expect(resolved.redFlagVeryLowRevenue).toBe(15_000); // A override applied
  });

  it("all hardcoded sector overrides produce valid merged thresholds", () => {
    for (const sector of getSupportedSectors()) {
      const resolved = resolveThresholds(t, sector + "99");
      expect(() => validateThresholds(resolved)).not.toThrow();
    }
  });

  it("lowers revenuePassMin and revenueFailMin for L (Housing)", () => {
    const resolved = resolveThresholds(t, "L21");
    expect(resolved.revenuePassMin).toBe(30_000);
    expect(resolved.revenueFailMin).toBe(15_000);
    expect(resolved.redFlagVeryLowRevenue).toBe(10_000);
  });

  it("lowers revenuePassMin and revenueFailMin for O (Youth Development)", () => {
    const resolved = resolveThresholds(t, "O50");
    expect(resolved.revenuePassMin).toBe(25_000);
    expect(resolved.revenueFailMin).toBe(10_000);
    expect(resolved.redFlagVeryLowRevenue).toBe(8_000);
  });

  it("lowers revenuePassMin and revenueFailMin for P (Human Services)", () => {
    const resolved = resolveThresholds(t, "P70");
    expect(resolved.revenuePassMin).toBe(30_000);
    expect(resolved.revenueFailMin).toBe(15_000);
    expect(resolved.redFlagVeryLowRevenue).toBe(10_000);
  });

  it("lowers revenuePassMin and revenueFailMin for S (Community Improvement)", () => {
    const resolved = resolveThresholds(t, "S20");
    expect(resolved.revenuePassMin).toBe(25_000);
    expect(resolved.revenueFailMin).toBe(10_000);
    expect(resolved.redFlagVeryLowRevenue).toBe(8_000);
  });

  it("reports supported sectors", () => {
    const sectors = getSupportedSectors();
    expect(sectors).toContain("A");
    expect(sectors).toContain("E");
    expect(sectors).toContain("K");
    expect(sectors).toContain("L");
    expect(sectors).toContain("O");
    expect(sectors).toContain("P");
    expect(sectors).toContain("S");
    expect(sectors.length).toBe(7);
  });

  // Integration: sector overrides affect scoring behavior

  it("food bank with $30K revenue PASSES with K sector thresholds", () => {
    const profile = makeProfile({
      ntee_code: "K31",
      latest_990: make990({ total_revenue: 30_000 }),
    });
    // Base thresholds: $30K < passMin ($50K) → REVIEW
    const baseCheck = checkRevenueRange(profile, t);
    expect(baseCheck.result).toBe("REVIEW");
    // K sector thresholds: $30K >= passMin ($25K) → PASS
    const resolved = resolveThresholds(t, profile.ntee_code);
    const sectorCheck = checkRevenueRange(profile, resolved);
    expect(sectorCheck.result).toBe("PASS");
  });

  it("arts org with $60K revenue PASSES with base thresholds (A revenue overrides removed)", () => {
    const profile = makeProfile({
      ntee_code: "A70",
      latest_990: make990({ total_revenue: 60_000 }),
    });
    // With new base thresholds: $60K >= passMin ($50K) → PASS
    const baseCheck = checkRevenueRange(profile, t);
    expect(baseCheck.result).toBe("PASS");
    // A sector resolved thresholds also give PASS (no revenue override)
    const resolved = resolveThresholds(t, profile.ntee_code);
    const sectorCheck = checkRevenueRange(profile, resolved);
    expect(sectorCheck.result).toBe("PASS");
  });

  it("health org with 45% compensation does NOT flag HIGH (E sector has higher threshold)", () => {
    // Use large revenue so size-tier doesn't raise thresholds above sector
    const profile = makeProfile({
      ntee_code: "E32",
      latest_990: make990({ total_revenue: 2_000_000, officer_compensation_ratio: 0.45 }),
    });
    const resolved = resolveThresholds(t, profile.ntee_code);
    const filings = [makeFiling()];
    // With base thresholds ($2M = large org): 0.45 > 0.40 → HIGH
    const baseFlags = detectRedFlags(profile, filings, t);
    expect(baseFlags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
    // With E thresholds: 0.45 < 0.50 → MEDIUM (moderate threshold is 0.35)
    const sectorFlags = detectRedFlags(profile, filings, resolved);
    expect(sectorFlags).not.toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "HIGH",
      }),
    );
    expect(sectorFlags).toContainEqual(
      expect.objectContaining({
        type: "high_officer_compensation",
        severity: "MEDIUM",
      }),
    );
  });

  // Boundary tests: REVIEW band preserved by revenueFailMin overrides

  it("K sector: org at exactly $10K FAILS (at revenueFailMin boundary)", () => {
    const profile = makeProfile({
      ntee_code: "K31",
      latest_990: make990({ total_revenue: 10_000 }),
    });
    const resolved = resolveThresholds(t, "K31");
    // $10K >= revenueFailMin ($10K) but < revenuePassMin ($25K) → REVIEW
    const check = checkRevenueRange(profile, resolved);
    expect(check.result).toBe("REVIEW");
  });

  it("K sector: org at $9,999 FAILS (below revenueFailMin)", () => {
    const profile = makeProfile({
      ntee_code: "K31",
      latest_990: make990({ total_revenue: 9_999 }),
    });
    const resolved = resolveThresholds(t, "K31");
    const check = checkRevenueRange(profile, resolved);
    expect(check.result).toBe("FAIL");
  });

  it("K sector: org at $25K PASSES (at revenuePassMin boundary)", () => {
    const profile = makeProfile({
      ntee_code: "K31",
      latest_990: make990({ total_revenue: 25_000 }),
    });
    const resolved = resolveThresholds(t, "K31");
    const check = checkRevenueRange(profile, resolved);
    expect(check.result).toBe("PASS");
  });

  it("K sector: $15K org has REVIEW band (not cliff)", () => {
    const profile = makeProfile({
      ntee_code: "K31",
      latest_990: make990({ total_revenue: 15_000 }),
    });
    const resolved = resolveThresholds(t, "K31");
    const check = checkRevenueRange(profile, resolved);
    // $15K is between failMin ($10K) and passMin ($25K) → REVIEW
    expect(check.result).toBe("REVIEW");
  });

  it("K sector: $12K org does NOT get contradictory very_low_revenue flag", () => {
    const profile = makeProfile({
      ntee_code: "K31",
      latest_990: make990({ total_revenue: 12_000 }),
    });
    const resolved = resolveThresholds(t, "K31");
    const flags = detectRedFlags(profile, [makeFiling()], resolved);
    // $12K > redFlagVeryLowRevenue ($8K) → no very_low_revenue flag
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: "very_low_revenue" }),
    );
  });
});
