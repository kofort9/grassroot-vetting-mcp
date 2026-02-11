import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  searchNonprofit,
  getNonprofitProfile,
  checkTier1,
  getRedFlags,
} from "../src/domain/nonprofit/tools.js";
import { ProPublicaClient } from "../src/domain/nonprofit/propublica-client.js";
import type {
  ProPublicaOrgDetailResponse,
  ProPublicaSearchResponse,
} from "../src/domain/nonprofit/types.js";
import {
  DEFAULT_THRESHOLDS,
  makeFiling,
  makeMockIrsClient,
  makeMockOfacClient,
  makePortfolioFitConfig,
} from "./fixtures.js";

// ============================================================================
// Mock ProPublicaClient
// ============================================================================

function makeMockClient() {
  return {
    search: vi.fn(),
    getOrganization: vi.fn(),
  } as unknown as ProPublicaClient;
}

function makeOrgResponse(
  overrides?: Partial<ProPublicaOrgDetailResponse>,
): ProPublicaOrgDetailResponse {
  return {
    organization: {
      ein: 953135649,
      name: "Test Nonprofit",
      city: "Los Angeles",
      state: "CA",
      ntee_code: "K31",
      subsection_code: 3,
      ruling_date: "2010-01-01",
    },
    filings_with_data: [makeFiling()],
    ...overrides,
  };
}

function makeSearchResponse(count = 2): ProPublicaSearchResponse {
  const orgs = [];
  for (let i = 0; i < count; i++) {
    orgs.push({
      ein: 953135649 + i,
      name: "Org " + (i + 1),
      city: "Los Angeles",
      state: "CA",
      ntee_code: "K31",
      subseccd: 3,
      ruling_date: "2010-01-01",
    });
  }
  return { total_results: count, organizations: orgs };
}

const t = DEFAULT_THRESHOLDS;

// ============================================================================
// searchNonprofit
// ============================================================================

