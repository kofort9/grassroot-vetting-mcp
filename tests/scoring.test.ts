import { describe, it, expect } from 'vitest';
import {
  checkYearsOperating,
  checkRevenueRange,
  checkOverheadRatio,
  checkRecent990,
  calculateScore,
  getRecommendation,
  detectRedFlags,
  runTier1Checks,
  runRedFlagCheck,
} from '../src/domain/nonprofit/scoring.js';
import { resolveThresholds, getSupportedSectors } from '../src/domain/nonprofit/sector-thresholds.js';
import { validateThresholds } from '../src/core/config.js';
import {
  DEFAULT_THRESHOLDS,
  makeProfile,
  make990,
  makeFiling,
  taxPrdOffset,
  makeMockIrsClient,
  makeMockOfacClient,
  makeRevokedIrsResult,
  makeFlaggedCourtResult,
} from './fixtures.js';

const t = DEFAULT_THRESHOLDS;

// ============================================================================
// checkYearsOperating
// ============================================================================

describe('checkYearsOperating', () => {
  it.each([
    [10, 'PASS'],
    [3,  'PASS'],   // boundary
    [2,  'REVIEW'],
    [1,  'REVIEW'], // boundary
    [0,  'FAIL'],
    [-1, 'FAIL'],   // data anomaly
  ] as const)('%d years → %s', (years, expected) => {
    const result = checkYearsOperating(makeProfile({ years_operating: years }), t);
    expect(result.result).toBe(expected);
  });

  it('fails for null years (no ruling date)', () => {
    const result = checkYearsOperating(makeProfile({ years_operating: null }), t);
    expect(result.result).toBe('FAIL');
    expect(result.detail).toContain('No ruling date');
  });
});

// ============================================================================
// checkRevenueRange
// ============================================================================

describe('checkRevenueRange', () => {
  it.each([
    [500_000,    'PASS'],   // middle of range
    [100_000,    'PASS'],   // lower boundary
    [10_000_000, 'PASS'],   // upper boundary
    [75_000,     'REVIEW'], // small but viable
    [30_000_000, 'REVIEW'], // larger org
    [25_000,     'FAIL'],   // too small
    [60_000_000, 'FAIL'],   // outside scope
  ] as const)('$%d revenue → %s', (revenue, expected) => {
    const result = checkRevenueRange(makeProfile({ latest_990: make990({ total_revenue: revenue }) }), t);
    expect(result.result).toBe(expected);
  });

  // --- Edge cases from the truthiness bug fix ---

  it('fails for $0 revenue (not falsy pass-through)', () => {
    const result = checkRevenueRange(makeProfile({ latest_990: make990({ total_revenue: 0 }) }), t);
    expect(result.result).toBe('FAIL');
    expect(result.detail).toBe('Zero revenue reported');
  });

  it('fails for negative revenue', () => {
    const result = checkRevenueRange(makeProfile({ latest_990: make990({ total_revenue: -50_000 }) }), t);
    expect(result.result).toBe('FAIL');
    expect(result.detail).toContain('Negative revenue');
  });

  it('fails for null revenue', () => {
    const result = checkRevenueRange(makeProfile({ latest_990: make990({ total_revenue: null as unknown as number }) }), t);
    expect(result.result).toBe('FAIL');
    expect(result.detail).toContain('No revenue data');
  });

  it('fails for undefined revenue (no 990)', () => {
    const result = checkRevenueRange(makeProfile({ latest_990: null }), t);
    expect(result.result).toBe('FAIL');
  });
});

// ============================================================================
// checkOverheadRatio
// ============================================================================

