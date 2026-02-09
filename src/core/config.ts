import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { VettingThresholds } from "../domain/nonprofit/types.js";

// Load environment variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ProPublicaConfig {
  apiBaseUrl: string;
  rateLimitMs: number;
}

export interface RedFlagConfig {
  courtlistenerApiToken?: string;
  courtlistenerBaseUrl: string;
  courtlistenerRateLimitMs: number;
  dataDir: string;
  dataMaxAgeDays: number;
}

export interface AppConfig {
  propublica: ProPublicaConfig;
  redFlag: RedFlagConfig;
  thresholds: VettingThresholds;
}

// Security: Only allow official ProPublica API endpoint
const ALLOWED_API_BASE_URL =
  "https://projects.propublica.org/nonprofits/api/v2";

function envNum(
  key: string,
  fallback: number,
  validate: (n: number) => boolean,
): number {
  const val = process.env[key];
  if (val === undefined || val.trim() === "") return fallback;
  const parsed = Number(val);
  return validate(parsed) ? parsed : fallback;
}

function envFloat(key: string, fallback: number): number {
  return envNum(key, fallback, Number.isFinite);
}

function envInt(key: string, fallback: number): number {
  return envNum(key, fallback, Number.isInteger);
}

/**
 * Loads ProPublica API configuration from environment variables
 * Note: ProPublica API is free and doesn't require authentication
 */
export function loadProPublicaConfig(): ProPublicaConfig {
  // Security: Ignore PROPUBLICA_API_BASE_URL env var to prevent SSRF
  // Only the official ProPublica endpoint is allowed
  return {
    apiBaseUrl: ALLOWED_API_BASE_URL,
    rateLimitMs: Math.max(100, envInt("PROPUBLICA_RATE_LIMIT_MS", 500)),
  };
}

/**
 * Loads vetting thresholds from environment variables.
 * Every value has a sensible default matching the original hardcoded behavior.
 */
export function loadThresholds(): VettingThresholds {
  return {
    // Check weights (4 checks x 25 = 100; 501c3 moved to gate layer)
    weightYearsOperating: envInt("VETTING_WEIGHT_YEARS", 25),
    weightRevenueRange: envInt("VETTING_WEIGHT_REVENUE", 25),
    weightOverheadRatio: envInt("VETTING_WEIGHT_OVERHEAD", 25),
    weightRecent990: envInt("VETTING_WEIGHT_990", 25),

    // Years operating
    yearsPassMin: envInt("VETTING_YEARS_PASS_MIN", 3),
    yearsReviewMin: envInt("VETTING_YEARS_REVIEW_MIN", 1),

    // Revenue range ($)
    revenueFailMin: envInt("VETTING_REVENUE_FAIL_MIN", 50000),
    revenuePassMin: envInt("VETTING_REVENUE_PASS_MIN", 100000),
    revenuePassMax: envInt("VETTING_REVENUE_PASS_MAX", 10000000),
    revenueReviewMax: envInt("VETTING_REVENUE_REVIEW_MAX", 50000000),

    // Expense-to-revenue ratio
    expenseRatioPassMin: envFloat("VETTING_EXPENSE_RATIO_PASS_MIN", 0.7),
    expenseRatioPassMax: envFloat("VETTING_EXPENSE_RATIO_PASS_MAX", 1.0),
    expenseRatioHighReview: envFloat("VETTING_EXPENSE_RATIO_HIGH_REVIEW", 1.2),
    expenseRatioLowReview: envFloat("VETTING_EXPENSE_RATIO_LOW_REVIEW", 0.5),

    // 990 filing recency (years)
    filing990PassMax: envInt("VETTING_990_PASS_MAX_YEARS", 2),
    filing990ReviewMax: envInt("VETTING_990_REVIEW_MAX_YEARS", 3),

    // Score cutoffs (75 threshold: gates handle binary disqualifiers, scoring is more forgiving)
    scorePassMin: envInt("VETTING_SCORE_PASS_MIN", 75),
    scoreReviewMin: envInt("VETTING_SCORE_REVIEW_MIN", 50),

    // Red flag thresholds
    redFlagStale990Years: envInt("VETTING_RF_STALE_990_YEARS", 4),
    redFlagHighExpenseRatio: envFloat("VETTING_RF_HIGH_EXPENSE_RATIO", 1.2),
    redFlagLowExpenseRatio: envFloat("VETTING_RF_LOW_EXPENSE_RATIO", 0.5),
    redFlagVeryLowRevenue: envInt("VETTING_RF_VERY_LOW_REVENUE", 25000),
    redFlagRevenueDeclinePercent: envFloat(
      "VETTING_RF_REVENUE_DECLINE_PCT",
      0.2,
    ),
    redFlagTooNewYears: envInt("VETTING_RF_TOO_NEW_YEARS", 1),

    // Officer compensation
    redFlagHighCompensation: envFloat("VETTING_RF_HIGH_COMPENSATION", 0.4),
    redFlagModerateCompensation: envFloat(
      "VETTING_RF_MODERATE_COMPENSATION",
      0.25,
    ),
  };
}

