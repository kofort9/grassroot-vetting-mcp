import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SearchHistoryStore } from "../src/data-sources/search-history-store.js";
import { SqliteDatabase } from "../src/data-sources/sqlite-adapter.js";
import { ensureSqlJs } from "../src/data-sources/sqlite-adapter.js";

describe("SearchHistoryStore", () => {
  let db: SqliteDatabase;
  let store: SearchHistoryStore;

  beforeEach(async () => {
    await ensureSqlJs();
    db = SqliteDatabase.inMemory();
    store = new SearchHistoryStore();
    store.initialize(db);
  });

  afterEach(() => {
    store.close();
    db.close();
  });

  it("logs and retrieves a search", () => {
    store.logSearch("search_nonprofit", { query: "food bank" }, 42);

    const results = store.listSearches();
    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe("search_nonprofit");
    expect(JSON.parse(results[0].query_json)).toEqual({ query: "food bank" });
    expect(results[0].result_count).toBe(42);
  });

  it("filters by tool name", () => {
    store.logSearch("search_nonprofit", { query: "food bank" }, 42);
    store.logSearch("discover_nonprofits", { state: "CA" }, 100);

    const results = store.listSearches({ tool: "search_nonprofit" });
    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe("search_nonprofit");
  });

  it("limits results", () => {
    for (let i = 0; i < 5; i++) {
      store.logSearch("search_nonprofit", { query: `test ${i}` }, i);
    }

    const results = store.listSearches({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("retrieves by ID", () => {
    store.logSearch("search_nonprofit", { query: "test" }, 10);

    const results = store.listSearches();
    const record = store.getById(results[0].id);
    expect(record).not.toBeNull();
    expect(record!.tool).toBe("search_nonprofit");
  });

  it("returns null for unknown ID", () => {
    const record = store.getById(999);
    expect(record).toBeNull();
  });

  it("throws on invalid since date", () => {
    expect(() => store.listSearches({ since: "not-a-date" })).toThrow(
      "Invalid since date format",
    );
  });

  it("throws when not initialized", () => {
    const uninitStore = new SearchHistoryStore();
    expect(() => uninitStore.listSearches()).toThrow("not initialized");
  });
});