describe('checkOverheadRatio', () => {
  it.each([
    [0.8,  'PASS'],   // healthy
    [0.70, 'PASS'],   // lower boundary
    [1.0,  'PASS'],   // upper boundary
    [1.1,  'REVIEW'], // slightly above revenue
    [0.6,  'REVIEW'], // low deployment
    [1.2,  'REVIEW'], // high review boundary (uses >)
    [0.5,  'REVIEW'], // low review boundary (uses <)
    [NaN,  'REVIEW'], // data corruption treated as missing
    [1.5,  'FAIL'],   // unsustainable
    [0.3,  'FAIL'],   // very low deployment
    [-0.5, 'FAIL'],   // data anomaly
  ] as const)('ratio %d → %s', (ratio, expected) => {
    const result = checkOverheadRatio(makeProfile({ latest_990: make990({ overhead_ratio: ratio }) }), t);
    expect(result.result).toBe(expected);
  });

  it('reviews for null ratio (missing data)', () => {
    const result = checkOverheadRatio(makeProfile({ latest_990: make990({ overhead_ratio: null }) }), t);
    expect(result.result).toBe('REVIEW');
    expect(result.detail).toContain('missing data');
  });

  it('reviews when no 990 at all', () => {
    const result = checkOverheadRatio(makeProfile({ latest_990: null }), t);
    expect(result.result).toBe('REVIEW');
  });

  it('fails for negative ratio with data anomaly message', () => {
    const result = checkOverheadRatio(makeProfile({ latest_990: make990({ overhead_ratio: -0.5 }) }), t);
    expect(result.result).toBe('FAIL');
    expect(result.detail).toContain('Negative');
    expect(result.detail).toContain('data anomaly');
  });
});

// ============================================================================
// checkRecent990
// ============================================================================

describe('checkRecent990', () => {
  it('passes for recent filing (last year)', () => {
    const result = checkRecent990(makeProfile(), t);
    expect(result.result).toBe('PASS');
  });

  it('fails when filing_count is 0', () => {
    const result = checkRecent990(makeProfile({ filing_count: 0 }), t);
    expect(result.result).toBe('FAIL');
    expect(result.detail).toContain('No 990 filings');
  });

  it('fails when no latest_990', () => {
    const result = checkRecent990(makeProfile({ latest_990: null, filing_count: 0 }), t);
    expect(result.result).toBe('FAIL');
  });

  it('fails for very old filing (2015)', () => {
    const result = checkRecent990(
      makeProfile({ latest_990: make990({ tax_period: '2015-06' }) }),
      t
    );
    expect(result.result).toBe('FAIL');
    expect(result.detail).toContain('too stale');
  });

  it('fails for malformed tax_period without NaN in detail', () => {
    const result = checkRecent990(
      makeProfile({ latest_990: make990({ tax_period: 'bad-data' }) }),
      t
    );
    expect(result.result).toBe('FAIL');
    expect(result.detail).not.toContain('NaN');
    expect(result.detail).toContain('could not be parsed');
  });
});

// ============================================================================
// calculateScore
// ============================================================================

describe('calculateScore', () => {
  it('returns 100 when all checks pass', () => {
    const checks = [
      { name: 'a', passed: true, result: 'PASS' as const, detail: '', weight: 30 },
      { name: 'b', passed: true, result: 'PASS' as const, detail: '', weight: 15 },
      { name: 'c', passed: true, result: 'PASS' as const, detail: '', weight: 20 },
      { name: 'd', passed: true, result: 'PASS' as const, detail: '', weight: 20 },
      { name: 'e', passed: true, result: 'PASS' as const, detail: '', weight: 15 },
    ];
    expect(calculateScore(checks)).toBe(100);
  });

  it('returns 0 when all checks fail', () => {
    const checks = [
      { name: 'a', passed: false, result: 'FAIL' as const, detail: '', weight: 30 },
      { name: 'b', passed: false, result: 'FAIL' as const, detail: '', weight: 15 },
      { name: 'c', passed: false, result: 'FAIL' as const, detail: '', weight: 20 },
      { name: 'd', passed: false, result: 'FAIL' as const, detail: '', weight: 20 },
      { name: 'e', passed: false, result: 'FAIL' as const, detail: '', weight: 15 },
    ];
    expect(calculateScore(checks)).toBe(0);
  });

  it('gives 50% weight for REVIEW results', () => {
    const checks = [
      { name: 'a', passed: false, result: 'REVIEW' as const, detail: '', weight: 20 },
    ];
    expect(calculateScore(checks)).toBe(10);
  });

  it('rounds to nearest integer', () => {
    const checks = [
      { name: 'a', passed: true, result: 'PASS' as const, detail: '', weight: 30 },
      { name: 'b', passed: false, result: 'REVIEW' as const, detail: '', weight: 15 },
      { name: 'c', passed: false, result: 'FAIL' as const, detail: '', weight: 20 },
    ];
    // 30 + 7.5 + 0 = 37.5 -> 38
    expect(calculateScore(checks)).toBe(38);
  });

  it('handles empty checks array', () => {
    expect(calculateScore([])).toBe(0);
  });
});

