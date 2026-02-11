// Tier 1 Check Types

import type { RedFlag } from "./red-flags.js";

export type CheckResult = "PASS" | "REVIEW" | "FAIL";

export interface Tier1Check {
  name: string;
  passed: boolean;
  result: CheckResult;
  detail: string;
  weight: number;
}

export interface Tier1Summary {
  headline: string;
  justification: string;
  key_factors: string[]; // Prefixed: "+" positive, "-" negative, "~" neutral/warning
  next_steps: string[];
}

export interface Tier1Result {
  ein: string;
  name: string;
  passed: boolean;
  gates: import("../../gates/gate-types.js").GateLayerResult;
  gate_blocked: boolean;
  score: number | null; // null when gate-blocked
  summary: Tier1Summary;
  checks: Tier1Check[] | null; // null when gate-blocked
  recommendation: "PASS" | "REVIEW" | "REJECT";
  review_reasons: string[];
  red_flags: RedFlag[];
}

// Vetting Thresholds (Configurable via Environment Variables)

export interface VettingThresholds {
  // Check weights (4 checks x 25 = 100; 501c3 moved to gate layer)
  weightYearsOperating: number;
  weightRevenueRange: number;
  weightOverheadRatio: number;
  weightRecent990: number;

  // Years operating
  yearsPassMin: number; // >= this = PASS (default: 3)
  yearsReviewMin: number; // >= this = REVIEW (default: 1)

  // Revenue range ($)
  revenueFailMin: number; // < this = FAIL (default: 50000)
  revenuePassMin: number; // >= this = PASS lower bound (default: 100000)
  revenuePassMax: number; // <= this = PASS upper bound (default: 10000000)
  revenueReviewMax: number; // <= this = REVIEW upper bound (default: 50000000)

  // Expense-to-revenue ratio
  expenseRatioPassMin: number; // lower bound of healthy range (default: 0.70)
  expenseRatioPassMax: number; // upper bound of healthy range (default: 1.0)
  expenseRatioHighReview: number; // above passMax, up to this = REVIEW (default: 1.2)
  expenseRatioLowReview: number; // below passMin, down to this = REVIEW (default: 0.5)

  // 990 filing recency (years)
  filing990PassMax: number; // <= this = PASS (default: 2)
  filing990ReviewMax: number; // <= this = REVIEW (default: 3)

  // Score-based recommendation cutoffs
  scorePassMin: number; // >= this = PASS (default: 75)
  scoreReviewMin: number; // >= this = REVIEW (default: 50)

  // Red flag thresholds
  redFlagStale990Years: number; // 990 older than this = HIGH flag (default: 4)
  redFlagHighExpenseRatio: number; // above this = HIGH flag (default: 1.2)
  redFlagLowExpenseRatio: number; // below this = MEDIUM flag (default: 0.5)
  redFlagVeryLowRevenue: number; // below this = MEDIUM flag (default: 25000)
  redFlagRevenueDeclinePercent: number; // decline > this = MEDIUM flag (default: 0.2)
  redFlagTooNewYears: number; // operating < this = MEDIUM flag (default: 1)

  // Officer compensation thresholds (decimal: 0.40 = 40%)
  redFlagHighCompensation: number; // above this = HIGH flag (default: 0.40)
  redFlagModerateCompensation: number; // above this = MEDIUM flag (default: 0.25)
}

// Portfolio-Fit Config (Platform Eligibility Policy)

export interface PortfolioFitConfig {
  enabled: boolean; // false = gate always passes (opt-in)
  allowedNteeCategories: string[]; // Prefix matching: ["A", "B", "N2", "P"]
  excludedEins: string[]; // Hard block (checked first, always wins)
  includedEins: string[]; // Hard allow (skips NTEE check)
}
