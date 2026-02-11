// Domain Types (cleaned up for tool responses)

export interface NonprofitSearchResult {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
}

export interface NonprofitAddress {
  city: string;
  state: string;
}

export interface Latest990Summary {
  tax_period: string;
  tax_year: number;
  form_type: string;
  total_revenue: number;
  total_expenses: number;
  total_assets: number;
  total_liabilities: number;
  overhead_ratio: number | null; // null when calculation not possible
  officer_compensation_ratio: number | null; // null when data unavailable
  program_revenue?: number;
  contributions?: number;
}

export interface NonprofitProfile {
  ein: string;
  name: string;
  address: NonprofitAddress;
  ruling_date: string;
  years_operating: number | null; // null when ruling date unavailable
  subsection: string;
  ntee_code: string;
  latest_990: Latest990Summary | null;
  filing_count: number;
}
