import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { ProPublicaClient } from "../src/domain/nonprofit/propublica-client.js";

// ============================================================================
// Mock axios
// ============================================================================

vi.mock("axios", () => {
  const mockGet = vi.fn();
  const mockInstance = {
    get: mockGet,
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: {
      create: vi.fn(() => mockInstance),
      isAxiosError: vi.fn((err: any) => err?.isAxiosError === true),
    },
  };
});

function getMockGet(): ReturnType<typeof vi.fn> {
  const instance = (axios.create as ReturnType<typeof vi.fn>).mock.results[0]
    ?.value;
  return instance?.get;
}

// ============================================================================
// Constructor
// ============================================================================

describe("ProPublicaClient constructor", () => {
  it("creates axios instance with correct config", () => {
    new ProPublicaClient({
      apiBaseUrl: "https://projects.propublica.org/nonprofits/api/v2",
      rateLimitMs: 500,
    });

    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://projects.propublica.org/nonprofits/api/v2",
        timeout: 30000,
      }),
    );
  });
});

// ============================================================================
// search
// ============================================================================

describe("ProPublicaClient.search", () => {
  let client: ProPublicaClient;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ProPublicaClient({
      apiBaseUrl: "https://projects.propublica.org/nonprofits/api/v2",
      rateLimitMs: 0, // No delay in tests
    });
    mockGet = getMockGet();
  });

  it("calls /search.json with query param", async () => {
    mockGet.mockResolvedValue({
      data: { total_results: 0, organizations: [] },
    });

    await client.search("food bank");

    expect(mockGet).toHaveBeenCalledWith("/search.json", {
      params: { q: "food bank" },
    });
  });

  it("includes state param when provided", async () => {
    mockGet.mockResolvedValue({
      data: { total_results: 0, organizations: [] },
    });

    await client.search("test", "ca");

    expect(mockGet).toHaveBeenCalledWith("/search.json", {
      params: { q: "test", state: "CA" },
    });
  });

  it("uppercases state parameter", async () => {
    mockGet.mockResolvedValue({
      data: { total_results: 0, organizations: [] },
    });

    await client.search("test", "ny");

    const callArgs = mockGet.mock.calls[0];
    expect(callArgs[1].params.state).toBe("NY");
  });

  it("filters results by city client-side (case-insensitive)", async () => {
    mockGet.mockResolvedValue({
      data: {
        total_results: 3,
        organizations: [
          {
            ein: 1,
            name: "Org A",
            city: "Los Angeles",
            state: "CA",
            ntee_code: null,
            ruling_date: "",
          },
          {
            ein: 2,
            name: "Org B",
            city: "San Francisco",
            state: "CA",
            ntee_code: null,
            ruling_date: "",
          },
          {
            ein: 3,
            name: "Org C",
            city: "los angeles",
            state: "CA",
            ntee_code: null,
            ruling_date: "",
          },
        ],
      },
    });

    const result = await client.search("test", undefined, "Los Angeles");

    expect(result.organizations).toHaveLength(2);
    expect(result.total_results).toBe(2);
  });

  it("returns empty results on 404", async () => {
    const error = { isAxiosError: true, response: { status: 404 } };
    mockGet.mockRejectedValue(error);
    (axios.isAxiosError as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await client.search("nonexistent");

    expect(result.total_results).toBe(0);
    expect(result.organizations).toEqual([]);
  });

  it("throws on non-404 errors", async () => {
    const error = { isAxiosError: true, response: { status: 500 } };
    mockGet.mockRejectedValue(error);
    (axios.isAxiosError as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await expect(client.search("test")).rejects.toEqual(error);
  });

  it("handles missing organizations array in response", async () => {
    mockGet.mockResolvedValue({
      data: { total_results: 0 },
    });

    const result = await client.search("test");
    expect(result.organizations).toEqual([]);
  });
});

// ============================================================================
// getOrganization
// ============================================================================

describe("ProPublicaClient.getOrganization", () => {
  let client: ProPublicaClient;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ProPublicaClient({
      apiBaseUrl: "https://projects.propublica.org/nonprofits/api/v2",
      rateLimitMs: 0,
    });
    mockGet = getMockGet();
  });

  it("normalizes EIN with dash", async () => {
    mockGet.mockResolvedValue({
      data: { organization: {}, filings_with_data: [] },
    });

    await client.getOrganization("95-3135649");

    expect(mockGet).toHaveBeenCalledWith("/organizations/953135649.json");
  });

  it("normalizes EIN with spaces", async () => {
    mockGet.mockResolvedValue({
      data: { organization: {}, filings_with_data: [] },
    });

    await client.getOrganization("95 3135649");

    expect(mockGet).toHaveBeenCalledWith("/organizations/953135649.json");
  });

  it("accepts plain 9-digit EIN", async () => {
    mockGet.mockResolvedValue({
      data: { organization: {}, filings_with_data: [] },
    });

    await client.getOrganization("953135649");

    expect(mockGet).toHaveBeenCalledWith("/organizations/953135649.json");
  });

  it("throws for EIN with too few digits", async () => {
    await expect(client.getOrganization("12345")).rejects.toThrow(
      "Invalid EIN format",
    );
  });

  it("throws for EIN with too many digits", async () => {
    await expect(client.getOrganization("1234567890")).rejects.toThrow(
      "Invalid EIN format",
    );
  });

  it("throws for EIN with letters (path injection prevention)", async () => {
    await expect(client.getOrganization("12-34/../../etc")).rejects.toThrow(
      "Invalid EIN format",
    );
  });

  it("throws for EIN with special characters", async () => {
    await expect(client.getOrganization("123%00789")).rejects.toThrow(
      "Invalid EIN format",
    );
  });

  it("returns null on 404", async () => {
    const error = { isAxiosError: true, response: { status: 404 } };
    mockGet.mockRejectedValue(error);
    (axios.isAxiosError as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await client.getOrganization("953135649");
    expect(result).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    const error = { isAxiosError: true, response: { status: 500 } };
    mockGet.mockRejectedValue(error);
    (axios.isAxiosError as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await expect(client.getOrganization("953135649")).rejects.toEqual(error);
  });

  it("returns response data on success", async () => {
    const orgData = {
      organization: { ein: 953135649, name: "Test" },
      filings_with_data: [],
    };
    mockGet.mockResolvedValue({ data: orgData });

    const result = await client.getOrganization("953135649");
    expect(result).toEqual(orgData);
  });
});
