import { describe, it, expect, vi } from "vitest";
import { checkVerified501c3 } from "../src/domain/gates/verified-501c3.js";
import { checkOfacSanctions } from "../src/domain/gates/ofac-sanctions.js";
import { checkFilingExists } from "../src/domain/gates/filing-exists.js";
import { runPreScreenGates } from "../src/domain/gates/gate-runner.js";
import {
  makeProfile,
  makeCleanIrsResult,
  makeRevokedIrsResult,
  makeCleanOfacResult,
  makeMatchedOfacResult,
  makePortfolioFitConfig,
  make990,
} from "./fixtures.js";

// ============================================================================
// Mock client factories
// ============================================================================

function makeMockIrsClient(revoked = false) {
  return {
    check: vi
      .fn()
      .mockReturnValue(revoked ? makeRevokedIrsResult() : makeCleanIrsResult()),
  };
}

function makeMockOfacClient(matched = false) {
  return {
    check: vi
      .fn()
      .mockReturnValue(
        matched ? makeMatchedOfacResult() : makeCleanOfacResult(),
      ),
  };
}

// ============================================================================
// Gate 1: Verified 501(c)(3)
// ============================================================================

describe("Gate 1: checkVerified501c3", () => {
  it("passes when all 3 sub-checks pass", () => {
    const profile = makeProfile({ subsection: "03", ruling_date: "2010-01-01" });
    const irsClient = makeMockIrsClient(false);

    const result = checkVerified501c3(profile, irsClient as any);
    expect(result.verdict).toBe("PASS");
    expect(result.sub_checks).toHaveLength(3);
    expect(result.sub_checks!.every((sc) => sc.passed)).toBe(true);
  });

  it("fails when subsection is not 03", () => {
    const profile = makeProfile({ subsection: "05" });
    const irsClient = makeMockIrsClient(false);

    const result = checkVerified501c3(profile, irsClient as any);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("501(c)(3) classification");
  });

  it("fails when IRS revocation is found", () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient(true);

    const result = checkVerified501c3(profile, irsClient as any);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("IRS revocation");
  });

  it("fails when ruling date is missing", () => {
    const profile = makeProfile({ ruling_date: "" });
    const irsClient = makeMockIrsClient(false);

    const result = checkVerified501c3(profile, irsClient as any);
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("IRS determination");
  });

  it("always runs all 3 sub-checks even when sub-check A fails", () => {
    const profile = makeProfile({ subsection: "05", ruling_date: "" });
    const irsClient = makeMockIrsClient(true);

    const result = checkVerified501c3(profile, irsClient as any);
    expect(result.verdict).toBe("FAIL");
    // All 3 sub-checks should be present (auditability)
    expect(result.sub_checks).toHaveLength(3);
    expect(result.sub_checks!.filter((sc) => !sc.passed)).toHaveLength(3);
  });
});

// ============================================================================
// Gate 2: OFAC Sanctions
// ============================================================================

describe("Gate 2: checkOfacSanctions", () => {
  it("passes when no OFAC matches", () => {
    const ofacClient = makeMockOfacClient(false);
    const result = checkOfacSanctions("Clean Org", ofacClient as any);
    expect(result.verdict).toBe("PASS");
  });

  it("fails when Entity-type match found", () => {
    const ofacClient = makeMockOfacClient(true);
    const result = checkOfacSanctions(
      "Bad Actor Foundation",
      ofacClient as any,
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.detail).toContain("Entity-type");
  });

  it("passes when only Individual-type matches found (false positive)", () => {
    const ofacClient = {
      check: vi.fn().mockReturnValue({
        found: true,
        detail: "OFAC match",
        matches: [
          {
            entNum: "99",
            name: "JOHN SMITH",
            sdnType: "Individual",
            program: "SDGT",
            matchedOn: "primary",
          },
        ],
      }),
    };

    const result = checkOfacSanctions(
      "John Smith Foundation",
      ofacClient as any,
    );
    expect(result.verdict).toBe("PASS");
    expect(result.detail).toContain("Individual-type");
    expect(result.detail).toContain("false positive");
  });
});