// ============================================================================
// getRecommendation
// ============================================================================

describe('getRecommendation', () => {
  it('returns PASS for score >= 75 with no flags', () => {
    expect(getRecommendation(85, [], t)).toBe('PASS');
  });

  it('returns PASS at exactly 75 (boundary)', () => {
    expect(getRecommendation(75, [], t)).toBe('PASS');
  });

  it('returns REVIEW for score 50-74', () => {
    expect(getRecommendation(65, [], t)).toBe('REVIEW');
  });

  it('returns REVIEW at exactly 50 (boundary)', () => {
    expect(getRecommendation(50, [], t)).toBe('REVIEW');
  });

  it('returns REJECT for score < 50', () => {
    expect(getRecommendation(30, [], t)).toBe('REJECT');
  });

  it('returns REJECT when HIGH severity flag exists regardless of score', () => {
    const highFlag = { severity: 'HIGH' as const, type: 'stale_990' as const, detail: 'test' };
    expect(getRecommendation(95, [highFlag], t)).toBe('REJECT');
  });

  it('does not auto-reject on MEDIUM flags', () => {
    const medFlag = { severity: 'MEDIUM' as const, type: 'too_new' as const, detail: 'test' };
    expect(getRecommendation(85, [medFlag], t)).toBe('PASS');
  });
});

// ============================================================================
// detectRedFlags
// ============================================================================

