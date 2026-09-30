/**
 * {@link S3StorageProvider}: staging through an Amazon S3 bucket
 * (`@aws-sdk/client-s3` with `@aws-sdk/s3-request-presigner`).
 */

import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { httpUrlOf, type StageInput, type StorageProvider } from '../core/storage.js';
import { exportOf, loadPeer, type Peer } from './peer.js';
import {
  OUTPUT_EXPIRY_SECONDS,
  READ_EXPIRY_SECONDS,
  adapterError,
  checkExpiry,
  invalidOption,
  keyPrefix,
  objectKey,
  readAll,
  uploadBody,
  type UploadBody,
} from './shared.js';

/** Static AWS credentials: an access key pair, plus the session token temporary credentials come with. */
export interface S3Credentials {
  /** The access key ID. */
  accessKeyId: string;
  /** The secret access key. */
  secretAccessKey: string;
  /** The session token of temporary credentials. */
  sessionToken?: string;
}

/** The part of an `S3Client` {@link S3StorageProvider} calls, and hands to `getSignedUrl`. */
export interface S3ClientLike {
  /** Sends one command; this provider sends `PutObjectCommand`. */
  send(command: object): Promise<unknown>;
}

/** The part of the `@aws-sdk/client-s3` module {@link S3StorageProvider} calls. */
export interface S3ClientModule {
  /** The client class, used when no `client` is given. */
  S3Client: new (config: {
    region?: string;
    credentials?: S3Credentials;
    requestChecksumCalculation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  }) => S3ClientLike;
  /** The upload command, sent for a staged input and presigned for an output's write URL. */
  PutObjectCommand: new (input: {
    Bucket: string;
    Key: string;
    Body?: Buffer | Readable;
    ContentType?: string;
    ContentLength?: number;
  }) => object;
  /** The read command, presigned for every read URL. */
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => object;
}

/** The part of the `@aws-sdk/s3-request-presigner` module {@link S3StorageProvider} calls. */
export interface S3PresignerModule {
  /** Presigns `command` with `client`'s credentials for `options.expiresIn` seconds. */
  getSignedUrl(
    client: S3ClientLike,
    command: object,
    options?: { expiresIn?: number },
  ): Promise<string>;
}

/** Options for {@link S3StorageProvider}. */
export interface S3StorageProviderOptions {
  /** The bucket every object is written to. */
  bucket: string;
  /**
   * The bucket's region, for the client this provider builds. Defaults to
   * the AWS SDK's own resolution (`AWS_REGION`, the shared config). Unused
   * when `client` is given.
   */
  region?: string;
  /**
   * Static credentials for the client this provider builds; never logged or
   * thrown. Defaults to the AWS SDK's own credential chain (the environment,
   * the shared config files, an instance or task role). Unused when `client`
   * is given.
   */
  credentials?: S3Credentials;
  /**
   * A configured `S3Client` to use instead of building one — for a
   * credential provider, a profile or an S3-compatible endpoint. Create it
   * with `requestChecksumCalculation: 'WHEN_REQUIRED'`: otherwise the SDK
   * signs every presigned PUT with a checksum of the empty body it presigns,
   * which no rendered file matches, and this provider refuses the write URL
   * it would produce.
   */
  client?: S3ClientLike;
  /**
   * Every key this provider writes goes under this prefix; a missing trailing
   * `/` is added. Defaults to `'firefly-audio-video/'`.
   */
  prefix?: string;
  /**
   * Seconds every URL this provider returns stays valid, from 1 to 604800
   * (seven days, the limit of a SigV4 presigned URL; temporary credentials
   * end it sooner). Defaults to one hour for a staged input and 24 hours for
   * an output, whose URLs must outlive the render and the download after it.
   */
  expiresIn?: number;
  /**
   * The `@aws-sdk/client-s3` module, used instead of importing it at run
   * time. Pass it, with `presigner`, in bundled code, where a run-time import
   * cannot find the package.
   */
  s3?: S3ClientModule;
  /** The `@aws-sdk/s3-request-presigner` module, used instead of importing it at run time. */
  presigner?: S3PresignerModule;
}

