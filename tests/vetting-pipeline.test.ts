import { describe, it, expect, vi, beforeEach } from "vitest";
import { VettingPipeline } from "../src/domain/nonprofit/vetting-pipeline.js";
import { makeScreeningResult } from "./fixtures.js";
import type { VettingPipelineConfig } from "../src/domain/nonprofit/vetting-pipeline.js";

// Mock the tools module
vi.mock("../src/domain/nonprofit/tools.js", () => ({
  checkTier1: vi.fn(),
}));

// Mock logging to suppress output
vi.mock("../src/core/logging.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { checkTier1 } from "../src/domain/nonprofit/tools.js";

const mockedCheckTier1 = vi.mocked(checkTier1);

/** Returns an ISO datetime string N days in the past */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function makeMockConfig(
  overrides?: Partial<VettingPipelineConfig>,
): VettingPipelineConfig {
  return {
    propublicaClient: {} as VettingPipelineConfig["propublicaClient"],
    thresholds: {} as VettingPipelineConfig["thresholds"],
    portfolioFit: {} as VettingPipelineConfig["portfolioFit"],
    irsClient: {} as VettingPipelineConfig["irsClient"],
    ofacClient: {} as VettingPipelineConfig["ofacClient"],
    courtClient: undefined,
    vettingStore: {
      getLatestByEin: vi.fn().mockReturnValue(null),
      saveResult: vi.fn(),
    } as unknown as VettingPipelineConfig["vettingStore"],
    cacheMaxAgeDays: 30,
    ...overrides,
  };
}

describe("VettingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns fresh result on cache miss", async () => {
    const tier1Result = makeScreeningResult({ ein: "12-3456789" });
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const config = makeMockConfig();
    const pipeline = new VettingPipeline(config);
    const { response, cached } = await pipeline.runScreening("12-3456789");

    expect(cached).toBe(false);
    expect(response.success).toBe(true);
    expect(response.data?.ein).toBe("12-3456789");
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });

  it("returns cached result on cache hit (within TTL)", async () => {
    const tier1Result = makeScreeningResult({ ein: "12-3456789" });
    const recentDate = daysAgo(5);
    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue({
          result_json: JSON.stringify(tier1Result),
          vetted_at: recentDate,
          vetted_by: "kofi",
        }),
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { response, cached, cachedNote } =
      await pipeline.runScreening("12-3456789");

    expect(cached).toBe(true);
    expect(response.success).toBe(true);
    expect(cachedNote).toContain("Previously vetted on");
    expect(cachedNote).toContain("TTL 30d");
    expect(mockedCheckTier1).not.toHaveBeenCalled();
  });

  it("auto-refreshes when cached result exceeds TTL", async () => {
    const tier1Result = makeScreeningResult({ ein: "12-3456789" });
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const staleDate = daysAgo(45); // 45 days old, exceeds 30-day TTL
    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue({
          result_json: JSON.stringify(tier1Result),
          vetted_at: staleDate,
          vetted_by: "kofi",
        }),
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { cached } = await pipeline.runScreening("12-3456789");

    expect(cached).toBe(false);
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });

  it("respects custom cacheMaxAgeDays", async () => {
    const tier1Result = makeScreeningResult({ ein: "12-3456789" });
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const date10dAgo = daysAgo(10);
    const config = makeMockConfig({
      cacheMaxAgeDays: 7, // 7-day TTL
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue({
          result_json: JSON.stringify(tier1Result),
          vetted_at: date10dAgo,
          vetted_by: "kofi",
        }),
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { cached } = await pipeline.runScreening("12-3456789");

    // 10 days old > 7-day TTL → should re-vet
    expect(cached).toBe(false);
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });

  it("bypasses cache when forceRefresh is true", async () => {
    const tier1Result = makeScreeningResult({ ein: "12-3456789" });
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue({
          result_json: JSON.stringify(tier1Result),
          vetted_at: daysAgo(2), // fresh cache — would normally hit
          vetted_by: "kofi",
        }),
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { cached } = await pipeline.runScreening("12-3456789", {
      forceRefresh: true,
    });

    expect(cached).toBe(false);
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });

  it("persists result on success", async () => {
    const tier1Result = makeScreeningResult();
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const saveResult = vi.fn();
    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue(null),
        saveResult,
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    await pipeline.runScreening("12-3456789");

    expect(saveResult).toHaveBeenCalledWith(tier1Result);
  });

  it("does not throw when persistence fails", async () => {
    const tier1Result = makeScreeningResult();
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue(null),
        saveResult: vi.fn().mockImplementation(() => {
          throw new Error("SQLite write failed");
        }),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { response } = await pipeline.runScreening("12-3456789");

    // Should still return success despite persistence failure
    expect(response.success).toBe(true);
  });

  it("skips cache check when vettingStore is undefined", async () => {
    const tier1Result = makeScreeningResult();
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const config = makeMockConfig({
      vettingStore: undefined,
    });

    const pipeline = new VettingPipeline(config);
    await pipeline.runScreening("12-3456789");

    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });
});