describe("searchNonprofit", () => {
  let client: ProPublicaClient;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("returns error for empty query", async () => {
    const result = await searchNonprofit(client, { query: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns error for whitespace-only query", async () => {
    const result = await searchNonprofit(client, { query: "   " });
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns error for query exceeding max length", async () => {
    const result = await searchNonprofit(client, { query: "a".repeat(501) });
    expect(result.success).toBe(false);
    expect(result.error).toContain("too long");
  });

  it("returns error for state code > 2 characters", async () => {
    const result = await searchNonprofit(client, {
      query: "test",
      state: "CAL",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("2-letter");
  });

  it("returns error for city exceeding max length", async () => {
    const result = await searchNonprofit(client, {
      query: "test",
      city: "a".repeat(101),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("too long");
  });

  it("accepts valid 2-letter state code", async () => {
    (client.search as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSearchResponse(1),
    );
    const result = await searchNonprofit(client, {
      query: "test",
      state: "CA",
    });
    expect(result.success).toBe(true);
  });

  it("returns formatted search results on success", async () => {
    (client.search as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSearchResponse(2),
    );
    const result = await searchNonprofit(client, { query: "food bank" });

    expect(result.success).toBe(true);
    expect(result.data?.results).toHaveLength(2);
    expect(result.data?.results[0].ein).toMatch(/^\d{2}-\d{7}$/);
    expect(result.data?.total).toBe(2);
    expect(result.attribution).toContain("ProPublica");
  });

  it("always includes attribution even on error", async () => {
    const result = await searchNonprofit(client, { query: "" });
    expect(result.attribution).toContain("ProPublica");
  });

  it("handles client error gracefully", async () => {
    (client.search as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );
    const result = await searchNonprofit(client, { query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("handles non-Error thrown values", async () => {
    (client.search as ReturnType<typeof vi.fn>).mockRejectedValue(
      "string error",
    );
    const result = await searchNonprofit(client, { query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("string error");
  });
});

// ============================================================================
// getNonprofitProfile
// ============================================================================

describe("getNonprofitProfile", () => {
  let client: ProPublicaClient;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("returns error for missing EIN", async () => {
    const result = await getNonprofitProfile(client, { ein: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns error when organization not found", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    const result = await getNonprofitProfile(client, { ein: "12-3456789" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns profile on success", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOrgResponse(),
    );
    const result = await getNonprofitProfile(client, { ein: "95-3135649" });

    expect(result.success).toBe(true);
    expect(result.data?.ein).toBe("95-3135649");
    expect(result.data?.name).toBe("Test Nonprofit");
    expect(result.data?.latest_990).not.toBeNull();
  });

  it("detects non-03 subsection", async () => {
    const response = makeOrgResponse();
    response.organization.subsection_code = 6;
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await getNonprofitProfile(client, { ein: "95-3135649" });

    expect(result.data?.subsection).toBe("06");
  });

  it("handles org with no filings", async () => {
    const response = makeOrgResponse({ filings_with_data: [] });
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await getNonprofitProfile(client, { ein: "95-3135649" });

    expect(result.success).toBe(true);
    expect(result.data?.latest_990).toBeNull();
    expect(result.data?.filing_count).toBe(0);
  });

  it("handles org with no ruling date", async () => {
    const response = makeOrgResponse();
    response.organization.ruling_date = "";
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await getNonprofitProfile(client, { ein: "95-3135649" });

    expect(result.success).toBe(true);
    expect(result.data?.years_operating).toBeNull();
  });

  it("builds latest_990 from most recent filing", async () => {
    const response = makeOrgResponse({
      filings_with_data: [
        makeFiling({ tax_prd: 202106, totrevenue: 100_000 }),
        makeFiling({ tax_prd: 202306, totrevenue: 300_000 }),
        makeFiling({ tax_prd: 202206, totrevenue: 200_000 }),
      ],
    });
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await getNonprofitProfile(client, { ein: "95-3135649" });

    expect(result.data?.latest_990?.total_revenue).toBe(300_000);
    expect(result.data?.filing_count).toBe(3);
  });

  it("handles client error gracefully", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Timeout"),
    );
    const result = await getNonprofitProfile(client, { ein: "95-3135649" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout");
  });
});

// ============================================================================
// checkTier1
// ============================================================================

describe("checkTier1", () => {
  let client: ProPublicaClient;
  let irsClient: ReturnType<typeof makeMockIrsClient>;
  let ofacClient: ReturnType<typeof makeMockOfacClient>;

  beforeEach(() => {
    client = makeMockClient();
    irsClient = makeMockIrsClient();
    ofacClient = makeMockOfacClient();
  });

  it("returns error for missing EIN", async () => {
    const result = await checkTier1(
      client,
      { ein: "" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns error when organization not found", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    const result = await checkTier1(
      client,
      { ein: "12-3456789" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns Tier1Result on success", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOrgResponse(),
    );
    const result = await checkTier1(
      client,
      { ein: "95-3135649" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.ein).toBe("95-3135649");
    expect(result.data?.checks).toBeInstanceOf(Array);
    expect(result.data?.checks!.length).toBe(4);
    expect(result.data?.score).toBeTypeOf("number");
    expect(result.data?.recommendation).toMatch(/^(PASS|REVIEW|REJECT)$/);
    expect(result.data?.gates).toBeDefined();
    expect(result.data?.gate_blocked).toBe(false);
  });

  it("healthy org passes with default thresholds", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOrgResponse(),
    );
    const result = await checkTier1(
      client,
      { ein: "95-3135649" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );
    expect(result.data?.recommendation).toBe("PASS");
    expect(result.data?.score).toBeGreaterThanOrEqual(75);
  });

  it("includes summary in result", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOrgResponse(),
    );
    const result = await checkTier1(
      client,
      { ein: "95-3135649" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );
    expect(result.data?.summary).toBeDefined();
    expect(result.data?.summary.headline).toBeTypeOf("string");
    expect(result.data?.summary.key_factors).toBeInstanceOf(Array);
    expect(result.data?.summary.next_steps).toBeInstanceOf(Array);
  });

  it("returns gate-blocked result when gates fail", async () => {
    const response = makeOrgResponse();
    response.organization.subsection_code = 6; // Non-501(c)(3) → Gate 1 fail
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await checkTier1(
      client,
      { ein: "95-3135649" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );

    expect(result.success).toBe(true);
    expect(result.data?.gate_blocked).toBe(true);
    expect(result.data?.score).toBeNull();
    expect(result.data?.checks).toBeNull();
    expect(result.data?.recommendation).toBe("REJECT");
  });

  it("handles client error gracefully", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API down"),
    );
    const result = await checkTier1(
      client,
      { ein: "95-3135649" },
      t,
      irsClient as any,
      ofacClient as any,
      makePortfolioFitConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("API down");
  });
});

// ============================================================================
// getRedFlags
// ============================================================================

describe("getRedFlags", () => {
  let client: ProPublicaClient;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("returns error for missing EIN", async () => {
    const result = await getRedFlags(client, { ein: "" }, t);
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns error when organization not found", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    const result = await getRedFlags(client, { ein: "12-3456789" }, t);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns clean result for healthy org", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOrgResponse(),
    );
    const result = await getRedFlags(client, { ein: "95-3135649" }, t);

    expect(result.success).toBe(true);
    expect(result.data?.ein).toBe("95-3135649");
    expect(result.data?.clean).toBe(true);
    expect(result.data?.flags).toEqual([]);
  });

  it("detects red flags for problematic org", async () => {
    // Use stale 990 + very low revenue to trigger red flags (gate-handled flags removed)
    const response = makeOrgResponse({
      filings_with_data: [
        makeFiling({ tax_prd: 201806, tax_prd_yr: 2018, totrevenue: 5_000 }),
      ],
    });
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await getRedFlags(client, { ein: "95-3135649" }, t);

    expect(result.success).toBe(true);
    expect(result.data?.clean).toBe(false);
    expect(result.data?.flags.length).toBeGreaterThan(0);
  });

  it("each flag has severity, type, and detail", async () => {
    const response = makeOrgResponse({
      filings_with_data: [
        makeFiling({ tax_prd: 201806, tax_prd_yr: 2018, totrevenue: 5_000 }),
      ],
    });
    (client.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValue(
      response,
    );
    const result = await getRedFlags(client, { ein: "95-3135649" }, t);

    for (const flag of result.data!.flags) {
      expect(flag.severity).toMatch(/^(HIGH|MEDIUM)$/);
      expect(flag.type).toBeTypeOf("string");
      expect(flag.detail).toBeTypeOf("string");
    }
  });

  it("handles client error gracefully", async () => {
    (client.getOrganization as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("503"),
    );
    const result = await getRedFlags(client, { ein: "95-3135649" }, t);
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});
