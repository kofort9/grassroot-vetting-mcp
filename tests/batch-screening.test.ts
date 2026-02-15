import { describe, it, expect, vi, beforeEach } from "vitest";
import { VettingPipeline } from "../src/domain/nonprofit/vetting-pipeline.js";
import { makeScreeningResult } from "./fixtures.js";
import type { VettingPipelineConfig } from "../src/domain/nonprofit/vetting-pipeline.js";

// Mock the local screening module
vi.mock("../src/domain/nonprofit/tools.js", () => ({
  screenNonprofitLocal: vi.fn(),
}));

vi.mock("../src/core/logging.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { screenNonprofitLocal } from "../src/domain/nonprofit/tools.js";

const mockedScreenNonprofitLocal = vi.mocked(screenNonprofitLocal);

/** Returns an ISO datetime string N days in the past */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

const ATTRIBUTION = "Data provided by IRS BMF + GivingTuesday Data Commons (ODbL 1.0)";

function makeMockConfig(): VettingPipelineConfig {
  return {
    discoveryIndex: {} as VettingPipelineConfig["discoveryIndex"],
    givingTuesdayClient: {} as VettingPipelineConfig["givingTuesdayClient"],
    xml990Store: {} as VettingPipelineConfig["xml990Store"],
    concordance: {} as VettingPipelineConfig["concordance"],
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
  };
}

describe("batch_screening via VettingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes multiple EINs sequentially", async () => {
    const eins = ["12-3456789", "98-7654321", "55-5555555"];

    mockedScreenNonprofitLocal.mockImplementation(async (ein) => ({
      success: true,
      data: makeScreeningResult({
        ein,
        recommendation: ein === "55-5555555" ? "REVIEW" : "PASS",
        score: ein === "55-5555555" ? 60 : 85,
      }),
      attribution: ATTRIBUTION,
    }));

    const pipeline = new VettingPipeline(makeMockConfig());

    const results = [];
    const stats = { pass: 0, review: 0, reject: 0, error: 0, cached: 0 };

    for (const ein of eins) {
      const { response, cached } = await pipeline.runScreening(ein);
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
    expect(mockedScreenNonprofitLocal).toHaveBeenCalledTimes(3);
  });

  it("counts cached results in stats", async () => {
    const cachedResult = makeScreeningResult({ ein: "12-3456789" });

    const config = makeMockConfig();
    (config.vettingStore!.getLatestByEin as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        result_json: JSON.stringify(cachedResult),
        vetted_at: daysAgo(3),
        vetted_by: "kofi",
      })
      .mockReturnValueOnce(null);

    mockedScreenNonprofitLocal.mockResolvedValue({
      success: true,
      data: makeScreeningResult({ ein: "98-7654321" }),
      attribution: ATTRIBUTION,
    });

    const pipeline = new VettingPipeline(config);

    const r1 = await pipeline.runScreening("12-3456789");
    const r2 = await pipeline.runScreening("98-7654321");

    expect(r1.cached).toBe(true);
    expect(r2.cached).toBe(false);
    expect(mockedScreenNonprofitLocal).toHaveBeenCalledTimes(1); // only 1 uncached
  });

  it("handles errors gracefully for individual EINs", async () => {
    mockedScreenNonprofitLocal
      .mockResolvedValueOnce({
        success: true,
        data: makeScreeningResult({ ein: "12-3456789" }),
        attribution: ATTRIBUTION,
      })
      .mockResolvedValueOnce({
        success: false,
        error: "Organization not found",
        attribution: ATTRIBUTION,
      });

    const pipeline = new VettingPipeline(makeMockConfig());

    const r1 = await pipeline.runScreening("12-3456789");
    const r2 = await pipeline.runScreening("00-0000000");

    expect(r1.response.success).toBe(true);
    expect(r2.response.success).toBe(false);
    expect(r2.response.error).toBe("Organization not found");
  });
});
