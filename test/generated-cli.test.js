import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { generateWebsiteClient } from '../src/generator.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'generated-cli-'));
  const result = await generateWebsiteClient({ url: 'https://example.test/app?private=must-not-persist',
    fetch: async () => new Response('<script src="/app.js"></script>'),
    graphqlEndpoint: 'https://api.example.test/graphql',
    assetFetch: async () => new Response(''),
    moduleUrls: [],
    graphqlDocuments: ['query List($first: Int) { items(first:$first) { id } } mutation Create($input: ItemInput!) { create(input:$input) { id } }'],
    restEndpoints: [{ name: 'GetPdf', origin: 'https://api.example.test', method: 'GET', pathTemplate: '/receipts/{id}' },
      { name: 'PutItem', origin: 'https://api.example.test', method: 'PUT', pathTemplate: '/items/{id}' }] });
  for (const [name, content] of Object.entries(result.files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content, { mode: name === 'cli.js' ? 0o755 : 0o644 });
  }
  const log = join(root, 'requests.jsonl');
  const transport = join(root, 'transport.mjs');
  await writeFile(transport, `import {appendFile} from 'node:fs/promises';
globalThis.fetch = async (url, options) => {
 await appendFile(${JSON.stringify(log)}, JSON.stringify({url:String(url),...options,signal:undefined})+'\\n');
 if (new URL(url).searchParams.has('redirect')) return new Response('', {status:302,headers:{location:'https://other.test/steal'}});
 if (new URL(url).pathname.startsWith('/receipts/')) return new Response('%PDF-fixture');
 return Response.json({data:{items:[{id:'fixture'}]}});
};`);
  async function run(args, stdin = '') {
    const child = spawn(process.execPath, ['--import', transport, join(root, 'cli.js'), ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdin.end(stdin);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, stdout, stderr };
  }
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { root, run, calls, files: result.files };
}

test('generated CLI lists operations, types, write warnings and runnable help without network or dependency installation', async () => {
  const { run, calls, files } = await fixture();
  const help = await run(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /List  READ/);
  assert.match(help.stdout, /Create  WRITE/);
  const operation = await run(['Create', '--help']);
  assert.equal(operation.code, 0);
  assert.match(operation.stdout, /input: ItemInput! \(required\)/);
  assert.match(operation.stdout, /--confirm-write Create/);
  assert.match(operation.stdout, /Input-object fields are not available/);
  assert.match((await run(['GetPdf', '--help'])).stdout, /path.id: string or number \(required\)/);
  assert.deepEqual(await calls(), []);
  assert.deepEqual(JSON.parse(files['package.json']).bin, { 'website-client': './cli.js' });
  assert.ok(!files['operations.js'].includes('must-not-persist'));
});

test('generated executable reads JSON variables and scopes runtime authentication to the operation origin', async () => {
  const { root, run, calls } = await fixture();
  const input = join(root, 'input.json'); await writeFile(input, '{"first":5}');
  const session = JSON.stringify({ origin: 'https://api.example.test', headers: { authorization: 'Bearer runtime-private' } });
  const result = await run(['List', '--input', input, '--session-stdin'], session);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { items: [{ id: 'fixture' }] });
  const [request] = await calls();
  assert.equal(request.headers.authorization, 'Bearer runtime-private');
  assert.equal(request.redirect, 'manual');
  assert.deepEqual(JSON.parse(request.body).variables, { first: 5 });
  assert.ok(!result.stdout.includes('runtime-private'));
  assert.notEqual((await run(['List', '--session-stdin'], JSON.stringify({ origin: 'https://other.test', headers: {} }))).code, 0);
  assert.equal((await calls()).length, 1);
});

test('writes require exact operation confirmation; malformed arguments and variables never send requests', async () => {
  const { root, run, calls } = await fixture();
  const input = join(root, 'input.json'); await writeFile(input, '{"input":{"amount":"1.00"}}');
  for (const args of [['Create', '--input', input], ['Create', '--confirm-write', 'PutItem'], ['Create', '--confirm-write', 'Create'], ['List', '--unknown'], ['List', '--login', '--session-stdin'], ['Missing'], ['List', '--browser', 'chromium']]) {
    assert.notEqual((await run(args)).code, 0, args.join(' '));
  }
  assert.deepEqual(await calls(), []);
  assert.equal((await run(['Create', '--input', input, '--confirm-write', 'Create'])).code, 0);
  assert.equal((await calls()).length, 1);
  assert.equal(JSON.parse((await calls())[0].body).operationName, 'Create');
});

test('REST downloads preserve bytes and private permissions; existing files block requests', async () => {
  const { root, run, calls } = await fixture();
  const input = join(root, 'path.json'); await writeFile(input, '{"path":{"id":"receipt-1"}}');
  const output = join(root, 'receipt.pdf');
  assert.equal((await run(['GetPdf', '--input', input, '--output', output])).code, 0);
  assert.equal(await readFile(output, 'utf8'), '%PDF-fixture');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.notEqual((await run(['GetPdf', '--input', input, '--output', output])).code, 0);
  assert.equal((await calls()).length, 1);
  assert.equal(await readFile(output, 'utf8'), '%PDF-fixture');
});

test('generated browser login rejects noninteractive use and invalid credential input without network', async () => {
  const { run, calls } = await fixture();
  assert.match((await run(['List', '--login'])).stderr, /interactive terminal/);
  for (const value of ['not-json', JSON.stringify({ origin: 'https://api.example.test', headers: { host: 'other.test' } }), 'x'.repeat(65537)]) {
    assert.notEqual((await run(['List', '--session-stdin'], value)).code, 0);
  }
  assert.deepEqual(await calls(), []);
});

test('redirect responses fail without forwarding authentication or retrying', async () => {
  const { root, run, calls } = await fixture();
  const input = join(root, 'redirect.json');
  await writeFile(input, '{"path":{"id":"one"},"query":{"redirect":"yes"}}');
  const result = await run(['GetPdf', '--input', input, '--session-stdin'], JSON.stringify({ origin: 'https://api.example.test', headers: { authorization: 'Bearer private-redirect-secret' } }));
  assert.notEqual(result.code, 0);
  assert.equal((await calls()).length, 1);
  assert.ok(!result.stderr.includes('private-redirect-secret'));
  assert.ok(!result.stdout.includes('private-redirect-secret'));
});
