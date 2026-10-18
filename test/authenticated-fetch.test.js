import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { collect, createAuthenticatedFetch, createFetchTransport, readCredentialsFromStdin } from '../src/index.js';

const origin = 'https://example.test';
const headers = { Cookie: 'session=private-value', Authorization: 'Bearer private-value' };

test('sends runtime authentication on allowed read requests and protects supplied credentials', async () => {
  const calls = [];
  const fetch = createAuthenticatedFetch({ origin, headers, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('ok');
  } });
  await fetch(`${origin}/records`, { headers: { cookie: 'replacement', accept: 'application/json' } });
  await fetch(new Request(`${origin}/metadata`, { method: 'HEAD' }));
  assert.equal(calls[0].init.headers.get('cookie'), headers.Cookie);
  assert.equal(calls[0].init.headers.get('authorization'), headers.Authorization);
  assert.equal(calls[0].init.headers.get('accept'), 'application/json');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[1].init.method, 'HEAD');
});

test('blocks mutations, bodies, other origins, and URL credentials before sending', async () => {
  let calls = 0;
  const fetch = createAuthenticatedFetch({ origin, headers, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(fetch(`${origin}/x`, { method: 'POST' }), /Only GET and HEAD/);
  await assert.rejects(fetch(`${origin}/x`, { body: 'x' }), /must not contain a body/);
  await assert.rejects(fetch('https://other.test/x'), /origin is not allowed/);
  await assert.rejects(fetch('https://name:secret@example.test/x'), /origin is not allowed/);
  assert.equal(calls, 0);
});

test('follows relative redirects only inside the configured origin', async () => {
  const calls = [];
  const fetch = createAuthenticatedFetch({ origin, headers, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: '/final' } }) : new Response('ok');
  } });
  assert.equal(await (await fetch(`${origin}/start`)).text(), 'ok');
  assert.equal(calls[1].url, `${origin}/final`);
  assert.equal(calls[1].init.headers.get('cookie'), headers.Cookie);

  let blockedCalls = 0;
  const blocked = createAuthenticatedFetch({ origin, headers, fetchImpl: async () => {
    blockedCalls += 1;
    return new Response(null, { status: 302, headers: { location: 'https://attacker.test/steal' } });
  } });
  await assert.rejects(blocked(`${origin}/start`), /origin is not allowed/);
  assert.equal(blockedCalls, 1);
});

test('bounds redirects and preserves authentication status responses', async () => {
  let calls = 0;
  const looping = createAuthenticatedFetch({ origin, headers, maxRedirects: 1, fetchImpl: async () => {
    calls += 1;
    return new Response(null, { status: 307, headers: { location: '/again' } });
  } });
  await assert.rejects(looping(`${origin}/start`), /Redirect limit exceeded/);
  assert.equal(calls, 2);
  const expired = createAuthenticatedFetch({ origin, headers, fetchImpl: async () => new Response(null, { status: 401 }) });
  assert.equal((await expired(`${origin}/x`)).status, 401);
});

test('sanitizes credential-bearing errors and reads bounded stdin without persisting', async () => {
  const fetch = createAuthenticatedFetch({ origin, headers, fetchImpl: async () => { throw new Error(headers.Cookie); } });
  await assert.rejects(fetch(`${origin}/x`), { message: 'Authenticated request failed' });
  const configuration = { origin, headers, records: [{ href: '/one', text: 'one' }] };
  assert.deepEqual(await readCredentialsFromStdin(Readable.from([JSON.stringify(configuration)])), configuration);
  await assert.rejects(readCredentialsFromStdin(Readable.from(['{"cookie":"private-value"'])), { message: 'Runtime configuration must be valid JSON' });
  await assert.rejects(readCredentialsFromStdin(Readable.from(['large']), { maxBytes: 2 }), /size limit/);
  assert.throws(() => createAuthenticatedFetch({ origin: `${origin}/wrong`, headers }), /exact HTTP or HTTPS origin/);
  assert.throws(() => createAuthenticatedFetch({ origin, headers: { Cookie: 'bad\nvalue' } }), /Invalid authentication headers/);
});

test('collector uses runtime Fetch authentication without writing it to the ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'authenticated-fetch-'));
  let calls = 0;
  const fetch = createAuthenticatedFetch({ origin, headers, fetchImpl: async (_url, init) => {
    calls += 1;
    assert.equal(init.headers.get('cookie'), headers.Cookie);
    return new Response('%PDF-ok', { headers: { 'content-type': 'application/pdf' } });
  } });
  const ledgerPath = path.join(root, 'ledger.json');
  const ledger = await collect({
    manifest: { version: 1, artifacts: [{ id: 'one', filename: 'one.pdf', url: `${origin}/file`, expected: { magic: '%PDF-' } }] },
    outputDir: root, ledgerPath, transport: createFetchTransport(fetch)
  });
  assert.equal(ledger.results.one.status, 'complete');
  assert.equal(calls, 1);
  assert.equal((await readFile(ledgerPath, 'utf8')).includes('private-value'), false);
});

test('collector does not retry a rejected origin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'authenticated-fetch-'));
  const fetch = createAuthenticatedFetch({ origin, headers, fetchImpl: async () => { throw new Error('Should not send'); } });
  const ledger = await collect({
    manifest: { version: 1, artifacts: [{ id: 'one', filename: 'one.pdf', url: 'https://other.test/file' }] },
    outputDir: root, ledgerPath: path.join(root, 'ledger.json'), transport: createFetchTransport(fetch),
    sleep: async () => { assert.fail('Policy failures must not retry'); }
  });
  assert.equal(ledger.results.one.attempts, 1);
});
