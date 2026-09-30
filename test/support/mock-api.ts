import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LogRecord, Logger } from '../../src/core/logging.js';
import type { StorageProvider } from '../../src/core/storage.js';

export const API = 'https://audio-video-api.adobe.io';
export const IMS = 'https://ims-na1.adobelogin.com';
export const STORAGE = 'https://storage.example';

/** The access token the mocked IMS mints. */
export const TOKEN = 'IMS_TOKEN_VALUE';

/** Wire timestamps: `CREATED` plus `seconds`, with an optional nanosecond-precision fraction. */
export const CREATED = '2026-09-29T12:00:00.000Z';
export function at(seconds: number, fraction = '.000'): string {
  return new Date(Date.parse(CREATED) + seconds * 1000).toISOString().replace('.000', fraction);
}

/** One request the mock saw. */
export interface RecordedCall {
  origin: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Drains a MockAgent reply callback's request body — native fetch hands it over as chunks. */
async function readBody(body: unknown): Promise<string> {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  let raw = '';
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return raw;
}

interface ReplyOptions {
  path: string;
  method: string;
  headers?: unknown;
  body?: unknown;
}

/**
 * A MockAgent installed as the global dispatcher — so the SDK's own fetches and
 * the official IMS provider's both reach it — with helpers for the IMS token
 * endpoint and the DGR endpoints. Every request is recorded in `calls`.
 */
export class MockApi {
  readonly agent = new MockAgent();
  readonly calls: RecordedCall[] = [];
  readonly #original = getGlobalDispatcher();

  constructor() {
    this.agent.disableNetConnect();
    setGlobalDispatcher(this.agent);
  }

