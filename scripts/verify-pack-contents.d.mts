export interface PublishEntry {
  files?: unknown;
}
export interface PublishEntryResolution {
  entry: PublishEntry | undefined;
  topLevelKeys: string[];
}
export declare function extractTrailingJson(output: string): unknown;
export declare function resolvePublishEntry(
  manifest: unknown,
  packageName: string,
): PublishEntryResolution;
export declare function checkPackedFiles(paths: string[]): string[];
export declare function hasBuiltDist(root: string): boolean;
export declare function runPackDryRun(): import('node:child_process').SpawnSyncReturns<string>;
