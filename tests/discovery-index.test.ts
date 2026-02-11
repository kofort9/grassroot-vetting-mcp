import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { DiscoveryIndex } from "../src/data-sources/discovery-index.js";
import type { DiscoveryIndexConfig } from "../src/domain/discovery/types.js";

const TEST_ORGS = [
  {
    ein: "123456789",
    name: "Oakland Education Fund",
    city: "OAKLAND",
    state: "CA",
    ntee_code: "B20",
    subsection: 3,
    ruling_date: "200501",
  },
  {
    ein: "234567890",
    name: "Bay Area Health Clinic",
    city: "SAN FRANCISCO",
    state: "CA",
    ntee_code: "E20",
    subsection: 3,
    ruling_date: "201003",
  },
  {
    ein: "345678901",
    name: "Texas Arts Council",
    city: "AUSTIN",
    state: "TX",
    ntee_code: "A30",
    subsection: 3,
    ruling_date: "199807",
  },
  {
    ein: "456789012",
    name: "NYC Housing Alliance",
    city: "NEW YORK",
    state: "NY",
    ntee_code: "L20",
    subsection: 3,
    ruling_date: "201501",
  },
  {
    ein: "567890123",
    name: "Private Foundation Inc",
    city: "CHICAGO",
    state: "IL",
    ntee_code: "T20",
    subsection: 4,
    ruling_date: "200801",
  },
];

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "discovery-index-test-"));
}

function makeConfig(dataDir: string): DiscoveryIndexConfig {
  return {
    dataDir,
    bmfRegions: ["eo1"],
    dataMaxAgeDays: 30,
    maxOrgsPerQuery: 500,
  };
}

function seedTestData(dataDir: string): void {
  const dbPath = path.join(dataDir, "discovery-index.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS bmf_orgs (
      ein        TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      city       TEXT NOT NULL DEFAULT '',
      state      TEXT NOT NULL DEFAULT '',
      ntee_code  TEXT NOT NULL DEFAULT '',
      subsection INTEGER NOT NULL DEFAULT 0,
      ruling_date TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_bmf_state ON bmf_orgs(state);
    CREATE INDEX IF NOT EXISTS idx_bmf_ntee ON bmf_orgs(ntee_code);
    CREATE INDEX IF NOT EXISTS idx_bmf_subsection ON bmf_orgs(subsection);
    CREATE INDEX IF NOT EXISTS idx_bmf_state_ntee ON bmf_orgs(state, ntee_code);
  `);

  const stmt = db.prepare(`
    INSERT INTO bmf_orgs (ein, name, city, state, ntee_code, subsection, ruling_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const org of TEST_ORGS) {
      stmt.run(
        org.ein,
        org.name,
        org.city,
        org.state,
        org.ntee_code,
        org.subsection,
        org.ruling_date,
      );
    }
  });

  insertAll();
  db.close();
}

