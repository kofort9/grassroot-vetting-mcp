import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  VettingThresholds,
  PortfolioFitConfig,
  GivingTuesdayConfig,
} from "../domain/nonprofit/types.js";
import type { DiscoveryIndexConfig } from "../domain/discovery/types.js";

// Load environment variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RedFlagConfig {
  courtlistenerApiToken?: string;
  courtlistenerBaseUrl: string;
  courtlistenerRateLimitMs: number;
  dataDir: string;
  dataMaxAgeDays: number;
}

export interface AppConfig {
  redFlag: RedFlagConfig;
  thresholds: VettingThresholds;
  portfolioFit: PortfolioFitConfig;
  discovery: DiscoveryIndexConfig;
  vettingCacheMaxAgeDays: number;
}

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
 * Loads vetting thresholds from environment variables.
 * Every value has a sensible default matching the original hardcoded behavior.
 */
export function loadThresholds(): VettingThresholds {
  return {
    // Check weights (10+25+35+30 = 100; 501c3 moved to gate layer)
    weightYearsOperating: envInt("VETTING_WEIGHT_YEARS", 10),
    weightRevenueRange: envInt("VETTING_WEIGHT_REVENUE", 25),
    weightSpendRate: envInt("VETTING_WEIGHT_OVERHEAD", 35),
    weightRecent990: envInt("VETTING_WEIGHT_990", 30),

    // Years operating
    yearsPassMin: envInt("VETTING_YEARS_PASS_MIN", 3),
    yearsReviewMin: envInt("VETTING_YEARS_REVIEW_MIN", 1),

    // Revenue range ($)
    revenueFailMin: envInt("VETTING_REVENUE_FAIL_MIN", 25000),
    revenuePassMin: envInt("VETTING_REVENUE_PASS_MIN", 50000),
    revenuePassMax: envInt("VETTING_REVENUE_PASS_MAX", 10000000),
    revenueReviewMax: envInt("VETTING_REVENUE_REVIEW_MAX", 50000000),

    // Expense-to-revenue ratio
    expenseRatioPassMin: envFloat("VETTING_EXPENSE_RATIO_PASS_MIN", 0.6),
    expenseRatioPassMax: envFloat("VETTING_EXPENSE_RATIO_PASS_MAX", 1.3),
    expenseRatioHighReview: envFloat("VETTING_EXPENSE_RATIO_HIGH_REVIEW", 1.5),
    expenseRatioLowReview: envFloat("VETTING_EXPENSE_RATIO_LOW_REVIEW", 0.4),

    // 990 filing recency (years)
    filing990PassMax: envInt("VETTING_990_PASS_MAX_YEARS", 3),
    filing990ReviewMax: envInt("VETTING_990_REVIEW_MAX_YEARS", 4),

    // Score cutoffs (75 threshold: gates handle binary disqualifiers, scoring is more forgiving)
    scorePassMin: envInt("VETTING_SCORE_PASS_MIN", 75),
    scoreReviewMin: envInt("VETTING_SCORE_REVIEW_MIN", 50),

    // Red flag thresholds
    redFlagStale990Years: envInt("VETTING_RF_STALE_990_YEARS", 4),
    redFlagHighExpenseRatio: envFloat("VETTING_RF_HIGH_EXPENSE_RATIO", 1.5),
    redFlagLowExpenseRatio: envFloat("VETTING_RF_LOW_EXPENSE_RATIO", 0.4),
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
    t.weightSpendRate,
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

// ============================================================================
// Portfolio-Fit Config
// ============================================================================

/** Default NTEE allowlist: all major categories except Q, T, V, X, Y, Z */
const DEFAULT_ALLOWED_NTEE = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "R",
  "S",
  "U",
  "W",
];

function parseEinList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/[-\s]/g, ""))
    .filter(Boolean);
}

/**
 * Loads portfolio-fit gate configuration from environment variables.
 * Enabled by default — set PORTFOLIO_FIT_ENABLED=false to disable.
 */