describe('detectRedFlags', () => {
  it('returns empty array for clean profile', () => {
    const profile = makeProfile();
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toEqual([]);
  });

  it('flags organization less than 1 year old (MEDIUM)', () => {
    const profile = makeProfile({ years_operating: 0 });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'too_new', severity: 'MEDIUM' })
    );
  });

  it('does NOT flag org at exactly 1 year', () => {
    const profile = makeProfile({ years_operating: 1 });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'too_new' })
    );
  });

  it('flags stale 990 older than 4 years (HIGH)', () => {
    const profile = makeProfile({
      latest_990: make990({ tax_period: '2018-06' }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'stale_990', severity: 'HIGH' })
    );
  });

  it('flags very high expense ratio > 1.2 (HIGH)', () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 1.5 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'very_high_overhead', severity: 'HIGH' })
    );
  });

  it('does NOT flag ratio at exactly 1.2 (boundary uses >)', () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 1.2 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'very_high_overhead' })
    );
  });

  it('flags low fund deployment < 0.5 (MEDIUM)', () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 0.3 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'low_fund_deployment', severity: 'MEDIUM' })
    );
  });

  it('does NOT flag ratio at exactly 0.5 (boundary uses <)', () => {
    const profile = makeProfile({
      latest_990: make990({ overhead_ratio: 0.5 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'low_fund_deployment' })
    );
  });

  it('flags very low revenue under $25K (MEDIUM)', () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 10_000 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'very_low_revenue', severity: 'MEDIUM' })
    );
  });

  it('does NOT flag null revenue as very low (guards null, not just undefined)', () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: null as unknown as number }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'very_low_revenue' })
    );
  });

  // --- $0 revenue truthiness edge case (bug #1 from cleanup) ---

  it('flags $0 revenue as very low (not skipped by falsy check)', () => {
    const profile = makeProfile({
      latest_990: make990({ total_revenue: 0 }),
    });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'very_low_revenue' })
    );
  });

  // --- Revenue decline ---

  it('flags >20% revenue decline year-over-year (MEDIUM)', () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 350_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    // 30% decline > 20% threshold
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'revenue_decline', severity: 'MEDIUM' })
    );
  });

  it('does not flag 15% decline (below threshold)', () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 425_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'revenue_decline' })
    );
  });

  it('does not flag revenue increase', () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 800_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'revenue_decline' })
    );
  });

  it('handles single filing (no decline check possible)', () => {
    const flags = detectRedFlags(makeProfile(), [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'revenue_decline' })
    );
  });

  it('handles previous revenue of 0 (avoids division by zero)', () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 100_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 0 }),
    ];
    // Should not throw, and should not flag decline (can't calculate % from 0)
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'revenue_decline' })
    );
  });

  it('skips revenue decline check when filings are >18 months apart', () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: 200_000 }),
      makeFiling({ tax_prd: taxPrdOffset(3), totrevenue: 500_000 }), // 3 years ago
    ];
    // 60% decline, but filings are ~36 months apart — skip
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'revenue_decline' })
    );
  });

  // --- Officer compensation ratio (now reads from profile.latest_990) ---

  it('flags high officer compensation > 40% as HIGH', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: 0.50 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation', severity: 'HIGH' })
    );
  });

  it('flags moderate officer compensation > 25% as MEDIUM', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: 0.30 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation', severity: 'MEDIUM' })
    );
  });

  it('does NOT flag compensation at exactly 40% (boundary uses >)', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: 0.40 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation', severity: 'HIGH' })
    );
  });

  it('does NOT flag compensation at exactly 25% (boundary uses >)', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: 0.25 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation' })
    );
  });

  it('does NOT flag compensation at 20% (below moderate threshold)', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: 0.20 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation' })
    );
  });

  it('does NOT flag when officer_compensation_ratio is null', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: null }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation' })
    );
  });

  it('does NOT flag when officer_compensation_ratio is 0', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: 0 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation' })
    );
  });

  it('does NOT flag when officer_compensation_ratio is negative (data anomaly)', () => {
    const profile = makeProfile({ latest_990: make990({ officer_compensation_ratio: -0.001 }) });
    const flags = detectRedFlags(profile, [makeFiling()], t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation' })
    );
  });

  // --- Revenue decline: negative revenue guard ---

  it('does not flag decline when latest revenue is negative (data anomaly)', () => {
    const filings = [
      makeFiling({ tax_prd: taxPrdOffset(0), totrevenue: -50_000 }),
      makeFiling({ tax_prd: taxPrdOffset(1), totrevenue: 500_000 }),
    ];
    const flags = detectRedFlags(makeProfile(), filings, t);
    expect(flags).not.toContainEqual(
      expect.objectContaining({ type: 'revenue_decline' })
    );
  });
});

// ============================================================================
// runTier1Checks (integration)
// ============================================================================

