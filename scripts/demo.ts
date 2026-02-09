/**
 * Demo: Run the Tier 1 vetting pipeline and print results.
 * Usage: npx tsx scripts/demo.ts
 */
import { runTier1Checks } from '../src/domain/nonprofit/scoring.js';
import { loadThresholds } from '../src/core/config.js';
import type {
  NonprofitProfile,
  ProPublica990Filing,
  IrsRevocationResult,
  OfacSanctionsResult,
} from '../src/domain/nonprofit/types.js';

// ── Mock clients (same shape as real ones) ──────────────────────────
const cleanIrs = (): IrsRevocationResult => ({
  found: false, revoked: false,
  detail: 'Not on IRS revocation list',
});
const revokedIrs = (): IrsRevocationResult => ({
  found: true, revoked: true,
  detail: 'REVOKED on 2022-05-15',
  revocationDate: '2022-05-15',
  legalName: 'REVOKED NONPROFIT INC',
});
const cleanOfac = (): OfacSanctionsResult => ({
  found: false, detail: 'No OFAC matches', matches: [],
});
const matchedOfac = (): OfacSanctionsResult => ({
  found: true,
  detail: 'OFAC SDN MATCH — sanctioned entity found',
  matches: [{ entNum: '12345', name: 'BAD ACTOR FOUNDATION', sdnType: 'Entity', program: 'SDGT', matchedOn: 'primary' as const }],
});

function makeClient(irsResult: IrsRevocationResult, ofacResult: OfacSanctionsResult) {
  return {
    irs: { check: () => irsResult },
    ofac: { check: () => ofacResult },
  };
}

// ── Profiles ────────────────────────────────────────────────────────
const year = new Date().getFullYear();

const healthy: NonprofitProfile = {
  ein: '95-3135649', name: 'Homeboy Industries',
  address: { city: 'Los Angeles', state: 'CA' },
  ruling_date: '1988-07-01', years_operating: 37,
  subsection: '03', ntee_code: 'J20',
  latest_990: {
    tax_period: `${year - 1}-06`, tax_year: year - 1, form_type: '990',
    total_revenue: 48_000_000, total_expenses: 42_000_000,
    total_assets: 25_000_000, total_liabilities: 5_000_000,
    overhead_ratio: 0.875, officer_compensation_ratio: 0.02,
  },
  filing_count: 12,
};

const revoked: NonprofitProfile = {
  ein: '12-3456789', name: 'Sketchy Foundation',
  address: { city: 'Miami', state: 'FL' },
  ruling_date: '2015-01-01', years_operating: 10,
  subsection: '03', ntee_code: 'T20',
  latest_990: {
    tax_period: `${year - 1}-12`, tax_year: year - 1, form_type: '990',
    total_revenue: 200_000, total_expenses: 180_000,
    total_assets: 100_000, total_liabilities: 20_000,
    overhead_ratio: 0.9, officer_compensation_ratio: null,
  },
  filing_count: 3,
};

const sanctioned: NonprofitProfile = {
  ein: '99-8765432', name: 'Bad Actor Foundation',
  address: { city: 'Houston', state: 'TX' },
  ruling_date: '2010-03-15', years_operating: 15,
  subsection: '03', ntee_code: 'Q33',
  latest_990: {
    tax_period: `${year - 1}-06`, tax_year: year - 1, form_type: '990',
    total_revenue: 1_500_000, total_expenses: 1_200_000,
    total_assets: 800_000, total_liabilities: 100_000,
    overhead_ratio: 0.8, officer_compensation_ratio: null,
  },
  filing_count: 8,
};

const young: NonprofitProfile = {
  ein: '88-1112222', name: 'Fresh Start Initiative',
  address: { city: 'Portland', state: 'OR' },
  ruling_date: '2024-01-15', years_operating: 1,
  subsection: '03', ntee_code: 'P20',
  latest_990: {
    tax_period: `${year - 1}-12`, tax_year: year - 1, form_type: '990EZ',
    total_revenue: 65_000, total_expenses: 48_000,
    total_assets: 30_000, total_liabilities: 5_000,
    overhead_ratio: 0.738, officer_compensation_ratio: null,
  },
  filing_count: 1,
};

// ── Filings ─────────────────────────────────────────────────────────
const recentFiling = (rev = 500_000): ProPublica990Filing => ({
  tax_prd: (year - 1) * 100 + 6,
  tax_prd_yr: year - 1,
  formtype: 1,
  totrevenue: rev,
  totfuncexpns: rev * 0.8,
  totassetsend: 1_000_000,
  totliabend: 200_000,
});

// ── Run ─────────────────────────────────────────────────────────────
const t = loadThresholds();

const scenarios = [
  { label: 'Healthy Org (Homeboy Industries)', profile: healthy, filings: [recentFiling(48_000_000)], ...makeClient(cleanIrs(), cleanOfac()) },
  { label: 'IRS Revoked', profile: revoked, filings: [recentFiling(200_000)], ...makeClient(revokedIrs(), cleanOfac()) },
  { label: 'OFAC Sanctioned', profile: sanctioned, filings: [recentFiling(1_500_000)], ...makeClient(cleanIrs(), matchedOfac()) },
  { label: 'Young + Small (borderline)', profile: young, filings: [recentFiling(65_000)], ...makeClient(cleanIrs(), cleanOfac()) },
];

console.log('═══════════════════════════════════════════════════════════');
console.log('  Bonsaei Tier 1 Vetting Pipeline Demo');
console.log('  Gates → Scoring (4x25) → Red Flags');
console.log('═══════════════════════════════════════════════════════════\n');

for (const { label, profile, filings, irs, ofac } of scenarios) {
  const result = runTier1Checks(profile, filings, t, irs as any, ofac as any);

  console.log(`┌─ ${label}`);
  console.log(`│  EIN: ${result.ein}  Name: ${result.name}`);

  // Gates
  console.log(`│  ── Gates ──`);
  for (const g of result.gates.gates) {
    const icon = g.verdict === 'PASS' ? '✓' : '✗';
    console.log(`│    ${icon} ${g.gate}: ${g.detail}`);
    if (g.sub_checks) {
      for (const sc of g.sub_checks) {
        console.log(`│      ${sc.passed ? '·' : '!'} ${sc.label}: ${sc.detail}`);
      }
    }
  }

  if (result.gate_blocked) {
    console.log(`│  ── GATE BLOCKED ── recommendation: ${result.recommendation}`);
    console.log(`│  ${result.summary.headline}`);
  } else {
    // Scoring
    console.log(`│  ── Scoring ──`);
    for (const c of result.checks!) {
      const pts = c.result === 'PASS' ? c.weight : c.result === 'REVIEW' ? c.weight * 0.5 : 0;
      console.log(`│    ${c.result.padEnd(6)} ${c.name.padEnd(18)} ${pts}/${c.weight}  ${c.detail}`);
    }
    console.log(`│  Score: ${result.score}/100  →  ${result.recommendation}`);

    // Red flags
    if (result.red_flags.length > 0) {
      console.log(`│  ── Red Flags ──`);
      for (const f of result.red_flags) {
        console.log(`│    [${f.severity}] ${f.type}: ${f.detail}`);
      }
    }

    console.log(`│  ${result.summary.headline}`);
  }
  console.log(`└${'─'.repeat(58)}\n`);
}