export function loadPortfolioFitConfig(): PortfolioFitConfig {
  const raw = process.env.PORTFOLIO_FIT_NTEE;
  return {
    enabled: !["false", "0", "no", "off"].includes(
      (process.env.PORTFOLIO_FIT_ENABLED ?? "").trim().toLowerCase(),
    ),
    allowedNteeCategories: raw
      ? raw
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : DEFAULT_ALLOWED_NTEE,
    excludedEins: parseEinList(process.env.PORTFOLIO_FIT_EXCLUDED_EINS),
    includedEins: parseEinList(process.env.PORTFOLIO_FIT_INCLUDED_EINS),
  };
}

// ============================================================================
// Discovery Index Config
// ============================================================================

/** IRS EO BMF region files (4 regions covering all US states). */
const DEFAULT_BMF_REGIONS = ["eo1", "eo2", "eo3", "eo4"];

/**
 * Loads discovery index configuration from environment variables.
 */
export function loadDiscoveryConfig(): DiscoveryIndexConfig {
  const rawRegions = process.env.DISCOVERY_BMF_REGIONS;
  return {
    dataDir: path.resolve(__dirname, "../../data"),
    bmfRegions: rawRegions
      ? rawRegions
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_BMF_REGIONS,
    dataMaxAgeDays: Math.max(1, envInt("DISCOVERY_MAX_AGE_DAYS", 30)),
    maxOrgsPerQuery: Math.min(
      1000,
      Math.max(1, envInt("DISCOVERY_MAX_RESULTS", 500)),
    ),
  };
}

// ============================================================================
// GivingTuesday Config (XML 990 pipeline)
// ============================================================================

const GIVINGTUESDAY_BASE_URL = "https://990-infrastructure.gtdata.org";

export function loadGivingTuesdayConfig(): GivingTuesdayConfig {
  const config: GivingTuesdayConfig = {
    apiBaseUrl: GIVINGTUESDAY_BASE_URL,
    rateLimitMs: Math.max(200, envInt("GT_RATE_LIMIT_MS", 1000)),
    xmlCacheDir: path.resolve(__dirname, "../../data/xml-cache"),
    maxXmlSizeBytes: Math.min(
      50 * 1024 * 1024,
      Math.max(1024, envInt("GT_MAX_XML_SIZE_BYTES", 25 * 1024 * 1024)),
    ),
    maxRetries: Math.max(0, Math.min(10, envInt("GT_MAX_RETRIES", 3))),
    retryBackoffMs: Math.max(100, envInt("GT_RETRY_BACKOFF_MS", 2000)),
  };
  validateGivingTuesdayConfig(config);
  return config;
}

export function validateGivingTuesdayConfig(config: GivingTuesdayConfig): void {
  const errors: string[] = [];

  if (!config.apiBaseUrl.startsWith("https://")) {
    errors.push("apiBaseUrl must start with https://");
  }
  if (config.rateLimitMs < 200) {
    errors.push("rateLimitMs must be >= 200");
  }
  if (config.maxXmlSizeBytes > 50 * 1024 * 1024) {
    errors.push("maxXmlSizeBytes must be <= 50MB");
  }
  if (config.maxXmlSizeBytes < 1024) {
    errors.push("maxXmlSizeBytes must be >= 1024");
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid GivingTuesday config:\n  - ${errors.join("\n  - ")}`,
    );
  }
}

/**
 * Loads full application config — backward compatible via loadConfig()
 */
export function loadConfig(): AppConfig {
  const thresholds = loadThresholds();
  validateThresholds(thresholds);
  return {
    redFlag: loadRedFlagConfig(),
    thresholds,
    portfolioFit: loadPortfolioFitConfig(),
    discovery: loadDiscoveryConfig(),
    vettingCacheMaxAgeDays: Math.min(365, Math.max(1, envInt("VETTING_CACHE_MAX_AGE_DAYS", 30))),
  };
}
