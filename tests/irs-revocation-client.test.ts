import { describe, it, expect } from "vitest";
import { IrsRevocationClient } from "../src/domain/red-flags/irs-revocation-client.js";
import { makeIrsRow, makeMockStore } from "./fixtures.js";

function makeClient(lookupReturn?: ReturnType<typeof makeIrsRow>) {
  const store = makeMockStore();
  store.lookupEin.mockReturnValue(lookupReturn);
  return { client: new IrsRevocationClient(store as any), store };
}

describe("IrsRevocationClient", () => {
  // ---- EIN format validation ----

  it("rejects EIN with fewer than 9 digits", () => {
    const { client } = makeClient();
    const result = client.check("1234");
    expect(result.found).toBe(false);
    expect(result.revoked).toBe(false);
    expect(result.detail).toContain("Invalid EIN");
  });

  it("rejects EIN with letters", () => {
    const { client } = makeClient();
    const result = client.check("12-ABC6789");
    expect(result.found).toBe(false);
    expect(result.detail).toContain("Invalid EIN");
  });

  it("accepts EIN with dashes (12-3456789)", () => {
    const { client, store } = makeClient();
    client.check("12-3456789");
    expect(store.lookupEin).toHaveBeenCalledWith("123456789");
  });

  it("accepts bare 9-digit EIN", () => {
    const { client, store } = makeClient();
    client.check("123456789");
    expect(store.lookupEin).toHaveBeenCalledWith("123456789");
  });

  // ---- Not found ----

  it("returns clean result when EIN not found", () => {
    const { client } = makeClient(undefined);
    const result = client.check("123456789");
    expect(result.found).toBe(false);
    expect(result.revoked).toBe(false);
    expect(result.detail).toContain("not found");
  });

  // ---- Revoked ----

  it("returns revoked result when found without reinstatement", () => {
    const row = makeIrsRow({ reinstatementDate: "" });
    const { client } = makeClient(row);
    const result = client.check("123456789");
    expect(result.found).toBe(true);
    expect(result.revoked).toBe(true);
    expect(result.detail).toContain("REVOKED");
    expect(result.revocationDate).toBe(row.revocationDate);
    expect(result.legalName).toBe(row.legalName);
  });

  // ---- Reinstated ----

  it("returns reinstated result when reinstatement date present", () => {
    const row = makeIrsRow({
      reinstatementDate: "2023-01-10",
      revocationDate: "2022-05-15",
      legalName: "REINSTATED ORG",
    });
    const { client } = makeClient(row);
    const result = client.check("123456789");
    expect(result.found).toBe(true);
    expect(result.revoked).toBe(false);
    expect(result.detail).toContain("reinstated");
    expect(result.reinstatementDate).toBe("2023-01-10");
  });
});
