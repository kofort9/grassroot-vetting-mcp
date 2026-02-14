import { describe, it, expect, vi, beforeEach } from "vitest";
import { getToolDefinitions } from "../src/server/nonprofit-tools.js";
import { makeScreeningResult } from "./fixtures.js";
import type { ServerContext } from "../src/server/context.js";
import type { ToolDefinition } from "../src/server/tool-registry.js";

vi.mock("../src/core/logging.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function parseResponse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function findTool(name: string): ToolDefinition {
  const tools = getToolDefinitions();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function makeMockCtx(
  overrides?: Partial<ServerContext>,
): ServerContext {
  return {
    config: { thresholds: {} } as ServerContext["config"],
    propublicaClient: {} as ServerContext["propublicaClient"],
    dataStore: {} as ServerContext["dataStore"],
    irsClient: {} as ServerContext["irsClient"],
    ofacClient: {} as ServerContext["ofacClient"],
    courtClient: undefined,
    vettingStore: {} as ServerContext["vettingStore"],
    vettingPipeline: {
      runScreening: vi.fn(),
    } as unknown as ServerContext["vettingPipeline"],
    searchHistoryStore: {
      logSearch: vi.fn(),
    } as unknown as ServerContext["searchHistoryStore"],
    discoveryIndex: {} as ServerContext["discoveryIndex"],
    discoveryPipeline: {} as ServerContext["discoveryPipeline"],
    discoveryReady: true,
    ...overrides,
  } as ServerContext;
}

describe("batch_screening handler", () => {
  let tool: ToolDefinition;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = findTool("batch_screening");
  });

  it("rejects empty eins array", async () => {
    const ctx = makeMockCtx();
    const result = await tool.handler({ eins: [] }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/eins array is required/);
  });

  it("rejects non-array eins (single string)", async () => {
    const ctx = makeMockCtx();
    const result = await tool.handler({ eins: "12-3456789" }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/eins array is required/);
  });

  it("rejects more than 25 EINs", async () => {
    const ctx = makeMockCtx();
    const eins = Array.from({ length: 26 }, (_, i) =>
      `${String(i).padStart(2, "0")}-0000000`,
    );
    const result = await tool.handler({ eins }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/Too many EINs/);
    expect(parsed.error).toContain("26");
  });

  it("returns compact output by default", async () => {
    const ctx = makeMockCtx();
    const mockRunTier1 = vi.mocked(ctx.vettingPipeline.runScreening);
    mockRunTier1.mockResolvedValueOnce({
      response: {
        success: true,
        data: makeScreeningResult({ ein: "12-3456789", recommendation: "PASS", score: 85 }),
        attribution: "test",
      },
      cached: false,
      cachedNote: undefined,
    });

    const result = await tool.handler({ eins: ["12-3456789"] }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(false);
    expect(parsed.data.results[0].result).toHaveProperty("recommendation");
    expect(parsed.data.results[0].result).toHaveProperty("flags");
    // Compact output should NOT have gates or checks
    expect(parsed.data.results[0].result).not.toHaveProperty("gates");
    expect(parsed.data.results[0].result).not.toHaveProperty("checks");
  });

  it("returns verbose output when verbose=true", async () => {
    const ctx = makeMockCtx();
    const mockRunTier1 = vi.mocked(ctx.vettingPipeline.runScreening);
    mockRunTier1.mockResolvedValueOnce({
      response: {
        success: true,
        data: makeScreeningResult({ ein: "12-3456789" }),
        attribution: "test",
      },
      cached: false,
      cachedNote: undefined,
    });

    const result = await tool.handler({ eins: ["12-3456789"], verbose: true }, ctx);
    const parsed = parseResponse(result);

    // Verbose should include full ScreeningResult fields
    expect(parsed.data.results[0].result).toHaveProperty("gates");
    expect(parsed.data.results[0].result).toHaveProperty("checks");
  });

  it("aggregates stats correctly across mixed results", async () => {
    const ctx = makeMockCtx();
    const mockRunTier1 = vi.mocked(ctx.vettingPipeline.runScreening);

    mockRunTier1
      .mockResolvedValueOnce({
        response: {
          success: true,
          data: makeScreeningResult({ ein: "11-1111111", recommendation: "PASS" }),
          attribution: "test",
        },
        cached: true,
        cachedNote: "Cached from 2026-01-15",
      })
      .mockResolvedValueOnce({
        response: {
          success: true,
          data: makeScreeningResult({ ein: "22-2222222", recommendation: "REVIEW", score: 60 }),
          attribution: "test",
        },
        cached: false,
        cachedNote: undefined,
      })
      .mockResolvedValueOnce({
        response: {
          success: true,
          data: makeScreeningResult({ ein: "33-3333333", recommendation: "REJECT", score: 30, passed: false }),
          attribution: "test",
        },
        cached: false,
        cachedNote: undefined,
      })
      .mockResolvedValueOnce({
        response: {
          success: false,
          error: "Organization not found",
          attribution: "test",
        },
        cached: false,
        cachedNote: undefined,
      });

    const result = await tool.handler({
      eins: ["11-1111111", "22-2222222", "33-3333333", "44-4444444"],
    }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(false);
    expect(parsed.data.total).toBe(4);
    expect(parsed.data.stats).toEqual({
      pass: 1,
      review: 1,
      reject: 1,
      error: 1,
      cached: 1,
    });
    expect(parsed.data.results).toHaveLength(4);
    expect(parsed.data.results[3].error).toBe("Organization not found");
  });

  it("wraps thrown errors per-EIN without crashing the batch", async () => {
    const ctx = makeMockCtx();
    const mockRunTier1 = vi.mocked(ctx.vettingPipeline.runScreening);

    mockRunTier1
      .mockResolvedValueOnce({
        response: {
          success: true,
          data: makeScreeningResult({ ein: "11-1111111" }),
          attribution: "test",
        },
        cached: false,
        cachedNote: undefined,
      })
      .mockRejectedValueOnce(new Error("Network timeout"));

    const result = await tool.handler({
      eins: ["11-1111111", "22-2222222"],
    }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(false); // batch itself succeeds
    expect(parsed.data.stats.pass).toBe(1);
    expect(parsed.data.stats.error).toBe(1);
    expect(parsed.data.results[1].error).toBe("Network timeout");
    expect(parsed.data.results[1].result).toBeNull();
  });
});

describe("screen_nonprofit handler error ordering", () => {
  let tool: ToolDefinition;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = findTool("screen_nonprofit");
  });

  it("returns error response when pipeline returns success=false", async () => {
    const ctx = makeMockCtx();
    const mockRunTier1 = vi.mocked(ctx.vettingPipeline.runScreening);
    mockRunTier1.mockResolvedValueOnce({
      response: {
        success: false,
        error: "Organization not found",
        attribution: "ProPublica Nonprofit Explorer API",
      },
      cached: false,
      cachedNote: undefined,
    });

    const result = await tool.handler({ ein: "00-0000000" }, ctx);
    const parsed = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Organization not found");
  });

  it("returns error when response has error string even if success is true", async () => {
    const ctx = makeMockCtx();
    const mockRunTier1 = vi.mocked(ctx.vettingPipeline.runScreening);
    mockRunTier1.mockResolvedValueOnce({
      response: {
        success: true,
        error: "Partial failure: court records unavailable",
        data: makeScreeningResult({ ein: "12-3456789" }),
        attribution: "test",
      },
      cached: false,
      cachedNote: undefined,
    });

    const result = await tool.handler({ ein: "12-3456789" }, ctx);
    const parsed = parseResponse(result);

    // Error field takes priority — defensive behavior
    expect(result.isError).toBe(true);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Partial failure: court records unavailable");
  });
});
