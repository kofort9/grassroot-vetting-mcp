// ProPublica API Response Types (raw API shapes)

export interface ProPublicaSearchResponse {
  total_results: number;
  organizations: ProPublicaOrganization[];
}

export interface ProPublicaOrganization {
  ein: number;
  name: string;
  city: string;
  state: string;
  ntee_code: string | null;
  // Search results use `subseccd`, org detail uses `subsection_code`
  subseccd?: number; // 3 = 501(c)(3) - from search results
  subsection_code?: number; // 3 = 501(c)(3) - from org detail
  ruling_date: string; // YYYY-MM-DD format
  totrevenue?: number;
  totfuncexpns?: number;
  totassetsend?: number;
  pf_asset_val?: number;
}

export interface ProPublicaOrgDetailResponse {
  organization: ProPublicaOrganization;
  filings_with_data: ProPublica990Filing[];
}

export interface ProPublica990Filing {
  tax_prd: number; // Tax period as YYYYMM
  tax_prd_yr: number; // Tax year
  formtype: number; // 990, 990EZ, 990PF
  totrevenue: number;
  totfuncexpns: number;
  totassetsend: number;
  totliabend: number;
  pct_compnsatncurrofcr?: number;
  totcntrbgfts?: number;
  totprgmrevnue?: number;
  invstmntinc?: number;
  txexmptbndsproceeds?: number;
  royaltsinc?: number;
  grsrntsreal?: number;
  grsrntsprsnl?: number;
  raboression?: number;
  grsalesecur?: number;
  grsalesothr?: number;
  totnetassetend?: number;
  pdf_url?: string;
}
