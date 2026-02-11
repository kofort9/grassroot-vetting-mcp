import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { DiscoveryPipeline } from "../src/domain/discovery/pipeline.js";
import { DiscoveryIndex } from "../src/data-sources/discovery-index.js";
import type { PortfolioFitConfig } from "../src/domain/nonprofit/types.js";
import type { DiscoveryIndexConfig } from "../src/domain/discovery/types.js";
import {
  ensureSqlJs,
  SqliteDatabase,
} from "../src/data-sources/sqlite-adapter.js";

const TEST_ORGS = [
  {
    ein: "111111111",
    name: "OAKLAND EDUCATION FUND",
    city: "OAKLAND",
    state: "CA",
    ntee_code: "B20",
    subsection: 3,
    ruling_date: "200501",
  },
  {
    ein: "222222222",
    name: "BAY AREA HEALTH CLINIC",
    city: "SAN FRANCISCO",
    state: "CA",
    ntee_code: "E20",
    subsection: 3,
    ruling_date: "201003",
  },
  {
    ein: "333333333",
    name: "TEXAS ARTS COUNCIL",
    city: "AUSTIN",
    state: "TX",
    ntee_code: "A30",
    subsection: 3,
    ruling_date: "199807",
  },
  {
    ein: "444444444",
    name: "NYC HOUSING ALLIANCE",
    city: "NEW YORK",
    state: "NY",
    ntee_code: "L20",
    subsection: 3,
    ruling_date: "201501",
  },
  {
    ein: "555555555",
    name: "PRIVATE FOUNDATION INC",
    city: "CHICAGO",
    state: "IL",
    ntee_code: "T20",
    subsection: 4,
    ruling_date: "200801",
  },
  {
    ein: "666666666",
    name: "CA YOUTH SPORTS LEAGUE",
    city: "LOS ANGELES",
    state: "CA",
    ntee_code: "N20",
    subsection: 3,
    ruling_date: "201201",
  },
  {
    ein: "777777777",
    name: "VETERANS SUPPORT GROUP",
    city: "OAKLAND",
    state: "CA",
    ntee_code: "W30",
    subsection: 3,
    ruling_date: "200901",
  },
  {
    ein: "888888888",
    name: "SCIENCE RESEARCH FUND",
    city: "OAKLAND",
    state: "CA",
    ntee_code: "U20",
    subsection: 3,
    ruling_date: "201801",
  },
  {
    ein: "999999999",
    name: "RELIGIOUS ORG UNKNOWN",
    city: "DALLAS",
    state: "TX",
    ntee_code: "X20",
    subsection: 3,
    ruling_date: "201001",
  },
];

const DEFAULT_PORTFOLIO_FIT: PortfolioFitConfig = {
  enabled: true,
  allowedNteeCategories: [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "R",
    "S",
    "U",
    "W",
  ],
  excludedEins: [],
  includedEins: [],
};

let tmpDir: string;
let index: DiscoveryIndex;
let pipeline: DiscoveryPipeline;

function seedDatabase(db: SqliteDatabase): void {
  db.sqlExec(`
    CREATE TABLE IF NOT EXISTS bmf_orgs (
      ein TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      ntee_code TEXT NOT NULL DEFAULT '',
      subsection INTEGER NOT NULL DEFAULT 0,
      ruling_date TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_bmf_state ON bmf_orgs(state);
    CREATE INDEX IF NOT EXISTS idx_bmf_ntee ON bmf_orgs(ntee_code);
    CREATE INDEX IF NOT EXISTS idx_bmf_subsection ON bmf_orgs(subsection);
    CREATE INDEX IF NOT EXISTS idx_bmf_state_ntee ON bmf_orgs(state, ntee_code);
  `);

  const insert = db.prepare(
    "INSERT INTO bmf_orgs (ein, name, city, state, ntee_code, subsection, ruling_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const org of TEST_ORGS) {
    insert.run(
      org.ein,
      org.name,
      org.city,
      org.state,
      org.ntee_code,
      org.subsection,
      org.ruling_date,
    );
  }
}

beforeAll(async () => {
  await ensureSqlJs();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-pipeline-"));

  // Create and seed the DB directly (bypassing buildIndex which needs network)
  const dbPath = path.join(tmpDir, "discovery-index.db");
  const db = SqliteDatabase.open(dbPath);
  seedDatabase(db);
  db.close();

  // Write a manifest so isReady() returns true
  fs.writeFileSync(
    path.join(tmpDir, "discovery-manifest.json"),
    JSON.stringify({
      bmf_index: {
        built_at: new Date().toISOString(),
        row_count: TEST_ORGS.length,
        regions_loaded: ["eo1"],
        source_urls: [],
      },
    }),
  );

  const config: DiscoveryIndexConfig = {
    dataDir: tmpDir,
    bmfRegions: ["eo1"],
    dataMaxAgeDays: 30,
    maxOrgsPerQuery: 500,
  };

  index = new DiscoveryIndex(config);
  index.initialize();
  pipeline = new DiscoveryPipeline(index, DEFAULT_PORTFOLIO_FIT);
});

