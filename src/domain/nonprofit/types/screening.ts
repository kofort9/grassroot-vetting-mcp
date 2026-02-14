// Screening & Criterion Types
//
// CriterionCheck — individual criterion evaluation (inputs to scoring)
// ScreeningResult — full pipeline output (gates + scoring + red flags)
//
// "Screening" here refers to the full automated screening pipeline,
// NOT just the gate/pre-screen layer. Gate types live in gates/gate-types.ts.
//
// Naming: "Screening" reflects automated financial checks against 990 data.
// Future deep-dive types will use "Review" or "DueDiligence" naming
// to distinguish human-led analysis from automated screening.

import type { RedFlag } from "./red-flags.js";

export type CheckResult = "PASS" | "REVIEW" | "FAIL";

export interface CriterionCheck {
  name: string;
  passed: boolean;
  result: CheckResult;
  detail: string;
  weight: number;
}

export interface ScreeningSummary {
  headline: string;
  justification: string;
  key_factors: string[]; // Prefixed: "+" positive, "-" negative, "~" neutral/warning
  next_steps: string[];
}

export interface ScreeningResult {
  ein: string;
  name: string;
  passed: boolean;
  gates: import("../../gates/gate-types.js").GateLayerResult;
  gate_blocked: boolean;
  score: number | null; // null when gate-blocked
  summary: ScreeningSummary;
  checks: CriterionCheck[] | null; // null when gate-blocked
  recommendation: "PASS" | "REVIEW" | "REJECT";
  review_reasons: string[];
  red_flags: RedFlag[];
}

// Vetting Thresholds (Configurable via Environment Variables)

export interface VettingThresholds {
  // Check weights (4 checks x 25 = 100; 501c3 moved to gate layer)
  weightYearsOperating: number;
  weightRevenueRange: number;
  weightSpendRate: number;
  weightRecent990: number;

  // Years operating
  yearsPassMin: number; // >= this = PASS
  yearsReviewMin: number; // >= this = REVIEW

  // Revenue range ($) — defaults in config.ts loadThresholds()
  revenueFailMin: number; // < this = FAIL
  revenuePassMin: number; // >= this = PASS lower bound
  revenuePassMax: number; // <= this = PASS upper bound
  revenueReviewMax: number; // <= this = REVIEW upper bound

  // Expense-to-revenue ratio
  expenseRatioPassMin: number; // lower bound of healthy range
  expenseRatioPassMax: number; // upper bound of healthy range
  expenseRatioHighReview: number; // above passMax, up to this = REVIEW
  expenseRatioLowReview: number; // below passMin, down to this = REVIEW

  // 990 filing recency (years)
  filing990PassMax: number; // <= this = PASS
  filing990ReviewMax: number; // <= this = REVIEW

  // Score-based recommendation cutoffs
  scorePassMin: number; // >= this = PASS
  scoreReviewMin: number; // >= this = REVIEW

  // Red flag thresholds
  redFlagStale990Years: number; // 990 older than this = HIGH flag
  redFlagHighExpenseRatio: number; // above this = HIGH flag
  redFlagLowExpenseRatio: number; // below this = MEDIUM flag
  redFlagVeryLowRevenue: number; // below this = MEDIUM flag
  redFlagRevenueDeclinePercent: number; // decline > this = MEDIUM flag
  redFlagTooNewYears: number; // operating < this = MEDIUM flag

  // Officer compensation thresholds (decimal: 0.40 = 40%)
  redFlagHighCompensation: number; // above this = HIGH flag
  redFlagModerateCompensation: number; // above this = MEDIUM flag
}

// Portfolio-Fit Config (Platform Eligibility Policy)

export interface PortfolioFitConfig {
  enabled: boolean; // false = gate always passes (opt-in)
  allowedNteeCategories: string[]; // Prefix matching: ["A", "B", "N2", "P"]
  excludedEins: string[]; // Hard block (checked first, always wins)
  includedEins: string[]; // Hard allow (skips NTEE check)
}
