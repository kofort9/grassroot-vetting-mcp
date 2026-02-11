import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { DiscoveryIndex } from "../src/data-sources/discovery-index.js";
import { DiscoveryPipeline } from "../src/domain/discovery/pipeline.js";
import * as discoveryTools from "../src/domain/discovery/tools.js";
import { loadPortfolioFitConfig } from "../src/core/config.js";
import type { DiscoveryIndexConfig } from "../src/domain/discovery/types.js";

/**
 * E2E: Full discovery stack with realistic test data.
 *
 * Exercises: discoverNonprofits() tool -> DiscoveryPipeline -> DiscoveryIndex -> SQLite
 * Uses the real portfolio-fit config (same NTEE allowlist as production).
 */

// Realistic sample across multiple states, NTEE codes, and subsections
const SEED_ORGS = [
  // California -- education
  { ein: "941234567", name: "OAKLAND COMMUNITY SCHOOLS", city: "OAKLAND", state: "CA", ntee_code: "B20", subsection: 3, ruling_date: "200305" },
  { ein: "942345678", name: "SF LITERACY PROJECT", city: "SAN FRANCISCO", state: "CA", ntee_code: "B60", subsection: 3, ruling_date: "201108" },
  { ein: "943456789", name: "LA STEM ACADEMY", city: "LOS ANGELES", state: "CA", ntee_code: "B28", subsection: 3, ruling_date: "201503" },
  // California -- arts
  { ein: "944567890", name: "BAY AREA ARTS COLLECTIVE", city: "SAN FRANCISCO", state: "CA", ntee_code: "A20", subsection: 3, ruling_date: "199901" },
  { ein: "945678901", name: "OAKLAND MURAL PROJECT", city: "OAKLAND", state: "CA", ntee_code: "A25", subsection: 3, ruling_date: "201007" },
  // California -- health
  { ein: "946789012", name: "EAST BAY FREE CLINIC", city: "OAKLAND", state: "CA", ntee_code: "E20", subsection: 3, ruling_date: "200811" },
  // California -- outside portfolio scope (religious)
  { ein: "947890123", name: "CA CHURCH MINISTRIES", city: "SACRAMENTO", state: "CA", ntee_code: "X20", subsection: 3, ruling_date: "198505" },
  // California -- non-501(c)(3)
  { ein: "948901234", name: "CA TRADE ASSOCIATION", city: "LOS ANGELES", state: "CA", ntee_code: "S20", subsection: 6, ruling_date: "200101" },
  // New York
  { ein: "131234567", name: "NYC YOUTH EDUCATION FUND", city: "NEW YORK", state: "NY", ntee_code: "B20", subsection: 3, ruling_date: "200607" },
  { ein: "132345678", name: "BROOKLYN ARTS CENTER", city: "BROOKLYN", state: "NY", ntee_code: "A30", subsection: 3, ruling_date: "201201" },
  // Texas
  { ein: "741234567", name: "AUSTIN ENVIRONMENTAL TRUST", city: "AUSTIN", state: "TX", ntee_code: "C20", subsection: 3, ruling_date: "201404" },
  { ein: "742345678", name: "HOUSTON FOOD BANK ALLIANCE", city: "HOUSTON", state: "TX", ntee_code: "K30", subsection: 3, ruling_date: "199803" },
  // Org with no NTEE code
  { ein: "951111111", name: "UNCLASSIFIED ORG", city: "RENO", state: "NV", ntee_code: "", subsection: 3, ruling_date: "201001" },
];

let tmpDir: string;
let index: DiscoveryIndex;
let pipeline: DiscoveryPipeline;

