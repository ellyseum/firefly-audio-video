import { expect, test } from 'vitest';
import { AudioVideoError } from '../src/core/errors.js';
import { exportOf, loadPeer, type Peer } from '../src/storage/peer.js';

const S3: Peer = {
  specifier: '@aws-sdk/client-s3',
  provider: 'S3StorageProvider',
  install: 'npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
  option: 's3',
};

/** The `AudioVideoError` a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<AudioVideoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AudioVideoError);
    return error as AudioVideoError;
  }
  throw new Error('expected a rejection');
}

/** An importer that fails the way the runtime does for a module it cannot find. */
function notFound(code: string, message = "Cannot find package '@aws-sdk/client-s3'") {
  return () => Promise.reject(Object.assign(new Error(message), { code }));
}

test('a peer import() cannot find rejects missing_peer_dependency naming the install command and the option', async () => {
  const error = await rejection(loadPeer(S3, notFound('ERR_MODULE_NOT_FOUND')));
  expect(error.code).toBe('missing_peer_dependency');
  expect(error.message).toContain('S3StorageProvider needs @aws-sdk/client-s3');
  expect(error.message).toContain('`npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`');
  expect(error.message).toContain('pass the module as the s3 option instead');
  expect((error.cause as Error & { code?: string }).code).toBe('ERR_MODULE_NOT_FOUND');
});

test("require()'s MODULE_NOT_FOUND — a CommonJS or bundled load — is a missing peer too", async () => {
  const error = await rejection(loadPeer(S3, notFound('MODULE_NOT_FOUND')));
  expect(error.code).toBe('missing_peer_dependency');
});

test('any other load failure rejects storage_failed with a redacted cause', async () => {
  const leak = 'https://acct.blob.core.windows.net/c/x?sv=2021&sig=LOADER_SIG_LEAK';
  const error = await rejection(
    loadPeer(S3, () => Promise.reject(new SyntaxError(`Unexpected token in ${leak}`))),
  );
  expect(error.code).toBe('storage_failed');
  expect(error.message).toBe('Loading @aws-sdk/client-s3 for S3StorageProvider failed.');
  expect((error.cause as Error).message).not.toContain('LOADER_SIG_LEAK');
  expect((error.cause as Error).name).toBe('SyntaxError');
});

test('a missing peer keeps a signed URL in the loader error out of its cause', async () => {
  const error = await rejection(
    loadPeer(S3, notFound('ERR_MODULE_NOT_FOUND', 'from https://x.example/y?sig=NOT_FOUND_SIG')),
  );
  expect((error.cause as Error).message).not.toContain('NOT_FOUND_SIG');
});

test('the default importer loads an installed peer by name at run time', async () => {
  const module = await loadPeer(S3);
  expect(typeof exportOf(module, 'S3Client', S3)).toBe('function');
});

test('exportOf reads an own export, else a property of the default export, else rejects storage_failed', () => {
  const own = { init: () => 'own' };
  const commonJs = { default: { init: () => 'default' } };
  expect(exportOf(own, 'init', S3)).toBe(own.init);
  expect(exportOf(commonJs, 'init', S3)).toBe(commonJs.default.init);
  for (const module of [{}, { default: 42 }, null, 'not a module']) {
    let error: unknown;
    try {
      exportOf(module, 'init', S3);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AudioVideoError);
    expect((error as AudioVideoError).code).toBe('storage_failed');
    expect((error as AudioVideoError).message).toBe(
      '@aws-sdk/client-s3 does not export init, which S3StorageProvider needs.',
    );
  }
});
