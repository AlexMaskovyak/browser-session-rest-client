import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collect, redactUrl, validateManifest } from '../src/index.js';

const artifact = { id: 'one', url: 'https://example.test/file?role_id=123', filename: 'one.pdf', expected: { contentType: 'application/pdf', magic: '%PDF-', minBytes: 6 } };

test('rejects duplicate ids, unsafe paths, mutations, and secret fields', () => {
  assert.throws(() => validateManifest({ version: 1, artifacts: [artifact, artifact] }), /Duplicate/);
  assert.throws(() => validateManifest({ version: 1, artifacts: [{ ...artifact, filename: '../x' }] }), /Unsafe/);
  assert.throws(() => validateManifest({ version: 1, artifacts: [{ ...artifact, method: 'POST' }] }), /Unsupported/);
  assert.throws(() => validateManifest({ version: 1, cookie: 'secret', artifacts: [] }), /Secret-bearing/);
});

test('redacts sensitive query values', () => {
  assert.equal(redactUrl(artifact.url), 'https://example.test/file?role_id=REDACTED');
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
