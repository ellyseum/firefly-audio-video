export interface ReleaseGateViolation {
  id: string;
  message: string;
}
export declare const VERSION_FILE: string;
export declare function checkReleaseGate(text: string): ReleaseGateViolation[];
