import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCompatibleFetch } from '../src/index.js';

function worker(script, options = {}) {
  return createBrowserCompatibleFetch({ command: process.execPath, args: ['-e', script, '--'], ...options });
}

test('passes credentials only through subprocess stdin and returns binary responses', async () => {
  const fetch = worker(`
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      if (process.argv.join(' ').includes('private-value')) process.exit(2);
      if (request.headers.cookie !== 'session=private-value') process.exit(3);
      process.stdout.write(JSON.stringify({status:200,headers:[['content-type','application/pdf']],url:request.url,body:Buffer.from('%PDF-ok').toString('base64')}));
    });
  `);
  const response = await fetch('https://example.test/file', { headers: { Cookie: 'session=private-value' } });
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://example.test/file');
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(await response.text(), '%PDF-ok');
});

test('does not disclose subprocess failures or malformed output', async () => {
  await assert.rejects(worker("process.stderr.write('session=private-value');process.exit(1)")('https://example.test'), { message: 'Browser-compatible request failed' });
  await assert.rejects(worker("process.stdout.write('session=private-value')")('https://example.test'), { message: 'Invalid browser-compatible response' });
  await assert.rejects(createBrowserCompatibleFetch({ command: '/nonexistent-command' })('https://example.test'), /Could not start/);
});

test('bounds subprocess time and response size and handles cancellation', async () => {
  const stalled = worker('setTimeout(()=>{},10000)', { timeoutMs: 20 });
  await assert.rejects(stalled('https://example.test'), /timed out/);
  await assert.rejects(worker("process.stdout.write('x'.repeat(100))", { maxResponseBytes: 10 })('https://example.test'), /size limit/);
  const controller = new AbortController();
  const pending = worker('setTimeout(()=>{},10000)')('https://example.test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /was aborted/);
});

test('rejects mutation before starting the subprocess', async () => {
  await assert.rejects(createBrowserCompatibleFetch({ command: '/nonexistent-command' })('https://example.test', { method: 'POST' }), /Only GET and HEAD/);
});
