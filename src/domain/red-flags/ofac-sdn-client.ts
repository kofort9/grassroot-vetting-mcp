import { CsvDataStore } from "../../data-sources/csv-data-store.js";
import { OfacSanctionsResult, OfacMatch } from "../nonprofit/types.js";
import { normalizeName } from "../../data-sources/name-normalizer.js";

export class OfacSdnClient {
  private store: CsvDataStore;

  constructor(store: CsvDataStore) {
    this.store = store;
  }

  check(name: string): OfacSanctionsResult {
    const rows = this.store.lookupName(name);

    if (rows.length === 0) {
      return {
        found: false,
        detail: "No OFAC SDN matches found (good — not on sanctions list)",
        matches: [],
      };
    }

    const normalized = normalizeName(name);
    const matches: OfacMatch[] = rows.map((row) => {
      const primaryNormalized = normalizeName(row.name);
      const matchedOn = normalized === primaryNormalized ? "primary" : "alias";

      return {
        entNum: row.entNum,
        name: row.name,
        sdnType: row.sdnType,
        program: row.program,
        matchedOn,
      };
    });

    return {
      found: true,
      detail: `OFAC SDN MATCH — ${matches.length} sanctioned entity/entities found matching "${name}"`,
      matches,
    };
  }
}