const NAME = 'S3StorageProvider';

const INSTALL = 'npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner';

const S3_PEER: Peer = {
  specifier: '@aws-sdk/client-s3',
  provider: NAME,
  install: INSTALL,
  option: 's3',
};

const PRESIGNER_PEER: Peer = {
  specifier: '@aws-sdk/s3-request-presigner',
  provider: NAME,
  install: INSTALL,
  option: 'presigner',
};

/** The longest lifetime a SigV4 presigned URL can have, in seconds. */
const MAX_EXPIRY_SECONDS = 604_800;

/** The SDK calls this provider makes, loaded once. */
interface S3Sdk {
  readonly client: S3ClientLike;
  readonly PutObjectCommand: S3ClientModule['PutObjectCommand'];
  readonly GetObjectCommand: S3ClientModule['GetObjectCommand'];
  readonly getSignedUrl: S3PresignerModule['getSignedUrl'];
}

/**
 * Stages through an Amazon S3 bucket:
 *
 * - `stageRead` uploads the input with `PutObject`, then presigns a `GET` of
 *   the object and returns that URL.
 * - `allocateOutput` presigns a `PUT` and a `GET` of one object: DGR renders
 *   into the first, and the asset is read from the second.
 *
 * Every key goes under `prefix` plus a unique name. `@aws-sdk/client-s3` and
 * `@aws-sdk/s3-request-presigner` are optional peer dependencies, imported
 * the first time this provider stages or allocates. The client it builds
 * uses `credentials` when given, else the SDK's default credential chain,
 * and `requestChecksumCalculation: 'WHEN_REQUIRED'`: its presigned `PUT`
 * URLs carry no checksum a rendered file would have to match, and its own
 * uploads are one plain `PUT` of the bytes with their length. A write URL
 * that demands a checksum — from a `client` built without that setting — is
 * refused.
 *
 * The credentials never appear in an error this provider throws, nor in any
 * printed form of it. A `Readable` is read into memory before its upload,
 * which needs the length first; stage a large file by its path instead,
 * which streams from disk.
 *
 * @example
 * ```ts
 * configure({
 *   clientId,
 *   clientSecret,
 *   storage: new S3StorageProvider({ bucket: 'renders', region: 'us-east-1' }),
 * });
 * ```
 */
export class S3StorageProvider implements StorageProvider {
  readonly #bucket: string;
  readonly #region: string | undefined;
  readonly #credentials: S3Credentials | undefined;
  readonly #secrets: readonly string[];
  readonly #client: S3ClientLike | undefined;
  readonly #prefix: string;
  readonly #expiresIn: number | undefined;
  readonly #s3: S3ClientModule | undefined;
  readonly #presigner: S3PresignerModule | undefined;
  #sdk: Promise<S3Sdk> | undefined;

  /**
   * @param options - See {@link S3StorageProviderOptions}.
   * @throws {@link AudioVideoError} `invalid_argument` for an invalid option.
   *   Nothing is imported until the first call.
   */
  constructor(options: S3StorageProviderOptions) {
    if (options === null || typeof options !== 'object') {
      throw invalidOption(`${NAME} expects an options object with a bucket.`);
    }
    const { bucket, region, credentials, client, prefix, expiresIn, s3, presigner } = options;
    if (typeof bucket !== 'string' || bucket.trim() === '') {
      throw invalidOption(`${NAME}: bucket must be a non-empty string.`);
    }
    if (region !== undefined && (typeof region !== 'string' || region.trim() === '')) {
      throw invalidOption(`${NAME}: region must be a non-empty string when provided.`);
    }
    if (client !== undefined && typeof client?.send !== 'function') {
      throw invalidOption(`${NAME}: client must be an S3Client, with send().`);
    }
    this.#bucket = bucket.trim();
    this.#region = region?.trim();
    this.#credentials = credentials === undefined ? undefined : checkCredentials(credentials);
    this.#secrets = Object.values(this.#credentials ?? {});
    this.#client = client;
    this.#prefix = keyPrefix(prefix, NAME);
    this.#expiresIn = expiresIn === undefined ? undefined : this.#checkExpiry(expiresIn);
    this.#s3 = s3;
    this.#presigner = presigner;
  }