/**
 * Validate threshold invariants at startup.
 * Throws on misconfiguration rather than silently running with broken logic.
 */
export function validateThresholds(t: VettingThresholds): void {
  const errors: string[] = [];

  const weights = [
    t.weightYearsOperating,
    t.weightRevenueRange,
    t.weightOverheadRatio,
    t.weightRecent990,
  ];
  if (weights.some((w) => w < 0)) {
    errors.push("All weights must be non-negative");
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum !== 100) {
    errors.push(`Weights must sum to 100, got ${weightSum}`);
  }

  if (t.revenueFailMin > t.revenuePassMin)
    errors.push("revenueFailMin must be <= revenuePassMin");
  if (t.revenuePassMin > t.revenuePassMax)
    errors.push("revenuePassMin must be <= revenuePassMax");
  if (t.revenuePassMax > t.revenueReviewMax)
    errors.push("revenuePassMax must be <= revenueReviewMax");

  if (t.expenseRatioLowReview > t.expenseRatioPassMin)
    errors.push("expenseRatioLowReview must be <= expenseRatioPassMin");
  if (t.expenseRatioPassMin > t.expenseRatioPassMax)
    errors.push("expenseRatioPassMin must be <= expenseRatioPassMax");
  if (t.expenseRatioPassMax > t.expenseRatioHighReview)
    errors.push("expenseRatioPassMax must be <= expenseRatioHighReview");

  if (t.yearsReviewMin > t.yearsPassMin)
    errors.push("yearsReviewMin must be <= yearsPassMin");
  if (t.filing990PassMax > t.filing990ReviewMax)
    errors.push("filing990PassMax must be <= filing990ReviewMax");
  if (t.scoreReviewMin > t.scorePassMin)
    errors.push("scoreReviewMin must be <= scorePassMin");
  if (t.scorePassMin < 0 || t.scorePassMin > 100)
    errors.push("scorePassMin must be between 0 and 100");
  if (t.scoreReviewMin < 0 || t.scoreReviewMin > 100)
    errors.push("scoreReviewMin must be between 0 and 100");
  if (t.revenueFailMin < 0) errors.push("revenueFailMin must be non-negative");
  if (t.revenueReviewMax < 0)
    errors.push("revenueReviewMax must be non-negative");
  if (t.yearsReviewMin < 0) errors.push("yearsReviewMin must be non-negative");
  if (t.yearsPassMin < 0) errors.push("yearsPassMin must be non-negative");
  if (t.filing990PassMax < 0)
    errors.push("filing990PassMax must be non-negative");
  if (t.filing990ReviewMax < 0)
    errors.push("filing990ReviewMax must be non-negative");
  if (t.redFlagTooNewYears < 0)
    errors.push("redFlagTooNewYears must be non-negative");
  if (t.redFlagStale990Years < 0)
    errors.push("redFlagStale990Years must be non-negative");
  if (t.redFlagRevenueDeclinePercent < 0 || t.redFlagRevenueDeclinePercent > 1)
    errors.push("redFlagRevenueDeclinePercent must be between 0 and 1");

  if (t.redFlagModerateCompensation < 0 || t.redFlagModerateCompensation > 1)
    errors.push("redFlagModerateCompensation must be between 0 and 1");
  if (t.redFlagHighCompensation < 0 || t.redFlagHighCompensation > 1)
    errors.push("redFlagHighCompensation must be between 0 and 1");
  if (t.redFlagModerateCompensation > t.redFlagHighCompensation)
    errors.push(
      "redFlagModerateCompensation must be <= redFlagHighCompensation",
    );

  if (errors.length > 0) {
    throw new Error(
      `Invalid vetting thresholds:\n  - ${errors.join("\n  - ")}`,
    );
  }
}

// Security: Only allow official CourtListener endpoint
const COURTLISTENER_BASE_URL = "https://www.courtlistener.com/api/rest/v4";

/**
 * Loads red flag data source configuration from environment variables.
 */
export function loadRedFlagConfig(): RedFlagConfig {
  return {
    courtlistenerApiToken: process.env.COURTLISTENER_API_TOKEN || undefined,
    courtlistenerBaseUrl: COURTLISTENER_BASE_URL,
    courtlistenerRateLimitMs: Math.max(
      100,
      envInt("COURTLISTENER_RATE_LIMIT_MS", 500),
    ),
    dataDir: path.resolve(__dirname, "../../data"),
    dataMaxAgeDays: Math.max(1, envInt("DATA_MAX_AGE_DAYS", 7)),
  };
}

/**
 * Loads full application config — backward compatible via loadConfig()
 */
export function loadConfig(): AppConfig {
  const thresholds = loadThresholds();
  validateThresholds(thresholds);
  return {
    propublica: loadProPublicaConfig(),
    redFlag: loadRedFlagConfig(),
    thresholds,
  };
}