describe('runTier1Checks', () => {
  it('returns PASS for a clean healthy profile', () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.recommendation).toBe('PASS');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.gate_blocked).toBe(false);
    expect(result.gates.all_passed).toBe(true);
    expect(result.red_flags).toHaveLength(0);
    expect(result.checks).toHaveLength(4);
    expect(result.summary.headline).toBe('Approved for Tier 2 Vetting');
  });

  it('returns REJECT when IRS revocation gate fails', () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient();
    irsClient.check.mockReturnValue(makeRevokedIrsResult());
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.recommendation).toBe('REJECT');
    expect(result.passed).toBe(false);
    expect(result.gate_blocked).toBe(true);
    expect(result.score).toBeNull();
    expect(result.checks).toBeNull();
  });

  it('returns REJECT for non-501(c)(3) (gate failure)', () => {
    const profile = makeProfile({ subsection: '04' });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.recommendation).toBe('REJECT');
    expect(result.gate_blocked).toBe(true);
    expect(result.score).toBeNull();
  });

  it('returns REJECT for bare minimum profile (no filings = gate 3 fail)', () => {
    const profile = makeProfile({
      years_operating: null,
      ruling_date: '',
      latest_990: null,
      filing_count: 0,
    });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [], t, irsClient as any, ofacClient as any);

    expect(result.recommendation).toBe('REJECT');
    // Gate 1 passes (subsection 03 + not revoked + has ruling_date... wait, ruling_date is '')
    // Actually Gate 1 sub-check C will fail (no ruling date)
    expect(result.gate_blocked).toBe(true);
    expect(result.score).toBeNull();
  });

  // --- review_reasons field ---

  it('has empty review_reasons for a clean PASS profile', () => {
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(makeProfile(), [makeFiling()], t, irsClient as any, ofacClient as any);
    expect(result.review_reasons).toEqual([]);
  });

  it('includes REVIEW check details in review_reasons', () => {
    // Profile with 2 years operating -> REVIEW on years check
    const profile = makeProfile({ years_operating: 2 });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.review_reasons.length).toBeGreaterThan(0);
    expect(result.review_reasons.some(r => r.includes('newer organization'))).toBe(true);
  });

  it('includes FAIL check details in review_reasons (scoring FAIL, not gate)', () => {
    // Revenue too low -> scoring FAIL, not a gate failure
    const profile = makeProfile({ latest_990: make990({ total_revenue: 10_000 }) });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.review_reasons.some(r => r.includes('too small'))).toBe(true);
  });

  it('includes HIGH red flag details prefixed with RED FLAG:', () => {
    // Stale 990 triggers HIGH red flag
    const profile = makeProfile({ latest_990: make990({ tax_period: '2018-06' }) });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.review_reasons.some(r => r.startsWith('RED FLAG:'))).toBe(true);
  });

  it('includes court records in red flags when provided', () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const courtResult = makeFlaggedCourtResult(3);
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any, courtResult);

    expect(result.red_flags).toContainEqual(
      expect.objectContaining({ type: 'court_records', severity: 'HIGH' })
    );
  });

  it('gate-blocked results have gate failure in review_reasons', () => {
    const profile = makeProfile({ subsection: '04' });
    const irsClient = makeMockIrsClient();
    const ofacClient = makeMockOfacClient();
    const result = runTier1Checks(profile, [makeFiling()], t, irsClient as any, ofacClient as any);

    expect(result.review_reasons.some(r => r.includes('Gate failure'))).toBe(true);
  });
});

// ============================================================================
// runRedFlagCheck
// ============================================================================

