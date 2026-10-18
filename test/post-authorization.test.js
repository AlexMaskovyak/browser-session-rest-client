import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticatedFetch, createBrowserCompatibleFetch } from '../src/index.js';

const origin = 'https://example.test';
const endpoint = `${origin}/query`;
const body = '{"query":"synthetic_read","variables":{"label":"é"}}';
const permits = (request) => request.url === endpoint && request.body === body;

test('POST requires exact caller authorization and preserves the authorized string', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('ok'); };
  const denied = createAuthenticatedFetch({ origin, headers: {}, fetchImpl });
  await assert.rejects(denied(endpoint, { method: 'POST', body }), /explicit POST authorization/);
  const fetch = createAuthenticatedFetch({ origin, headers: {}, fetchImpl, authorizePost: permits });
  await assert.rejects(fetch(`${origin}/other`, { method: 'POST', body }), /not authorized/);
  await assert.rejects(fetch(endpoint, { method: 'POST', body: '{}' }), /not authorized/);
  assert.equal(calls.length, 0);
  await fetch(endpoint, { method: 'POST', body });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, body);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('origin and body validation precede POST authorization and transport', async () => {
  let authorizations = 0;
  const fetch = createAuthenticatedFetch({
    origin, headers: {}, authorizePost: () => { authorizations += 1; return true; },
    fetchImpl: async () => assert.fail('Invalid request reached transport')
  });
  for (const url of ['https://other.test/query', 'https://name:secret@example.test/query']) {
    await assert.rejects(fetch(url, { method: 'POST', body }), /origin is not allowed/);
  }
  for (const invalid of [undefined, {}, Buffer.from(body), 'é'.repeat(1024 * 1024)]) {
    await assert.rejects(fetch(endpoint, { method: 'POST', body: invalid }), /explicit string body/);
  }
  const request = new Request(endpoint, { method: 'POST', body });
  await assert.rejects(fetch(request, { body }), /explicit string body/);
  assert.equal(authorizations, 0);
});

test('POST authorization must synchronously return true and cannot disclose exceptions', async () => {
  for (const authorizePost of [() => false, () => 1, async () => true, async () => { throw new Error('private-value'); }]) {
    const fetch = createAuthenticatedFetch({ origin, headers: {}, authorizePost, fetchImpl: () => assert.fail('Denied request was sent') });
    await assert.rejects(fetch(endpoint, { method: 'POST', body }), { message: 'POST request is not authorized' });
  }
  const fetch = createAuthenticatedFetch({
    origin, headers: {}, authorizePost: () => { throw new Error('private-value'); },
    fetchImpl: () => assert.fail('Failed authorization was sent')
  });
  await assert.rejects(fetch(endpoint, { method: 'POST', body }), { message: 'POST authorization failed' });
});

test('authorized POST redirects never replay the request', async () => {
  for (const status of [301, 302, 303, 304, 307, 308]) {
    let calls = 0;
    const fetch = createAuthenticatedFetch({ origin, headers: {}, authorizePost: permits, fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status, headers: { location: '/other' } });
    } });
    await assert.rejects(fetch(endpoint, { method: 'POST', body }), /POST redirects are not allowed/);
    assert.equal(calls, 1);
  }
});

function worker(script, options = {}) {
  return createBrowserCompatibleFetch({ command: process.execPath, args: ['-e', script, '--'], ...options });
}

test('browser-compatible worker receives authorized POST body only through stdin', async () => {
  const fetch = worker(`
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      if (request.method !== 'POST' || request.authorizedPost !== true || request.body !== ${JSON.stringify(body)}) process.exit(2);
      if (process.argv.join(' ').includes('synthetic_read')) process.exit(3);
      process.stdout.write(JSON.stringify({status:200,headers:[],url:request.url,body:Buffer.from('ok').toString('base64')}));
    });
  `, { authorizePost: permits });
  assert.equal(await (await fetch(endpoint, { method: 'POST', body })).text(), 'ok');
});

test('browser-compatible POST validates before spawning and rejects redirects', async () => {
  const guarded = createBrowserCompatibleFetch({ command: '/nonexistent-command', authorizePost: permits });
  await assert.rejects(guarded('https://other.test/query', { method: 'POST', body }), /not authorized/);
  await assert.rejects(guarded('https://name:secret@example.test/query', { method: 'POST', body }), /origin is not allowed/);
  await assert.rejects(guarded(endpoint, { method: 'POST', body: Buffer.from(body) }), /explicit string body/);
  await assert.rejects(guarded(new Request(endpoint, { method: 'POST', body })), /explicit string body/);
  const failure = createBrowserCompatibleFetch({ command: '/nonexistent-command', authorizePost: () => { throw new Error('private-value'); } });
  await assert.rejects(failure(endpoint, { method: 'POST', body }), { message: 'POST authorization failed' });
  const redirect = worker(`process.stdout.write(JSON.stringify({status:302,headers:[['location','/other']],url:${JSON.stringify(endpoint)},body:''}))`, { authorizePost: permits });
  await assert.rejects(redirect(endpoint, { method: 'POST', body }), /POST redirects are not allowed/);
});
