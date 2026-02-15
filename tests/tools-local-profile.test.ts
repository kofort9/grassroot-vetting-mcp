import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getNonprofitProfileLocal,
  getRedFlagsLocal,
  type LocalScreeningDeps,
} from "../src/domain/nonprofit/tools.js";
import { getToolDefinitions } from "../src/server/nonprofit-tools.js";
import {
  makeGtFilingEntry,
  makeXml990ExtractedData,
  DEFAULT_THRESHOLDS,
  makePortfolioFitConfig,
} from "./fixtures.js";
import type { DiscoveryCandidate } from "../src/domain/discovery/types.js";
import type { DiscoveryResult } from "../src/domain/discovery/types.js";

// ============================================================================
// Shared mock factories
// ============================================================================

function makeCandidate(overrides?: Partial<DiscoveryCandidate>): DiscoveryCandidate {
  return {
    ein: "131624100",
    name: "Museum of Modern Art",
    city: "New York",
    state: "NY",
    ntee_code: "A51",
    subsection: 3,
    ruling_date: "1940-01-01",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<LocalScreeningDeps>): LocalScreeningDeps {
  return {
    discoveryIndex: {
      getByEin: vi.fn().mockReturnValue(makeCandidate()),
    } as any,
    givingTuesdayClient: {
      getFilingIndex: vi.fn().mockResolvedValue([makeGtFilingEntry()]),
      downloadXml: vi.fn().mockResolvedValue("<xml/>"),
    } as any,
    xml990Store: {
      getLatestExtract: vi.fn().mockReturnValue(makeXml990ExtractedData()),
      getAllExtracts: vi.fn().mockReturnValue([]),
      hasExtract: vi.fn().mockReturnValue(false),
      saveMetadata: vi.fn(),
      saveExtract: vi.fn(),
    } as any,
    concordance: {} as any,
    thresholds: DEFAULT_THRESHOLDS,
    irsClient: { check: vi.fn().mockReturnValue({ found: false, revoked: false, detail: "clean" }) } as any,
    ofacClient: {
      check: vi.fn().mockReturnValue({ found: false, detail: "clean", matches: [] }),
      fuzzyCheck: vi.fn().mockReturnValue({ found: false, detail: "clean", matches: [] }),
    } as any,
    portfolioFitConfig: makePortfolioFitConfig(),
    ...overrides,
  };
}

// ============================================================================
// getNonprofitProfileLocal
// ============================================================================

describe("getNonprofitProfileLocal", () => {
  it("returns profile from BMF + GT + XML data", async () => {
    const deps = makeDeps();
    const result = await getNonprofitProfileLocal("13-1624100", deps);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.ein).toBe("13-1624100");
    expect(result.data!.name).toBe("Museum of Modern Art");
    expect(result.data!.latest_990).not.toBeNull();
    expect(result.data!.latest_990!.total_revenue).toBe(500_000);
    expect(result.attribution).toContain("IRS BMF");
  });

  it("returns profile with latest_990: null when no XML available", async () => {
    const deps = makeDeps({
      xml990Store: {
        getLatestExtract: vi.fn().mockReturnValue(null),
        getAllExtracts: vi.fn().mockReturnValue([]),
        hasExtract: vi.fn().mockReturnValue(false),
        saveMetadata: vi.fn(),
        saveExtract: vi.fn(),
      } as any,
      givingTuesdayClient: {
        getFilingIndex: vi.fn().mockResolvedValue([]),
        downloadXml: vi.fn(),
      } as any,
    });

    const result = await getNonprofitProfileLocal("13-1624100", deps);

    expect(result.success).toBe(true);
    expect(result.data!.latest_990).toBeNull();
    expect(result.data!.filing_count).toBe(0);
  });

  it("returns error when EIN not in BMF", async () => {
    const deps = makeDeps({
      discoveryIndex: {
        getByEin: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    const result = await getNonprofitProfileLocal("99-9999999", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in BMF");
  });

  it("returns error when EIN is empty", async () => {
    const deps = makeDeps();
    const result = await getNonprofitProfileLocal("", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("EIN parameter is required");
  });
});

// ============================================================================
// getRedFlagsLocal
// ============================================================================

describe("getRedFlagsLocal", () => {
  it("detects red flags from local data", async () => {
    // Profile with stale 990 (old tax year) — triggers stale data flag
    const staleExtract = makeXml990ExtractedData({
      taxYear: 2018,
    });

    const deps = makeDeps({
      xml990Store: {
        getLatestExtract: vi.fn().mockReturnValue(staleExtract),
        getAllExtracts: vi.fn().mockReturnValue([]),
        hasExtract: vi.fn().mockReturnValue(false),
        saveMetadata: vi.fn(),
        saveExtract: vi.fn(),
      } as any,
      givingTuesdayClient: {
        getFilingIndex: vi.fn().mockResolvedValue([
          makeGtFilingEntry({ TaxYear: "2018", TaxPeriod: "2018-06-30" }),
        ]),
        downloadXml: vi.fn(),
      } as any,
    });

    const result = await getRedFlagsLocal("13-1624100", deps);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.ein).toBe("13-1624100");
    // Should have at least a stale data flag
    expect(result.data!.flags.length).toBeGreaterThan(0);
  });

  it("fetches 2nd filing for revenue decline when only 1 XML cached", async () => {
    const extract1 = makeXml990ExtractedData({
      objectId: "obj1",
      taxYear: 2022,
    });

    const filings = [
      makeGtFilingEntry({ ObjectId: "obj1", TaxYear: "2022", TaxPeriod: "2022-06-30" }),
      makeGtFilingEntry({ ObjectId: "obj2", TaxYear: "2021", TaxPeriod: "2021-06-30" }),
    ];

    const downloadXml = vi.fn().mockResolvedValue("<xml/>");

    const deps = makeDeps({
      xml990Store: {
        getLatestExtract: vi.fn().mockReturnValue(extract1),
        getAllExtracts: vi.fn().mockReturnValue([extract1]),
        hasExtract: vi.fn().mockReturnValue(false),
        saveMetadata: vi.fn(),
        saveExtract: vi.fn(),
      } as any,
      givingTuesdayClient: {
        getFilingIndex: vi.fn().mockResolvedValue(filings),
        downloadXml,
      } as any,
      concordance: { get: vi.fn() } as any,
    });

    await getRedFlagsLocal("13-1624100", deps);

    // Should have attempted to download the 2nd filing
    expect(downloadXml).toHaveBeenCalled();
  });

  it("gracefully skips revenue decline when only 1 filing available", async () => {
    const deps = makeDeps({
      givingTuesdayClient: {
        getFilingIndex: vi.fn().mockResolvedValue([makeGtFilingEntry()]),
        downloadXml: vi.fn(),
      } as any,
    });

    const result = await getRedFlagsLocal("13-1624100", deps);

    expect(result.success).toBe(true);
    // No crash, result is valid
    expect(result.data!.ein).toBe("13-1624100");
  });

  it("returns error when EIN not in BMF", async () => {
    const deps = makeDeps({
      discoveryIndex: {
        getByEin: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    const result = await getRedFlagsLocal("99-9999999", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in BMF");
  });

  it("court client failure is non-blocking", async () => {
    const deps = makeDeps({
      courtClient: {
        searchByOrgName: vi.fn().mockRejectedValue(new Error("Court API down")),
      } as any,
    });

    const result = await getRedFlagsLocal("13-1624100", deps);

    // Should succeed despite court failure
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});

// ============================================================================
// search_nonprofit (BMF-backed)
// ============================================================================

describe("search_nonprofit handler", () => {
  function getSearchHandler() {
    const tools = getToolDefinitions();
    const searchTool = tools.find((t) => t.name === "search_nonprofit");
    if (!searchTool) throw new Error("search_nonprofit tool not found");
    return searchTool.handler;
  }

  function makeSearchCtx(
    candidates: DiscoveryCandidate[] = [],
    ready = true,
  ): any {
    return {
      discoveryIndex: {
        isReady: vi.fn().mockReturnValue(ready),
        query: vi.fn().mockReturnValue({
          candidates,
          total: candidates.length,
          filters_applied: [],
          index_stats: { total_orgs: 1000, last_updated: "2026-01-01" },
        } as DiscoveryResult),
      },
      searchHistoryStore: {
        logSearch: vi.fn(),
      },
    };
  }

  it("returns matching orgs from BMF", async () => {
    const handler = getSearchHandler();
    const ctx = makeSearchCtx([
      makeCandidate({ name: "Habitat for Humanity International" }),
      makeCandidate({ ein: "541234567", name: "Habitat for Humanity of Portland" }),
    ]);

    const result = await handler({ query: "habitat for humanity" }, ctx);

    expect(result).toBeDefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.results).toHaveLength(2);
    expect(parsed.data.results[0].name).toBe("Habitat for Humanity International");
    expect(parsed.data.attribution).toContain("IRS Business Master File");
  });

  it("passes state filter to discovery index", async () => {
    const handler = getSearchHandler();
    const ctx = makeSearchCtx([makeCandidate({ state: "CA" })]);

    await handler({ query: "habitat", state: "CA" }, ctx);

    expect(ctx.discoveryIndex.query).toHaveBeenCalledWith(
      expect.objectContaining({ state: "CA", nameContains: "habitat" }),
    );
  });

  it("passes city filter to discovery index", async () => {
    const handler = getSearchHandler();
    const ctx = makeSearchCtx([makeCandidate({ city: "Portland" })]);

    await handler({ query: "habitat", city: "Portland" }, ctx);

    expect(ctx.discoveryIndex.query).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Portland" }),
    );
  });

  it("returns error when query is empty", async () => {
    const handler = getSearchHandler();
    const ctx = makeSearchCtx();

    const result = await handler({ query: "" }, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Query parameter is required");
  });

  it("returns error when BMF index not ready", async () => {
    const handler = getSearchHandler();
    const ctx = makeSearchCtx([], false);

    const result = await handler({ query: "test" }, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not initialized");
  });
});
