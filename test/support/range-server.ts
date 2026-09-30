import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** One representation the server hands out. */
export interface Resource {
  body: Buffer;
  etag?: string;
  lastModified?: string;
}

/** The range headers one request carried. */
export interface SeenRequest {
  range: string | undefined;
  ifRange: string | undefined;
}

/**
 * How the server answers one request. Every field is optional; with none set
 * it serves the resource correctly — `206` for a satisfiable `Range` whose
 * `If-Range` (when sent) matches the resource's `ETag` or `Last-Modified`,
 * `416` for an unsatisfiable one, `200` with the whole body otherwise.
 */
export interface Handling {
  /** Send only this many body bytes, then close the connection mid-response. */
  cutAfter?: number;
  /** Answer this status with an empty body instead of serving the resource. */
  status?: number;
  /** Answer `200` with the whole body whatever the request asked for. */
  ignoreRange?: boolean;
  /**
   * Send a `206` whose `Content-Range` is built from the requested start and
   * the resource's length, instead of the correct one; the body is still the
   * requested range.
   */
  contentRange?: (start: number, length: number) => string;
  /** Send this `ETag` instead of the resource's own. */
  etag?: string;
}

export interface RangeServerOptions {
  /** The resource each request is served from; a function of the request's index can change it between requests. */
  resource: Resource | ((index: number) => Resource);
  /** How to answer request `index` (0 for the first); the default serves it correctly. */
  handle?: (index: number) => Handling;
}

export interface RangeServer {
  /** The resource's URL on 127.0.0.1, with a query string like a presigned URL's. */
  readonly url: string;
  /** Every request so far, in arrival order. */
  readonly requests: SeenRequest[];
  /** How many responses the server has cut off mid-body so far. */
  cuts(): number;
  /** Resolves once the server has no open connection, rejecting after `timeoutMs`. */
  idle(timeoutMs?: number): Promise<void>;
  /** Closes the server and every connection still open. */
  close(): Promise<void>;
}

/**
 * A real HTTP server on 127.0.0.1 serving one resource with `Range` and
 * `If-Range` support, for exercising resumable downloads over real sockets
 * through the platform's own fetch. Every response carries
 * `Connection: close`, so a connection stays open only while a response is
 * being delivered or a client is holding a body it has not finished with.
 */
export async function startRangeServer(options: RangeServerOptions): Promise<RangeServer> {
  const requests: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  let cuts = 0;
  const resourceAt = (index: number): Resource =>
    typeof options.resource === 'function' ? options.resource(index) : options.resource;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const index = requests.length;
    requests.push({ range: header(req, 'range'), ifRange: header(req, 'if-range') });
    const resource = resourceAt(index);
    const handling = options.handle?.(index) ?? {};
    const answer = plan(resource, req, handling);

    const headers: Record<string, string | number> = {
      'content-type': 'application/octet-stream',
      connection: 'close',
      'content-length': answer.body.length,
    };
    const etag = handling.etag ?? resource.etag;
    if (etag !== undefined) headers.etag = etag;
    if (resource.lastModified !== undefined) headers['last-modified'] = resource.lastModified;
    if (answer.contentRange !== undefined) headers['content-range'] = answer.contentRange;
    res.writeHead(answer.status, headers);

    const { cutAfter } = handling;
    if (cutAfter === undefined || cutAfter >= answer.body.length) {
      res.end(answer.body);
      return;
    }
    res.write(answer.body.subarray(0, cutAfter), () => {
      cuts += 1;
      res.socket?.destroy();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/out.mov?sv=2021&sig=RANGE_SERVER_SECRET`,
    requests,
    cuts: () => cuts,
    async idle(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (sockets.size > 0) {
        if (Date.now() > deadline) {
          throw new Error(`${sockets.size} connection(s) still open after ${timeoutMs} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The status, `Content-Range` and body a request gets, before any cut. */
function plan(
  resource: Resource,
  req: IncomingMessage,
  handling: Handling,
): { status: number; contentRange?: string; body: Buffer } {
  const { body } = resource;
  if (handling.status !== undefined) return { status: handling.status, body: Buffer.alloc(0) };
  const start = rangeStart(header(req, 'range'));
  const ifRange = header(req, 'if-range');
  const validatorMatches =
    ifRange === undefined || ifRange === resource.etag || ifRange === resource.lastModified;
  if (handling.ignoreRange === true || start === undefined || !validatorMatches) {
    return { status: 200, body };
  }
  if (start >= body.length) {
    return { status: 416, contentRange: `bytes */${body.length}`, body: Buffer.alloc(0) };
  }
  return {
    status: 206,
    contentRange:
      handling.contentRange?.(start, body.length) ??
      `bytes ${start}-${body.length - 1}/${body.length}`,
    body: body.subarray(start),
  };
}

/** The start of an open-ended `Range: bytes=<start>-`, or `undefined` for anything else. */
function rangeStart(range: string | undefined): number | undefined {
  const match = range === undefined ? null : /^bytes=(\d+)-$/.exec(range);
  return match === null ? undefined : Number(match[1]);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** `bytes`' SHA-256, hex-encoded — a compact way to assert two payloads are identical. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic, non-repeating bytes, so a spliced or shifted download cannot match by accident. */
export function payload(length: number, seed = 1): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}