describe("DiscoveryIndex", () => {
  let index: DiscoveryIndex;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    index = new DiscoveryIndex(makeConfig(tmpDir));
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  it("initialize() creates DB file and table with indexes", () => {
    index.initialize();

    const dbPath = path.join(tmpDir, "discovery-index.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify table exists by querying it
    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bmf_orgs'",
      )
      .all();
    expect(tables).toHaveLength(1);

    // Verify indexes exist
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bmf_orgs'",
      )
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_bmf_state");
    expect(indexNames).toContain("idx_bmf_ntee");
    expect(indexNames).toContain("idx_bmf_subsection");
    expect(indexNames).toContain("idx_bmf_state_ntee");

    db.close();
  });

  // -------------------------------------------------------------------------
  // Query: state filter
  // -------------------------------------------------------------------------

  it("query() filters by state", () => {
    seedTestData(tmpDir);
    index.initialize();

    const result = index.query({ state: "CA" });
    expect(result.total).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.state === "CA")).toBe(true);
    expect(result.filters_applied).toContain("state=CA");
  });

  // -------------------------------------------------------------------------
  // Query: NTEE prefix filter
  // -------------------------------------------------------------------------

  it("query() filters by NTEE prefix", () => {
    seedTestData(tmpDir);
    index.initialize();

    // "B" matches "B20" (Oakland Education Fund)
    const result = index.query({ nteeCategories: ["B"] });
    expect(result.total).toBe(1);
    expect(result.candidates[0].ein).toBe("123456789");
  });

  it("query() supports multiple NTEE prefixes (OR logic)", () => {
    seedTestData(tmpDir);
    index.initialize();

    // "B" matches B20, "E" matches E20
    const result = index.query({ nteeCategories: ["B", "E"] });
    expect(result.total).toBe(2);
    const eins = result.candidates.map((c) => c.ein).sort();
    expect(eins).toEqual(["123456789", "234567890"]);
  });

  // -------------------------------------------------------------------------
  // Query: city filter (case-insensitive)
  // -------------------------------------------------------------------------

  it("query() filters by city (case-insensitive)", () => {
    seedTestData(tmpDir);
    index.initialize();

    const result = index.query({ city: "oakland" });
    expect(result.total).toBe(1);
    expect(result.candidates[0].name).toBe("Oakland Education Fund");
  });

  // -------------------------------------------------------------------------
  // Query: name substring
  // -------------------------------------------------------------------------

  it("query() filters by name substring", () => {
    seedTestData(tmpDir);
    index.initialize();

    const result = index.query({ nameContains: "HEALTH" });
    expect(result.total).toBe(1);
    expect(result.candidates[0].ein).toBe("234567890");
  });

  // -------------------------------------------------------------------------
  // Query: combined filters
  // -------------------------------------------------------------------------

  it("query() applies combined filters (AND logic)", () => {
    seedTestData(tmpDir);
    index.initialize();

    // CA + ntee B = only Oakland Education Fund
    const result = index.query({ state: "CA", nteeCategories: ["B"] });
    expect(result.total).toBe(1);
    expect(result.candidates[0].ein).toBe("123456789");
  });

  it("query() filters by subsection", () => {
    seedTestData(tmpDir);
    index.initialize();

    // subsection=4 matches only Private Foundation Inc
    const result = index.query({ subsection: 4 });
    expect(result.total).toBe(1);
    expect(result.candidates[0].ein).toBe("567890123");
  });

  it("query() filters by ruling year range", () => {
    seedTestData(tmpDir);
    index.initialize();

    // orgs with ruling date >= 2010
    const result = index.query({ minRulingYear: 2010 });
    expect(result.total).toBe(2);
    const eins = result.candidates.map((c) => c.ein).sort();
    expect(eins).toEqual(["234567890", "456789012"]);
  });

  it("query() filters by maxRulingYear", () => {
    seedTestData(tmpDir);
    index.initialize();

    // orgs with ruling date <= 2000
    const result = index.query({ maxRulingYear: 2000 });
    expect(result.total).toBe(1);
    expect(result.candidates[0].ein).toBe("345678901");
  });

  it("query() excludes NTEE prefixes", () => {
    seedTestData(tmpDir);
    index.initialize();

    // Exclude "T" prefix (Private Foundation Inc)
    const result = index.query({ nteeExclude: ["T"] });
    expect(result.total).toBe(4);
    expect(result.candidates.every((c) => !c.ntee_code.startsWith("T"))).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it("query() respects limit and offset", () => {
    seedTestData(tmpDir);
    index.initialize();

    // Get first 2, ordered by name
    const page1 = index.query({ limit: 2, offset: 0 });
    expect(page1.candidates).toHaveLength(2);
    expect(page1.total).toBe(5); // Total is all orgs

    // Get next 2
    const page2 = index.query({ limit: 2, offset: 2 });
    expect(page2.candidates).toHaveLength(2);

    // No overlap between pages
    const page1Eins = page1.candidates.map((c) => c.ein);
    const page2Eins = page2.candidates.map((c) => c.ein);
    expect(page1Eins.some((e) => page2Eins.includes(e))).toBe(false);
  });

  it("query() clamps limit to maxOrgsPerQuery", () => {
    const config = makeConfig(tmpDir);
    config.maxOrgsPerQuery = 3;
    index.close();
    index = new DiscoveryIndex(config);

    seedTestData(tmpDir);
    index.initialize();

    const result = index.query({ limit: 999 });
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Empty results
  // -------------------------------------------------------------------------

  it("query() returns empty results for non-matching filter", () => {
    seedTestData(tmpDir);
    index.initialize();

    const result = index.query({ state: "ZZ" });
    expect(result.total).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  it("getStats() returns correct org count", () => {
    seedTestData(tmpDir);
    index.initialize();

    const stats = index.getStats();
    expect(stats.totalOrgs).toBe(5);
  });

  it("getStats() returns null lastUpdated when no manifest exists", () => {
    index.initialize(); // No data seeded, no manifest

    const stats = index.getStats();
    expect(stats.totalOrgs).toBe(0);
    expect(stats.lastUpdated).toBeNull();
  });

  it("getStats() returns lastUpdated from manifest", () => {
    seedTestData(tmpDir);

    // Write a manifest
    const manifestPath = path.join(tmpDir, "discovery-manifest.json");
    const manifest = {
      bmf_index: {
        built_at: "2026-02-10T12:00:00.000Z",
        row_count: 5,
        regions_loaded: ["eo1"],
        source_urls: ["https://www.irs.gov/pub/irs-soi/eo1.csv"],
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    index.initialize();
    const stats = index.getStats();
    expect(stats.totalOrgs).toBe(5);
    expect(stats.lastUpdated).toBe("2026-02-10T12:00:00.000Z");
  });

  // -------------------------------------------------------------------------
  // isReady
  // -------------------------------------------------------------------------

  it("isReady() returns false when no manifest exists", () => {
    index.initialize();
    expect(index.isReady()).toBe(false);
  });

  it("isReady() returns true when manifest is fresh", () => {
    const manifestPath = path.join(tmpDir, "discovery-manifest.json");
    const manifest = {
      bmf_index: {
        built_at: new Date().toISOString(),
        row_count: 5,
        regions_loaded: ["eo1"],
        source_urls: [],
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    index.initialize();
    expect(index.isReady()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  it("close() handles double-close gracefully", () => {
    index.initialize();
    index.close();
    expect(() => index.close()).not.toThrow();
  });

  it("throws when querying without initialization", () => {
    expect(() => index.query({})).toThrow(/not initialized/);
  });
});