  /**
   * Uploads `input` to a new object — or the object `opts.key` names under
   * the prefix — and resolves with a presigned URL DGR can read it from.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for an input that is
   *   not a local file, a `Buffer` or a `Readable`, or an invalid option;
   *   `missing_peer_dependency` when an AWS SDK package cannot be imported;
   *   `storage_failed` when the upload or presigning fails.
   */
  async stageRead(
    input: StageInput,
    opts: { key?: string; contentType?: string; expiresIn?: number } = {},
  ): Promise<string> {
    const body = await uploadBody(input, NAME);
    const key = objectKey(this.#prefix, opts.key, 'staged', body);
    const expiresIn = this.#expiry(opts.expiresIn, READ_EXPIRY_SECONDS);
    const contentType = checkContentType(opts.contentType);
    const sdk = await this.#load();
    await this.#upload(sdk, key, body, contentType);
    return this.#presign(sdk, 'GET', key, expiresIn);
  }

  /**
   * Presigns a `PUT` and a `GET` of one new object — or the object `opts.key`
   * names under the prefix.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for an invalid option,
   *   or a `client` whose presigned `PUT` demands a checksum;
   *   `missing_peer_dependency` when an AWS SDK package cannot be imported;
   *   `storage_failed` when presigning fails.
   */
  async allocateOutput(
    opts: { key?: string; expiresIn?: number } = {},
  ): Promise<{ writeUrl: string; readUrl: string }> {
    const key = objectKey(this.#prefix, opts.key, 'outputs');
    const expiresIn = this.#expiry(opts.expiresIn, OUTPUT_EXPIRY_SECONDS);
    const sdk = await this.#load();
    const writeUrl = await this.#presign(sdk, 'PUT', key, expiresIn);
    refuseChecksum(writeUrl);
    const readUrl = await this.#presign(sdk, 'GET', key, expiresIn);
    return { writeUrl, readUrl };
  }

  /** The SDK, imported and the client built on first use — again after a failed attempt. */
  #load(): Promise<S3Sdk> {
    this.#sdk ??= this.#import().catch((error: unknown) => {
      this.#sdk = undefined;
      throw error;
    });
    return this.#sdk;
  }

  async #import(): Promise<S3Sdk> {
    const s3 = this.#s3 ?? (await loadPeer(S3_PEER));
    const presigner = this.#presigner ?? (await loadPeer(PRESIGNER_PEER));
    const S3Client = functionExport(s3, 'S3Client', S3_PEER) as S3ClientModule['S3Client'];
    const PutObjectCommand = functionExport(
      s3,
      'PutObjectCommand',
      S3_PEER,
    ) as S3ClientModule['PutObjectCommand'];
    const GetObjectCommand = functionExport(
      s3,
      'GetObjectCommand',
      S3_PEER,
    ) as S3ClientModule['GetObjectCommand'];
    const getSignedUrl = functionExport(
      presigner,
      'getSignedUrl',
      PRESIGNER_PEER,
    ) as S3PresignerModule['getSignedUrl'];
    let client = this.#client;
    if (client === undefined) {
      try {
        client = new S3Client({
          ...(this.#region !== undefined ? { region: this.#region } : {}),
          ...(this.#credentials !== undefined ? { credentials: { ...this.#credentials } } : {}),
          requestChecksumCalculation: 'WHEN_REQUIRED',
        });
      } catch (error) {
        throw adapterError('Creating the S3 client failed', error, this.#secrets);
      }
    }
    return { client, PutObjectCommand, GetObjectCommand, getSignedUrl };
  }

  /** Sends a `PutObject` of `body` to `key`; a file stream is closed however the upload ends. */
  async #upload(
    sdk: S3Sdk,
    key: string,
    body: UploadBody,
    contentType: string | undefined,
  ): Promise<void> {
    const payload = await putPayload(body);
    try {
      await sdk.client.send(
        new sdk.PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...payload,
          ...(contentType !== undefined ? { ContentType: contentType } : {}),
        }),
      );
    } catch (error) {
      throw adapterError('Uploading the object to S3 failed', error, this.#secrets);
    } finally {
      if (!Buffer.isBuffer(payload.Body)) payload.Body.destroy();
    }
  }

  /** A presigned `method` URL of `key`. */
  async #presign(
    sdk: S3Sdk,
    method: 'GET' | 'PUT',
    key: string,
    expiresIn: number,
  ): Promise<string> {
    let url: unknown;
    try {
      const object = { Bucket: this.#bucket, Key: key };
      const command =
        method === 'PUT' ? new sdk.PutObjectCommand(object) : new sdk.GetObjectCommand(object);
      url = await sdk.getSignedUrl(sdk.client, command, { expiresIn });
    } catch (error) {
      throw adapterError(`Presigning a ${method} of the object failed`, error, this.#secrets);
    }
    if (typeof url !== 'string' || httpUrlOf(url) === undefined) {
      throw adapterError(`getSignedUrl() resolved without an http(s) URL for the ${method}`);
    }
    return url;
  }

  #expiry(value: number | undefined, fallback: number): number {
    return value === undefined ? (this.#expiresIn ?? fallback) : this.#checkExpiry(value);
  }

  #checkExpiry(value: unknown): number {
    return checkExpiry(value, `${NAME}: expiresIn`, MAX_EXPIRY_SECONDS);
  }
}

