export type GateVerdict = "PASS" | "FAIL";

export interface GateSubCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface GateCheckResult {
  gate: string;
  verdict: GateVerdict;
  detail: string;
  sub_checks?: GateSubCheck[];
}

export interface GateLayerResult {
  all_passed: boolean;
  gates: GateCheckResult[];
  blocking_gate?: string;
}
