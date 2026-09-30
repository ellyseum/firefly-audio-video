/**
 * {@link AzureBlobStorageProvider}: staging through an Azure Blob Storage
 * container (`@azure/storage-blob`).
 */

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
  uploadBody,
  type UploadBody,
} from './shared.js';

/** The part of a `BlockBlobClient` {@link AzureBlobStorageProvider} calls. */
export interface AzureBlockBlobClient {
  /** The blob's URL. */
  readonly url: string;
  /** Uploads bytes held in memory; `abortSignal` stops it. */
  uploadData(
    data: Buffer,
    options?: { blobHTTPHeaders?: { blobContentType?: string }; abortSignal?: AbortSignal },
  ): Promise<unknown>;
  /** Uploads a file from disk, in blocks; `abortSignal` stops it. */
  uploadFile(
    filePath: string,
    options?: { blobHTTPHeaders?: { blobContentType?: string }; abortSignal?: AbortSignal },
  ): Promise<unknown>;
  /** Uploads a stream of unknown length, in blocks; `abortSignal` stops it. */
  uploadStream(
    stream: Readable,
    bufferSize?: number,
    maxConcurrency?: number,
    options?: { blobHTTPHeaders?: { blobContentType?: string }; abortSignal?: AbortSignal },
  ): Promise<unknown>;
  /** The blob's URL with a SAS signed by the account key. */
  generateSasUrl(options: {
    permissions?: object;
    expiresOn?: Date;
    protocol?: 'https' | 'https,http';
  }): Promise<string>;
}

/** The part of a `ContainerClient` {@link AzureBlobStorageProvider} calls. */
export interface AzureContainerClient {
  /** The client for one block blob in the container. */
  getBlockBlobClient(blobName: string): AzureBlockBlobClient;
}

/** The part of a `BlobServiceClient` {@link AzureBlobStorageProvider} calls. */
export interface AzureBlobServiceClient {
  /** The client for one container in the account. */
  getContainerClient(containerName: string): AzureContainerClient;
}

/** The part of the `@azure/storage-blob` module {@link AzureBlobStorageProvider} calls. */
export interface AzureBlobModule {
  /** The service client class; its `fromConnectionString` builds the client when no `client` is given. */
  BlobServiceClient: {
    fromConnectionString(connectionString: string): AzureBlobServiceClient;
  };
  /** Parses the permissions a SAS grants. */
  BlobSASPermissions: { parse(permissions: string): object };
}

/** Options for {@link AzureBlobStorageProvider}. Pass exactly one of `connectionString`, `accountName` with `accountKey`, or `client`. */
export interface AzureBlobStorageProviderOptions {
  /** The container every blob is written to; it must already exist. */
  container: string;
  /**
   * A connection string holding the account key (`AccountName=…;AccountKey=…`,
   * or `UseDevelopmentStorage=true` for Azurite); never logged or thrown. One
   * holding a `SharedAccessSignature` and no `AccountKey` is refused: every
   * URL this provider returns is signed with the key.
   */
  connectionString?: string;
  /** The storage account's name: 3 to 24 lowercase letters and digits. Pass it with `accountKey`. */
  accountName?: string;
  /** The storage account's base64 key, with `accountName`; never logged or thrown. */
  accountKey?: string;
  /**
   * The blob service URL of `accountName`, for Azurite or a sovereign cloud.
   * Defaults to `https://<accountName>.blob.core.windows.net`.
   */
  endpoint?: string;
  /**
   * A `BlobServiceClient` to use instead of building one. It must hold the
   * account's shared key: every SAS this provider returns is signed with it.
   */
  client?: AzureBlobServiceClient;
  /**
   * Every key this provider writes goes under this prefix; a missing trailing
   * `/` is added. Defaults to `'firefly-audio-video/'`.
   */
  prefix?: string;
  /**
   * Seconds every URL this provider returns stays valid, from 1 to 604800
   * (seven days). Defaults to 24 hours: a staged input's URL must last until
   * the service reads it, which can follow a long wait in its queue, and an
   * output's URLs must outlive the render and the download after it.
   */
  expiresIn?: number;
  /**
   * The `@azure/storage-blob` module, used instead of importing it at run
   * time. Pass it in bundled code, where a run-time import cannot find the
   * package.
   */
  module?: AzureBlobModule;
}

const NAME = 'AzureBlobStorageProvider';

const PEER: Peer = {
  specifier: '@azure/storage-blob',
  provider: NAME,
  install: 'npm install @azure/storage-blob',
  option: 'module',
};

