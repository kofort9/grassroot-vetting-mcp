import { describe, it, expect } from "vitest";
import {
  generateSummary,
  VERDICT_CONFIG,
  CHECK_MESSAGES,
  RED_FLAG_FACTORS,
} from "../src/domain/nonprofit/messages.js";
import type { Tier1Check, RedFlag } from "../src/domain/nonprofit/types.js";

// ============================================================================
// Helper: build test data
// ============================================================================

function makeCheck(overrides?: Partial<Tier1Check>): Tier1Check {
  return {
    name: "years_operating",
    passed: true,
    result: "PASS",
    detail: "15 years operating (since 2010-01-01)",
    weight: 25,
    ...overrides,
  };
}

function makeRedFlag(overrides?: Partial<RedFlag>): RedFlag {
  return {
    severity: "HIGH",
    type: "stale_990",
    detail: "Most recent 990 is from 2018-06 (8.0 years old)",
    ...overrides,
  };
}

// ============================================================================
// VERDICT_CONFIG
// ============================================================================

describe("VERDICT_CONFIG", () => {
  it("has entries for PASS, REVIEW, REJECT", () => {
    expect(VERDICT_CONFIG.PASS).toBeDefined();
    expect(VERDICT_CONFIG.REVIEW).toBeDefined();
    expect(VERDICT_CONFIG.REJECT).toBeDefined();
  });

  it("each entry has headline, template, and next_steps", () => {
    for (const key of ["PASS", "REVIEW", "REJECT"] as const) {
      const config = VERDICT_CONFIG[key];
      expect(config.headline).toBeTypeOf("string");
      expect(config.template).toBeTypeOf("string");
      expect(config.next_steps).toBeInstanceOf(Array);
      expect(config.next_steps.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// CHECK_MESSAGES
// ============================================================================

describe("CHECK_MESSAGES", () => {
  const expectedChecks = [
    "years_operating",
    "revenue_range",
    "spend_rate",
    "recent_990",
  ];

  it("has entries for all 4 checks", () => {
    for (const check of expectedChecks) {
      expect(CHECK_MESSAGES[check]).toBeDefined();
    }
  });

  it("each check has PASS, REVIEW, FAIL with factor and weight", () => {
    for (const check of expectedChecks) {
      for (const result of ["PASS", "REVIEW", "FAIL"] as const) {
        const msg = CHECK_MESSAGES[check][result];
        expect(msg.factor).toBeTypeOf("string");
        expect(["positive", "negative", "neutral"]).toContain(msg.weight);
      }
    }
  });
});

// ============================================================================
// RED_FLAG_FACTORS
// ============================================================================

describe("RED_FLAG_FACTORS", () => {
  it("maps known red flag types to messages", () => {
    expect(RED_FLAG_FACTORS["stale_990"]).toBeTypeOf("string");
    expect(RED_FLAG_FACTORS["very_low_revenue"]).toBeTypeOf("string");
    expect(RED_FLAG_FACTORS["court_records"]).toBeTypeOf("string");
    expect(RED_FLAG_FACTORS["high_officer_compensation"]).toBeTypeOf("string");
  });
});

// ============================================================================
// generateSummary
// ============================================================================

describe("generateSummary", () => {
  const allPassChecks: Tier1Check[] = [
    makeCheck({ name: "years_operating", result: "PASS" }),
    makeCheck({ name: "revenue_range", result: "PASS" }),
    makeCheck({ name: "spend_rate", result: "PASS" }),
    makeCheck({ name: "recent_990", result: "PASS" }),
  ];

  // ---------- PASS recommendation ----------

  describe("PASS recommendation", () => {
    it("returns PASS headline", () => {
      const summary = generateSummary(
        "Test Org",
        92,
        "PASS",
        allPassChecks,
        [],
        15,
      );
      expect(summary.headline).toBe("Approved for Tier 2 Vetting");
    });

    it("interpolates score, name, and years into justification", () => {
      const summary = generateSummary(
        "Acme Foundation",
        88,
        "PASS",
        allPassChecks,
        [],
        10,
      );
      expect(summary.justification).toContain("88/100");
      expect(summary.justification).toContain("Acme Foundation");
      expect(summary.justification).toContain("10 years");
    });

    it('uses "unknown" when yearsOperating is null', () => {
      const summary = generateSummary(
        "Test Org",
        85,
        "PASS",
        allPassChecks,
        [],
        null,
      );
      expect(summary.justification).toContain("unknown");
    });

    it("includes PASS next_steps", () => {
      const summary = generateSummary(
        "Test Org",
        92,
        "PASS",
        allPassChecks,
        [],
        15,
      );
      expect(summary.next_steps).toEqual(VERDICT_CONFIG.PASS.next_steps);
    });

    it("returns a new array for next_steps (not a reference)", () => {
      const summary = generateSummary(
        "Test Org",
        92,
        "PASS",
        allPassChecks,
        [],
        15,
      );
      expect(summary.next_steps).not.toBe(VERDICT_CONFIG.PASS.next_steps);
      expect(summary.next_steps).toEqual(VERDICT_CONFIG.PASS.next_steps);
    });
  });

  // ---------- REVIEW recommendation ----------

  describe("REVIEW recommendation", () => {
    const mixedChecks: Tier1Check[] = [
      makeCheck({
        name: "years_operating",
        result: "REVIEW",
        passed: false,
        detail: "Only 2 years",
      }),
      makeCheck({
        name: "revenue_range",
        result: "FAIL",
        passed: false,
        detail: "Revenue too low",
      }),
      makeCheck({ name: "spend_rate", result: "PASS" }),
      makeCheck({ name: "recent_990", result: "PASS" }),
    ];

    it("returns REVIEW headline", () => {
      const summary = generateSummary(
        "Test Org",
        62,
        "REVIEW",
        mixedChecks,
        [],
        2,
      );
      expect(summary.headline).toBe("Manual Review Required");
    });

    it("includes issues summary from non-PASS checks", () => {
      const summary = generateSummary(
        "Test Org",
        62,
        "REVIEW",
        mixedChecks,
        [],
        2,
      );
      expect(summary.justification).toContain("Only 2 years");
      expect(summary.justification).toContain("Revenue too low");
    });

    it("limits issues summary to 3 items", () => {
      const manyFailChecks = [
        makeCheck({
          name: "years_operating",
          result: "FAIL",
          detail: "Issue 1",
        }),
        makeCheck({ name: "revenue_range", result: "FAIL", detail: "Issue 2" }),
        makeCheck({
          name: "spend_rate",
          result: "FAIL",
          detail: "Issue 3",
        }),
        makeCheck({ name: "recent_990", result: "FAIL", detail: "Issue 4" }),
      ];
      const summary = generateSummary(
        "Test Org",
        20,
        "REJECT",
        manyFailChecks,
        [],
        1,
      );
      expect(summary.justification).toContain("Issue 1");
      expect(summary.justification).toContain("Issue 3");
      expect(summary.justification).not.toContain("Issue 4");
    });
  });

  // ---------- REJECT recommendation ----------

  describe("REJECT recommendation", () => {
    it("returns REJECT headline", () => {
      const failChecks = [
        makeCheck({
          name: "years_operating",
          result: "FAIL",
          detail: "No ruling date",
        }),
      ];
      const summary = generateSummary(
        "Bad Org",
        15,
        "REJECT",
        failChecks,
        [],
        0,
      );
      expect(summary.headline).toBe("Does Not Meet Criteria");
    });

    it("interpolates score into justification", () => {
      const failChecks = [
        makeCheck({
          name: "years_operating",
          result: "FAIL",
          detail: "No ruling date",
        }),
      ];
      const summary = generateSummary(
        "Bad Org",
        15,
        "REJECT",
        failChecks,
        [],
        0,
      );
      expect(summary.justification).toContain("15/100");
    });
  });

  // ---------- Key factors ----------

  describe("key_factors", () => {
    it('prefixes positive factors with "+"', () => {
      const checks = [makeCheck({ name: "years_operating", result: "PASS" })];
      const summary = generateSummary("Org", 90, "PASS", checks, [], 10);
      expect(summary.key_factors[0]).toMatch(/^\+ /);
    });

    it('prefixes negative factors with "-"', () => {
      const checks = [makeCheck({ name: "years_operating", result: "FAIL" })];
      const summary = generateSummary("Org", 30, "REJECT", checks, [], 0);
      expect(summary.key_factors[0]).toMatch(/^- /);
    });

    it('prefixes neutral factors with "~"', () => {
      const checks = [makeCheck({ name: "years_operating", result: "REVIEW" })];
      const summary = generateSummary("Org", 60, "REVIEW", checks, [], 2);
      expect(summary.key_factors[0]).toMatch(/^~ /);
    });

    it("includes factors for all known checks", () => {
      const summary = generateSummary("Org", 90, "PASS", allPassChecks, [], 10);
      expect(summary.key_factors.length).toBe(4);
    });

    it("skips checks with unknown names", () => {
      const checks = [makeCheck({ name: "unknown_check", result: "PASS" })];
      const summary = generateSummary("Org", 90, "PASS", checks, [], 10);
      expect(summary.key_factors.length).toBe(0);
    });
  });

  // ---------- Red flag integration ----------

  describe("red flags in key_factors", () => {
    it("adds red flags as negative factors with severity", () => {
      const flags: RedFlag[] = [
        makeRedFlag({ type: "stale_990", severity: "HIGH" }),
      ];
      const summary = generateSummary("Org", 60, "REVIEW", [], flags, 5);
      expect(summary.key_factors.length).toBe(1);
      expect(summary.key_factors[0]).toContain("HIGH");
      expect(summary.key_factors[0]).toMatch(/^- /);
    });

    it("uses flag detail when type is not in RED_FLAG_FACTORS", () => {
      const flags: RedFlag[] = [
        {
          severity: "MEDIUM",
          type: "unknown_flag_type" as any,
          detail: "Custom flag detail",
        },
      ];
      const summary = generateSummary("Org", 50, "REVIEW", [], flags, 5);
      expect(summary.key_factors[0]).toContain("Custom flag detail");
    });

    it("deduplicates when red flag message already in check factors", () => {
      // Check factor for recent_990 FAIL detail contains stale info
      // RED_FLAG_FACTORS['stale_990'] = 'Financial data is severely outdated'
      // These are different — so both should appear
      const checks = [makeCheck({ name: "years_operating", result: "PASS" })];
      const flags: RedFlag[] = [
        makeRedFlag({ type: "stale_990", severity: "HIGH" }),
      ];
      const summary = generateSummary("Org", 60, "REVIEW", checks, flags, 5);
      expect(summary.key_factors.length).toBe(2);
    });
  });

  // ---------- Edge cases ----------

  describe("edge cases", () => {
    it("handles empty checks and no red flags", () => {
      const summary = generateSummary("Org", 80, "PASS", [], [], 10);
      expect(summary.key_factors).toEqual([]);
      // PASS template uses {{years}} not {{issues_summary}}, so 'No specific concerns' won't appear
    });

    it("handles zero score", () => {
      const summary = generateSummary("Org", 0, "REJECT", [], [], 0);
      expect(summary.justification).toContain("0/100");
    });

    it("handles score of 100", () => {
      const summary = generateSummary(
        "Org",
        100,
        "PASS",
        allPassChecks,
        [],
        20,
      );
      expect(summary.justification).toContain("100/100");
    });
  });
});
