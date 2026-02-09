import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted() so mock references are available inside vi.mock() factories
const { mockGet, mockAxiosCreate } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockAxiosCreate = vi.fn(() => ({
    get: mockGet,
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  }));
  return { mockGet, mockAxiosCreate };
});

vi.mock("axios", () => ({
  default: {
    create: mockAxiosCreate,
    isAxiosError: (err: unknown) =>
      typeof err === "object" && err !== null && "isAxiosError" in err,
  },
}));

vi.mock("../../src/core/logging.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { CourtListenerClient } from "../src/domain/red-flags/courtlistener-client.js";
import type { RedFlagConfig } from "../src/core/config.js";

function makeConfig(overrides?: Partial<RedFlagConfig>): RedFlagConfig {
  return {
    courtlistenerApiToken: "test-token-123",
    courtlistenerBaseUrl: "https://www.courtlistener.com/api/rest/v4",
    courtlistenerRateLimitMs: 0, // No rate limiting in tests
    dataDir: "/tmp/test-data",
    dataMaxAgeDays: 7,
    ...overrides,
  };
}

function makeDocket(overrides?: Record<string, unknown>) {
  return {
    id: 1001,
    case_name: "Test Org v. State",
    court: "ca9",
    date_argued: "2024-06-01",
    date_filed: "2024-03-15",
    docket_number: "24-12345",
    absolute_url: "/docket/1001/test-org-v-state/",
    ...overrides,
  };
}

describe("CourtListenerClient", () => {
  let client: CourtListenerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new CourtListenerClient(makeConfig());
  });

  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  describe("construction", () => {
    it("creates axios client with correct base URL and auth header", () => {
      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "https://www.courtlistener.com/api/rest/v4",
          headers: expect.objectContaining({
            Authorization: "Token test-token-123",
          }),
          maxRedirects: 0,
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // searchByOrgName — success cases
  // --------------------------------------------------------------------------

  describe("searchByOrgName", () => {
    it("returns found=false when no results", async () => {
      mockGet.mockResolvedValue({
        data: { count: 0, next: null, previous: null, results: [] },
      });

      const result = await client.searchByOrgName("Clean Charity");
      expect(result.found).toBe(false);
      expect(result.caseCount).toBe(0);
      expect(result.cases).toEqual([]);
      expect(result.detail).toContain("Clean Charity");
    });

    it("returns found=true with mapped cases when results exist", async () => {
      mockGet.mockResolvedValue({
        data: {
          count: 2,
          next: null,
          previous: null,
          results: [
            makeDocket(),
            makeDocket({
              id: 1002,
              case_name: "Test Org v. County",
              absolute_url: "/docket/1002/test-org-v-county/",
            }),
          ],
        },
      });

      const result = await client.searchByOrgName("Test Org");
      expect(result.found).toBe(true);
      expect(result.caseCount).toBe(2);
      expect(result.cases).toHaveLength(2);
      expect(result.cases[0].caseName).toBe("Test Org v. State");
      expect(result.cases[0].absoluteUrl).toBe(
        "https://www.courtlistener.com/docket/1001/test-org-v-state/",
      );
    });

    it("handles missing fields gracefully (empty strings)", async () => {
      mockGet.mockResolvedValue({
        data: {
          count: 1,
          results: [
            {
              id: 999,
              case_name: "",
              court: "",
              date_argued: null,
              date_filed: null,
              docket_number: "",
              absolute_url: "",
            },
          ],
        },
      });

      const result = await client.searchByOrgName("Edge Case Org");
      expect(result.found).toBe(true);
      expect(result.cases[0].caseName).toBe("");
      expect(result.cases[0].absoluteUrl).toBe("");
    });

    it("passes correct query params including Solr-quoted name", async () => {
      mockGet.mockResolvedValue({
        data: { count: 0, results: [] },
      });

      await client.searchByOrgName("My Org", 3);

      expect(mockGet).toHaveBeenCalledWith("/search/", {
        params: expect.objectContaining({
          q: '"My Org"',
          type: "r",
          order_by: "dateFiled desc",
          page_size: 20,
        }),
      });
      // Verify lookback date is roughly 3 years ago
      const params = mockGet.mock.calls[0][1].params;
      const filedAfter = new Date(params.filed_after);
      const threeYearsAgo = new Date();
      threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
      const diffMs = Math.abs(filedAfter.getTime() - threeYearsAgo.getTime());
      expect(diffMs).toBeLessThan(86400000); // within 1 day
    });

    it("sanitizes Solr query syntax characters from name", async () => {
      mockGet.mockResolvedValue({
        data: { count: 0, results: [] },
      });

      await client.searchByOrgName('Org "Name" [with] +special: chars!');

      const calledQuery = mockGet.mock.calls[0][1].params.q;
      // Solr special chars should be stripped
      expect(calledQuery).not.toContain("[");
      expect(calledQuery).not.toContain("+");
      expect(calledQuery).not.toContain("!");
      expect(calledQuery).not.toContain(":");
      // But the org name text should remain
      expect(calledQuery).toContain("Org");
      expect(calledQuery).toContain("Name");
    });

    it("uses default lookbackYears of 1", async () => {
      mockGet.mockResolvedValue({
        data: { count: 0, results: [] },
      });

      await client.searchByOrgName("Default Lookback");

      const params = mockGet.mock.calls[0][1].params;
      const filedAfter = new Date(params.filed_after);
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const diffMs = Math.abs(filedAfter.getTime() - oneYearAgo.getTime());
      expect(diffMs).toBeLessThan(86400000);
    });

    it("uses totalCount from response, not results.length", async () => {
      // API returns count=15 but only 5 results on page 1
      mockGet.mockResolvedValue({
        data: {
          count: 15,
          next: "https://courtlistener.com/api/rest/v4/search/?page=2",
          results: Array.from({ length: 5 }, (_, i) =>
            makeDocket({ id: 2000 + i }),
          ),
        },
      });

      const result = await client.searchByOrgName("Big Case Org");
      expect(result.caseCount).toBe(15);
      expect(result.cases).toHaveLength(5);
    });
  });

  // --------------------------------------------------------------------------
  // searchByOrgName — error handling
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws on 401 (invalid token)", async () => {
      const error = Object.assign(new Error("Unauthorized"), {
        isAxiosError: true,
        response: { status: 401, data: "Invalid token" },
        config: { url: "/search/" },
      });
      mockGet.mockRejectedValue(error);

      await expect(client.searchByOrgName("Any Org")).rejects.toThrow(
        "CourtListener API token is invalid or expired",
      );
    });

    it("returns graceful result on 429 (rate limit)", async () => {
      const error = Object.assign(new Error("Too Many Requests"), {
        isAxiosError: true,
        response: { status: 429, data: "Rate limit exceeded" },
        config: { url: "/search/" },
      });
      mockGet.mockRejectedValue(error);

      const result = await client.searchByOrgName("Rate Limited Org");
      expect(result.found).toBe(false);
      expect(result.detail).toContain("rate limit");
      expect(result.caseCount).toBe(0);
    });

    it("re-throws non-axios errors", async () => {
      mockGet.mockRejectedValue(new TypeError("Network failure"));

      await expect(client.searchByOrgName("Any Org")).rejects.toThrow(
        "Network failure",
      );
    });

    it("re-throws unknown axios errors (e.g., 500)", async () => {
      const error = Object.assign(new Error("Internal Server Error"), {
        isAxiosError: true,
        response: { status: 500, data: "Server Error" },
        config: { url: "/search/" },
      });
      mockGet.mockRejectedValue(error);

      await expect(client.searchByOrgName("Any Org")).rejects.toThrow(
        "Internal Server Error",
      );
    });
  });
});
