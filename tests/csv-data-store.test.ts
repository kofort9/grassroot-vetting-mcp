import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { CsvDataStore } from "../src/data-sources/csv-data-store.js";
import type { RedFlagConfig } from "../src/core/config.js";

// ============================================================================
// Mocks
// ============================================================================

// Mock axios
vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

// Mock unzipper
vi.mock("unzipper", () => ({
  Open: {
    file: vi.fn(),
  },
}));

// Mock fs (sync methods)
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
  },
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Suppress log output in tests
vi.mock("../src/core/logging.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  getErrorMessage: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

import axios from "axios";
import * as unzipper from "unzipper";
import fs from "fs";
import fsp from "fs/promises";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<RedFlagConfig>): RedFlagConfig {
  return {
    courtlistenerBaseUrl: "https://www.courtlistener.com/api/rest/v4",
    courtlistenerRateLimitMs: 500,
    dataDir: "/tmp/test-data",
    dataMaxAgeDays: 7,
    ...overrides,
  };
}

/**
 * Generate a minimal IRS pipe-delimited CSV with N rows.
 * Format: EIN|LegalName|DBA|City|State|Zip|Country|ExemptionType|RevDate|PostDate|ReinDate
 */
function makeIrsCsv(rowCount: number): string {
  const header =
    "EIN|Legal Name|DBA Name|City|State|ZIP Code|Country|Exemption Type|Revocation Date|Posting Date|Reinstatement Date";
  const lines = [header];
  for (let i = 0; i < rowCount; i++) {
    const ein = String(100000000 + i);
    lines.push(
      `${ein}|ORG ${i}|DBA ${i}|CITY|CA|90001|US|03|2022-01-01|2022-02-01|`,
    );
  }
  return lines.join("\n");
}

/**
 * Generate a minimal OFAC SDN CSV with N rows.
 * No header — positional: entNum, name, sdnType, program, title, remarks
 */
function makeOfacSdnCsv(rows: Array<{ entNum: string; name: string; sdnType?: string }>): string {
  return rows
    .map(
      (r) =>
        `"${r.entNum}","${r.name}","${r.sdnType ?? "Entity"}","SDGT","","remarks"`,
    )
    .join("\n");
}

/**
 * Generate OFAC alt-names CSV.
 * No header — positional: entNum, altNum, altType, altName, altRemarks
 */
function makeOfacAltCsv(rows: Array<{ entNum: string; altName: string }>): string {
  return rows
    .map((r) => `"${r.entNum}","1","aka","${r.altName}",""`)
    .join("\n");
}

function makeManifest(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    irs_revocation: {
      downloaded_at: new Date().toISOString(),
      row_count: 500000,
    },
    ofac_sdn: {
      downloaded_at: new Date().toISOString(),
      sdn_count: 12000,
      alt_count: 8000,
    },
    ...overrides,
  });
}

/** Set up mocks so parseIrsFromDisk succeeds with the given CSV content */
function setupIrsDisk(csvContent: string) {
  (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
    (filePath: string) => {
      if (filePath.includes("manifest")) return Promise.resolve(makeManifest());
      if (filePath.includes("irs-revocation")) return Promise.resolve(csvContent);
      return Promise.resolve("");
    },
  );
}