afterEach(() => {
  index.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DiscoveryPipeline", () => {
  it("returns all 501(c)(3) orgs matching portfolio-fit by default", () => {
    const result = pipeline.discover({});
    // Should exclude: T20 (not in allowlist), X20 (not in allowlist), subsection=4 (555555555)
    // 555555555 is subsection 4, so filtered by default subsection=3
    // 999999999 has X20 which is outside portfolio scope
    expect(result.candidates.length).toBeGreaterThanOrEqual(5);
    const eins = result.candidates.map((c) => c.ein);
    // T20 and X20 are excluded by portfolio fit; subsection 4 excluded by default
    expect(eins).not.toContain("555555555"); // subsection 4
    expect(eins).not.toContain("999999999"); // X20 outside scope
  });

  it("filters by state", () => {
    const result = pipeline.discover({ state: "CA" });
    expect(result.candidates.every((c) => c.state === "CA")).toBe(true);
    expect(result.candidates.length).toBe(5); // 5 CA orgs that match portfolio fit
  });

  it("filters by city (case-insensitive)", () => {
    const result = pipeline.discover({ state: "CA", city: "oakland" });
    expect(result.candidates.length).toBe(3); // Oakland Education Fund, Veterans Support, Science Research
    expect(result.candidates.every((c) => c.city === "OAKLAND")).toBe(true);
  });

  it("filters by NTEE categories (intersected with portfolio-fit)", () => {
    const result = pipeline.discover({ nteeCategories: ["B"] });
    expect(result.candidates.every((c) => c.ntee_code.startsWith("B"))).toBe(
      true,
    );
    expect(result.candidates.length).toBe(1); // B20 only
  });

  it("rejects user NTEE categories outside portfolio scope", () => {
    // T is excluded from default portfolio fit
    const result = pipeline.discover({ nteeCategories: ["T"] });
    expect(result.candidates.length).toBe(0);
  });

  it("allows broad NTEE search within portfolio scope", () => {
    const result = pipeline.discover({ nteeCategories: ["E", "B"] });
    expect(result.candidates.length).toBe(2); // B20 + E20
  });

  it("respects portfolioFitOnly=false to bypass platform filter", () => {
    const result = pipeline.discover({ portfolioFitOnly: false });
    // Without portfolio fit, all 501(c)(3) orgs are returned (includes X20, not subsection 4)
    const eins = result.candidates.map((c) => c.ein);
    expect(eins).toContain("999999999"); // X20 now included
    expect(eins).not.toContain("555555555"); // Still excluded: subsection 4
  });

  it("applies pagination with limit and offset", () => {
    const page1 = pipeline.discover({ limit: 2, offset: 0 });
    const page2 = pipeline.discover({ limit: 2, offset: 2 });
    expect(page1.candidates.length).toBe(2);
    expect(page2.candidates.length).toBe(2);
    // No overlap between pages
    const page1Eins = page1.candidates.map((c) => c.ein);
    const page2Eins = page2.candidates.map((c) => c.ein);
    expect(page1Eins.some((ein) => page2Eins.includes(ein))).toBe(false);
  });

  it("reports total count independent of pagination", () => {
    const result = pipeline.discover({ state: "CA", limit: 1 });
    expect(result.candidates.length).toBe(1);
    expect(result.total).toBe(5); // 5 CA orgs matching portfolio fit
  });

  it("returns empty result for no matches", () => {
    const result = pipeline.discover({ state: "ZZ" });
    expect(result.candidates.length).toBe(0);
    expect(result.total).toBe(0);
  });

  it("tracks filters applied", () => {
    const result = pipeline.discover({ state: "CA", city: "Oakland" });
    expect(result.filters_applied).toContain("state=CA");
    expect(result.filters_applied.some((f) => f.includes("city"))).toBe(true);
  });

  it("includes index stats in result", () => {
    const result = pipeline.discover({});
    expect(result.index_stats.total_orgs).toBe(TEST_ORGS.length);
    expect(result.index_stats.last_updated).toBeTruthy();
  });

  it("filters by name substring", () => {
    const result = pipeline.discover({ nameContains: "EDUCATION" });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].ein).toBe("111111111");
  });

  describe("with portfolio-fit disabled", () => {
    it("skips NTEE scope when portfolio-fit is disabled", () => {
      const disabledConfig: PortfolioFitConfig = {
        ...DEFAULT_PORTFOLIO_FIT,
        enabled: false,
      };
      const disabledPipeline = new DiscoveryPipeline(index, disabledConfig);
      const result = disabledPipeline.discover({});
      // All 501(c)(3) orgs returned (no NTEE filter)
      const eins = result.candidates.map((c) => c.ein);
      expect(eins).toContain("999999999"); // X20 included now
      expect(eins).not.toContain("555555555"); // Still subsection 4
    });
  });

  describe("ruling year filters", () => {
    it("filters by minRulingYear", () => {
      const result = pipeline.discover({ minRulingYear: 2010 });
      expect(
        result.candidates.every((c) => {
          const year = parseInt(c.ruling_date.substring(0, 4), 10);
          return year >= 2010;
        }),
      ).toBe(true);
    });

    it("filters by maxRulingYear", () => {
      const result = pipeline.discover({ maxRulingYear: 2005 });
      expect(
        result.candidates.every((c) => {
          const year = parseInt(c.ruling_date.substring(0, 4), 10);
          return year <= 2005;
        }),
      ).toBe(true);
    });
  });
});
