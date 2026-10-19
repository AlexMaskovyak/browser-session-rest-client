import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collect, createPlaywrightFetch, redactUrl, requestContextFromStorageState, validateManifest } from '../src/index.js';

const artifact = { id: 'one', url: 'https://example.test/file?role_id=123', filename: 'one.pdf', expected: { contentType: 'application/pdf', magic: '%PDF-', minBytes: 6 } };

test('direct transport imports do not load optional Playwright', async () => {
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier === 'playwright-core') throw new Error('Playwright must not load');
    return next(specifier, context);
  }`;
  const entry = new URL('../src/index.js', import.meta.url).href;
  const script = `const api = await import(${JSON.stringify(entry)}); if (typeof api.createAuthenticatedFetch !== 'function') process.exit(2);`;
  await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-loader', `data:text/javascript,${encodeURIComponent(loader)}`, '--input-type=module', '-e', script]);
});

test('rejects duplicate ids, unsafe paths, mutations, and secret fields', () => {
  assert.throws(() => validateManifest({ version: 1, artifacts: [artifact, artifact] }), /Duplicate/);
  assert.throws(() => validateManifest({ version: 1, artifacts: [{ ...artifact, filename: '../x' }] }), /Unsafe/);
  for (const filename of ['.', '..', 'sub\\file.pdf', 'sub/file.pdf', 'bad\0.pdf']) {
    assert.throws(() => validateManifest({ version: 1, artifacts: [{ ...artifact, filename }] }), /Unsafe/);
  }
  assert.throws(() => validateManifest({ version: 1, artifacts: [{ ...artifact, method: 'POST' }] }), /Unsupported/);
  assert.throws(() => validateManifest({ version: 1, cookie: 'secret', artifacts: [] }), /Secret-bearing/);
});

test('redacts sensitive query values', () => {
  assert.equal(redactUrl(artifact.url), 'https://example.test/file?role_id=REDACTED');
  const url = 'https://synthetic:synthetic@example.test/file?cookie=synthetic&csrf=synthetic&password=synthetic&session=synthetic&credential=synthetic&date=2026-01-01#synthetic';
  assert.equal(redactUrl(url), 'https://example.test/file?cookie=REDACTED&csrf=REDACTED&password=REDACTED&session=REDACTED&credential=REDACTED&date=2026-01-01');
});

test('downloads atomically and resumes a verified artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-session-client-'));
  const outputDir = path.join(root, 'out');
  const ledgerPath = path.join(root, 'results.json');
  let calls = 0;
  const transport = { request: async ({ url }) => { calls += 1; return { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-ok'), url }; } };
  const manifest = { version: 1, artifacts: [artifact] };
  await collect({ manifest, outputDir, ledgerPath, transport });
  await collect({ manifest, outputDir, ledgerPath, transport });
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(outputDir, 'one.pdf'), 'utf8'), '%PDF-ok');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.equal(ledger.results.one.status, 'complete');
  assert.equal(ledger.results.one.url, 'https://example.test/file?role_id=REDACTED');
});

test('does not replace a file with invalid content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-session-client-'));
  const outputDir = path.join(root, 'out');
  const ledgerPath = path.join(root, 'results.json');
  await collect({ manifest: { version: 1, artifacts: [artifact] }, outputDir, ledgerPath, transport: { request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('login') }) } });
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.equal(ledger.results.one.status, 'failed');
  await assert.rejects(readFile(path.join(outputDir, 'one.pdf')));
});

test('retries transient failures but not authentication failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-session-client-'));
  let transientCalls = 0;
  const transient = { request: async ({ url }) => {
    transientCalls += 1;
    if (transientCalls < 3) return { status: 503, headers: {}, body: Buffer.alloc(0), url };
    return { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-ok'), url };
  } };
  const ledger = await collect({ manifest: { version: 1, artifacts: [artifact] }, outputDir: path.join(root, 'out'), ledgerPath: path.join(root, 'transient.json'), transport: transient, sleep: async () => {} });
  assert.equal(transientCalls, 3);
  assert.equal(ledger.results.one.attempts, 3);

  let authCalls = 0;
  const auth = { request: async ({ url }) => { authCalls += 1; return { status: 401, headers: {}, body: Buffer.alloc(0), url }; } };
  const failed = await collect({ manifest: { version: 1, artifacts: [{ ...artifact, id: 'auth', filename: 'auth.pdf' }] }, outputDir: path.join(root, 'auth-out'), ledgerPath: path.join(root, 'auth.json'), transport: auth, sleep: async () => {} });
  assert.equal(authCalls, 1);
  assert.equal(failed.results.auth.status, 'failed');
  assert.equal(failed.results.auth.attempts, 1);
});

test('adapts an authenticated Playwright request context to Fetch', async () => {
  const calls = [];
  const requestContext = { fetch: async (url, options) => {
    calls.push({ url, options });
    return {
      ok: () => true,
      status: () => 200,
      url: () => url,
      headers: () => ({ 'content-type': 'application/json' }),
      body: async () => Buffer.from('{"ok":true}')
    };
  } };
  const response = await createPlaywrightFetch(requestContext)(new URL('https://example.test/items'), { method: 'GET' });
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls[0].options.failOnStatusCode, false);
  assert.equal(calls[0].options.maxRedirects, 0);
});

test('rejects a storage-state file with broad permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-session-client-'));
  const storageState = path.join(root, 'state.json');
  await writeFile(storageState, '{"cookies":[],"origins":[]}');
  await chmod(storageState, 0o644);
  await assert.rejects(requestContextFromStorageState(storageState), /must not be accessible/);
});
