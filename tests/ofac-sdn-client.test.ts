import { describe, it, expect } from "vitest";
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
