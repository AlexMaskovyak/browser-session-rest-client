import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedFetch, createBrowserCompatibleFetch } from '../src/index.js';

const origin = 'https://example.test';
test('writes remain disabled by default and require an exact synchronous guard', async () => {
  let calls = 0;
  const make = (authorizeWrite) => createAuthenticatedFetch({ origin, headers: {}, authorizeWrite, fetchImpl: async () => { calls++; return new Response('ok'); } });
  for (const guard of [undefined, () => false, async () => true, () => { throw Error('secret'); }]) {
    await assert.rejects(make(guard)(origin, { method: 'PUT', body: new Uint8Array([1]) }));
  }
  assert.equal(calls, 0);
});
test('copies binary bodies before the guard and rejects streams, oversized and cross-origin writes', async () => {
  const bytes = new Uint8Array([1, 2]);
  const fetch = createAuthenticatedFetch({ origin, headers: {}, authorizeWrite: ({ method, body }) => { assert.equal(method, 'PUT'); body[0] = 9; bytes[1] = 9; return true; }, fetchImpl: async (_, init) => { assert.deepEqual([...init.body], [1, 2]); return new Response(); } });
  await fetch(origin, { method: 'PUT', body: bytes });
  await assert.rejects(fetch('https://other.test', { method: 'PUT', body: bytes }), /origin/);
  await assert.rejects(fetch(origin, { method: 'PUT', body: new Uint8Array(16 * 1024 * 1024 + 1) }), /exceeds/);
  await assert.rejects(fetch(new Request(origin, { method: 'POST', body: 'stream' })), /explicit/);
});
test('write redirects stop without retrying or leaking transport errors', async () => {
  let calls = 0;
  const fetch = createAuthenticatedFetch({ origin, headers: {}, authorizeWrite: () => true, fetchImpl: async () => { calls++; return new Response(null, { status: 307, headers: { location: '/next' } }); } });
  await assert.rejects(fetch(origin, { method: 'PUT', body: 'bytes' }), /PUT redirects/);
  assert.equal(calls, 1);
});
test('browser-compatible writes encode arbitrary bytes only through stdin', async () => {
  const fetch = createBrowserCompatibleFetch({ authorizeWrite: ({ method }) => method === 'PUT', command: process.execPath, args: ['-e', `
    let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end', ()=>{
      const r=JSON.parse(input);
      if(r.authorizedWrite!==true || r.bodyBase64!=='AP+A' || r.method!=='PUT')process.exit(2);
      process.stdout.write(JSON.stringify({status:200,headers:[],url:r.url,body:''}));
    });`, '--'] });
  assert.equal((await fetch(origin, { method: 'PUT', body: new Uint8Array([0, 255, 128]) })).status, 200);
});
