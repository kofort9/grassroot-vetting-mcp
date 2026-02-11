import { describe, it, expect, vi, beforeEach } from "vitest";
import { VettingPipeline } from "../src/domain/nonprofit/vetting-pipeline.js";
import { makeTier1Result } from "./fixtures.js";
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
    vettingStoreReady: true,
    ...overrides,
  };
}

describe("VettingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns fresh result on cache miss", async () => {
    const tier1Result = makeTier1Result({ ein: "12-3456789" });
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const config = makeMockConfig();
    const pipeline = new VettingPipeline(config);
    const { response, cached } = await pipeline.runTier1("12-3456789");

    expect(cached).toBe(false);
    expect(response.success).toBe(true);
    expect(response.data?.ein).toBe("12-3456789");
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });

  it("returns cached result on cache hit", async () => {
    const tier1Result = makeTier1Result({ ein: "12-3456789" });
    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue({
          result_json: JSON.stringify(tier1Result),
          vetted_at: "2026-01-15",
          vetted_by: "kofi",
        }),
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { response, cached, cachedNote } =
      await pipeline.runTier1("12-3456789");

    expect(cached).toBe(true);
    expect(response.success).toBe(true);
    expect(cachedNote).toContain("Previously vetted on 2026-01-15");
    expect(mockedCheckTier1).not.toHaveBeenCalled();
  });

  it("bypasses cache when forceRefresh is true", async () => {
    const tier1Result = makeTier1Result({ ein: "12-3456789" });
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const config = makeMockConfig({
      vettingStore: {
        getLatestByEin: vi.fn().mockReturnValue({
          result_json: JSON.stringify(tier1Result),
          vetted_at: "2026-01-15",
          vetted_by: "kofi",
        }),
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    const { cached } = await pipeline.runTier1("12-3456789", {
      forceRefresh: true,
    });

    expect(cached).toBe(false);
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });

  it("persists result on success", async () => {
    const tier1Result = makeTier1Result();
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
    await pipeline.runTier1("12-3456789");

    expect(saveResult).toHaveBeenCalledWith(tier1Result);
  });

  it("does not throw when persistence fails", async () => {
    const tier1Result = makeTier1Result();
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
    const { response } = await pipeline.runTier1("12-3456789");

    // Should still return success despite persistence failure
    expect(response.success).toBe(true);
  });

  it("skips cache check when vettingStoreReady is false", async () => {
    const tier1Result = makeTier1Result();
    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: tier1Result,
      attribution: "ProPublica Nonprofit Explorer API",
    });

    const getLatestByEin = vi.fn();
    const config = makeMockConfig({
      vettingStoreReady: false,
      vettingStore: {
        getLatestByEin,
        saveResult: vi.fn(),
      } as unknown as VettingPipelineConfig["vettingStore"],
    });

    const pipeline = new VettingPipeline(config);
    await pipeline.runTier1("12-3456789");

    expect(getLatestByEin).not.toHaveBeenCalled();
    expect(mockedCheckTier1).toHaveBeenCalledOnce();
  });
});