  async close(): Promise<void> {
    await this.agent.close();
    setGlobalDispatcher(this.#original);
  }

  /** Calls whose method matches and whose path starts with `prefix`, on `origin` (the API by default). */
  count(method: string, prefix: string, origin = API): number {
    return this.calls.filter(
      (call) => call.origin === origin && call.method === method && call.path.startsWith(prefix),
    ).length;
  }

  /** The parsed JSON bodies of every render submit, in order. */
  submitted(path = '/v1/templates/render'): Array<Record<string, unknown>> {
    return this.calls
      .filter((call) => call.origin === API && call.method === 'POST' && call.path === path)
      .map((call) => JSON.parse(call.body) as Record<string, unknown>);
  }

  /** The IMS token endpoint, answering every mint with {@link TOKEN}. */
  ims(): void {
    this.agent
      .get(IMS)
      .intercept({ path: '/ims/token/v3', method: 'POST' })
      .reply(200, async (opts) => {
        await this.#record(IMS, opts);
        return { access_token: TOKEN, token_type: 'bearer', expires_in: 86_399 };
      })
      .persist();
  }

  /** The form bodies every IMS mint sent, as parsed search params. */
  imsRequests(): URLSearchParams[] {
    return this.calls
      .filter((call) => call.origin === IMS)
      .map((call) => new URLSearchParams(call.body));
  }

  /**
   * A submit endpoint answering `202 { jobId, statusUrl, cancelUrl }` with
   * `Retry-After` on every response, as the live API does. Job IDs come from
   * `jobIds` in order; `onSubmit` sees each one with the parsed request body.
   */
  submit(
    jobIds: string[],
    opts: {
      path?: string;
      retryAfter?: string;
      onSubmit?: (jobId: string, body: Record<string, unknown>) => void;
    } = {},
  ): void {
    const path = opts.path ?? '/v1/templates/render';
    let next = 0;
    this.agent
      .get(API)
      .intercept({ path, method: 'POST' })
      .reply(
        202,
        async (reply) => {
          const call = await this.#record(API, reply);
          const jobId = jobIds[Math.min(next, jobIds.length - 1)] ?? 'job';
          next += 1;
          opts.onSubmit?.(jobId, JSON.parse(call.body) as Record<string, unknown>);
          return {
            jobId,
            statusUrl: `${API}/v1/status/${jobId}`,
            cancelUrl: `${API}/v1/cancel/${jobId}`,
          };
        },
        { headers: { 'retry-after': opts.retryAfter ?? '1', 'x-request-id': 'req-submit' } },
      )
      .persist();
  }

  /**
   * The status endpoint for `jobId`: `answer(n)` builds the body for the
   * `n`th poll (0-based).
   */
  status(jobId: string, answer: (poll: number) => object): void {
    let poll = 0;
    this.agent
      .get(API)
      .intercept({ path: `/v1/status/${jobId}`, method: 'GET' })
      .reply(200, async (reply) => {
        await this.#record(API, reply);
        const body = answer(poll);
        poll += 1;
        return body;
      })
      .persist();
  }

  /** The cancel endpoint for `jobId`, answering as the live API does. */
  cancel(jobId: string): void {
    this.agent
      .get(API)
      .intercept({ path: `/v1/cancel/${jobId}`, method: 'PUT' })
      .reply(202, async (reply) => {
        await this.#record(API, reply);
        return { jobId, status: 'canceling' };
      })
      .persist();
  }

  /** Any API endpoint, answering `status` with `body` every time. */
  reply(method: string, path: string, status: number, body: object | string): void {
    this.agent
      .get(API)
      .intercept({ path, method })
      .reply(status, async (reply) => {
        await this.#record(API, reply);
        return body;
      })
      .persist();
  }

  /** A `GET` on `STORAGE` for any path starting with `pathPrefix`, answering `bytes`. */
  download(pathPrefix: string, bytes: Buffer): void {
    this.agent
      .get(STORAGE)
      .intercept({ path: (path) => path.startsWith(pathPrefix), method: 'GET' })
      .reply(200, async (reply) => {
        await this.#record(STORAGE, reply);
        return bytes;
      })
      .persist();
  }

  /**
   * The same as {@link MockApi.download}, but the response answers only after
   * `delayMs` — for a test that aborts a download already in flight. `onStart`
   * fires the moment the request lands, before the delay.
   */
  downloadDelayed(pathPrefix: string, bytes: Buffer, delayMs: number, onStart?: () => void): void {
    this.agent
      .get(STORAGE)
      .intercept({ path: (path) => path.startsWith(pathPrefix), method: 'GET' })
      .reply(200, async (reply) => {
        onStart?.();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await this.#record(STORAGE, reply);
        return bytes;
      })
      .persist();
  }

  /** Records one request an interceptor answered, and returns the record. */
  async #record(origin: string, opts: ReplyOptions): Promise<RecordedCall> {
    const call: RecordedCall = {
      origin,
      method: opts.method,
      path: opts.path,
      headers: (opts.headers ?? {}) as Record<string, string>,
      body: await readBody(opts.body),
    };
    this.calls.push(call);
    return call;
  }
}

/** A running status body for `jobId`. */
export function running(jobId: string, totalJobItems = 1): object {
  return { jobId, status: 'running', createdDate: CREATED, totalJobItems };
}

/** One terminal `outputs[]` entry, indexes as strings, as the live API sends them. */
export function wireOutput(
  variationIndex: number,
  presetIndex: number,
  started: number,
  completed: number,
  destination = `${STORAGE}/out/${variationIndex}-${presetIndex}.mov`,
): object {
  return {
    destination: { url: destination },
    variationIndex: String(variationIndex),
    presetIndex: String(presetIndex),
    startedDate: at(started),
    completedDate: at(completed, '.000123456'),
  };
}

/** A succeeded status body for `jobId` carrying `outputs`. */
export function succeeded(jobId: string, outputs: object[]): object {
  return {
    jobId,
    status: 'succeeded',
    createdDate: CREATED,
    totalJobItems: outputs.length,
    outputs,
  };
}

/** A succeeded status body for `jobId` carrying no `outputs` key at all. */
export function succeededWithoutOutputs(jobId: string): object {
  return { jobId, status: 'succeeded', createdDate: CREATED };
}

/** A fake {@link StorageProvider} that records every call and returns SAS-shaped URLs. */
export interface FakeStorage extends StorageProvider {
  readonly staged: Array<{ input: unknown; opts: unknown }>;
  readonly allocations: Array<{ writeUrl: string; readUrl: string }>;
}

export function fakeStorage(): FakeStorage {
  let n = 0;
  const staged: FakeStorage['staged'] = [];
  const allocations: FakeStorage['allocations'] = [];
  return {
    staged,
    allocations,
    async stageRead(input: Buffer | Readable | URL | string, opts?: unknown): Promise<string> {
      n += 1;
      staged.push({ input, opts });
      return `${STORAGE}/staged/${n}.epr?sv=2021&sp=r&sig=STAGE_SIG_${n}`;
    },
    async allocateOutput(): Promise<{ writeUrl: string; readUrl: string }> {
      n += 1;
      const slot = {
        writeUrl: `${STORAGE}/out/${n}.mov?sv=2021&sp=w&sig=WRITE_SIG_${n}`,
        readUrl: `${STORAGE}/out/${n}.mov?sv=2021&sp=r&sig=READ_SIG_${n}`,
      };
      allocations.push(slot);
      return slot;
    },
  };
}

/** A {@link Logger} that keeps every record it is given. */
export function recordingLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, log: (record) => void records.push(record) };
}

/** One real macrotask turn — drains every pending microtask, however many hops deep. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolves once `predicate()` holds, checking after each macrotask turn; rejects after `turns`. */
export async function until(predicate: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('condition not reached');
}

/** Resolves once `predicate()` holds, checking every few milliseconds; rejects after `timeoutMs`. */
export async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(5);
  }
}

/**
 * Answers every request whose URL starts with `prefix` through a stub over
 * `globalThis.fetch`, with `chunks` 1 KiB chunks, one every `everyMs`, and
 * counts the chunks served; every other request goes to the real fetch.
 * `restore` puts the real fetch back.
 */
export function trickle(
  prefix: string,
  chunks: number,
  everyMs: number,
): { served: () => number; restore: () => void } {
  let served = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(prefix)) return realFetch(input, init);
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await sleep(everyMs);
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        if (served >= chunks) {
          controller.close();
          return;
        }
        served += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(chunks * 1024) },
    });
  };
  return {
    served: () => served,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
