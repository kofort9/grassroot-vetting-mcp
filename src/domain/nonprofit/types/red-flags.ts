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
  | "court_records"
  | "ofac_near_match";

export interface CourtCaseSummary {
  dateFiled: string | null;
  court: string;
  url: string;
}

export interface RedFlag {
  severity: RedFlagSeverity;
  type: RedFlagType;
  detail: string;
  cases?: CourtCaseSummary[];
}

export interface RedFlagResult {
  ein: string;
  name: string;
  flags: RedFlag[];
  clean: boolean;
}