function seedDatabase(dir: string): void {
  const dbPath = path.join(dir, "discovery-index.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE bmf_orgs (
      ein TEXT PRIMARY KEY, name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '',
      ntee_code TEXT NOT NULL DEFAULT '', subsection INTEGER NOT NULL DEFAULT 0,
      ruling_date TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_bmf_state ON bmf_orgs(state);
    CREATE INDEX idx_bmf_ntee ON bmf_orgs(ntee_code);
    CREATE INDEX idx_bmf_subsection ON bmf_orgs(subsection);
    CREATE INDEX idx_bmf_state_ntee ON bmf_orgs(state, ntee_code);
  `);
  const stmt = db.prepare(
    "INSERT INTO bmf_orgs (ein, name, city, state, ntee_code, subsection, ruling_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const o of SEED_ORGS) {
    stmt.run(o.ein, o.name, o.city, o.state, o.ntee_code, o.subsection, o.ruling_date);
  }
  db.close();

  fs.writeFileSync(
    path.join(dir, "discovery-manifest.json"),
    JSON.stringify({
      bmf_index: {
        built_at: new Date().toISOString(),
        row_count: SEED_ORGS.length,
        regions_loaded: ["eo1"],
        source_urls: [],
      },
    }),
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-e2e-"));
  seedDatabase(tmpDir);

  const config: DiscoveryIndexConfig = {
    dataDir: tmpDir,
    bmfRegions: ["eo1"],
    dataMaxAgeDays: 30,
    maxOrgsPerQuery: 500,
  };

  index = new DiscoveryIndex(config);
  index.initialize();

  // Use real portfolio-fit config (same NTEE allowlist as production)
  const portfolioFit = loadPortfolioFitConfig();
  pipeline = new DiscoveryPipeline(index, portfolioFit);
});

afterAll(() => {
  index.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Discovery E2E", () => {
  describe("Scenario: Discover arts nonprofits in California", () => {
    it("returns only CA arts orgs within portfolio scope", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        state: "CA",
        ntee_categories: ["A"],
      });

      expect(result.success).toBe(true);
      expect(result.attribution).toContain("IRS");
      expect(result.data).toBeDefined();

      const { candidates, total } = result.data!;
      expect(total).toBe(2); // BAY AREA ARTS COLLECTIVE + OAKLAND MURAL PROJECT
      expect(candidates).toHaveLength(2);
      expect(candidates.every((c) => c.state === "CA")).toBe(true);
      expect(candidates.every((c) => c.ntee_code.startsWith("A"))).toBe(true);
      expect(candidates.every((c) => c.subsection === 3)).toBe(true);
    });
  });

  describe("Scenario: Discover education nonprofits across all states", () => {
    it("returns all education orgs in index", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        ntee_categories: ["B"],
      });

      expect(result.success).toBe(true);
      const { candidates, total } = result.data!;
      expect(total).toBe(4); // 3 CA + 1 NY education orgs
      expect(candidates.every((c) => c.ntee_code.startsWith("B"))).toBe(true);
    });
  });

  describe("Scenario: Browse all nonprofits in Oakland, CA", () => {
    it("returns Oakland orgs within portfolio scope, excludes X20", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        state: "CA",
        city: "Oakland",
      });

      expect(result.success).toBe(true);
      const { candidates } = result.data!;

      const names = candidates.map((c) => c.name);
      expect(names).toContain("OAKLAND COMMUNITY SCHOOLS");
      expect(names).toContain("OAKLAND MURAL PROJECT");
      expect(names).toContain("EAST BAY FREE CLINIC");

      // X20 (religious) excluded by portfolio-fit scope
      expect(names).not.toContain("CA CHURCH MINISTRIES");
    });
  });

  describe("Scenario: Exclude religious orgs (X category)", () => {
    it("X category is already excluded by portfolio-fit scope", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        state: "CA",
      });

      const eins = result.data!.candidates.map((c) => c.ein);
      expect(eins).not.toContain("947890123"); // X20
    });
  });

  describe("Scenario: Non-501(c)(3) excluded by default", () => {
    it("subsection=6 orgs are excluded by default", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        state: "CA",
      });

      const eins = result.data!.candidates.map((c) => c.ein);
      expect(eins).not.toContain("948901234"); // subsection 6
    });

    it("subsection=0 shows all subsections", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        state: "CA",
        subsection: 0,
        portfolio_fit_only: false,
      });

      // With subsection=0, the filter isn't applied, so all CA orgs returned
      // (including subsection 6 and X20)
      expect(result.data!.total).toBeGreaterThanOrEqual(8);
    });
  });

  describe("Scenario: Pagination for large result sets", () => {
    it("page 1 and page 2 are disjoint", () => {
      const page1 = discoveryTools.discoverNonprofits(pipeline, {
        limit: 3,
        offset: 0,
      });
      const page2 = discoveryTools.discoverNonprofits(pipeline, {
        limit: 3,
        offset: 3,
      });

      expect(page1.data!.candidates).toHaveLength(3);
      expect(page2.data!.candidates).toHaveLength(3);

      const p1Eins = new Set(page1.data!.candidates.map((c) => c.ein));
      const p2Eins = page2.data!.candidates.map((c) => c.ein);
      expect(p2Eins.some((ein) => p1Eins.has(ein))).toBe(false);

      // Total stays the same regardless of page
      expect(page1.data!.total).toBe(page2.data!.total);
    });
  });

  describe("Scenario: Name search", () => {
    it("finds orgs by name substring", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        name_contains: "FOOD BANK",
      });

      expect(result.data!.candidates).toHaveLength(1);
      expect(result.data!.candidates[0].name).toBe("HOUSTON FOOD BANK ALLIANCE");
    });
  });

  describe("Scenario: Ruling year filter", () => {
    it("finds recently established orgs", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        min_ruling_year: 2014,
      });

      expect(
        result.data!.candidates.every((c) => {
          const year = parseInt(c.ruling_date.substring(0, 4), 10);
          return year >= 2014;
        }),
      ).toBe(true);
    });
  });

  describe("Scenario: Candidate is ready for vetting", () => {
    it("each candidate has EIN, name, state, NTEE -- ready for check_tier1", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, {
        state: "CA",
        ntee_categories: ["B"],
      });

      for (const candidate of result.data!.candidates) {
        expect(candidate.ein).toMatch(/^\d{9}$/);
        expect(candidate.name.length).toBeGreaterThan(0);
        expect(candidate.state).toBe("CA");
        expect(candidate.ntee_code).toBeTruthy();
        expect(candidate.subsection).toBe(3);
        expect(candidate.ruling_date).toMatch(/^\d{6}$/);
      }
    });
  });

  describe("Response shape matches MCP tool contract", () => {
    it("has success, data, attribution fields", () => {
      const result = discoveryTools.discoverNonprofits(pipeline, { state: "TX" });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("attribution");
      expect(result).toHaveProperty("data");
      expect(result.data).toHaveProperty("candidates");
      expect(result.data).toHaveProperty("total");
      expect(result.data).toHaveProperty("filters_applied");
      expect(result.data).toHaveProperty("index_stats");
      expect(result.data!.index_stats).toHaveProperty("total_orgs");
      expect(result.data!.index_stats).toHaveProperty("last_updated");
    });
  });
});
