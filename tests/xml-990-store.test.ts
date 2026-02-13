import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ensureSqlJs, SqliteDatabase } from "../src/data-sources/sqlite-adapter.js";
import { Xml990Store } from "../src/data-sources/xml-990-store.js";
import {
  makeGtFilingEntry,
  makeXml990ExtractedData,
} from "./fixtures.js";
import fsp from "fs/promises";
import path from "path";
import fs from "fs";

describe("Xml990Store", () => {
  const testDir = "/tmp/test-xml990-store";
  let store: Xml990Store;

  beforeAll(async () => {
    await ensureSqlJs();
  });

  beforeEach(async () => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      await fsp.rm(testDir, { recursive: true });
    }
    await fsp.mkdir(testDir, { recursive: true });

    store = new Xml990Store(testDir);
    store.initialize();
  });

  afterAll(async () => {
    try {
      store?.close();
      if (fs.existsSync(testDir)) {
        await fsp.rm(testDir, { recursive: true });
      }
    } catch {
      // ignore
    }
  });

  it("initializes and creates tables", () => {
    // Should not throw
    expect(() => store.initialize()).not.toThrow();
  });

  it("saves and retrieves metadata", () => {
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);

    // Metadata saved — no direct getter for metadata,
    // but it shouldn't throw
  });

  it("saves and retrieves extract by EIN", () => {
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);

    const data = makeXml990ExtractedData();
    store.saveExtract(data);

    const result = store.getLatestExtract("131624100");
    expect(result).not.toBeNull();
    expect(result!.ein).toBe("131624100");
    expect(result!.taxYear).toBe(2022);
    expect(result!.partIX).not.toBeNull();
    expect(result!.partIX!.totalExpenses).toBe(400_000);
  });

  it("retrieves latest extract when multiple exist", () => {
    const filing2020 = makeGtFilingEntry({
      ObjectId: "obj_2020",
      TaxYear: "2020",
    });
    const filing2022 = makeGtFilingEntry({
      ObjectId: "obj_2022",
      TaxYear: "2022",
    });

    store.saveMetadata(filing2020);
    store.saveMetadata(filing2022);

    store.saveExtract(
      makeXml990ExtractedData({
        objectId: "obj_2020",
        taxYear: 2020,
      }),
    );
    store.saveExtract(
      makeXml990ExtractedData({
        objectId: "obj_2022",
        taxYear: 2022,
      }),
    );

    const result = store.getLatestExtract("131624100");
    expect(result!.taxYear).toBe(2022);
  });

  it("returns null for unknown EIN", () => {
    const result = store.getLatestExtract("999999999");
    expect(result).toBeNull();
  });

  it("hasExtract returns true for existing extract", () => {
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);
    store.saveExtract(makeXml990ExtractedData());

    expect(
      store.hasExtract("131624100", "202301234567890123_public"),
    ).toBe(true);
  });

  it("hasExtract returns false for missing extract", () => {
    expect(store.hasExtract("131624100", "nonexistent_obj")).toBe(false);
  });

  it("handles EIN normalization (strips dashes)", () => {
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);
    store.saveExtract(makeXml990ExtractedData());

    // Should find with dashed EIN
    const result = store.getLatestExtract("13-1624100");
    expect(result).not.toBeNull();
  });

  it("persist writes to disk", () => {
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);
    store.saveExtract(makeXml990ExtractedData());
    store.persist();

    const dbPath = path.join(testDir, "xml-990.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const stats = fs.statSync(dbPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it("throws on corrupt extract JSON instead of returning null", () => {
    // Manually insert corrupt JSON to simulate corruption
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);
    store.saveExtract(makeXml990ExtractedData());

    // Corrupt the stored JSON by direct DB manipulation
    // Access internal db via any-cast (test-only)
    const db = (store as any).db;
    db.prepare(
      "UPDATE xml_990_extracts SET extract_json = '{invalid json' WHERE ein = '131624100'",
    ).run();

    expect(() => store.getLatestExtract("131624100")).toThrow(
      "Corrupt extract JSON",
    );
  });

  it("saveMetadata handles REPLACE on conflict (same ObjectId)", () => {
    const filing = makeGtFilingEntry();
    store.saveMetadata(filing);

    // Save again with same ObjectId — should not throw
    const updated = makeGtFilingEntry({ TaxYear: "2023" });
    expect(() => store.saveMetadata(updated)).not.toThrow();
  });

  it("throws when not initialized", () => {
    const uninitStore = new Xml990Store(testDir);
    expect(() => uninitStore.getLatestExtract("131624100")).toThrow(
      "not initialized",
    );
  });
});
