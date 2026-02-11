import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { VettingStore } from "../src/data-sources/vetting-store.js";
import { makeTier1Result } from "./fixtures.js";
import { ensureSqlJs } from "../src/data-sources/sqlite-adapter.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vetting-store-test-"));
}

describe("VettingStore", () => {
  let store: VettingStore;
  let tmpDir: string;

  beforeAll(async () => {
    await ensureSqlJs();
  });

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new VettingStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initialize() creates DB file and table", () => {
    store.initialize();
    const dbPath = path.join(tmpDir, "vetting.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("saveResult() inserts and returns record", () => {
    store.initialize();
    const result = makeTier1Result();
    const record = store.saveResult(result);

    expect(record.id).toBe(1);
    expect(record.ein).toBe("953135649"); // Hyphen stripped
    expect(record.name).toBe("Test Nonprofit");
    expect(record.recommendation).toBe("PASS");
    expect(record.score).toBe(85);
    expect(record.passed).toBe(true);
    expect(record.gate_blocked).toBe(false);
    expect(record.red_flag_count).toBe(0);
    expect(record.vetted_by).toBe("kofi");
    expect(record.vetted_at).toBeTruthy();
    expect(JSON.parse(record.result_json)).toEqual(result);
  });

  it("saveResult() normalizes EIN (strips hyphens)", () => {
    store.initialize();
    const result = makeTier1Result({ ein: "12-3456789" });
    const record = store.saveResult(result);

    expect(record.ein).toBe("123456789");
  });

  it("getLatestByEin() returns null for unknown EIN", () => {
    store.initialize();
    const record = store.getLatestByEin("000000000");
    expect(record).toBeNull();
  });

  it("getLatestByEin() returns most recent when multiple exist", () => {
    store.initialize();
    const ein = "95-3135649";

    // Save two results for the same EIN
    store.saveResult(
      makeTier1Result({ ein, score: 70, recommendation: "REVIEW" }),
    );
    store.saveResult(
      makeTier1Result({ ein, score: 90, recommendation: "PASS" }),
    );

    const latest = store.getLatestByEin(ein);
    expect(latest).not.toBeNull();
    expect(latest!.score).toBe(90);
    expect(latest!.recommendation).toBe("PASS");
  });

  it("getLatestByEin() normalizes input EIN", () => {
    store.initialize();
    store.saveResult(makeTier1Result({ ein: "12-3456789" }));

    // Look up with different format
    const record = store.getLatestByEin("123456789");
    expect(record).not.toBeNull();
    expect(record!.ein).toBe("123456789");
  });

  it("listVetted() returns all results, newest first", () => {
    store.initialize();

    store.saveResult(makeTier1Result({ ein: "111111111", name: "First" }));
    store.saveResult(makeTier1Result({ ein: "222222222", name: "Second" }));
    store.saveResult(makeTier1Result({ ein: "333333333", name: "Third" }));

    const results = store.listVetted();
    expect(results).toHaveLength(3);
    // Newest first (highest ID = last inserted = most recent)
    expect(results[0].name).toBe("Third");
    expect(results[2].name).toBe("First");
  });

  it("listVetted({ recommendation }) filters correctly", () => {
    store.initialize();

    store.saveResult(makeTier1Result({ recommendation: "PASS", score: 85 }));
    store.saveResult(
      makeTier1Result({
        ein: "222222222",
        recommendation: "REVIEW",
        score: 60,
        passed: false,
      }),
    );
    store.saveResult(
      makeTier1Result({
        ein: "333333333",
        recommendation: "REJECT",
        score: 30,
        passed: false,
      }),
    );

    const passResults = store.listVetted({ recommendation: "PASS" });
    expect(passResults).toHaveLength(1);
    expect(passResults[0].recommendation).toBe("PASS");

    const rejectResults = store.listVetted({ recommendation: "REJECT" });
    expect(rejectResults).toHaveLength(1);
    expect(rejectResults[0].recommendation).toBe("REJECT");
  });

  it("listVetted({ since }) filters by date", () => {
    store.initialize();

    store.saveResult(makeTier1Result({ ein: "111111111" }));

    // All results are "now", so filtering with a far-future date should return nothing
    const futureResults = store.listVetted({ since: "2099-01-01" });
    expect(futureResults).toHaveLength(0);

    // Filtering with a past date should return all
    const pastResults = store.listVetted({ since: "2020-01-01" });
    expect(pastResults).toHaveLength(1);
  });

  it("listVetted({ limit }) respects limit cap", () => {
    store.initialize();

    // Insert 5 records
    for (let i = 0; i < 5; i++) {
      store.saveResult(
        makeTier1Result({ ein: String(100000000 + i), name: `Org ${i}` }),
      );
    }

    const limited = store.listVetted({ limit: 2 });
    expect(limited).toHaveLength(2);

    // Limit above MAX_LIMIT (100) should be capped
    const allResults = store.listVetted({ limit: 999 });
    expect(allResults).toHaveLength(5); // Only 5 exist, cap doesn't matter
  });

  it("getStats() returns correct counts", () => {
    store.initialize();

    store.saveResult(makeTier1Result({ recommendation: "PASS", score: 85 }));
    store.saveResult(
      makeTier1Result({
        ein: "222222222",
        recommendation: "PASS",
        score: 80,
      }),
    );
    store.saveResult(
      makeTier1Result({
        ein: "333333333",
        recommendation: "REVIEW",
        score: 60,
        passed: false,
      }),
    );
    store.saveResult(
      makeTier1Result({
        ein: "444444444",
        recommendation: "REJECT",
        score: 30,
        passed: false,
      }),
    );

    const stats = store.getStats();
    expect(stats.total).toBe(4);
    expect(stats.pass).toBe(2);
    expect(stats.review).toBe(1);
    expect(stats.reject).toBe(1);
  });

  it("close() handles double-close gracefully", () => {
    store.initialize();
    store.close();
    // Second close should not throw
    expect(() => store.close()).not.toThrow();
  });

  it("listVetted({ limit }) clamps negative values to 1", () => {
    store.initialize();
    store.saveResult(makeTier1Result({ ein: "111111111" }));

    const results = store.listVetted({ limit: -5 });
    expect(results).toHaveLength(1);
  });

  it("listVetted({ since }) rejects invalid date format", () => {
    store.initialize();

    expect(() => store.listVetted({ since: "not-a-date" })).toThrow(
      /Invalid since date format/,
    );
  });
});
