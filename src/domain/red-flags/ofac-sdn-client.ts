import { CsvDataStore } from "../../data-sources/csv-data-store.js";
import {
  OfacSanctionsResult,
  OfacMatch,
  OfacFuzzyResult,
  OfacFuzzyMatch,
} from "../nonprofit/types.js";
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

  fuzzyCheck(name: string, threshold: number = 0.85): OfacFuzzyResult {
    if (threshold < 0 || threshold > 1.0) {
      throw new Error(
        `Invalid OFAC fuzzy threshold: ${threshold}. Must be between 0.0 and 1.0`,
      );
    }

    const fuzzyMatches = this.store.fuzzyLookupName(name, threshold);

    if (fuzzyMatches.length === 0) {
      return { found: false, detail: "No fuzzy OFAC matches", matches: [] };
    }

    const entityMatches: OfacFuzzyMatch[] = [];
    for (const fm of fuzzyMatches) {
      for (const row of fm.rows) {
        if (row.sdnType.toLowerCase() === "entity") {
          entityMatches.push({
            entNum: row.entNum,
            name: row.name,
            sdnType: row.sdnType,
            program: row.program,
            matchedOn:
              normalizeName(row.name) === fm.normalizedName
                ? "primary"
                : "alias",
            similarity: fm.similarity,
          });
        }
      }
    }

    if (entityMatches.length === 0) {
      return {
        found: false,
        detail: "Fuzzy matches found but all Individual-type",
        matches: [],
      };
    }

    return {
      found: true,
      detail: `${entityMatches.length} near-match(es) on OFAC SDN list`,
      matches: entityMatches.sort((a, b) => b.similarity - a.similarity),
    };
  }
}