// ============================================================================
// Gate 3: Filing Exists
// ============================================================================

describe("Gate 3: checkFilingExists", () => {
  it("passes when filings exist", () => {
    const profile = makeProfile({ filing_count: 5, latest_990: make990() });
    const result = checkFilingExists(profile);
    expect(result.verdict).toBe("PASS");
    expect(result.detail).toContain("5 990 filing(s)");
  });

  it("fails when filing count is 0", () => {
    const profile = makeProfile({ filing_count: 0, latest_990: null });
    const result = checkFilingExists(profile);
    expect(result.verdict).toBe("FAIL");
  });

  it("fails when latest_990 is null even with filing_count > 0", () => {
    const profile = makeProfile({ filing_count: 3, latest_990: null });
    const result = checkFilingExists(profile);
    expect(result.verdict).toBe("FAIL");
  });
});

// ============================================================================
// Gate Runner (orchestration)
// ============================================================================

describe("runPreScreenGates", () => {
  const defaultFitConfig = makePortfolioFitConfig();

  it("returns all_passed when all gates pass", () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(false);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      defaultFitConfig,
    );
    expect(result.all_passed).toBe(true);
    expect(result.gates).toHaveLength(4);
    expect(result.blocking_gate).toBeUndefined();
  });

  it("Gate 1 failure still runs all gates for audit completeness", () => {
    const profile = makeProfile({ subsection: "05" });
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(false);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      defaultFitConfig,
    );
    expect(result.all_passed).toBe(false);
    expect(result.gates).toHaveLength(4);
    expect(result.blocking_gate).toBe("verified_501c3");
  });

  it("reports first failure as blocking_gate when multiple gates fail", () => {
    const profile = makeProfile({ subsection: "05", filing_count: 0, latest_990: null });
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(true);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      defaultFitConfig,
    );
    expect(result.all_passed).toBe(false);
    expect(result.gates).toHaveLength(4);
    // First failure is Gate 1
    expect(result.blocking_gate).toBe("verified_501c3");
    // But all 4 gates ran — Gate 2 and 3 also failed
    expect(result.gates[1].verdict).toBe("FAIL");
    expect(result.gates[2].verdict).toBe("FAIL");
  });

  it("Gate 2 failure still runs Gates 3 and 4 — gates array has length 4", () => {
    const profile = makeProfile();
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(true);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      defaultFitConfig,
    );
    expect(result.all_passed).toBe(false);
    expect(result.gates).toHaveLength(4);
    expect(result.blocking_gate).toBe("ofac_sanctions");
  });

  it("Gate 3 failure when no filings", () => {
    const profile = makeProfile({ filing_count: 0, latest_990: null });
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(false);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      defaultFitConfig,
    );
    expect(result.all_passed).toBe(false);
    expect(result.gates).toHaveLength(4);
    expect(result.blocking_gate).toBe("filing_exists");
  });

  it("Gate 4 can block when NTEE is outside portfolio scope", () => {
    const fitConfig = makePortfolioFitConfig({
      allowedNteeCategories: ["A", "B"],
    });
    const profile = makeProfile({ ntee_code: "Z99" });
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(false);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      fitConfig,
    );
    expect(result.all_passed).toBe(false);
    expect(result.gates).toHaveLength(4);
    expect(result.blocking_gate).toBe("portfolio_fit");
  });

  it("all 4 gates always run even when Gate 4 fails", () => {
    const fitConfig = makePortfolioFitConfig({
      allowedNteeCategories: [],
    });
    const profile = makeProfile({ ntee_code: "K31" });
    const irsClient = makeMockIrsClient(false);
    const ofacClient = makeMockOfacClient(false);

    const result = runPreScreenGates(
      profile,
      irsClient as any,
      ofacClient as any,
      fitConfig,
    );
    expect(result.gates).toHaveLength(4);
    expect(result.gates[0].verdict).toBe("PASS"); // 501c3
    expect(result.gates[1].verdict).toBe("PASS"); // OFAC
    expect(result.gates[2].verdict).toBe("PASS"); // filing
    expect(result.gates[3].verdict).toBe("FAIL"); // portfolio_fit
  });
});
