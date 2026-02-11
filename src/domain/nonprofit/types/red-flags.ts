// Red Flag Types

export type RedFlagSeverity = "HIGH" | "MEDIUM";

export type RedFlagType =
  | "stale_990"
  | "low_fund_deployment"
  | "very_high_overhead"
  | "very_low_revenue"
  | "revenue_decline"
  | "too_new"
  | "high_officer_compensation"
  | "court_records";

export interface RedFlag {
  severity: RedFlagSeverity;
  type: RedFlagType;
  detail: string;
}

export interface RedFlagResult {
  ein: string;
  name: string;
  flags: RedFlag[];
  clean: boolean;
}
