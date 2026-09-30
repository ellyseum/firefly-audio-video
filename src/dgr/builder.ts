/**
 * The fluent {@link RenderBuilder} `render(templateUrl)` returns: sugar for a
 * render with one source, one preset and one output. It proxies the `Preset`
 * chain onto an internal preset, is itself the thenable job, and starts
 * nothing until it is awaited or one of its terminals is called.
 */

import { Readable } from 'node:stream';
import type { Asset, AssetReadOptions } from '../core/asset.js';
import { AudioVideoError } from '../core/errors.js';
import type { JobMeta, JobStatusLike, PollInterval } from '../core/job.js';
import { rejectedJob, type JobHandle } from '../core/pooled-job.js';
import { linkSignals } from '../core/signals.js';
import { PRESET_NAMES } from '../presets/names.js';
import type { Client, RenderJob } from './client.js';
import { Preset, toPreset, type PresetInput, type ResizeTarget } from './preset.js';
import type { FluentRenderInput, TemplateSource } from './render.js';
import type { BitDepth, Bitrate, Chroma, EncodeConfig, PresetName } from './schemas.js';

/** Options for a fluent `render(templateUrl, options)`. */
export interface RenderBuilderOptions {
  /** Runs this render on `client` rather than the default client (or the client whose `render()` was called). */
  client?: Client;
  /**
   * Cancels the render when it aborts: before the job is submitted nothing is
   * submitted; after, the service is asked to stop the job. The render rejects
   * `cancelled` with the abort reason as `cause`.
   */
  signal?: AbortSignal;
  /** Called once per status poll with the raw status body, the terminal poll included. */
  onProgress?: (status: JobStatusLike) => void;
  /**
   * Milliseconds between status polls — a constant, or a function of the
   * milliseconds elapsed since the job started. Defaults to 1 s for the first
   * 30 s, then 2 s until two minutes, then 5 s.
   */
  pollIntervalMs?: PollInterval;
  /** The preset the chain starts from; any preset input `toPreset` accepts. */
  preset?: PresetInput;
  /** The output's file name. Cosmetic: the preset decides the real container. */
  fileName?: string;
}

/** One property per catalog preset name, each a new builder rendering with that preset. */
type NamedBuilderSteps = { readonly [K in PresetName]: RenderBuilder };

/**
 * A single-source, single-preset, single-output render, configured by
 * chaining. Every catalog name (`.prores`, `.prores4444xq`, `.hevc1080p10bit`,
 * `.h264Land1080pHq`, …) and every `Preset` modifier (`.resize()`,
 * `.bitDepth()`, `.bitrate()`, `.chroma()`, `.alpha()`, `.with()`,
 * `.extend()`) returns a new builder; none mutates this one. The builder is
 * the job: awaiting it (or calling `then()`) starts one render, and every
 * consumer of that builder shares it; it resolves with the finished
 * {@link Asset}. `.buffer()`, `.stream()` and `.save()` start the render if it
 * has not started and read its asset exactly as the same `Asset` methods do.
 * Nothing starts until one of those is called, so an unawaited builder
 * submits nothing.
 *
 * The output location comes from the client's storage
 * (`StorageProvider.allocateOutput()`): DGR writes to the allocated write URL
 * and the asset reads from its read URL. Without storage configured, or with
 * no preset chosen, the render rejects `invalid_argument`.
 *
 * @example
 * ```ts
 * await render(templateUrl).prores4444xq.alpha().save('./out.mov');
 * const bytes = await render(templateUrl).hevc1080p10bit.bitrate('40M').buffer();
 * render(templateUrl).h264Vert1920pHq.stream().pipe(response);
 * ```
 */