/** The `credentials` option, checked and copied — its values never quoted in an error. */
function checkCredentials(value: unknown): S3Credentials {
  const { accessKeyId, secretAccessKey, sessionToken } = (value ?? {}) as Partial<
    Record<keyof S3Credentials, unknown>
  >;
  if (
    typeof value !== 'object' ||
    !isFilled(accessKeyId) ||
    !isFilled(secretAccessKey) ||
    (sessionToken !== undefined && !isFilled(sessionToken))
  ) {
    throw invalidOption(
      `${NAME}: credentials must hold a non-empty accessKeyId and secretAccessKey, and a ` +
        'sessionToken only as a non-empty string.',
    );
  }
  return { accessKeyId, secretAccessKey, ...(sessionToken !== undefined ? { sessionToken } : {}) };
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A module's export `name`, which must be a function or a class. */
function functionExport(module: unknown, name: string, peer: Peer): unknown {
  const value = exportOf(module, name, peer);
  if (typeof value !== 'function') {
    throw adapterError(`${peer.specifier} exports a ${name} that is not a function`);
  }
  return value;
}

/** A `contentType` option, when given. */
function checkContentType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value !== '') return value;
  throw invalidOption(`${NAME}: contentType must be a non-empty string when provided.`);
}

/** What a `PutObject` sends for `body`: a file streams from disk with its length, anything else goes as bytes. */
async function putPayload(
  body: UploadBody,
): Promise<{ Body: Buffer | Readable; ContentLength: number }> {
  if (body.kind === 'file') return { Body: createReadStream(body.path), ContentLength: body.size };
  const bytes = body.kind === 'buffer' ? body.data : await readAll(body.stream);
  return { Body: bytes, ContentLength: bytes.length };
}

/**
 * Refuses a presigned `PUT` URL that demands a flexible checksum: a
 * checksum value, which the SDK computes over the empty body it presigned
 * and no rendered file matches, or a checksum algorithm, which obliges the
 * uploader to send a checksum S3 then verifies.
 */
function refuseChecksum(writeUrl: string): void {
  const names = [...new URL(writeUrl).searchParams.keys()].map((name) => name.toLowerCase());
  if (
    names.some(
      (name) => name.startsWith('x-amz-checksum-') || name === 'x-amz-sdk-checksum-algorithm',
    )
  ) {
    throw invalidOption(
      `${NAME}: the S3 client presigns PUT URLs that demand a flexible checksum (the SDK signs ` +
        "one computed over an empty body): create it with requestChecksumCalculation: 'WHEN_REQUIRED'.",
    );
  }
}
