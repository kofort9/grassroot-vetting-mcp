import type {
  Tier1Result,
  RedFlagResult,
  CourtCaseSummary,
} from "../domain/nonprofit/types.js";

/**
 * Compact tier1 output — just the decision-relevant fields.
 */
export interface CompactTier1 {
  ein: string;
  name: string;
  recommendation: "PASS" | "REVIEW" | "REJECT";
  score: number | null;
  gate_blocked: boolean;
  flags: Array<{
    severity: string;
    type: string;
    detail: string;
    cases?: CourtCaseSummary[];
  }>;
  next_steps: string[];
}

/**
 * Compact red-flag output.
 */
export interface CompactRedFlags {
  ein: string;
  name: string;
  clean: boolean;
  flags: Array<{
    severity: string;
    type: string;
    detail: string;
    cases?: CourtCaseSummary[];
  }>;
}

export function compactTier1(result: Tier1Result): CompactTier1 {
  return {
    ein: result.ein,
    name: result.name,
    recommendation: result.recommendation,
    score: result.score,
    gate_blocked: result.gate_blocked,
    flags: result.red_flags.map((f) => ({
      severity: f.severity,
      type: f.type,
      detail: f.detail,
      ...(f.cases && { cases: f.cases }),
    })),
    next_steps: result.summary.next_steps,
  };
}

export function compactRedFlags(result: RedFlagResult): CompactRedFlags {
  return {
    ein: result.ein,
    name: result.name,
    clean: result.clean,
    flags: result.flags.map((f) => ({
      severity: f.severity,
      type: f.type,
      detail: f.detail,
      ...(f.cases && { cases: f.cases }),
    })),
  };
}