export interface RenderBuilder extends RenderJob<Asset>, NamedBuilderSteps {
  /** A new builder whose preset is resized; see `Preset.resize`. */
  resize(target: ResizeTarget): RenderBuilder;
  /** A new builder whose preset has `bitDepth` set; see `Preset.bitDepth`. */
  bitDepth(bits: BitDepth): RenderBuilder;
  /** A new builder whose preset has a target `bitrate`; see `Preset.bitrate`. */
  bitrate(value: Bitrate): RenderBuilder;
  /** A new builder whose preset has `chroma` set; see `Preset.chroma`. */
  chroma(value: Chroma): RenderBuilder;
  /** A new builder whose preset has alpha on (the default) or off; see `Preset.alpha`. */
  alpha(on?: boolean): RenderBuilder;
  /** A new builder with `overrides` merged over its preset's config; see `Preset.with`. */
  with(overrides: Partial<EncodeConfig>): RenderBuilder;
  /** The same as {@link RenderBuilder.with}. */
  extend(overrides: Partial<EncodeConfig>): RenderBuilder;
  /** Renders, then reads the finished asset into memory; see `Asset.buffer`. */
  buffer(options?: AssetReadOptions): Promise<Buffer>;
  /**
   * A byte stream over the finished asset; see `Asset.stream`. Lazy: the
   * render starts on the stream's first read, and a render failure surfaces
   * as an `'error'` event.
   */
  stream(options?: AssetReadOptions): Readable;
  /** Renders, then streams the finished asset to `path`; see `Asset.save`. */
  save(path: string, options?: AssetReadOptions): Promise<void>;
}

/** @internal What a builder starts its render through: the client it resolves to. */
export interface FluentRenderer {
  startFluentRender(input: FluentRenderInput, options: RenderBuilderOptions): JobHandle<Asset>;
  /** Logs a render as cancelled before it reached this client — for a builder already bound to it. */
  logCancelled(error: AudioVideoError): void;
}

/**
 * @internal A builder for `source`. `resolve` is called when the render
 * starts — never before — and names the client it runs on; a throw from it
 * rejects the render.
 */
export function createRenderBuilder(
  source: TemplateSource,
  options: RenderBuilderOptions,
  resolve: () => FluentRenderer,
): RenderBuilder {
  // The catalog-name properties are defined on the prototype in FluentRender's static block.
  return new FluentRender(source, options, resolve, options.preset) as unknown as RenderBuilder;
}

class FluentRender implements Omit<RenderBuilder, PresetName> {
  readonly #source: TemplateSource;
  readonly #options: RenderBuilderOptions;
  readonly #resolve: () => FluentRenderer;
  readonly #preset: PresetInput | undefined;
  #job: JobHandle<Asset> | undefined;
  #cancelled = false;
  /** Aborts a terminal's in-progress read (`buffer()`, `stream()`, `save()`) on `cancel()`, even once the render has already settled. */
  readonly #reading = new AbortController();

  constructor(
    source: TemplateSource,
    options: RenderBuilderOptions,
    resolve: () => FluentRenderer,
    preset: PresetInput | undefined,
  ) {
    this.#source = source;
    this.#options = options;
    this.#resolve = resolve;
    this.#preset = preset;
  }

  get jobId(): string | undefined {
    return this.#job?.jobId;
  }

  get meta(): JobMeta | undefined {
    return this.#job?.meta;
  }

  then<TResult1 = Asset, TResult2 = never>(
    onfulfilled?: ((value: Asset) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#started().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<Asset | TResult> {
    return this.#started().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Asset> {
    return this.#started().finally(onfinally);
  }

  /**
   * See {@link JobHandle.cancel}. Also aborts a terminal's read
   * (`buffer()`, `stream()`, `save()`) if one is in progress, or starts,
   * regardless of whether the render itself has already settled — a
   * builder's terminal downloads the finished asset after the underlying
   * job does, which is otherwise past the point {@link JobHandle.cancel}'s
   * own abort reaches.
   */
  cancel(): Promise<void> {
    this.#reading.abort(
      new AudioVideoError({
        message: 'The job was cancelled while its result was being read.',
        code: 'cancelled',
      }),
    );
    if (this.#job !== undefined) return this.#job.cancel();
    this.#cancelled = true;
    return Promise.resolve();
  }

  buffer(options?: AssetReadOptions): Promise<Buffer> {
    return this.#started().then((asset) => this.#read(options, (read) => asset.buffer(read)));
  }

  stream(options?: AssetReadOptions): Readable {
    return Readable.from(this.#chunks(options), { objectMode: false });
  }

  save(path: string, options?: AssetReadOptions): Promise<void> {
    return this.#started().then((asset) => this.#read(options, (read) => asset.save(path, read)));
  }

  resize(target: ResizeTarget): RenderBuilder {
    return this.#step((preset) => preset.resize(target));
  }

  bitDepth(bits: BitDepth): RenderBuilder {
    return this.#step((preset) => preset.bitDepth(bits));
  }

  bitrate(value: Bitrate): RenderBuilder {
    return this.#step((preset) => preset.bitrate(value));
  }

  chroma(value: Chroma): RenderBuilder {
    return this.#step((preset) => preset.chroma(value));
  }

  alpha(on = true): RenderBuilder {
    return this.#step((preset) => preset.alpha(on));
  }

  with(overrides: Partial<EncodeConfig>): RenderBuilder {
    return this.#step((preset) => preset.with(overrides));
  }

  extend(overrides: Partial<EncodeConfig>): RenderBuilder {
    return this.with(overrides);
  }

  /**
   * Backs `util.inspect(builder)` / `console.log(builder)`: the job ID, and the
   * chosen preset's redacted JSON form. A preset given as a raw `.epr` URL or
   * XML is normalized first, so a presigned URL's signature never prints.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): { jobId: string | undefined; preset: unknown } {
    return { jobId: this.jobId, preset: this.#inspectPreset() };
  }

  /** The preset field `inspect` shows: its redacted JSON form, or `undefined` when none is chosen yet or it cannot be normalized. */
  #inspectPreset(): unknown {
    const preset = this.#preset;
    if (preset === undefined) return undefined;
    try {
      return toPreset(preset).toJSON();
    } catch {
      return '<unresolved preset>';
    }
  }

  /** A new builder with `change` applied to this builder's preset, or to an empty base without one. */
  #step(change: (preset: Preset) => Preset): RenderBuilder {
    const base = this.#preset === undefined ? new Preset() : toPreset(this.#preset);
    return this.#withPreset(change(base));
  }

