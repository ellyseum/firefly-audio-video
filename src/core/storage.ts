/**
 * The storage seam DGR's URL-only contract depends on. DGR reads every input —
 * the template, its assets, a staged `.epr` — from an http(s) URL, and writes
 * every output to a presigned write URL. A {@link StorageProvider} is how the
 * SDK turns local bytes into a URL DGR can read, and how it obtains an output
 * slot DGR can write to and a caller can read back. One implementation per
 * storage platform; the client uses one only when an input actually needs it.
 */

import type { Readable } from 'node:stream';

/**
 * Anything a {@link StorageProvider} can stage: a `Buffer`, a `Readable`, a
 * `URL`, or a string (a local file path).
 */
export type StageInput = Buffer | Readable | URL | string;

/**
 * Stages inputs for DGR to read and allocates the locations DGR writes its
 * outputs to. The client calls {@link StorageProvider.stageRead} for a
 * generated `.epr` and {@link StorageProvider.allocateOutput} for a fluent
 * render's output; `stage()` hands its input straight to `stageRead`.
 *
 * @example
 * ```ts
 * const storage: StorageProvider = {
 *   async stageRead(input, opts) {
 *     const key = opts?.key ?? `staged/${randomUUID()}`;
 *     await upload(key, input, opts?.contentType);
 *     return presign(key, 'read', opts?.expiresIn);
 *   },
 *   async allocateOutput(opts) {
 *     const key = opts?.key ?? `out/${randomUUID()}`;
 *     return { writeUrl: presign(key, 'write'), readUrl: presign(key, 'read') };
 *   },
 * };
 * configure({ clientId, clientSecret, storage });
 * ```
 */
export interface StorageProvider {
  /**
   * Uploads `input` and resolves with a presigned URL DGR can read it from.
   *
   * @param input - The bytes to stage; see {@link StageInput}.
   * @param opts - `key` names the stored object, `contentType` labels it, and
   *   `expiresIn` (seconds) bounds how long the returned URL stays valid.
   * @returns A presigned read URL for the staged object.
   */
  stageRead(
    input: StageInput,
    opts?: { key?: string; contentType?: string; expiresIn?: number },
  ): Promise<string>;
  /**
   * Allocates one output location: DGR `PUT`s the rendered file to `writeUrl`,
   * and the finished asset is read back from `readUrl` — two URLs for the same
   * stored object.
   *
   * @param opts - `key` names the stored object and `expiresIn` (seconds)
   *   bounds how long both URLs stay valid.
   * @returns The write URL DGR renders into and the read URL the asset is read from.
   */
  allocateOutput(opts?: {
    key?: string;
    expiresIn?: number;
  }): Promise<{ writeUrl: string; readUrl: string }>;
}