/** The longest lifetime this provider gives a SAS, in seconds. */
const MAX_EXPIRY_SECONDS = 604_800;

/** A storage account name as Azure allows it. */
const ACCOUNT_NAME_RE = /^[a-z0-9]{3,24}$/;

/** An account key: base64, which also keeps it from breaking out of a connection string. */
const ACCOUNT_KEY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The permissions a SAS grants: read, or create and write. */
type Access = 'r' | 'cw';

const ACCESS: Record<Access, string> = { r: 'read', cw: 'write' };

/** The SDK calls this provider makes, loaded once. */
interface AzureSdk {
  readonly container: AzureContainerClient;
  readonly BlobSASPermissions: AzureBlobModule['BlobSASPermissions'];
}

/**
 * Stages through an Azure Blob Storage container:
 *
 * - `stageRead` signs a read-only SAS for a new blob, then uploads the input
 *   to it as a block blob — a `Buffer` in one call, a file from disk and a
 *   `Readable` in blocks, neither read into memory whole — and returns the
 *   signed URL. Signing comes first so that a client which cannot sign fails
 *   before anything is written.
 * - `allocateOutput` signs two SAS URLs for one blob: create and write, which
 *   DGR renders into, and read, which the asset is read from.
 *
 * Every key goes under `prefix` plus a unique name. Every SAS is signed with
 * the account key, lasts `expiresIn` seconds, and on an HTTPS endpoint is
 * valid over HTTPS only. `@azure/storage-blob` is an optional peer
 * dependency, imported the first time this provider stages or allocates; the
 * client it builds comes from the connection string, or from one made of
 * `accountName`, `accountKey` and `endpoint`.
 *
 * The account key and the connection string never appear in an error this
 * provider throws, nor in any printed form of it; nor does a SAS.
 *
 * @example
 * ```ts
 * configure({
 *   clientId,
 *   clientSecret,
 *   storage: new AzureBlobStorageProvider({
 *     container: 'renders',
 *     connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
 *   }),
 * });
 * ```
 */
export class AzureBlobStorageProvider implements StorageProvider {
  readonly #container: string;
  readonly #connectionString: string | undefined;
  readonly #client: AzureBlobServiceClient | undefined;
  readonly #secrets: readonly string[];
  readonly #prefix: string;
  readonly #expiresIn: number | undefined;
  readonly #module: AzureBlobModule | undefined;
  #sdk: Promise<AzureSdk> | undefined;

