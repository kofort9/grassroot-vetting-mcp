import { describe, it, expect, vi, beforeEach } from "vitest";
import { VettingPipeline } from "../src/domain/nonprofit/vetting-pipeline.js";
import { makeTier1Result } from "./fixtures.js";
import type { VettingPipelineConfig } from "../src/domain/nonprofit/vetting-pipeline.js";
import type { Tier1Result, ToolResponse } from "../src/domain/nonprofit/types.js";

// Mock the tools module
vi.mock("../src/domain/nonprofit/tools.js", () => ({
  checkTier1: vi.fn(),
}));

vi.mock("../src/core/logging.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { checkTier1 } from "../src/domain/nonprofit/tools.js";

const mockedCheckTier1 = vi.mocked(checkTier1);

function makeMockConfig(): VettingPipelineConfig {
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
  };
}

describe("batch_tier1 via VettingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes multiple EINs sequentially", async () => {
    const eins = ["12-3456789", "98-7654321", "55-5555555"];

    mockedCheckTier1.mockImplementation(async (_client, input) => ({
      success: true,
      data: makeTier1Result({
        ein: input.ein,
        recommendation: input.ein === "55-5555555" ? "REVIEW" : "PASS",
        score: input.ein === "55-5555555" ? 60 : 85,
      }),
      attribution: "ProPublica Nonprofit Explorer API",
    }));

    const pipeline = new VettingPipeline(makeMockConfig());

    const results = [];
    const stats = { pass: 0, review: 0, reject: 0, error: 0, cached: 0 };

    for (const ein of eins) {
      const { response, cached } = await pipeline.runTier1(ein);
      if (cached) stats.cached++;
      if (response.success && response.data) {
        const rec = response.data.recommendation;
        if (rec === "PASS") stats.pass++;
        else if (rec === "REVIEW") stats.review++;
        else stats.reject++;
        results.push({ ein, recommendation: rec, cached });
      }
    }

    expect(results).toHaveLength(3);
    expect(stats.pass).toBe(2);
    expect(stats.review).toBe(1);
    expect(stats.reject).toBe(0);
    expect(mockedCheckTier1).toHaveBeenCalledTimes(3);
  });

  it("counts cached results in stats", async () => {
    const cachedResult = makeTier1Result({ ein: "12-3456789" });

    const config = makeMockConfig();
    (config.vettingStore.getLatestByEin as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        result_json: JSON.stringify(cachedResult),
        vetted_at: "2026-01-15",
        vetted_by: "kofi",
      })
      .mockReturnValueOnce(null);

    mockedCheckTier1.mockResolvedValue({
      success: true,
      data: makeTier1Result({ ein: "98-7654321" }),
      attribution: "test",
    });

    const pipeline = new VettingPipeline(config);

    const r1 = await pipeline.runTier1("12-3456789");
    const r2 = await pipeline.runTier1("98-7654321");

    expect(r1.cached).toBe(true);
    expect(r2.cached).toBe(false);
    expect(mockedCheckTier1).toHaveBeenCalledTimes(1); // only 1 uncached
  });

  it("handles errors gracefully for individual EINs", async () => {
    mockedCheckTier1
      .mockResolvedValueOnce({
        success: true,
        data: makeTier1Result({ ein: "12-3456789" }),
        attribution: "test",
      })
      .mockResolvedValueOnce({
        success: false,
        error: "Organization not found",
        attribution: "test",
      });

    const pipeline = new VettingPipeline(makeMockConfig());

    const r1 = await pipeline.runTier1("12-3456789");
    const r2 = await pipeline.runTier1("00-0000000");

    expect(r1.response.success).toBe(true);
    expect(r2.response.success).toBe(false);
    expect(r2.response.error).toBe("Organization not found");
  });
});
