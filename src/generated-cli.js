// Standalone source emitted into each generated package. No generator dependency.
export const GENERATED_CLI = String.raw`#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { WebsiteClient } from './index.js';
import { operations, restEndpoints, websiteUrl } from './operations.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'CLI_USAGE' }); };
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const limit = 64 * 1024 * 1024;
function describe(name) {
  const operation = own(operations, name), rest = own(restEndpoints, name);
  if (!operation && !rest) fail('Unknown operation. Run node cli.js --help.');
  return { operation, rest, writes: operation ? operation.kind === 'mutation' : !['GET', 'HEAD'].includes(rest.method),
    endpoint: operation ? operation.endpoint : rest.origin + rest.pathTemplate };
}
function help(name) {
  console.log('Run website operations from your terminal. Node 18+ required.');
  console.log('Usage: node cli.js OPERATION [--input FILE.json] [--login | --session-stdin] [--output NEW_FILE] [--confirm-write OPERATION]');
  console.log('Help reads local definitions only. An operation command sends requests to the website.');
  if (!name) {
    for (const key of [...Object.keys(operations), ...Object.keys(restEndpoints)]) {
      const item = describe(key);
      console.log('  ' + key + '  ' + (item.writes ? 'WRITE' : 'READ') + '  ' + item.endpoint);
    }
    console.log('Next: node cli.js OPERATION --help (replace OPERATION with a listed name).');
  } else {
    const item = describe(name);
    console.log('\n' + name + ': ' + (item.writes ? 'WRITES remote data' : 'READS remote data') + '\nEndpoint: ' + item.endpoint);
    if (item.operation) {
      console.log('Input: a JSON object of GraphQL variables. GraphQL is the request format used by this endpoint.');
      for (const variable of item.operation.variables) console.log('  ' + variable.name + ': ' + variable.type + (variable.required ? ' (required)' : ' (optional)'));
      console.log('Input-object fields are not available from operation source. Obtain their schema or inspect the website form request; do not guess them.');
    } else {
      console.log('Method: ' + item.rest.method + '\nInput: JSON object with path, query and body fields.');
      for (const match of item.rest.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) console.log('  path.' + match[1] + ': string or number (required)');
      console.log('  query: optional object of URL parameters. body: JSON payload for writes only.');
      console.log('The body schema is not inferred. Review it against the website before writing.');
    }
    console.log('Command after preparing input.json: node cli.js ' + name + ' --input input.json --login' + (item.writes ? ' --confirm-write ' + name : ''));
    console.log('This is a command example, not a verified payload. --input may be omitted when no inputs are required.');
    if (item.writes) console.log('No automatic retries. If a write fails, check the website before trying again.');
  }
  console.log('\nAuthentication: --login opens a temporary browser. Run npm install first; Chrome is the default. Log in, open the website, then press Enter.');
  console.log('For downloaded Chromium: npx playwright-core@1.56.0 install chromium; add --browser chromium.');
  console.log('Advanced: --session-stdin reads {"origin":"https://api.example.test","headers":{...}} from a trusted credential helper. This is a format example, not credentials.');
  console.log('Headers must come from your authorized current session and match the selected endpoint origin. No credential helper is bundled. Do not put secrets in command arguments or committed files.');
  console.log('Without an authentication flag, requests are anonymous. Browser login does not supply application-specific CSRF headers or bypass browser challenges.');
  console.log('--output writes a REST response to a new file, including PDFs. Existing files are never replaced. Without it, JSON is printed to stdout, which may contain private data.');
  console.log('Generation does not prove live compatibility or implement multi-step workflows such as receipt upload plus expense creation.');
}
async function credentials(origin) {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) fail('Session input exceeds 64 KiB.'); }
  let bundle;
  try { bundle = JSON.parse(text); } catch { fail('Session input must be JSON.'); }
  if (bundle?.origin !== origin || !bundle.headers || typeof bundle.headers !== 'object' || Array.isArray(bundle.headers)) fail('Session origin must match this operation endpoint.');
  const headers = new Headers();
  for (const [key, value] of Object.entries(bundle.headers)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || /^(host|content-length|connection|transfer-encoding)$/i.test(key)) fail('Invalid session header.');
    headers.set(key, value);
  }
  return headers;
}
async function withLogin(browserName, run) {
  if (!process.stdin.isTTY) fail('--login requires an interactive terminal.');
  if (!['chrome', 'chromium', 'msedge'].includes(browserName)) fail('Supported browsers: chrome, chromium, msedge.');
  let browser, context, terminal;
  const controller = new AbortController();
  const cancel = () => { controller.abort(); context?.close().catch(() => {}); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ channel: browserName, headless: false });
    browser.on('disconnected', cancel);
    context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.on('close', cancel);
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded' });
    terminal = createInterface({ input: process.stdin, output: process.stderr });
    terminal.once('SIGINT', cancel);
    await terminal.question('Log in in the browser, open the website, then press Enter here to run the operation. Ctrl+C cancels.\n', { signal: controller.signal });
    terminal.close();
    if (new URL(page.url()).origin !== new URL(websiteUrl).origin || /login|sign.?in|oauth|password/i.test(new URL(page.url()).pathname) || await page.locator('input[type="password"]:visible').count()) fail('Login is not complete.');
    return await run(async (url, options) => {
      const response = await context.request.fetch(String(url), { method: options.method, headers: options.headers, data: options.body, maxRedirects: 0, failOnStatusCode: false, timeout: 30000 });
      try {
        if (Number(response.headers()['content-length']) > limit) fail('Response exceeds 64 MiB.');
        const bytes = await response.body();
        if (bytes.length > limit) fail('Response exceeds 64 MiB.');
        return new Response([204, 205, 304].includes(response.status()) || options.method === 'HEAD' ? null : bytes, { status: response.status(), headers: response.headers() });
      } finally { await response.dispose(); }
    });
  } finally {
    terminal?.close();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  }
}
export async function main(args = process.argv.slice(2)) {
  const name = args[0];
  if (!name || (args.length === 1 && ['--help', '-h'].includes(name))) { help(); return; }
  const item = describe(name), flags = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (Object.hasOwn(flags, flag)) fail('Duplicate flag.');
    if (['--help', '-h', '--login', '--session-stdin'].includes(flag)) flags[flag] = true;
    else if (['--input', '--output', '--confirm-write', '--browser'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) flags[flag] = args[++i];
    else fail('Unknown or incomplete flag. Run node cli.js --help.');
  }
  if (flags['--help'] || flags['-h']) { help(name); return; }
  if (flags['--login'] && flags['--session-stdin']) fail('Choose --login or --session-stdin, not both.');
  if (flags['--browser'] && !flags['--login']) fail('--browser requires --login.');
  if (item.writes && flags['--confirm-write'] !== name) fail('Write blocked. Review the input and add --confirm-write ' + name + '.');
  if (flags['--confirm-write'] && flags['--confirm-write'] !== name) fail('Write confirmation must name this exact operation.');
  if (flags['--output'] && !item.rest) fail('--output is for REST responses. GraphQL results are printed as JSON.');
  let input = {};
  if (flags['--input']) {
    const bytes = await readFile(flags['--input']);
    if (bytes.length > 1024 * 1024) fail('Input exceeds 1 MiB.');
    try { input = JSON.parse(bytes); } catch { fail('Input file must contain JSON.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Input must be a JSON object.');
  const origin = new URL(item.operation ? item.operation.endpoint : item.rest.origin).origin;
  const headers = flags['--session-stdin'] ? await credentials(origin) : new Headers();
  let output;
  try {
    // Reserve before any network request so an existing file cannot cause a write retry.
    if (flags['--output']) {
      try { output = await open(flags['--output'], 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('Output file already exists. Choose a new --output path. No request was sent.'); throw error; }
    }
    const run = async fetch => {
      const client = new WebsiteClient({ fetch: async (url, options) => {
        if (new URL(url).origin !== origin) fail('Request origin changed.');
        const merged = new Headers(headers);
        for (const [key, value] of new Headers(options.headers)) merged.set(key, value);
        return fetch(url, { ...options, headers: Object.fromEntries(merged), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      }, allowMutations: item.writes });
      const result = await client.request(name, input, { confirmMutation: item.writes, rawResponse: !!output });
      if (output) {
        let size = 0;
        for await (const chunk of result.body ?? []) {
          size += chunk.byteLength;
          if (size > limit) fail('Download exceeds 64 MiB. Partial file retained; inspect it before retrying.');
          await output.writeFile(chunk);
        }
        console.error('Response saved. A downloaded receipt does not prove reimbursement or payment.');
      } else console.log(JSON.stringify(result, null, 2));
    };
    if (flags['--login']) await withLogin(flags['--browser'] ?? 'chrome', run);
    else await run(globalThis.fetch);
  } finally { await output?.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { if (error.code === 'CLI_USAGE' || ['Invalid operation variables', 'Missing or invalid path parameter', 'Read requests cannot contain a body'].includes(error.message)) console.error(error.message); console.error('Operation did not complete. Check flags, input and authentication with --help. For writes, reconcile the website before retrying. A partial output file may remain. No automatic retry was made.'); process.exitCode = 1; });
}
`;
