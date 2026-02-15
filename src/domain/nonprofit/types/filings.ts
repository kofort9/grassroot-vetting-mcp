// 990 Filing Summary Types

export interface Filing990Summary {
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