  #withPreset(preset: PresetInput): RenderBuilder {
    return new FluentRender(
      this.#source,
      this.#options,
      this.#resolve,
      preset,
    ) as unknown as RenderBuilder;
  }

  /** This builder's render, started on first use and shared by every consumer after. */
  #started(): JobHandle<Asset> {
    this.#job ??= this.#start();
    return this.#job;
  }

  /**
   * Logs this builder's before-start cancellation on `options.client`, when
   * naming one costs nothing: a builder already bound to a client needs no
   * default resolved to find it. An unbound builder stays silent rather than
   * resolve the default client just to log a cancellation that never reached
   * it.
   */
  #logCancelledIfBound(error: AudioVideoError): void {
    if (this.#options.client === undefined) return;
    try {
      this.#resolve().logCancelled(error);
    } catch {
      // The named client was invalid; there is nothing to log on.
    }
  }

  #start(): JobHandle<Asset> {
    if (this.#cancelled) {
      const error = new AudioVideoError({
        message: 'The job was cancelled before it was submitted.',
        code: 'cancelled',
      });
      this.#logCancelledIfBound(error);
      return rejectedJob(error);
    }
    let renderer: FluentRenderer;
    try {
      renderer = this.#resolve();
    } catch (error) {
      return rejectedJob(error);
    }
    const { fileName } = this.#options;
    return renderer.startFluentRender(
      {
        source: this.#source,
        preset: this.#preset,
        ...(fileName !== undefined ? { fileName } : {}),
      },
      this.#options,
    );
  }

  async *#chunks(options: AssetReadOptions | undefined): AsyncGenerator<Buffer> {
    const asset = await this.#started();
    const link = this.#readLink(options);
    try {
      yield* asset.stream({ signal: link.signal });
    } finally {
      link.release();
    }
  }

  /** Runs one terminal's read under {@link FluentRender.#readLink}, releasing the link once the read settles. */
  async #read<V>(
    options: AssetReadOptions | undefined,
    read: (options: AssetReadOptions) => Promise<V>,
  ): Promise<V> {
    const link = this.#readLink(options);
    try {
      return await read({ signal: link.signal });
    } finally {
      link.release();
    }
  }

  /**
   * The signal a terminal's underlying `Asset` read observes: the caller's
   * own signal, this builder's `signal` option, and this builder's own
   * `cancel()` — whichever fires first. Its listeners on those signals go
   * once it aborts or `release` is called, which the terminal does when its
   * read is over: the caller's signals can outlive the read by far.
   */
  #readLink(options: AssetReadOptions | undefined): { signal: AbortSignal; release: () => void } {
    const signals = [this.#reading.signal, this.#options.signal, options?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    return linkSignals(signals);
  }

  static {
    for (const name of PRESET_NAMES) {
      Object.defineProperty(this.prototype, name, {
        get(this: FluentRender): RenderBuilder {
          return this.#withPreset(Preset[name]);
        },
        enumerable: false,
      });
    }
  }
}