describe('runRedFlagCheck', () => {
  it('returns clean=true for healthy profile', () => {
    const profile = makeProfile();
    const result = runRedFlagCheck(profile, [makeFiling()], t);

    expect(result.clean).toBe(true);
    expect(result.flags).toHaveLength(0);
    expect(result.ein).toBe('95-3135649');
    expect(result.name).toBe('Test Nonprofit');
  });

  it('returns clean=false when flags exist', () => {
    // Use a stale 990 to trigger a red flag (gate-handled flags removed)
    const profile = makeProfile({ latest_990: make990({ tax_period: '2018-06' }) });
    const result = runRedFlagCheck(profile, [makeFiling()], t);

    expect(result.clean).toBe(false);
    expect(result.flags.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// resolveThresholds (sector-specific)
// ============================================================================

describe('resolveThresholds', () => {
  it('returns base thresholds unchanged for unknown NTEE code', () => {
    const resolved = resolveThresholds(t, 'Z99');
    expect(resolved).toEqual(t);
  });

  it('returns base thresholds for empty NTEE code', () => {
    const resolved = resolveThresholds(t, '');
    expect(resolved).toEqual(t);
  });

  it('overrides expense ratio thresholds for K (Food/Agriculture)', () => {
    const resolved = resolveThresholds(t, 'K31');
    expect(resolved.expenseRatioPassMin).toBe(0.6);
    expect(resolved.expenseRatioPassMax).toBe(1.3);
    expect(resolved.expenseRatioHighReview).toBe(1.5);
    expect(resolved.redFlagHighExpenseRatio).toBe(1.5);
    expect(resolved.redFlagLowExpenseRatio).toBe(0.4);
    // Non-overridden fields stay at base
    expect(resolved.weightYearsOperating).toBe(t.weightYearsOperating);
    expect(resolved.revenuePassMin).toBe(t.revenuePassMin);
  });

  it('overrides revenue thresholds for A (Arts)', () => {
    const resolved = resolveThresholds(t, 'A70');
    expect(resolved.revenueFailMin).toBe(25_000);
    expect(resolved.revenuePassMin).toBe(50_000);
    expect(resolved.expenseRatioPassMin).toBe(0.6);
    expect(resolved.redFlagVeryLowRevenue).toBe(15_000);
    // Non-overridden fields stay at base
    expect(resolved.expenseRatioPassMax).toBe(t.expenseRatioPassMax);
  });

  it('overrides revenue and compensation for E (Health)', () => {
    const resolved = resolveThresholds(t, 'E32');
    expect(resolved.revenuePassMax).toBe(50_000_000);
    expect(resolved.revenueReviewMax).toBe(100_000_000);
    expect(resolved.redFlagHighCompensation).toBe(0.5);
    expect(resolved.redFlagModerateCompensation).toBe(0.35);
    // Non-overridden fields stay at base
    expect(resolved.weightYearsOperating).toBe(t.weightYearsOperating);
  });

  it('is case-insensitive on NTEE code', () => {
    const resolved = resolveThresholds(t, 'k31');
    expect(resolved.expenseRatioPassMax).toBe(1.3); // K override applied
  });

  it('all hardcoded sector overrides produce valid merged thresholds', () => {
    for (const sector of getSupportedSectors()) {
      const resolved = resolveThresholds(t, sector + '99');
      expect(() => validateThresholds(resolved)).not.toThrow();
    }
  });

  it('reports supported sectors', () => {
    const sectors = getSupportedSectors();
    expect(sectors).toContain('A');
    expect(sectors).toContain('E');
    expect(sectors).toContain('K');
    expect(sectors.length).toBe(3);
  });

  // Integration: sector overrides affect scoring behavior

  it('food bank with 1.3x expense ratio PASSES with K thresholds (would FAIL with base)', () => {
    const profile = makeProfile({
      ntee_code: 'K31',
      latest_990: make990({ overhead_ratio: 1.25 }),
    });
    const resolved = resolveThresholds(t, profile.ntee_code);
    // With base thresholds: 1.25 > 1.2 → FAIL (high review boundary)
    const baseCheck = checkOverheadRatio(profile, t);
    expect(baseCheck.result).toBe('FAIL');
    // With K thresholds: 1.25 < 1.3 → PASS
    const sectorCheck = checkOverheadRatio(profile, resolved);
    expect(sectorCheck.result).toBe('PASS');
  });

  it('arts org with $60K revenue PASSES with A thresholds (would REVIEW with base)', () => {
    const profile = makeProfile({
      ntee_code: 'A70',
      latest_990: make990({ total_revenue: 60_000 }),
    });
    const resolved = resolveThresholds(t, profile.ntee_code);
    // With base thresholds: $60K is between failMin ($50K) and passMin ($100K) → REVIEW
    const baseCheck = checkRevenueRange(profile, t);
    expect(baseCheck.result).toBe('REVIEW');
    // With A thresholds: $60K >= passMin ($50K) and <= passMax ($10M) → PASS
    const sectorCheck = checkRevenueRange(profile, resolved);
    expect(sectorCheck.result).toBe('PASS');
  });

  it('health org with 45% compensation does NOT flag HIGH (higher threshold)', () => {
    const profile = makeProfile({
      ntee_code: 'E32',
      latest_990: make990({ officer_compensation_ratio: 0.45 }),
    });
    const resolved = resolveThresholds(t, profile.ntee_code);
    const filings = [makeFiling()];
    // With base thresholds: 0.45 > 0.40 → HIGH
    const baseFlags = detectRedFlags(profile, filings, t);
    expect(baseFlags).toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation', severity: 'HIGH' })
    );
    // With E thresholds: 0.45 < 0.50 → MEDIUM (moderate threshold is 0.35)
    const sectorFlags = detectRedFlags(profile, filings, resolved);
    expect(sectorFlags).not.toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation', severity: 'HIGH' })
    );
    expect(sectorFlags).toContainEqual(
      expect.objectContaining({ type: 'high_officer_compensation', severity: 'MEDIUM' })
    );
  });
});
