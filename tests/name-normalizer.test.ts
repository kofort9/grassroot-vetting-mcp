import { describe, it, expect } from "vitest";
import { normalizeName } from "../src/data-sources/name-normalizer.js";

describe("normalizeName", () => {
  it("lowercases input", () => {
    expect(normalizeName("HELLO WORLD")).toBe("hello world");
  });

  it("strips diacritics via Unicode NFD", () => {
    expect(normalizeName("José García")).toBe("jose garcia");
    expect(normalizeName("Müller")).toBe("muller");
  });

  it("strips punctuation", () => {
    expect(normalizeName("Hello, World!")).toBe("hello world");
    expect(normalizeName("O'Brien & Associates")).toBe("obrien associates");
  });

  it('removes "the" prefix', () => {
    expect(normalizeName("The Red Cross")).toBe("red cross");
    expect(normalizeName("THE SALVATION ARMY")).toBe("salvation army");
  });

  it('does not remove "the" in the middle', () => {
    expect(normalizeName("Save the Children")).toBe("save the children");
  });

  it("strips trailing org suffixes", () => {
    expect(normalizeName("Acme Inc")).toBe("acme");
    expect(normalizeName("Acme Corporation")).toBe("acme");
    expect(normalizeName("Acme Foundation")).toBe("acme foundation");
    expect(normalizeName("Acme Ltd")).toBe("acme");
    expect(normalizeName("Acme LLC")).toBe("acme");
    expect(normalizeName("Acme Assoc")).toBe("acme");
    expect(normalizeName("Acme Organization")).toBe("acme");
    expect(normalizeName("Acme NFP")).toBe("acme");
  });

  it("strips stacked trailing suffixes iteratively", () => {
    expect(normalizeName("Acme Corp Inc")).toBe("acme");
    expect(normalizeName("Acme Inc Ltd")).toBe("acme");
  });

  it("does not strip suffixes that are mid-name", () => {
    // "Inc" in middle should stay — only trailing suffixes stripped
    expect(normalizeName("Inc Something")).toBe("inc something");
  });

  it("preserves semantic words like national, fund, trust", () => {
    expect(normalizeName("National Wildlife Fund")).toBe(
      "national wildlife fund",
    );
    expect(normalizeName("Community Trust")).toBe("community trust");
    expect(normalizeName("International Society")).toBe(
      "international society",
    );
  });

  it("collapses multiple spaces", () => {
    expect(normalizeName("Hello    World")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeName("  Hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(normalizeName("")).toBe("");
  });
});
