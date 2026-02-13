/**
 * Demo: Full Tier 1 Vetting Pipeline
 *
 * Shows the 3-layer architecture in action:
 *   Layer 1: Gates (binary pre-screen)
 *   Layer 2: Scoring (4 weighted checks = 100 max)
 *   Layer 3: Red Flags (anomaly overlay)
 *
 * Run with: npx vitest run tests/demo-pipeline.test.ts --reporter=verbose
 */
import { describe, it, expect, vi } from "vitest";
import { runTier1Checks } from "../src/domain/nonprofit/scoring.js";
import {
  makeProfile,
  makeFiling,
  makeMockIrsClient,
  makeMockOfacClient,
  makePortfolioFitConfig,
  makeRevokedIrsResult,
  makeMatchedOfacResult,
  makeFlaggedCourtResult,
  DEFAULT_THRESHOLDS,
  taxPrdOffset,
} from "./fixtures.js";

const t = DEFAULT_THRESHOLDS;

describe("Full Tier 1 Pipeline Demo", () => {
  // -----------------------------------------------------------------
  // Scenario 1: Healthy nonprofit → PASS (score 100)
  // -----------------------------------------------------------------
  it("Healthy org: gates pass, all 4 checks score 25 → PASS at 100", () => {
    const profile = makeProfile({
      name: "Homeboy Industries",
      years_operating: 15,
    });
    const filings = [makeFiling()];
    const irs = makeMockIrsClient();
    const ofac = makeMockOfacClient();

    const result = runTier1Checks(
      profile,
      filings,
      t,
      irs as any,
      ofac as any,
      makePortfolioFitConfig(),
    );

    // Gates all pass
    expect(result.gate_blocked).toBe(false);
    expect(result.gates.all_passed).toBe(true);
    expect(result.gates.gates).toHaveLength(4);
    expect(result.gates.gates.every((g) => g.verdict === "PASS")).toBe(true);

    // Scoring: 4 checks, all PASS
    expect(result.checks).toHaveLength(4);
    expect(result.checks!.map((c) => c.name)).toEqual([
      "years_operating",
      "revenue_range",
      "spend_rate",
      "recent_990",
    ]);
    expect(result.checks!.every((c) => c.result === "PASS")).toBe(true);
    expect(result.score).toBe(100);

    // No red flags
    expect(result.red_flags).toEqual([]);
    expect(result.recommendation).toBe("PASS");
    expect(result.passed).toBe(true);

    // Summary is human-readable
    expect(result.summary.headline).toBe("Approved for Tier 2 Vetting");
    expect(result.summary.key_factors.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------
  // Scenario 2: Revoked 501(c)(3) → Gate-blocked REJECT
  // -----------------------------------------------------------------
  it("Revoked nonprofit: Gate 1 blocks → REJECT with null score", () => {
    const profile = makeProfile({ name: "Revoked Foundation" });
    const filings = [makeFiling()];
    const irs = makeMockIrsClient();
    const ofac = makeMockOfacClient();

    // IRS says revoked
    irs.check.mockReturnValue(makeRevokedIrsResult());

    const result = runTier1Checks(
      profile,
      filings,
      t,
      irs as any,
      ofac as any,
      makePortfolioFitConfig(),
    );

    // Gate-blocked at Gate 1
    expect(result.gate_blocked).toBe(true);
    expect(result.gates.all_passed).toBe(false);
    expect(result.gates.blocking_gate).toBe("verified_501c3");

    // Gate 1 ran all 3 sub-checks (auditability)
    const gate1 = result.gates.gates[0];
    expect(gate1.sub_checks).toHaveLength(3);
    expect(gate1.sub_checks![0].label).toBe("501(c)(3) classification");
    expect(gate1.sub_checks![1].label).toBe("IRS revocation check");
    expect(gate1.sub_checks![1].passed).toBe(false); // revoked

    // No scoring happened
    expect(result.score).toBeNull();
    expect(result.checks).toBeNull();
    expect(result.recommendation).toBe("REJECT");

    // Summary explains gate failure
    expect(result.summary.headline).toContain("Gate Failure");
  });

  // -----------------------------------------------------------------
  // Scenario 3: OFAC sanctioned entity → Gate 2 blocks
  // -----------------------------------------------------------------
  it("Sanctioned org: Gate 2 blocks → REJECT, Gates 1 and 3 still run", () => {
    const profile = makeProfile({ name: "Bad Actor Foundation" });
    const filings = [makeFiling()];
    const irs = makeMockIrsClient();
    const ofac = makeMockOfacClient();

    // OFAC says matched
    ofac.check.mockReturnValue(makeMatchedOfacResult());

    const result = runTier1Checks(
      profile,
      filings,
      t,
      irs as any,
      ofac as any,
      makePortfolioFitConfig(),
    );

    expect(result.gate_blocked).toBe(true);
    expect(result.gates.blocking_gate).toBe("ofac_sanctions");

    // Gate 1 passed, Gate 2 failed, Gates 3-4 still ran (per spec)
    expect(result.gates.gates).toHaveLength(4);
    expect(result.gates.gates[0].verdict).toBe("PASS"); // 501c3
    expect(result.gates.gates[1].verdict).toBe("FAIL"); // OFAC
    expect(result.gates.gates[2].verdict).toBe("PASS"); // filing exists
    expect(result.gates.gates[3].verdict).toBe("PASS"); // portfolio fit
  });

  // -----------------------------------------------------------------
  // Scenario 4: Young org with low revenue → REVIEW (score ~50)
  // -----------------------------------------------------------------
  it("Young small org: scores 95 (PASS with new revenue floor)", () => {
    const profile = makeProfile({
      name: "New Community Aid",
      years_operating: 2, // REVIEW (< yearsPassMin=3, >= yearsReviewMin=1)
      ruling_date: "2024-01-01",
      latest_990: {
        tax_period: `${new Date().getFullYear() - 1}-06`,
        tax_year: new Date().getFullYear() - 1,
        form_type: "990",
        total_revenue: 80_000, // PASS ($80K >= passMin $50K)
        total_expenses: 56_000,
        total_assets: 50_000,
        total_liabilities: 10_000,
        overhead_ratio: 0.7, // PASS (0.7 >= passMin 0.6)
        officer_compensation_ratio: null,
      },
    });
    const filings = [makeFiling({ totrevenue: 80_000, totfuncexpns: 56_000 })];
    const irs = makeMockIrsClient();
    const ofac = makeMockOfacClient();

    const result = runTier1Checks(
      profile,
      filings,
      t,
      irs as any,
      ofac as any,
      makePortfolioFitConfig(),
    );

    expect(result.gate_blocked).toBe(false);

    // years_operating = REVIEW (2 yrs, need 3 for PASS) → 5 pts (half of 10)
    // revenue_range = PASS ($80K >= passMin $50K) → 25 pts
    // spend_rate = PASS (0.7 >= passMin 0.6) → 35 pts
    // recent_990 = PASS (recent) → 30 pts
    // Score: 5 + 25 + 35 + 30 = 95
    expect(result.score).toBe(95);
    expect(result.recommendation).toBe("PASS");

    // years_operating: 2 is above redFlagTooNewYears=1, so no "too_new" flag
    expect(result.red_flags).toEqual([]);
  });

  // -----------------------------------------------------------------
  // Scenario 5: Court records trigger red flag overlay
  // -----------------------------------------------------------------
  it("Org with 3+ court cases → HIGH red flag → auto-REJECT", () => {
    const profile = makeProfile({ name: "Troubled Charity" });
    const filings = [makeFiling()];
    const irs = makeMockIrsClient();
    const ofac = makeMockOfacClient();
    const courtResult = makeFlaggedCourtResult(4); // 3+ = HIGH

    const result = runTier1Checks(
      profile,
      filings,
      t,
      irs as any,
      ofac as any,
      makePortfolioFitConfig(),
      courtResult,
    );

    // Gates pass (org is a valid 501c3)
    expect(result.gate_blocked).toBe(false);

    // Score would be 100 (healthy org) but...
    expect(result.score).toBe(100);

    // Court records trigger HIGH red flag → auto-REJECT
    expect(result.red_flags.some((f) => f.type === "court_records")).toBe(true);
    expect(
      result.red_flags.find((f) => f.type === "court_records")!.severity,
    ).toBe("HIGH");
    expect(result.recommendation).toBe("REJECT");
    expect(result.passed).toBe(false);
  });

  // -----------------------------------------------------------------
  // Scenario 6: Revenue decline between filings
  // -----------------------------------------------------------------
  it("Revenue decline >20% triggers MEDIUM red flag", () => {
    const profile = makeProfile({
      name: "Declining Org",
      latest_990: {
        tax_period: `${new Date().getFullYear() - 1}-06`,
        tax_year: new Date().getFullYear() - 1,
        form_type: "990",
        total_revenue: 350_000, // 30% decline from 500K
        total_expenses: 280_000,
        total_assets: 800_000,
        total_liabilities: 150_000,
        overhead_ratio: 0.8,
        officer_compensation_ratio: null,
      },
    });
    // Two filings: latest 350K, previous 500K → 30% decline
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 350_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const irs = makeMockIrsClient();
    const ofac = makeMockOfacClient();

    const result = runTier1Checks(
      profile,
      filings,
      t,
      irs as any,
      ofac as any,
      makePortfolioFitConfig(),
    );

    expect(result.gate_blocked).toBe(false);
    expect(result.red_flags.some((f) => f.type === "revenue_decline")).toBe(
      true,
    );
    expect(
      result.red_flags.find((f) => f.type === "revenue_decline")!.severity,
    ).toBe("MEDIUM");
    // MEDIUM doesn't auto-reject — score still determines recommendation
    expect(result.recommendation).toMatch(/^(PASS|REVIEW)$/);
  });
});