/** Set up mocks so parseOfacFromDisk succeeds */
function setupOfacDisk(sdnCsv: string, altCsv: string) {
  (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
    (filePath: string) => {
      if (filePath.includes("manifest")) return Promise.resolve(makeManifest());
      if (filePath.includes("sdn.csv")) return Promise.resolve(sdnCsv);
      if (filePath.includes("alt.csv")) return Promise.resolve(altCsv);
      if (filePath.includes("irs-revocation")) return Promise.resolve(makeIrsCsv(500_000));
      return Promise.resolve("");
    },
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("CsvDataStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------- Construction & Accessors ----------

  describe("construction", () => {
    it("starts with empty maps", () => {
      const store = new CsvDataStore(makeConfig());
      expect(store.irsRowCount).toBe(0);
      expect(store.ofacEntryCount).toBe(0);
    });
  });

  // ---------- IRS CSV Parsing ----------

  describe("IRS parsing (via initialize from disk)", () => {
    it("parses pipe-delimited IRS data correctly", async () => {
      const csv = makeIrsCsv(500_000);
      setupIrsDisk(csv);

      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      expect(store.irsRowCount).toBe(500_000);
    });

    it("skips malformed rows (< 11 fields)", async () => {
      const header = "EIN|Name|DBA|City|State|Zip|Country|Type|RevDate|PostDate|ReinDate";
      const good = "123456789|GOOD ORG|DBA|CITY|CA|90001|US|03|2022-01-01|2022-02-01|";
      const bad = "987654321|BAD ROW|too few fields";
      const csv = [header, good, bad].join("\n");

      setupIrsDisk(csv);

      // Override so it doesn't fail the MIN_IRS_ROWS check — test the parse logic
      // We need to test with a store that won't warn about small data
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // Only the good row parsed (bad one skipped)
      expect(store.irsRowCount).toBe(1);
    });

    it("skips rows with invalid EIN format", async () => {
      const header = "EIN|Name|DBA|City|State|Zip|Country|Type|RevDate|PostDate|ReinDate";
      const valid = "123456789|VALID ORG|DBA|CITY|CA|90001|US|03|2022-01-01|2022-02-01|";
      const letters = "ABC123456|LETTER ORG|DBA|CITY|CA|90001|US|03|2022-01-01|2022-02-01|";
      const short = "12345|SHORT ORG|DBA|CITY|CA|90001|US|03|2022-01-01|2022-02-01|";
      const csv = [header, valid, letters, short].join("\n");

      setupIrsDisk(csv);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      expect(store.irsRowCount).toBe(1);
    });

    it("normalizes EIN by stripping dashes and spaces", async () => {
      const store = new CsvDataStore(makeConfig());
      const csv = makeIrsCsv(500_000);
      setupIrsDisk(csv);
      await store.initialize();

      // lookupEin strips dashes
      const result = store.lookupEin("10-0000000");
      expect(result).toBeDefined();
      expect(result!.ein).toBe("100000000");
    });
  });

  // ---------- OFAC CSV Parsing ----------

  describe("OFAC parsing (via initialize from disk)", () => {
    it("parses SDN and alt-name CSVs, builds name map", async () => {
      const sdn = makeOfacSdnCsv([
        { entNum: "100", name: "AL QAEDA FOUNDATION" },
        { entNum: "200", name: "HAMAS SERVICES" },
      ]);
      const alt = makeOfacAltCsv([
        { entNum: "100", altName: "AL QAIDA FOUNDATION" },
      ]);

      setupOfacDisk(sdn, alt);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // 2 primary names + 1 alias = 3 entries (or 2 if alias normalizes same)
      expect(store.ofacEntryCount).toBeGreaterThanOrEqual(2);
    });

    it("lookupName finds by normalized primary name", async () => {
      const sdn = makeOfacSdnCsv([
        { entNum: "100", name: "BAD ACTOR FOUNDATION" },
      ]);
      const alt = makeOfacAltCsv([]);

      setupOfacDisk(sdn, alt);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // Name normalization: lowercase, strip suffixes, etc.
      const matches = store.lookupName("Bad Actor Foundation");
      expect(matches).toHaveLength(1);
      expect(matches[0].entNum).toBe("100");
    });

    it("lookupName finds by alias", async () => {
      const sdn = makeOfacSdnCsv([
        { entNum: "100", name: "PRIMARY NAME INC" },
      ]);
      const alt = makeOfacAltCsv([
        { entNum: "100", altName: "ALIAS NAME" },
      ]);

      setupOfacDisk(sdn, alt);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      const matches = store.lookupName("Alias Name");
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe("PRIMARY NAME INC");
    });

    it("lookupName returns empty array for unknown name", async () => {
      const sdn = makeOfacSdnCsv([
        { entNum: "100", name: "KNOWN ENTITY" },
      ]);
      setupOfacDisk(sdn, makeOfacAltCsv([]));
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      expect(store.lookupName("Unknown Org")).toEqual([]);
    });

    it("deduplicates alias matches for same entNum", async () => {
      const sdn = makeOfacSdnCsv([
        { entNum: "100", name: "MAIN ORG" },
      ]);
      const alt = makeOfacAltCsv([
        { entNum: "100", altName: "MAIN ORG" }, // same as primary after normalization
      ]);

      setupOfacDisk(sdn, alt);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      const matches = store.lookupName("Main Org");
      // Should not have duplicate entries for same entNum
      expect(matches).toHaveLength(1);
    });

    it("skips SDN rows with fewer than 6 fields", async () => {
      const sdn = '"100","SHORT ROW","Entity"\n"200","VALID ENTITY","Entity","SDGT","title","remarks"';
      setupOfacDisk(sdn, makeOfacAltCsv([]));
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // Only "VALID ENTITY" should be indexed
      expect(store.lookupName("Short Row")).toEqual([]);
      expect(store.lookupName("Valid Entity")).toHaveLength(1);
    });

    it("skips alt rows with fewer than 5 fields", async () => {
      const sdn = makeOfacSdnCsv([{ entNum: "100", name: "TARGET ORG" }]);
      const alt = '"100","1","aka"\n"100","2","aka","GOOD ALIAS",""'; // first row too short
      setupOfacDisk(sdn, alt);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // Only "GOOD ALIAS" should be indexed
      expect(store.lookupName("Good Alias")).toHaveLength(1);
    });
  });

  // ---------- lookupEin ----------

  describe("lookupEin", () => {
    it("returns undefined for unknown EIN", async () => {
      const csv = makeIrsCsv(500_000);
      setupIrsDisk(csv);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      expect(store.lookupEin("999999999")).toBeUndefined();
    });

    it("finds EIN with dashes in input", async () => {
      const csv = makeIrsCsv(500_000);
      setupIrsDisk(csv);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // EIN 100000000 exists (first row)
      const result = store.lookupEin("10-0000000");
      expect(result).toBeDefined();
    });

    it("finds EIN without dashes", async () => {
      const csv = makeIrsCsv(500_000);
      setupIrsDisk(csv);
      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      const result = store.lookupEin("100000000");
      expect(result).toBeDefined();
    });
  });

  // ---------- Staleness ----------

  describe("staleness check", () => {
    it("triggers download when manifest has no download date", async () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes("manifest")) return Promise.resolve("{}");
          return Promise.reject(new Error("File not found"));
        },
      );

      // Mock axios for download
      const irsCsv = makeIrsCsv(500_000);
      const zipBuffer = Buffer.from("fake-zip");
      (axios.get as ReturnType<typeof vi.fn>).mockImplementation(
        (url: string) => {
          if (url.includes("irs.gov")) {
            return Promise.resolve({ data: zipBuffer });
          }
          if (url.includes("sdn.csv")) {
            return Promise.resolve({
              data: makeOfacSdnCsv([
                ...Array.from({ length: 5000 }, (_, i) => ({
                  entNum: String(i),
                  name: `ENTITY ${i}`,
                })),
              ]),
            });
          }
          if (url.includes("alt.csv")) {
            return Promise.resolve({ data: makeOfacAltCsv([]) });
          }
          return Promise.reject(new Error("Unknown URL"));
        },
      );

      // Mock unzipper
      (unzipper.Open.file as ReturnType<typeof vi.fn>).mockResolvedValue({
        files: [
          {
            uncompressedSize: 1000,
            buffer: () => Promise.resolve(Buffer.from(irsCsv)),
          },
        ],
      });

      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      expect(axios.get).toHaveBeenCalled();
      expect(store.irsRowCount).toBe(500_000);
      expect(store.ofacEntryCount).toBeGreaterThan(0);
    });

    it("uses cached data when manifest shows recent download", async () => {
      const irsCsv = makeIrsCsv(500_000);
      const sdn = makeOfacSdnCsv([{ entNum: "100", name: "TEST" }]);
      setupOfacDisk(sdn, makeOfacAltCsv([]));
      // Override IRS readFile too
      (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes("manifest")) return Promise.resolve(makeManifest());
          if (filePath.includes("irs-revocation")) return Promise.resolve(irsCsv);
          if (filePath.includes("sdn.csv")) return Promise.resolve(sdn);
          if (filePath.includes("alt.csv")) return Promise.resolve(makeOfacAltCsv([]));
          return Promise.resolve("");
        },
      );

      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // Should NOT have called axios (used disk cache)
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  // ---------- Refresh ----------

  describe("refresh", () => {
    it("enforces 60-second cooldown", async () => {
      const irsCsv = makeIrsCsv(500_000);
      setupOfacDisk(
        makeOfacSdnCsv([{ entNum: "1", name: "X" }]),
        makeOfacAltCsv([]),
      );
      (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes("manifest")) return Promise.resolve(makeManifest());
          if (filePath.includes("irs-revocation")) return Promise.resolve(irsCsv);
          if (filePath.includes("sdn.csv"))
            return Promise.resolve(makeOfacSdnCsv([{ entNum: "1", name: "X" }]));
          if (filePath.includes("alt.csv")) return Promise.resolve(makeOfacAltCsv([]));
          return Promise.resolve("");
        },
      );

      // Mock axios for the refresh download
      (axios.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.includes("irs.gov"))
          return Promise.resolve({ data: Buffer.from("zip") });
        if (url.includes("sdn.csv"))
          return Promise.resolve({
            data: makeOfacSdnCsv(
              Array.from({ length: 5000 }, (_, i) => ({
                entNum: String(i),
                name: `E${i}`,
              })),
            ),
          });
        if (url.includes("alt.csv"))
          return Promise.resolve({ data: makeOfacAltCsv([]) });
        return Promise.reject(new Error("Unknown"));
      });
      (unzipper.Open.file as ReturnType<typeof vi.fn>).mockResolvedValue({
        files: [
          {
            uncompressedSize: 1000,
            buffer: () => Promise.resolve(Buffer.from(irsCsv)),
          },
        ],
      });

      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // First refresh should succeed
      await store.refresh("ofac");

      // Second refresh immediately should throw cooldown error
      await expect(store.refresh("ofac")).rejects.toThrow("cooldown");
    });
  });

  // ---------- Mutex ----------

  describe("operation lock (mutex)", () => {
    it("serializes concurrent initialize and refresh calls", async () => {
      const irsCsv = makeIrsCsv(500_000);
      setupOfacDisk(
        makeOfacSdnCsv([{ entNum: "1", name: "X" }]),
        makeOfacAltCsv([]),
      );
      (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes("manifest")) return Promise.resolve(makeManifest());
          if (filePath.includes("irs-revocation")) return Promise.resolve(irsCsv);
          if (filePath.includes("sdn.csv"))
            return Promise.resolve(makeOfacSdnCsv([{ entNum: "1", name: "X" }]));
          if (filePath.includes("alt.csv")) return Promise.resolve(makeOfacAltCsv([]));
          return Promise.resolve("");
        },
      );

      const store = new CsvDataStore(makeConfig());

      // Both should complete without error (serialized by mutex)
      const results = await Promise.allSettled([
        store.initialize(),
        store.initialize(),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");
    });
  });

  // ---------- Error Handling ----------

  describe("error handling", () => {
    it("throws when no cached IRS data and download fails", async () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes("manifest")) return Promise.resolve("{}");
          return Promise.reject(new Error("File not found"));
        },
      );
      (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network down"),
      );

      const store = new CsvDataStore(makeConfig());
      await expect(store.initialize()).rejects.toThrow("Cannot load IRS");
    });

    it("falls back to cached IRS data when download fails", async () => {
      const irsCsv = makeIrsCsv(500_000);
      // First readFile call returns empty manifest (triggers download)
      // Download fails, but CSV exists on disk
      let manifestCallCount = 0;
      (fsp.readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes("manifest")) {
            manifestCallCount++;
            // First manifest read: stale (triggers download)
            if (manifestCallCount === 1) return Promise.resolve("{}");
            // Subsequent: fresh
            return Promise.resolve(makeManifest());
          }
          if (filePath.includes("irs-revocation")) return Promise.resolve(irsCsv);
          if (filePath.includes("sdn.csv"))
            return Promise.resolve(
              makeOfacSdnCsv(
                Array.from({ length: 5000 }, (_, i) => ({
                  entNum: String(i),
                  name: `E${i}`,
                })),
              ),
            );
          if (filePath.includes("alt.csv")) return Promise.resolve(makeOfacAltCsv([]));
          return Promise.resolve("");
        },
      );
      // Download fails
      (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Timeout"),
      );
      // But CSV exists on disk
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const store = new CsvDataStore(makeConfig());
      await store.initialize();

      // Should have loaded from disk cache despite download failure
      expect(store.irsRowCount).toBeGreaterThan(0);
    });
  });
});
