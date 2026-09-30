export interface ReleaseGateViolation {
  id: string;
  message: string;
}
export declare function checkReleaseGate(text: string): ReleaseGateViolation[];
