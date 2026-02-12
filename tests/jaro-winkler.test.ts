import { describe, it, expect } from "vitest";
import { jaroWinkler } from "../src/data-sources/jaro-winkler.js";

describe("jaroWinkler", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaroWinkler("hello", "hello")).toBe(1.0);
  });

  it("returns 0.0 for empty first string", () => {
    expect(jaroWinkler("", "hello")).toBe(0.0);
  });

  it("returns 0.0 for empty second string", () => {
    expect(jaroWinkler("hello", "")).toBe(0.0);
  });

  it("returns 0.0 for both empty strings", () => {
    expect(jaroWinkler("", "")).toBe(0.0); // empty strings are never a valid match
  });

  it('scores "martha"/"marhta" ≈ 0.961', () => {
    const score = jaroWinkler("martha", "marhta");
    expect(score).toBeCloseTo(0.961, 2);
  });

  it('scores "dwayne"/"duane" ≈ 0.840', () => {
    const score = jaroWinkler("dwayne", "duane");
    expect(score).toBeCloseTo(0.84, 2);
  });

  it("returns low score for completely different strings", () => {
    const score = jaroWinkler("abcdef", "zyxwvu");
    expect(score).toBeLessThan(0.5);
  });

  it("returns high score for single character difference in long string", () => {
    const score = jaroWinkler(
      "international relief foundation",
      "international releif foundation",
    );
    expect(score).toBeGreaterThan(0.95);
  });

  it("is symmetric", () => {
    const ab = jaroWinkler("dixon", "dicksonx");
    const ba = jaroWinkler("dicksonx", "dixon");
    expect(ab).toBeCloseTo(ba, 10);
  });

  it("gives winkler boost for shared prefix", () => {
    // "internat" shares 4-char prefix "inte" — should get winkler boost
    const withPrefix = jaroWinkler("international", "internasional");
    const noPrefix = jaroWinkler("ational", "asional");
    // Both have similar edit distance, but shared prefix boosts the first
    expect(withPrefix).toBeGreaterThan(noPrefix);
  });

  it("handles single character strings", () => {
    expect(jaroWinkler("a", "a")).toBe(1.0);
    expect(jaroWinkler("a", "b")).toBe(0.0);
  });
});
