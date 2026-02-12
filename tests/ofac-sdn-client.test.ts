import { describe, it, expect, vi } from "vitest";
import { OfacSdnClient } from "../src/domain/red-flags/ofac-sdn-client.js";
import { makeOfacRow, makeMockStore } from "./fixtures.js";

function makeClient(lookupReturn: ReturnType<typeof makeOfacRow>[] = []) {
  const store = makeMockStore();
  store.lookupName.mockReturnValue(lookupReturn);
  return { client: new OfacSdnClient(store as any), store };
}

describe("OfacSdnClient", () => {
  it("returns clean result when no matches", () => {
    const { client } = makeClient([]);
    const result = client.check("Clean Organization");
    expect(result.found).toBe(false);
    expect(result.matches).toEqual([]);
    expect(result.detail).toContain("No OFAC SDN matches");
  });

  it("returns match with primary matchedOn when name matches primary", () => {
    const row = makeOfacRow({ name: "BAD ACTOR FOUNDATION" });
    const { client } = makeClient([row]);
    const result = client.check("Bad Actor Foundation");
    expect(result.found).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedOn).toBe("primary");
    expect(result.matches[0].entNum).toBe(row.entNum);
    expect(result.matches[0].program).toBe(row.program);
  });

  it("returns match with alias matchedOn when name differs from primary", () => {
    // Row's primary name differs from the query — store returned it via alias map
    const row = makeOfacRow({ name: "DIFFERENT PRIMARY NAME" });
    const { client } = makeClient([row]);
    const result = client.check("Some Alias Name");
    expect(result.found).toBe(true);
    expect(result.matches[0].matchedOn).toBe("alias");
  });

  it("returns multiple matches", () => {
    const rows = [
      makeOfacRow({ entNum: "111", name: "MATCH ONE" }),
      makeOfacRow({ entNum: "222", name: "MATCH TWO" }),
    ];
    const { client } = makeClient(rows);
    const result = client.check("Something");
    expect(result.found).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.detail).toContain("2 sanctioned");
  });

  it("passes name through to store.lookupName", () => {
    const { client, store } = makeClient([]);
    client.check("Test Org Inc");
    expect(store.lookupName).toHaveBeenCalledWith("Test Org Inc");
  });
});

// ============================================================================
// fuzzyCheck
// ============================================================================

describe("OfacSdnClient.fuzzyCheck", () => {
  function makeFuzzyClient(
    fuzzyReturn: Array<{
      normalizedName: string;
      similarity: number;
      rows: ReturnType<typeof makeOfacRow>[];
    }> = [],
  ) {
    const store = makeMockStore();
    store.fuzzyLookupName = vi.fn().mockReturnValue(fuzzyReturn);
    return { client: new OfacSdnClient(store as any), store };
  }

  it("returns not found when no near-matches", () => {
    const { client } = makeFuzzyClient([]);
    const result = client.fuzzyCheck("Clean Org");
    expect(result.found).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("returns match with similarity score for Entity-type", () => {
    const { client } = makeFuzzyClient([
      {
        normalizedName: "bad actor foundaton",
        similarity: 0.92,
        rows: [makeOfacRow({ sdnType: "Entity" })],
      },
    ]);
    const result = client.fuzzyCheck("Bad Actor Foundation");
    expect(result.found).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].similarity).toBe(0.92);
  });

  it("filters out Individual-type matches (only Entity returned)", () => {
    const { client } = makeFuzzyClient([
      {
        normalizedName: "john doe",
        similarity: 0.90,
        rows: [makeOfacRow({ sdnType: "Individual", name: "JOHN DOE" })],
      },
    ]);
    const result = client.fuzzyCheck("John Doe Foundation");
    expect(result.found).toBe(false);
    expect(result.detail).toContain("Individual-type");
  });

  it("uses default threshold of 0.85", () => {
    const { client, store } = makeFuzzyClient([]);
    client.fuzzyCheck("Test Org");
    expect(store.fuzzyLookupName).toHaveBeenCalledWith("Test Org", 0.85);
  });

  it("accepts custom threshold", () => {
    const { client, store } = makeFuzzyClient([]);
    client.fuzzyCheck("Test Org", 0.90);
    expect(store.fuzzyLookupName).toHaveBeenCalledWith("Test Org", 0.90);
  });

  it("throws on invalid threshold (> 1.0)", () => {
    const { client } = makeFuzzyClient([]);
    expect(() => client.fuzzyCheck("Test Org", 1.5)).toThrow("Invalid OFAC fuzzy threshold");
  });

  it("throws on invalid threshold (< 0)", () => {
    const { client } = makeFuzzyClient([]);
    expect(() => client.fuzzyCheck("Test Org", -0.5)).toThrow("Invalid OFAC fuzzy threshold");
  });

  it("sorts matches by descending similarity", () => {
    const { client } = makeFuzzyClient([
      {
        normalizedName: "match a",
        similarity: 0.87,
        rows: [makeOfacRow({ entNum: "111", sdnType: "Entity", name: "MATCH A" })],
      },
      {
        normalizedName: "match b",
        similarity: 0.93,
        rows: [makeOfacRow({ entNum: "222", sdnType: "Entity", name: "MATCH B" })],
      },
    ]);
    const result = client.fuzzyCheck("Something");
    expect(result.matches[0].similarity).toBe(0.93);
    expect(result.matches[1].similarity).toBe(0.87);
  });
});