  /**
   * @param options - See {@link AzureBlobStorageProviderOptions}.
   * @throws {@link AudioVideoError} `invalid_argument` for an invalid option.
   *   Nothing is imported until the first call.
   */
  constructor(options: AzureBlobStorageProviderOptions) {
    if (options === null || typeof options !== 'object') {
      throw invalidOption(`${NAME} expects an options object with a container.`);
    }
    const {
      container,
      connectionString,
      accountName,
      accountKey,
      endpoint,
      client,
      prefix,
      expiresIn,
      module,
    } = options;
    if (!isFilled(container)) {
      throw invalidOption(`${NAME}: container must be a non-empty string.`);
    }
    const account = accountName !== undefined || accountKey !== undefined;
    const sources = [connectionString !== undefined, account, client !== undefined];
    if (sources.filter(Boolean).length !== 1) {
      throw invalidOption(
        `${NAME}: pass exactly one of connectionString, accountName with accountKey, or client.`,
      );
    }
    if (connectionString !== undefined && !isFilled(connectionString)) {
      throw invalidOption(`${NAME}: connectionString must be a non-empty string.`);
    }
    if (connectionString !== undefined && holdsSasWithoutKey(connectionString)) {
      throw invalidOption(
        `${NAME}: connectionString holds a shared access signature and no account key, and ` +
          'every URL this provider returns is signed with the account key: pass a connection ' +
          'string that holds the key, or accountName with accountKey.',
      );
    }
    if (endpoint !== undefined && !account) {
      throw invalidOption(`${NAME}: endpoint goes with accountName and accountKey.`);
    }
    if (client !== undefined && typeof client?.getContainerClient !== 'function') {
      throw invalidOption(
        `${NAME}: client must be a BlobServiceClient, with getContainerClient().`,
      );
    }
    this.#container = container.trim();
    this.#connectionString = account
      ? accountConnectionString(accountName, accountKey, endpoint)
      : connectionString;
    this.#client = client;
    this.#secrets =
      this.#connectionString === undefined
        ? []
        : [this.#connectionString, ...connectionStringSecrets(this.#connectionString)];
    this.#prefix = keyPrefix(prefix, NAME);
    this.#expiresIn = expiresIn === undefined ? undefined : this.#checkExpiry(expiresIn);
    this.#module = module;
  }

  /**
   * Uploads `input` to a new blob — or the blob `opts.key` names under the
   * prefix — and resolves with its URL carrying a read-only SAS. The SAS is
   * signed before the upload, so a client that cannot sign fails with
   * nothing written, and its lifetime counts from the start of the upload.
   * `opts.signal` goes to the upload as the SDK's `abortSignal`, which stops
   * it when it aborts; signing takes no signal.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for an input that is
   *   not a local file, a `Buffer` or a `Readable`, or an invalid option;
   *   `missing_peer_dependency` when `@azure/storage-blob` cannot be
   *   imported; `storage_failed` when signing or the upload fails.
   */
  async stageRead(
    input: StageInput,
    opts: { key?: string; contentType?: string; expiresIn?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const body = await uploadBody(input, NAME);
    const key = objectKey(this.#prefix, opts.key, 'staged', body);
    const expiresIn = this.#expiry(opts.expiresIn, READ_EXPIRY_SECONDS);
    const contentType = checkContentType(opts.contentType);
    const sdk = await this.#load();
    const blob = this.#blob(sdk, key);
    const url = await this.#sign(sdk, blob, 'r', expiresIn);
    await this.#upload(blob, body, contentType, opts.signal);
    return url;
  }

  /**
   * Signs a create-and-write SAS and a read SAS for one new blob — or the
   * blob `opts.key` names under the prefix.
   *
   * @throws {@link AudioVideoError} `invalid_argument` for an invalid option;
   *   `missing_peer_dependency` when `@azure/storage-blob` cannot be
   *   imported; `storage_failed` when signing fails — as it does for a
   *   client without the account key.
   */
  async allocateOutput(
    opts: { key?: string; expiresIn?: number } = {},
  ): Promise<{ writeUrl: string; readUrl: string }> {
    const key = objectKey(this.#prefix, opts.key, 'outputs');
    const expiresIn = this.#expiry(opts.expiresIn, OUTPUT_EXPIRY_SECONDS);
    const sdk = await this.#load();
    const blob = this.#blob(sdk, key);
    const writeUrl = await this.#sign(sdk, blob, 'cw', expiresIn);
    const readUrl = await this.#sign(sdk, blob, 'r', expiresIn);
    return { writeUrl, readUrl };
  }

  /** The SDK, imported and the container client built on first use — again after a failed attempt. */
  #load(): Promise<AzureSdk> {
    this.#sdk ??= this.#import().catch((error: unknown) => {
      this.#sdk = undefined;
      throw error;
    });
    return this.#sdk;
  }

  async #import(): Promise<AzureSdk> {
    const module = this.#module ?? (await loadPeer(PEER));
    const BlobSASPermissions = exportOf(
      module,
      'BlobSASPermissions',
      PEER,
    ) as AzureBlobModule['BlobSASPermissions'];
    if (typeof BlobSASPermissions?.parse !== 'function') {
      throw adapterError(`${PEER.specifier} exports a BlobSASPermissions without parse()`);
    }
    const service = this.#client ?? this.#service(module);
    let container: unknown;
    try {
      container = service.getContainerClient(this.#container);
    } catch (error) {
      throw adapterError('Opening the Azure Blob container failed', error, this.#secrets);
    }
    if (
      typeof (container as Partial<AzureContainerClient> | null)?.getBlockBlobClient !== 'function'
    ) {
      throw adapterError('getContainerClient() returned no container client');
    }
    return { container: container as AzureContainerClient, BlobSASPermissions };
  }

  /** The service client this provider builds from its connection string. */
  #service(module: unknown): AzureBlobServiceClient {
    const BlobServiceClient = exportOf(
      module,
      'BlobServiceClient',
      PEER,
    ) as AzureBlobModule['BlobServiceClient'];
    if (typeof BlobServiceClient?.fromConnectionString !== 'function') {
      throw adapterError(
        `${PEER.specifier} exports a BlobServiceClient without fromConnectionString()`,
      );
    }
    let service: unknown;
    try {
      service = BlobServiceClient.fromConnectionString(this.#connectionString as string);
    } catch (error) {
      throw adapterError('Creating the Azure Blob client failed', error, this.#secrets);
    }
    if (
      typeof (service as Partial<AzureBlobServiceClient> | null)?.getContainerClient !== 'function'
    ) {
      throw adapterError('fromConnectionString() returned no service client');
    }
    return service as AzureBlobServiceClient;
  }

  #blob(sdk: AzureSdk, key: string): AzureBlockBlobClient {
    try {
      return sdk.container.getBlockBlobClient(key);
    } catch (error) {
      throw adapterError('Opening the blob failed', error, this.#secrets);
    }
  }

  /** Uploads `body` to `blob`, stopped by `signal`: a Buffer in one call, a file or a stream in blocks. */
  async #upload(
    blob: AzureBlockBlobClient,
    body: UploadBody,
    contentType: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const options = {
      ...(contentType !== undefined ? { blobHTTPHeaders: { blobContentType: contentType } } : {}),
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    };
    try {
      if (body.kind === 'buffer') await blob.uploadData(body.data, options);
      else if (body.kind === 'file') await blob.uploadFile(body.path, options);
      else await blob.uploadStream(body.stream, undefined, undefined, options);
    } catch (error) {
      throw adapterError('Uploading the blob failed', error, this.#secrets);
    }
  }

  /** `blob`'s URL with a SAS granting `access` for `expiresIn` seconds. */
  async #sign(
    sdk: AzureSdk,
    blob: AzureBlockBlobClient,
    access: Access,
    expiresIn: number,
  ): Promise<string> {
    let url: unknown;
    try {
      url = await blob.generateSasUrl({
        permissions: sdk.BlobSASPermissions.parse(access),
        expiresOn: new Date(Date.now() + expiresIn * 1000),
        ...(/^https:/i.test(blob.url) ? { protocol: 'https' as const } : {}),
      });
    } catch (error) {
      throw adapterError(
        `Signing a ${ACCESS[access]} SAS for the blob failed`,
        error,
        this.#secrets,
      );
    }
    if (typeof url !== 'string' || httpUrlOf(url) === undefined) {
      throw adapterError(
        `generateSasUrl() resolved without an http(s) URL for the ${ACCESS[access]} SAS`,
      );
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

/**
 * An account connection string for `name`, `key` and `endpoint`, checked —
 * the key never quoted in an error. With no endpoint the SDK derives the
 * account's own `https://<name>.blob.core.windows.net`.
 */
function accountConnectionString(name: unknown, key: unknown, endpoint: unknown): string {
  if (typeof name !== 'string' || !ACCOUNT_NAME_RE.test(name)) {
    throw invalidOption(
      `${NAME}: accountName must be 3 to 24 lowercase letters and digits, passed with accountKey.`,
    );
  }
  if (typeof key !== 'string' || !ACCOUNT_KEY_RE.test(key)) {
    throw invalidOption(
      `${NAME}: accountKey must be the account's base64 key, passed with accountName.`,
    );
  }
  const account = `AccountName=${name};AccountKey=${key}`;
  if (endpoint === undefined) {
    return `DefaultEndpointsProtocol=https;${account};EndpointSuffix=core.windows.net`;
  }
  const url = httpUrlOf(endpoint);
  if (url === undefined || url.includes(';')) {
    throw invalidOption(`${NAME}: endpoint must be an http(s) URL without a semicolon.`);
  }
  return `DefaultEndpointsProtocol=${new URL(url).protocol.slice(0, -1)};${account};BlobEndpoint=${url}`;
}

/** A connection string's non-empty `name=value` fields, each name lowercased. */
function connectionStringFields(connectionString: string): Array<[name: string, value: string]> {
  return connectionString.split(';').flatMap((part): Array<[string, string]> => {
    const at = part.indexOf('=');
    if (at <= 0) return [];
    const value = part.slice(at + 1).trim();
    return value === '' ? [] : [[part.slice(0, at).trim().toLowerCase(), value]];
  });
}

/** The secret values a connection string holds: its account key and any SAS. */
function connectionStringSecrets(connectionString: string): string[] {
  return connectionStringFields(connectionString)
    .filter(([name]) => name === 'accountkey' || name === 'sharedaccesssignature')
    .map(([, value]) => value);
}

/**
 * True for a connection string holding a SAS and no account key: a client
 * built from it can upload but can never sign the URLs this provider returns.
 */
function holdsSasWithoutKey(connectionString: string): boolean {
  const names = new Set(connectionStringFields(connectionString).map(([name]) => name));
  return names.has('sharedaccesssignature') && !names.has('accountkey');
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A `contentType` option, when given. */
function checkContentType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value !== '') return value;
  throw invalidOption(`${NAME}: contentType must be a non-empty string when provided.`);
}
