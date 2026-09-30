# firefly-audio-video

[![quality](https://github.com/ellyseum/firefly-audio-video/actions/workflows/quality.yml/badge.svg?branch=main)](https://github.com/ellyseum/firefly-audio-video/actions/workflows/quality.yml)
[![license](https://img.shields.io/github/license/ellyseum/firefly-audio-video)](https://github.com/ellyseum/firefly-audio-video/blob/main/LICENSE)
[![node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fellyseum%2Ffirefly-audio-video%2Fmain%2Fpackage.json&query=%24.engines.node&label=node)](https://github.com/ellyseum/firefly-audio-video/blob/main/package.json)
[![npm](https://img.shields.io/npm/v/firefly-audio-video)](https://www.npmjs.com/package/firefly-audio-video)

Node.js SDK and CLI for Dynamic Graphics Render (DGR), the Adobe Firefly Services API that renders
Motion Graphics templates (`.mogrt`) on `audio-video-api.adobe.io`. The API is asynchronous and
reads and writes only URLs; `await render(spec)` submits the job, polls it to completion and
resolves with the finished asset. Presets are typed JSON: a config that matches one of DGR's native
presets is sent as that preset, and any other becomes a generated Adobe Media Encoder preset
(`.epr`), so the render itself delivers the final codec and frame size. Local files, `Buffer`s and
streams are staged to your storage on the way in, every log record and error is redacted, and the
`dgr` CLI runs the same code for people and agents.

## Install

```sh
npm i firefly-audio-video
```

Node.js 18 or later; CI runs the built package on Node 18, 20, 22 and 24. A storage provider loads
its cloud SDK the first time it runs, so install only the one you use. Without it, the provider
rejects `missing_peer_dependency` and names the command.

| Storage            | Provider                   | Install                                                        |
| ------------------ | -------------------------- | -------------------------------------------------------------- |
| App Builder Files  | `AioFilesStorageProvider`  | `npm install @adobe/aio-lib-files`                             |
| Amazon S3          | `S3StorageProvider`        | `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` |
| Azure Blob Storage | `AzureBlobStorageProvider` | `npm install @azure/storage-blob`                              |

A render whose inputs and outputs are all URLs needs none of them.

## Quickstart

The SDK authenticates with an Adobe IMS OAuth Server-to-Server credential. Without `configure()`,
the first call builds the default client from the environment:

```sh
export IMS_OAUTH_S2S_CLIENT_ID=<client id>
export IMS_OAUTH_S2S_CLIENT_SECRET=<client secret>
export IMS_OAUTH_S2S_SCOPES=openid,AdobeID,firefly_api,ff_apis   # optional; the default
```

`IMS_OAUTH_S2S_SCOPES` takes a comma-separated list or a JSON array,
`["openid","AdobeID","firefly_api","ff_apis"]`, the form an `aio`-generated `.env` stores. The
library reads `process.env` only; the CLI also loads `.env` from the working directory.

```ts
import { render } from 'firefly-audio-video';

const asset = await render({
  source: 'https://storage.example.com/capsule.mogrt?sig=read',
  presets: ['h264Land1080pHq'],
  outputs: [
    {
      presetIndex: 0,
      destination: 'https://storage.example.com/out.mp4?sig=write', // DGR writes the file here
      readUrl: 'https://storage.example.com/out.mp4?sig=read', // the asset reads it back from here
    },
  ],
});

await asset.save('./out.mp4');
console.log(asset.meta.jobId, asset.meta.totalMs);
```

`render()` resolves once the job is done; `asset.url` is the read URL, and nothing downloads until
you ask. With a [storage provider](#storage), the template can be a local file and an output needs
no `destination`.

The top-level functions run on that default client. `configure({ clientId, clientSecret, ... })`
replaces it, and the last call wins; `createClient(...)` returns an independent client for a second
credential or for use inside a library. Both take the credential as options (or
`{ clientId, tokenProvider }` to supply tokens yourself); only the default client reads the
environment. Every function takes `{ client }`, and a client has the same methods.

### Calls

| Call                         | Resolves with                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `render(spec, options?)`     | the finished `Asset`, or `Asset[]` in `outputs` order for a spec with several outputs |
| `render(template, options?)` | a [fluent builder](#presets-and-encode) that is itself the job                        |
| `describe(template)`         | the template's editable controls and fonts                                            |
| `listPresets()`              | DGR's native presets                                                                  |
| `status(jobId)`              | the job's raw status body                                                             |
| `cancel(jobId)`              | the service's acknowledgement                                                         |
| `stage(input)`               | a URL DGR can read `input` from                                                       |

`describe()` also takes an After Effects project zip as `{ source, type: 'aep', compName }`.
`render()` and `describe()` return a handle you `await`; it also carries `jobId` once the service
accepts the job, `meta` once the job ends, and `cancel()`. Their options:

| Option                  | Effect                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `signal`                | Aborting it cancels the job: before the submit nothing is sent; after it, the service is asked to stop the job. Rejects `cancelled`. |
| `onProgress`            | Called with every status poll's body.                                                                                                |
| `pollIntervalMs`        | Milliseconds between polls, or a function of the time elapsed. Defaults to 1 s for the first 30 s, 2 s until two minutes, then 5 s.  |
| `resolveAs`, `savePath` | `render()` only: resolve with the output's `'url'`, `'buffer'`, `'stream'`, or `'file'` (the path saved to) instead of the `Asset`.  |

`signal: AbortSignal.timeout(ms)` gives a render a deadline.

## Presets and encode

Anywhere a preset goes (a spec's `presets`, the fluent builder, `toPreset()`) it can be:

- a catalog name, such as `'prores4444xq'`: editors autocomplete it, and an unknown name rejects
  `invalid_preset` with the list of valid ones;
- a `Preset`: from the catalog (`presets.hevc4k10bit` or `Preset.hevc4k10bit`, where a typo does
  not compile) or from a config (`encode({...})`, `new Preset({...})`);
- an encode config object;
- a DGR preset ID: a string for one of the sixteen the catalog knows (`'ffs_video_api_prores'`), or
  `{ presetId }` for any ID, sent as it is;
- a real Adobe Media Encoder `.epr`: a file path, its XML, an http(s) URL, or `Preset.fromEpr(...)`,
  sent as it is.

| Catalog name                                               | Encode                    | Frame size | Sent as          |
| ---------------------------------------------------------- | ------------------------- | ---------- | ---------------- |
| `h264Land1080pHq`, `h264Land1080pLq`, `h264Land1080p2Pass` | H.264                     | 1920x1080  | native preset    |
| `h264Square1080pHq`, `…Lq`, `…2Pass`                       | H.264                     | 1080x1080  | native preset    |
| `h264Vert1920pHq`, `…Lq`, `…2Pass`                         | H.264                     | 1080x1920  | native preset    |
| `h264Portrait1620pHq`, `…Lq`, `…2Pass`                     | H.264                     | 1080x1620  | native preset    |
| `h264Portrait1350pHq`, `…Lq`, `…2Pass`                     | H.264                     | 1080x1350  | native preset    |
| `prores`                                                   | ProRes 4444 with alpha    | the source | native preset    |
| `prores4444xq`                                             | ProRes 4444 XQ with alpha | the source | generated `.epr` |
| `hevc1080p10bit`                                           | HEVC Main10, 4:2:0        | 1920x1080  | generated `.epr` |
| `hevc4k10bit`                                              | HEVC Main10, 4:2:0        | 3840x2160  | generated `.epr` |

`dgr presets` prints the catalog offline; `listPresets()` asks the service. `encode(config)` builds
a preset from a full config, in which only `codec` is required:

| Field         | Accepts                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `codec`       | `'hevc'` (`hvc1`), `'prores4444'` (`ap4h`), `'prores4444xq'` (`ap4x`), or `'h264'`, which renders only through DGR's native presets |
| `resolution`  | `'3840x2160'` or `{ width, height }`; without one, the frame size follows the source                                                |
| `frameRate`   | frames per second, such as `29.97`; it needs a `resolution`, and without one the rate follows the source                            |
| `bitDepth`    | HEVC `8` (Main) or `10` (Main10); ProRes is 12-bit                                                                                  |
| `chroma`      | HEVC and H.264 `'420'`, ProRes `'444'`                                                                                              |
| `bitrate`     | HEVC's target, in bits per second or as `'40M'` or `'2500k'`                                                                        |
| `alpha`       | `true` for ProRes 4444 and ProRes 4444 XQ                                                                                           |
| `mode`        | one of H.264's native rate tiers: `'hq'`, `'lq'` or `'2pass'`                                                                       |
| `color`       | `'rec709'`, the color space a generated `.epr` encodes                                                                              |
| `matchSource` | `true` to match the source's frame size, the default without a `resolution`                                                         |

A `Preset` is immutable. `.resize()` takes an aspect ratio on DGR's native ladder (`'16:9'`, `'1:1'`,
`'9:16'`, `'2:3'`, `'4:5'`) or a `'WxH'` size; `.bitrate()`, `.bitDepth()`, `.chroma()`, `.alpha()`
and `.with({...})` (also `.extend()`) set the rest. Each returns a new `Preset`, and `toJSON()`,
`String()` and `console.log` show its JSON.

```ts
import { encode, Preset, presets } from 'firefly-audio-video';

const vertical = presets.h264Land1080pLq.resize('9:16'); // sent as ffs_video_api_vert_1920p_lq
const master = Preset.prores4444xq.resize('3840x2160'); // a generated .epr: ProRes 4444 XQ at 4K
const hevc = encode({ codec: 'hevc', bitDepth: 10, resolution: '3840x2160' }).bitrate('40M');

console.log(String(hevc));
// {"kind":"config","config":{"codec":"hevc","bitDepth":10,"resolution":"3840x2160","bitrate":"40M"}}
```

Nothing resolves until the render. A preset whose config equals one of DGR's native presets is sent
as that `presetId`; any other is generated as an `.epr` and staged through your storage, which it
therefore needs. `dgr encode` prints the XML a config yields. The opt-in live suite
(`npm run smoke`) renders `prores`, `prores4444xq` and `hevc1080p10bit` on the service and checks
the FourCC of each file that comes back.

`render(template)` without a spec returns a builder that takes the same chain and is the job itself:
one template, one preset, and one output that your storage allocates.

```ts
import { configure, render, S3StorageProvider } from 'firefly-audio-video';

configure({
  clientId: process.env.IMS_OAUTH_S2S_CLIENT_ID!,
  clientSecret: process.env.IMS_OAUTH_S2S_CLIENT_SECRET!,
  storage: new S3StorageProvider({ bucket: 'my-renders', region: 'us-east-1' }),
});

await render('./capsule.mogrt').prores4444xq.resize('9:16').save('./master.mov');
const bytes = await render('./capsule.mogrt').hevc1080p10bit.bitrate('20M').buffer();
```

## Storage

DGR reads every input from a URL and writes every output to a presigned URL. A `StorageProvider`
bridges your bytes to that with two methods: `stageRead(input, opts)` uploads and resolves with a
presigned read URL, and `allocateOutput(opts)` resolves with `{ writeUrl, readUrl }` for one
object, which DGR writes and the asset reads back.

The client uses it for an input given as a file path, a `file:` URL, a `Buffer` or a `Readable` (a
spec's `source`, `assets` and `{ url }` presets, the template of a fluent render or a `describe()`,
and `stage()`), for every generated `.epr`, and for every output without a `destination`. An
http(s) URL, as a string or a `URL`, is used as it is and never reaches a provider. A string that
is neither an http(s) URL nor an existing file rejects `invalid_argument`.

| Provider                   | Credentials                                                                                                                           | URL lifetime (`expiresIn`) |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `AioFilesStorageProvider`  | `{ namespace, auth }`, else `__OW_NAMESPACE` and `__OW_API_KEY` inside an action, else `AIO_runtime_namespace` and `AIO_runtime_auth` | 2 to 86400 s               |
| `S3StorageProvider`        | `credentials`, else the AWS SDK's default credential chain                                                                            | 1 to 604800 s              |
| `AzureBlobStorageProvider` | a `connectionString` holding the account key, `accountName` with `accountKey`, or a `client` built with the shared key                | 1 to 604800 s              |

Every provider defaults to one hour for a staged input and 24 hours for an output, and writes its
keys under `firefly-audio-video/` unless `prefix` says otherwise. The SDK never deletes what it
stages; expire that prefix with your store's lifecycle rules.

**App Builder Files.** A client with no `storage` in an App Builder environment (`__OW_NAMESPACE`
or `AIO_runtime_namespace` set) uses an `AioFilesStorageProvider` on its own. That provider imports
`@adobe/aio-lib-files` by name at run time, which cannot reach a package webpack bundled into the
action, so a webpack-bundled action passes the module:

```ts
import * as files from '@adobe/aio-lib-files';
import { AioFilesStorageProvider, configure } from 'firefly-audio-video';

configure({
  clientId: process.env.IMS_OAUTH_S2S_CLIENT_ID!,
  clientSecret: process.env.IMS_OAUTH_S2S_CLIENT_SECRET!,
  storage: new AioFilesStorageProvider({ module: files }),
});
```

The Files library caches the SAS credentials it is given in plain text under the OS temp directory;
`cacheFile` names another file, and `cacheFile: false` turns the cache off.

**S3.** The S3 client the provider builds presigns `PUT` URLs with no checksum, so any rendered file
can be written to them. A `client` you pass must be created with
`requestChecksumCalculation: 'WHEN_REQUIRED'`: otherwise the AWS SDK signs each presigned `PUT`
with a checksum of the empty body, which no rendered file matches, and the provider refuses that
write URL with `invalid_argument`.

**Azure.** Every SAS the provider returns is signed with the account key, so a connection string
that holds only a `SharedAccessSignature` is refused. A staged input gets a read-only SAS; an output
gets a create-and-write SAS for DGR and a read SAS for the asset. On an HTTPS endpoint each SAS is
valid over HTTPS only, and the container must already exist.

`AioFilesStorageProvider` and `S3StorageProvider` read a `Readable` into memory before the upload,
which needs its length, so stage a large file by its path; `AzureBlobStorageProvider` uploads a
stream in blocks.

**Your own.** Any object with those two methods is a provider, for Google Cloud Storage or any
store that signs URLs. `PassthroughStorageProvider` keeps a client from ever uploading, App Builder
included.

```ts
import { randomUUID } from 'node:crypto';
import type { StageInput, StorageProvider } from 'firefly-audio-video';

// upload() and presign() stand for your store's own SDK calls.
declare function upload(key: string, input: StageInput, contentType?: string): Promise<void>;
declare function presign(key: string, method: 'GET' | 'PUT', expiresIn?: number): Promise<string>;

export const storage: StorageProvider = {
  async stageRead(input, opts) {
    const key = opts?.key ?? `staged/${randomUUID()}`;
    await upload(key, input, opts?.contentType);
    return presign(key, 'GET', opts?.expiresIn);
  },
  async allocateOutput(opts) {
    const key = opts?.key ?? `outputs/${randomUUID()}`;
    return {
      writeUrl: await presign(key, 'PUT', opts?.expiresIn),
      readUrl: await presign(key, 'GET', opts?.expiresIn),
    };
  },
};
```

## Concurrency

Each client runs at most `concurrency` render and describe jobs at once, `10` by default
(`DEFAULT_CONCURRENCY`); further calls wait their turn in order. There is no batch API: loop over
`render()`, and the pool bounds the fan-out.

```ts
import { createClient, S3StorageProvider } from 'firefly-audio-video';

const client = createClient({
  clientId: process.env.IMS_OAUTH_S2S_CLIENT_ID!,
  clientSecret: process.env.IMS_OAUTH_S2S_CLIENT_SECRET!,
  storage: new S3StorageProvider({ bucket: 'my-renders' }),
  concurrency: 4,
});

const templates = ['./intro.mogrt', './lower-third.mogrt', './outro.mogrt'];
const masters = await Promise.all(templates.map((template) => client.render(template).prores));
```

A job holds its slot from staging until it settles. Its uploads, generated `.epr` files and output
allocations run once it is admitted, just before its submit, so a staged URL is fresh however long
the job queued, and at most `concurrency` jobs hold upload bytes at once. A `resolveAs` download
runs after the slot is released, and `status()`, `cancel()`, `listPresets()` and `stage()` take no
slot.

A `429` is retried with backoff, honoring `Retry-After` up to 60 s and otherwise exponential with
jitter, up to `retry: { maxRetries }` times (default `5`). The pool counts per process: several
processes sharing one credential coordinate through a `PoolBackend` of your own, passed as `pool`.

## Downloads

An `Asset` is a presigned read URL and the ways to consume it. `asset.url` costs nothing; each of
these makes its own request:

| Method       | Result                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `buffer()`   | the whole file in memory                                                                                 |
| `stream()`   | a Node `Readable`; the request starts on the first read                                                  |
| `save(path)` | streams to a temporary file beside `path` and renames it into place; on failure `path` is left as it was |

Every download resumes. A body cut off mid-transfer continues with a `Range` request for the missing
bytes, conditional on the file being unchanged (`If-Range`). `retries` (default `3`; `0` turns
resuming off) bounds how often one download re-requests, each retry after a jittered backoff of at
most two seconds. When the server cannot resume, `save()` starts over within the same budget, while
`stream()` and `buffer()` fail with `asset_fetch_failed`, because bytes already delivered cannot be
taken back. A `signal` aborts any of them with `cancelled`. The fluent builder's `buffer()`,
`stream()` and `save()` take the same options.

```ts
import type { Asset } from 'firefly-audio-video';

export async function deliver(asset: Asset): Promise<void> {
  await asset.save('./master.mov', { retries: 5, signal: AbortSignal.timeout(10 * 60_000) });
}
```

`asset.meta` carries the job's timing (`queueMs`, `renderMs`, `totalMs`, and the same per output).
`asset.url` is unredacted, since it is the working handle; `toJSON()`, `toString()` and
`console.log(asset)` show it redacted.

## Logging

Every `render`, `describe`, `listPresets`, `status`, `cancel` and `stage` call writes one NDJSON
record to stdout when it settles; importing the package writes nothing. A record from `render()`:

```text
{"time":"2026-09-30T07:38:51.173Z","level":"info","msg":"render completed","endpoint":"POST /v1/templates/render","jobId":"8c1f2e4a-5b6d-4e7f-9a0b-1c2d3e4f5a6b","queueMs":5000,"renderMs":30000,"totalMs":35000,"preset":"ffs_video_api_land_1080p_hq","codec":"h264","resolution":"1920x1080","totalJobItems":1,"status":"succeeded"}
```

`time` (ISO-8601), `level` (`info`, `warn` for a cancelled call, `error`) and `msg` lead, then flat
fields: `endpoint`, `jobId`, `queueMs`, `renderMs`, `totalMs`, `preset`, `codec`, `resolution`,
`totalJobItems`, `status`, and `error` as one `code: message` string. Every value is a string or a
number, so a column-based ingester maps each field to a column; a field with no value is left out.

| `logging`             | Effect                                              |
| --------------------- | --------------------------------------------------- |
| omitted or `true`     | records on stdout                                   |
| `false`               | no records                                          |
| `'warn'` or `'error'` | records on stdout at that level and above           |
| a `Logger`            | any `{ log(record) }`, such as an adapter over pino |

```ts
import { createClient, rotatingFileLogger, stdoutJsonLogger } from 'firefly-audio-video';

const credentials = {
  clientId: process.env.IMS_OAUTH_S2S_CLIENT_ID!,
  clientSecret: process.env.IMS_OAUTH_S2S_CLIENT_SECRET!,
};

const toFile = createClient({
  ...credentials,
  logging: rotatingFileLogger({
    path: './logs/dgr.ndjson',
    maxBytes: 5 * 1024 * 1024,
    maxFiles: 3,
  }),
});
const toStderr = createClient({
  ...credentials,
  logging: stdoutJsonLogger({ stream: process.stderr, minLevel: 'warn' }),
});
```

Each record is redacted before any sink sees it, and a sink that throws never breaks the call; its
first failure is reported once on stderr. One message bypasses the logger: the official IMS token
provider writes `Error while fetching token` to `console.error` when a request to IMS fails or its
reply is not JSON, and `logging: false` does not silence it.

Inside an App Builder action, stdout is the activation log, and App Builder log forwarding ships it
to Splunk, Azure Log Analytics or New Relic. Splunk and New Relic are expected to parse each record
into fields; whether Azure Log Analytics splits the JSON keys into columns has not been verified.

## Errors

Every rejection and throw is an `AudioVideoError`: an `Error` with a stable `.code` to switch on,
`.status` (HTTP), `.jobId`, `.requestId` (the response's `x-request-id`), `.items` (detail such as
each failed output's errors) and a native `.cause`.

```ts
import { AudioVideoError, render, type RenderRequest } from 'firefly-audio-video';

export async function renderOrReport(spec: RenderRequest) {
  try {
    return await render(spec);
  } catch (error) {
    if (error instanceof AudioVideoError && error.code === 'job_failed') {
      console.error(error.jobId, error.items); // one entry per failed output, redacted
    }
    throw error;
  }
}
```

| Code                      | Meaning                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `invalid_argument`        | An input, option or config is invalid, or an input needs storage and none is configured; nothing was submitted. |
| `invalid_preset`          | An unknown preset, an unreadable `.epr`, or a config its codec cannot produce.                                  |
| `missing_peer_dependency` | A storage provider's SDK is not installed; the message names the `npm install` command.                         |
| `auth_failed`             | IMS refused the credential or did not answer within 30 seconds, or your `tokenProvider` threw.                  |
| `submit_failed`           | The submit's response named no job ID or status URL.                                                            |
| `job_failed`              | The job failed or reported errors; `.items` lists the errors per output.                                        |
| `job_poll_failed`         | Five status polls in a row failed transiently. The job may still finish; its ID is on the error.                |
| `cancelled`               | `cancel()`, an aborted `signal`, or the service cancelled the job.                                              |
| `invalid_response`        | The service answered with something the SDK cannot use.                                                         |
| `http_<status>`           | A non-2xx response left after retries, such as `http_404`; `.items` holds the redacted body.                    |
| `request_timeout`         | One HTTP attempt ran past 30 seconds.                                                                           |
| `request_failed`          | The request failed in transit: DNS, a refused or reset connection.                                              |
| `storage_failed`          | A storage provider failed to load, upload or presign.                                                           |
| `asset_fetch_failed`      | A download failed, could not resume, or ran out of retries.                                                     |
| `internal_error`          | An embedded `.epr` template lost its shape: a bug in this package.                                              |

Errors are redacted when they are built. `.message`, `.items`, `toJSON()`, `toString()` and
`console.log(error)` never carry a bearer token, an `x-api-key`, a presigned URL's signature (Azure
SAS, AWS SigV4 and SigV2, Google Cloud Storage V4 and V2), a connection string's key, or a JWT.
`.jobId` and `.requestId` stay as the service sent them. `.cause` holds the underlying error for
inspection and is left out of every serialized form.

## CLI

`npx firefly-audio-video <command>` runs it without an install; installed, the command is `dgr`.

```sh
dgr render --template ./capsule.mogrt --preset prores4444xq --out ./master.mov --storage s3://my-renders/dgr
dgr render --spec ./render.json --json            # a spec file: { source, presets, outputs }
dgr describe ./capsule.mogrt --storage s3://my-renders/dgr
dgr presets                                       # the catalog, offline; --remote asks the service
dgr status 8c1f2e4a-5b6d-4e7f-9a0b-1c2d3e4f5a6b
dgr cancel 8c1f2e4a-5b6d-4e7f-9a0b-1c2d3e4f5a6b
dgr stage ./logo.png --storage azure://assets
dgr encode '{"codec":"hevc","bitDepth":10,"resolution":"3840x2160"}' --out ./hevc-4k.epr
```

`render` takes `--spec <file>`, or `--template` with one of `--preset` (a catalog name, a native
preset ID or an `.epr` path) or `--encode <json>`. It prints the output's URL, or saves the file
with `--out`. The first Ctrl+C cancels the job; a second exits at once.

`--json` prints exactly one JSON document on stdout, success or failure, usage errors included:
`{ "ok": true, ... }` with the command's fields, or
`{ "ok": false, "error": { "code", "message", "jobId"?, "requestId"? } }`.

| Command            | `--json` fields                                     |
| ------------------ | --------------------------------------------------- |
| `render`           | `jobId`, `output`, `queueMs`, `renderMs`, `totalMs` |
| `describe`         | `controls`, `fonts`                                 |
| `presets`          | `presets`                                           |
| `status`, `cancel` | `job`                                               |
| `stage`            | `url`                                               |
| `encode`           | `xml`, or `path` with `--out`                       |

`--log` writes the SDK's NDJSON records to stderr; without it the CLI writes none, so stdout carries
only the result.

Credentials come from `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET` and
`IMS_OAUTH_S2S_SCOPES`, in the environment or a `.env` in the working directory, or from
`--client-id`, `--client-secret` and `--scope`. Prefer the environment: a value on the command line
is visible to other processes on the machine.

`render`, `describe` and `stage` stage through `--storage <uri>`, or `DGR_STORAGE`:

| `--storage`                      | Provider                   | Also reads                                                                                       |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `s3://<bucket>[/<prefix>]`       | `S3StorageProvider`        | the AWS SDK's credential chain; the region from `--region`, `AWS_REGION` or `AWS_DEFAULT_REGION` |
| `azure://<container>[/<prefix>]` | `AzureBlobStorageProvider` | `AZURE_STORAGE_CONNECTION_STRING`, never a flag, since it carries the account key                |
| `aio-files`                      | `AioFilesStorageProvider`  | `AIO_runtime_namespace` and `AIO_runtime_auth`                                                   |

Without either, a command in an App Builder environment uses App Builder Files, as the library does.

Exit codes, as `dgr --help` lists them:

| Exit code | Meaning                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`       | success                                                                                                                                                |
| `2`       | a usage error, or the SDK rejected `invalid_argument`, `invalid_preset` or `missing_peer_dependency`                                                   |
| `3`       | `auth_failed`                                                                                                                                          |
| `4`       | the job failed, timed out or returned an invalid response, or it was cancelled from outside this process                                               |
| `5`       | a network or HTTP failure: `request_failed`, `request_timeout`, `http_*`, `submit_failed`, `job_poll_failed`, `asset_fetch_failed` or `storage_failed` |
| `130`     | cancelled by this process's own Ctrl+C                                                                                                                 |
| `1`       | anything else                                                                                                                                          |

## Release channels

| Channel              | Install                                                  | Published                                                       |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `latest`             | `npm i firefly-audio-video`                              | on each release, when the release pull request merges           |
| `next`               | `npm i firefly-audio-video@next`                         | on every green push to `main`, as `<x.y.z+1>-next.<run>.g<sha>` |
| pull request preview | the install command pkg.pr.new posts on the pull request | on every pull request, once pkg.pr.new is connected             |

Every version is published from GitHub Actions with `npm publish --provenance`, so npm carries a
signed statement of the commit and workflow that built it; `npm audit signatures` checks it. The
publish flow and its gates are in
[CONTRIBUTING.md](https://github.com/ellyseum/firefly-audio-video/blob/main/CONTRIBUTING.md).

## Design notes

| Choice                                | Reason                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@adobe/firefly-services-common-apis` | IMS tokens come from the Firefly Services SDK's own `ServerToServerTokenProvider`. The SDK guards it: a refused credential rejects `auth_failed` rather than yielding an empty token, expiry is read from the token's claims, and a stalled request times out after 30 seconds without blocking later calls. |
| `zod`                                 | Every public input is validated at the boundary, with a message naming the field; the exported input types are inferred from the same schemas.                                                                                                                                                               |
| `commander`, `dotenv`                 | The CLI's argument parser and its `.env`.                                                                                                                                                                                                                                                                    |
| A zero-dependency logger              | One synchronous `write` per record: nothing for a webpack build to special-case, and no worker thread or buffer to lose lines when a short-lived action freezes.                                                                                                                                             |
| A hand-rolled `429` loop              | It reads `Retry-After` on a `429` only, so an accepted submit is never delayed, caps every wait at 60 s, and stops mid-wait when the caller's `AbortSignal` fires.                                                                                                                                           |
| `InMemoryPool` rather than `p-limit`  | `p-limit` 4 and later ship as ES modules only, and this package publishes CommonJS and ESM builds; the pool is a FIFO limiter with no timers.                                                                                                                                                                |

## Files

| Path                                                                                                                                                      | Holds                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                                                                            | every public export                                                                                                                                                                          |
| `src/dgr/`                                                                                                                                                | the client and top-level functions, the fluent builder, render and describe, `Preset`, and the zod input schemas                                                                             |
| `src/core/`                                                                                                                                               | the capability-neutral spine: auth, HTTP with `429` retries, the job poller, the pool, `Asset`, logging, redaction, errors and the `StorageProvider` interface                               |
| `src/presets/`                                                                                                                                            | the catalog and the `.epr` generator with its embedded templates                                                                                                                             |
| `src/storage/`                                                                                                                                            | the App Builder Files, S3 and Azure providers, and the loader for their optional peers                                                                                                       |
| `src/cli.ts`, `src/cli/`                                                                                                                                  | the `dgr` CLI                                                                                                                                                                                |
| `test/`                                                                                                                                                   | the unit suite; `test/smoke/` holds the live render suite                                                                                                                                    |
| `scripts/`                                                                                                                                                | `runtime-smoke.mjs`, `bundle-smoke.mjs`, `verify-pack-contents.mjs` and `check-release-gate.mjs` (see [Commands](#commands))                                                                 |
| `.github/workflows/`                                                                                                                                      | `quality.yml` (every gate on Node 22 and 24, the runtime smoke on 18 through 24, actionlint, commitlint, a dependency audit), `release.yml`, `pkg-pr-new.yml`, `codeql.yml`, `scorecard.yml` |
| `tsup.config.ts`, `tsconfig.json`, `vitest.config.ts`, `vitest.smoke.config.ts`, `eslint.config.js`, `commitlint.config.js`, `release-please-config.json` | build, type, test, lint, commit and release configuration                                                                                                                                    |

## Commands

Runnable here:

| Command                                 | Does                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                | installs the locked dependencies and the git hooks                                                                                                                                                          |
| `npm run build`                         | builds `dist/`: ESM, CommonJS and type declarations                                                                                                                                                         |
| `npm run typecheck`                     | `tsc --noEmit` over `src/` and `test/`                                                                                                                                                                      |
| `npm run lint`                          | ESLint                                                                                                                                                                                                      |
| `npm run format:check`                  | Prettier, checking only                                                                                                                                                                                     |
| `npm run format`                        | Prettier, writing                                                                                                                                                                                           |
| `npm test`                              | the unit suite                                                                                                                                                                                              |
| `npm run coverage`                      | the unit suite with coverage and its thresholds                                                                                                                                                             |
| `npm run runtime-smoke`                 | exercises the built `dist/` on the running Node, with no dependencies (after `npm run build`)                                                                                                               |
| `npm run bundle-smoke`                  | bundles an application against the built package without the storage peers; each provider must reject `missing_peer_dependency` (after `npm run build`)                                                     |
| `node scripts/verify-pack-contents.mjs` | a dry-run publish whose file list must be `dist/`, `LICENSE`, `README.md` and `package.json`                                                                                                                |
| `node scripts/check-release-gate.mjs`   | checks the publish gates in `release.yml`                                                                                                                                                                   |
| `npm run smoke`                         | live renders, one per codec path, each checked by the FourCC it asked for; billed, and skipped unless `IMS_OAUTH_S2S_CLIENT_ID` is set (the top of `test/smoke/render.smoke.test.ts` lists its environment) |

Publishes or deploys, run by the workflows and not here:

| Command                                               | Run by                                          |
| ----------------------------------------------------- | ----------------------------------------------- |
| `npm publish --provenance --access public`            | `release.yml`, publishing `latest` on a release |
| `npm publish --provenance --tag next --access public` | `release.yml`, publishing `next` from `main`    |
| `npx --no-install pkg-pr-new publish`                 | `pkg-pr-new.yml`, previewing a pull request     |

## Security

Report a vulnerability privately through the repository's Security tab; see
[SECURITY.md](https://github.com/ellyseum/firefly-audio-video/blob/main/SECURITY.md).

## Contributing

[CONTRIBUTING.md](https://github.com/ellyseum/firefly-audio-video/blob/main/CONTRIBUTING.md) covers
the release channels and the publish flow. Commits follow Conventional Commits, checked by
commitlint, and participation follows the
[Code of Conduct](https://github.com/ellyseum/firefly-audio-video/blob/main/CODE_OF_CONDUCT.md).

## License

[Apache-2.0](https://github.com/ellyseum/firefly-audio-video/blob/main/LICENSE). Copyright 2026
Adobe Inc.

Maintained by [ellyseum](https://github.com/ellyseum).
