// IRS Revocation Types

export interface IrsRevocationRow {
  ein: string;
  legalName: string;
  dba: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  exemptionType: string;
  revocationDate: string;
  postingDate: string;
  reinstatementDate: string;
}

export interface IrsRevocationResult {
  found: boolean;
  revoked: boolean;
  detail: string;
  revocationDate?: string;
  reinstatementDate?: string;
  legalName?: string;
}

// OFAC SDN Types

export interface OfacSdnRow {
  entNum: string;
  name: string;
  sdnType: string;
  program: string;
  title: string;
  remarks: string;
}

export interface OfacAltRow {
  entNum: string;
  altNum: string;
  altType: string;
  altName: string;
  altRemarks: string;
}

export interface OfacMatch {
  entNum: string;
  name: string;
  sdnType: string;
  program: string;
  matchedOn: string; // 'primary' | 'alias'
}

export interface OfacSanctionsResult {
  found: boolean;
  detail: string;
  matches: OfacMatch[];
}

// CourtListener Types

export interface CourtListenerCase {
  id: number;
  caseName: string;
  court: string;
  dateArgued: string | null;
  dateFiled: string | null;
  docketNumber: string;
  absoluteUrl: string;
}

export interface CourtRecordsResult {
  found: boolean;
  detail: string;
  caseCount: number;
  cases: CourtListenerCase[];
}

// Data Manifest (tracks CSV freshness)

export interface DataManifest {
  irs_revocation?: {
    downloaded_at: string;
    row_count: number;
  };
  ofac_sdn?: {
    downloaded_at: string;
    sdn_count: number;
    alt_count: number;
  };
}
