import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateThresholds, loadPortfolioFitConfig } from '../src/core/config.js';
import { DEFAULT_THRESHOLDS, makeThresholds } from './fixtures.js';

describe('validateThresholds', () => {
  it('accepts default thresholds', () => {
    expect(() => validateThresholds(DEFAULT_THRESHOLDS)).not.toThrow();
  });

  // --- Weight validation ---

  it('rejects weights that do not sum to 100', () => {
    const t = makeThresholds({ weightYearsOperating: 50 }); // sum = 125
    expect(() => validateThresholds(t)).toThrow(/Weights must sum to 100/);
  });

  it('rejects negative weights', () => {
    // Keep sum at 100 but with a negative: -10 + 60 + 25 + 25 = 100
    const t = makeThresholds({ weightYearsOperating: -10, weightRevenueRange: 60 });
    expect(() => validateThresholds(t)).toThrow(/non-negative/);
  });

  it('accepts zero weight (disabling a check)', () => {
    // sum still 100: 0 + 50 + 25 + 25 = 100
    const t = makeThresholds({ weightYearsOperating: 0, weightRevenueRange: 50 });
    expect(() => validateThresholds(t)).not.toThrow();
  });

  // --- Revenue range ordering ---

  it('rejects revenueFailMin > revenuePassMin', () => {
    const t = makeThresholds({ revenueFailMin: 200_000, revenuePassMin: 100_000 });
    expect(() => validateThresholds(t)).toThrow(/revenueFailMin/);
  });

  it('rejects revenuePassMin > revenuePassMax', () => {
    const t = makeThresholds({ revenuePassMin: 20_000_000 });
    expect(() => validateThresholds(t)).toThrow(/revenuePassMin/);
  });

  it('rejects revenuePassMax > revenueReviewMax', () => {
    const t = makeThresholds({ revenuePassMax: 60_000_000 });
    expect(() => validateThresholds(t)).toThrow(/revenuePassMax/);
  });

  // --- Expense ratio ordering ---

  it('rejects expenseRatioLowReview > expenseRatioPassMin', () => {
    const t = makeThresholds({ expenseRatioLowReview: 0.9 });
    expect(() => validateThresholds(t)).toThrow(/expenseRatioLowReview/);
  });

  it('rejects expenseRatioPassMin > expenseRatioPassMax', () => {
    const t = makeThresholds({ expenseRatioPassMin: 1.5 });
    expect(() => validateThresholds(t)).toThrow(/expenseRatioPassMin/);
  });

  it('rejects expenseRatioPassMax > expenseRatioHighReview', () => {
    const t = makeThresholds({ expenseRatioPassMax: 2.0 });
    expect(() => validateThresholds(t)).toThrow(/expenseRatioPassMax/);
  });

  // --- Other ordering invariants ---

  it('rejects yearsReviewMin > yearsPassMin', () => {
    const t = makeThresholds({ yearsReviewMin: 5 });
    expect(() => validateThresholds(t)).toThrow(/yearsReviewMin/);
  });

  it('rejects filing990PassMax > filing990ReviewMax', () => {
    const t = makeThresholds({ filing990PassMax: 5 });
    expect(() => validateThresholds(t)).toThrow(/filing990PassMax/);
  });

  it('rejects scoreReviewMin > scorePassMin', () => {
    const t = makeThresholds({ scoreReviewMin: 90 });
    expect(() => validateThresholds(t)).toThrow(/scoreReviewMin/);
  });

  it('rejects scorePassMin > 100', () => {
    // need scoreReviewMin <= scorePassMin, so bump both
    const t = makeThresholds({ scorePassMin: 101, scoreReviewMin: 50 });
    expect(() => validateThresholds(t)).toThrow(/scorePassMin must be between/);
  });

  it('rejects scorePassMin < 0', () => {
    const t = makeThresholds({ scorePassMin: -1 });
    expect(() => validateThresholds(t)).toThrow(/scorePassMin must be between/);
  });

  // --- Officer compensation thresholds ---

  it('rejects redFlagModerateCompensation > redFlagHighCompensation', () => {
    const t = makeThresholds({ redFlagModerateCompensation: 0.5, redFlagHighCompensation: 0.3 });
    expect(() => validateThresholds(t)).toThrow(/redFlagModerateCompensation/);
  });

  it('rejects redFlagHighCompensation > 1', () => {
    const t = makeThresholds({ redFlagHighCompensation: 1.5 });
    expect(() => validateThresholds(t)).toThrow(/redFlagHighCompensation/);
  });

  it('rejects redFlagModerateCompensation < 0', () => {
    const t = makeThresholds({ redFlagModerateCompensation: -0.1 });
    expect(() => validateThresholds(t)).toThrow(/redFlagModerateCompensation/);
  });

  // --- Multiple errors ---

  it('reports multiple errors at once', () => {
    const t = makeThresholds({
      weightYearsOperating: -5,
      revenueFailMin: 200_000,
      scorePassMin: 101,
    });
    let caught: Error | undefined;
    try { validateThresholds(t); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('non-negative');
    expect(caught!.message).toContain('revenueFailMin');
    expect(caught!.message).toContain('scorePassMin');
  });
});

// ============================================================================
// loadPortfolioFitConfig
// ============================================================================

describe('loadPortfolioFitConfig', () => {
  const ENV_KEYS = [
    'PORTFOLIO_FIT_ENABLED',
    'PORTFOLIO_FIT_NTEE',
    'PORTFOLIO_FIT_EXCLUDED_EINS',
    'PORTFOLIO_FIT_INCLUDED_EINS',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // --- enabled flag ---

  it('enabled by default when PORTFOLIO_FIT_ENABLED is unset', () => {
    const config = loadPortfolioFitConfig();
    expect(config.enabled).toBe(true);
  });

  it('disabled when PORTFOLIO_FIT_ENABLED=false', () => {
    process.env.PORTFOLIO_FIT_ENABLED = 'false';
    expect(loadPortfolioFitConfig().enabled).toBe(false);
  });

  it('disabled when PORTFOLIO_FIT_ENABLED=0', () => {
    process.env.PORTFOLIO_FIT_ENABLED = '0';
    expect(loadPortfolioFitConfig().enabled).toBe(false);
  });

  it('disabled when PORTFOLIO_FIT_ENABLED=no (case-insensitive)', () => {
    process.env.PORTFOLIO_FIT_ENABLED = 'NO';
    expect(loadPortfolioFitConfig().enabled).toBe(false);
  });

  it('disabled when PORTFOLIO_FIT_ENABLED=off', () => {
    process.env.PORTFOLIO_FIT_ENABLED = 'off';
    expect(loadPortfolioFitConfig().enabled).toBe(false);
  });

  it('handles whitespace around PORTFOLIO_FIT_ENABLED value', () => {
    process.env.PORTFOLIO_FIT_ENABLED = '  false  ';
    expect(loadPortfolioFitConfig().enabled).toBe(false);
  });

  it('enabled for unknown values (e.g. "yes", "true", "1")', () => {
    process.env.PORTFOLIO_FIT_ENABLED = 'yes';
    expect(loadPortfolioFitConfig().enabled).toBe(true);
  });

  // --- NTEE categories ---

  it('uses default allowlist when PORTFOLIO_FIT_NTEE is unset', () => {
    const config = loadPortfolioFitConfig();
    expect(config.allowedNteeCategories).toContain('A');
    expect(config.allowedNteeCategories).toContain('P');
    expect(config.allowedNteeCategories).not.toContain('Q');
    expect(config.allowedNteeCategories).not.toContain('Z');
    expect(config.allowedNteeCategories).toHaveLength(20);
  });

  it('parses CSV NTEE categories and uppercases them', () => {
    process.env.PORTFOLIO_FIT_NTEE = 'a,b,n2';
    const config = loadPortfolioFitConfig();
    expect(config.allowedNteeCategories).toEqual(['A', 'B', 'N2']);
  });

  it('filters empty strings from NTEE CSV (trailing comma)', () => {
    process.env.PORTFOLIO_FIT_NTEE = 'A,B,';
    const config = loadPortfolioFitConfig();
    expect(config.allowedNteeCategories).toEqual(['A', 'B']);
    expect(config.allowedNteeCategories).not.toContain('');
  });

  it('trims whitespace from NTEE categories', () => {
    process.env.PORTFOLIO_FIT_NTEE = ' P , K , N2 ';
    const config = loadPortfolioFitConfig();
    expect(config.allowedNteeCategories).toEqual(['P', 'K', 'N2']);
  });

  // --- EIN lists ---

  it('returns empty EIN lists when env vars unset', () => {
    const config = loadPortfolioFitConfig();
    expect(config.excludedEins).toEqual([]);
    expect(config.includedEins).toEqual([]);
  });

  it('parses and normalizes excluded EINs (strips hyphens)', () => {
    process.env.PORTFOLIO_FIT_EXCLUDED_EINS = '95-3135649,12-3456789';
    const config = loadPortfolioFitConfig();
    expect(config.excludedEins).toEqual(['953135649', '123456789']);
  });

  it('parses and normalizes included EINs (strips hyphens)', () => {
    process.env.PORTFOLIO_FIT_INCLUDED_EINS = '95-3135649';
    const config = loadPortfolioFitConfig();
    expect(config.includedEins).toEqual(['953135649']);
  });

  it('filters empty entries from EIN lists (trailing comma)', () => {
    process.env.PORTFOLIO_FIT_EXCLUDED_EINS = '953135649,,';
    const config = loadPortfolioFitConfig();
    expect(config.excludedEins).toEqual(['953135649']);
  });
});
