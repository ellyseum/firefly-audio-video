import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

/** Where the official token provider posts its client-credentials exchange. */
export const IMS_ORIGIN = 'https://ims-na1.adobelogin.com';

const TOKEN_PATH = '/ims/token/v3';

/** Tuning for one scripted IMS answer. */
export interface ImsAnswerOptions {
  /** Holds the answer back until this settles, so the mint is still in flight meanwhile. */
  hold?: Promise<unknown>;
  /** How many consecutive token requests this answer serves. Defaults to 1. */
  times?: number;
}

/**
 * A scripted IMS token endpoint on a MockAgent installed as the global
 * dispatcher, so the official provider's own `fetch` reaches it and the
 * network never does. Each {@link FakeIms.answer} queues the reply to the next
 * token request; a request with no reply queued fails the way an unreachable
 * IMS does.
 */
export class FakeIms {
  readonly #agent = new MockAgent();
  readonly #original = getGlobalDispatcher();
  /** The raw form body of every token request IMS received, in arrival order. */
  readonly requests: string[] = [];

  constructor() {
    this.#agent.disableNetConnect();
    setGlobalDispatcher(this.#agent);
  }

  async close(): Promise<void> {
    await this.#agent.close();
    setGlobalDispatcher(this.#original);
  }

  /**
   * Answers the next token request with `status` and `body`: an object is sent
   * as JSON, a string verbatim.
   */
  answer(status: number, body: object | string, options: ImsAnswerOptions = {}): void {
    this.#agent
      .get(IMS_ORIGIN)
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(
        status,
        async (request) => {
          this.requests.push(await readBody(request.body));
          await options.hold;
          return body;
        },
        {
          headers: {
            'content-type': typeof body === 'string' ? 'text/html' : 'application/json',
          },
        },
      )
      .times(options.times ?? 1);
  }

  /** Answers the next token request with `accessToken`, in the shape IMS mints it. */
  token(accessToken: string, options?: ImsAnswerOptions): void {
    this.answer(
      200,
      { access_token: accessToken, token_type: 'bearer', expires_in: 86_399 },
      options,
    );
  }

  /** The `n`th request's form body, parsed. */
  form(n: number): URLSearchParams {
    return new URLSearchParams(this.requests[n] ?? '');
  }
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

/** A promise and the function that resolves it. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
