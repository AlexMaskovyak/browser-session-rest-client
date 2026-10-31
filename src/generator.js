import { createHash } from 'node:crypto';
import { GENERATED_CLI } from './generated-cli.js';
import { parse, print } from 'graphql';
import { discoverModuleReferences, discoverGraphqlDocuments, generateGraphqlOperationModule, discoverStaticFetchEndpoints } from './discovery.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Discovery requires credential-free HTTPS URLs');
  return url;
}

/** Discover from source, not by probing candidate API routes or executing JavaScript. */
export async function generateWebsiteClient({
  url, fetch: sessionFetch, assetFetch = globalThis.fetch, assetOrigins = [], graphqlEndpoint,
  operationNames, moduleUrls = [], graphqlDocuments = [], restEndpoints = [], apiOrigins = [], name = 'website-client', maxModules = 80,
  maxSourceBytes = 4 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024, keywords = []
} = {}) {
  const website = safeUrl(url);
  if (typeof sessionFetch !== 'function' || typeof assetFetch !== 'function') throw new Error('Website and asset Fetch transports are required');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid client package name');
  if (![maxModules, maxSourceBytes, maxTotalBytes].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Positive discovery limits required');
  const allowed = new Set([website.origin, ...assetOrigins.map((origin) => safeUrl(origin).origin)]);
  const pending = new Set();
  const visited = new Set();
  const failed = [];
  const sources = [];
  const documents = [];
  const staticRest = new Map();
  const allowedApis = new Set([website.origin, ...apiOrigins.map((origin) => safeUrl(origin).origin)]);
  let bytes = 0;
  async function read(target, fetch) {
    let response;
    try { response = await fetch(target, { method: 'GET', redirect: 'manual' }); }
    catch { throw new Error('Discovery source request failed'); }
    if (!response.ok || (response.url && new URL(response.url).origin !== new URL(target).origin)) throw new Error('Discovery source unavailable');
    const length = Number(response.headers?.get?.('content-length'));
    if (length > maxSourceBytes) throw new Error('Discovery source exceeds limit');
    let source;
    // Bound the actual body, not just a possibly missing Content-Length.
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxSourceBytes || bytes + size > maxTotalBytes) throw new Error('Discovery source exceeds limit');
          chunks.push(Buffer.from(value));
        }
        source = Buffer.concat(chunks).toString('utf8');
      } finally { await reader.cancel().catch(() => {}); }
    } else source = await response.text();
    const size = Buffer.byteLength(source);
    if (size > maxSourceBytes || bytes + size > maxTotalBytes) throw new Error('Discovery source exceeds limit');
    bytes += size;
    return source;
  }
  function enqueue(reference, base) {
    try {
      const target = safeUrl(new URL(reference, base).href);
      if (allowed.has(target.origin) && !visited.has(target.href)) pending.add(target.href);
    } catch { /* Unsafe or unsupported reference. */ }
  }
  const html = await read(website.href, sessionFetch);
  if (/<input\b[^>]*type\s*=\s*["']?password\b/i.test(html)) throw new Error('Website authentication required');
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)) enqueue(match[1], website);
  for (const reference of moduleUrls) enqueue(reference, website);
  const seeds = new Set(moduleUrls.map((reference) => new URL(reference, website).href));
  const terms = [...keywords, ...website.pathname.split('/').filter((part) => part.length > 3)].map((term) => term.toLowerCase());
  const score = (candidate) => Number(seeds.has(candidate)) * 1000 + terms.reduce((sum, term) => sum + Number(new URL(candidate).pathname.toLowerCase().includes(term)), 0);
  while (pending.size && visited.size < maxModules && bytes < maxTotalBytes) {
    const target = [...pending].sort((a, b) => score(b) - score(a))[0];
    pending.delete(target);
    visited.add(target);
    try {
      // Authenticated headers never go to the CDN. Origin scope is explicit.
      const source = await read(target, target.startsWith(`${website.origin}/`) ? sessionFetch : assetFetch);
      documents.push(...discoverGraphqlDocuments(source));
      for (const endpoint of discoverStaticFetchEndpoints(source, website)) if (allowedApis.has(endpoint.origin)) staticRest.set(`${endpoint.method} ${endpoint.origin}${endpoint.pathTemplate}`, endpoint);
      sources.push({ path: new URL(target).pathname, sha256: digest(source) });
      for (const reference of discoverModuleReferences(source, target)) enqueue(reference, target);
    } catch { failed.push({ path: new URL(target).pathname, reason: 'unavailable-or-over-limit' }); }
  }
  // Prefer source definitions over runtime documents (which often add __typename).
  const sourceNames = new Set(documents.flatMap((document) => parse(document).definitions.map((definition) => definition.name?.value)));
  let runtimeBytes = 0;
  for (const document of graphqlDocuments) {
    runtimeBytes += Buffer.byteLength(document);
    if (runtimeBytes > maxTotalBytes) throw new Error('Observed definitions exceed discovery limit');
    const definitions = parse(document).definitions.filter((definition) => definition.name && !sourceNames.has(definition.name.value));
    if (definitions.length) documents.push(print({ kind: 'Document', definitions }));
  }
  const available = new Set();
  for (const document of documents) for (const definition of parse(document).definitions) {
    if (definition.kind === 'OperationDefinition' && definition.name && ['query', 'mutation'].includes(definition.operation)) available.add(definition.name.value);
  }
  const names = operationNames ?? [...available];
  if (!Array.isArray(names) || new Set(names).size !== names.length || names.some((n) => !available.has(n))) throw new Error('Selected operation was not discovered');
  if (names.length && !graphqlEndpoint) throw new Error('Observed GraphQL endpoint required; API routes are not guessed');
  const files = {};
  const operations = {};
  const generatedNames = [];
  const unboundOperations = [];
  for (const operationName of names) {
    if (['__proto__', 'prototype', 'constructor', 'request', 'fetch', 'allowMutations'].includes(operationName)) throw new Error('Operation name conflicts with generated API');
    // An endpoint is an observed mapping supplied by the session, never inferred from an operation name.
    const endpoint = typeof graphqlEndpoint === 'function' ? graphqlEndpoint(operationName) : typeof graphqlEndpoint === 'string' ? graphqlEndpoint : graphqlEndpoint[operationName];
    if (!endpoint && typeof graphqlEndpoint === 'function' && operationNames === undefined) { unboundOperations.push(operationName); continue; }
    if (!endpoint) throw new Error('Missing operation endpoint mapping');
    const generated = generateGraphqlOperationModule({ documents, operationName, endpoint });
    const descriptor = JSON.parse(generated.slice(generated.indexOf('Object.freeze(') + 14, generated.lastIndexOf(');')));
    const definition = parse(descriptor.query).definitions.find((d) => d.kind === 'OperationDefinition');
    descriptor.variables = definition.variableDefinitions.map((d) => ({ name: d.variable.name.value, type: print(d.type), required: d.type.kind === 'NonNullType' && !d.defaultValue }));
    operations[operationName] = descriptor;
    generatedNames.push(operationName);
    files[`operations/${operationName}.js`] = generated;
  }
  const rest = {};
  const staticEndpoints = [...staticRest.values()].map((endpoint, index) => ({ ...endpoint, name: `Rest${endpoint.method}${index + 1}` }));
  for (const endpoint of [...staticEndpoints, ...restEndpoints]) {
    if (!endpoint || !/^[A-Za-z][A-Za-z0-9_]*$/.test(endpoint.name) || ['__proto__', 'prototype', 'constructor', 'request', 'fetch', 'allowMutations'].includes(endpoint.name) || Object.hasOwn(rest, endpoint.name) || Object.hasOwn(operations, endpoint.name) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method) || !/^\/(?!\/)/.test(endpoint.pathTemplate) || /[?#\\\x00-\x20]/.test(endpoint.pathTemplate)) throw new Error('Invalid reviewed REST endpoint');
    const origin = safeUrl(endpoint.origin).origin;
    if (new URL(endpoint.pathTemplate.replaceAll(/\{[A-Za-z][A-Za-z0-9_]*\}/g, 'placeholder'), origin).origin !== origin) throw new Error('Invalid reviewed REST path');
    rest[endpoint.name] = { origin, method: endpoint.method, pathTemplate: endpoint.pathTemplate };
  }
  if (!generatedNames.length && !Object.keys(rest).length) throw new Error('No supported endpoint contracts discovered; inspect runtime requests or provide reviewed REST contracts');
  files['operations.js'] = `export const websiteUrl = ${JSON.stringify(website.origin + website.pathname)};\nexport const operations = ${JSON.stringify(operations, null, 2)};\nexport const restEndpoints = ${JSON.stringify(rest, null, 2)};\n`;
  files['index.js'] = GENERATED_CLIENT;
  files['cli.js'] = GENERATED_CLI;
  files['package.json'] = `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', exports: './index.js', bin: { [name]: './cli.js' }, scripts: { start: 'node cli.js' }, dependencies: { 'playwright-core': '1.56.0' }, engines: { node: '>=18' } }, null, 2)}\n`;
  const report = { websiteOrigin: website.origin, sourceCount: sources.length, sourceBytes: bytes, sources, failed, remainingModules: pending.size, bounded: pending.size > 0, discoveredOperations: [...available], generatedOperations: generatedNames, unboundOperations, staticRestEndpoints: staticEndpoints.map((e) => e.name), reviewedRestEndpoints: restEndpoints.map((e) => e.name), liveVerified: false, limitations: ['Passive source inspection only; runtime-only and undiscovered routes may be missing.', 'Static REST methods are scaffolds; runtime payload validation and parameterization require review.', 'Generation never executes endpoint operations. Live compatibility requires an authorized read or separately approved write.'] };
  files['discovery.json'] = `${JSON.stringify(report, null, 2)}\n`;
  files['README.md'] = `# ${name}\n\nRun the website's discovered operations from your terminal, or import WebsiteClient in JavaScript. Node 18+ is required.\n\n## Start here\n\n1. In this generated directory, run \`node cli.js --help\` to list the operation names and whether they read or write data. Help does not contact the website.\n2. Run \`node cli.js OPERATION --help\`, replacing OPERATION with a listed name. This shows its endpoint, required inputs and a command example. Prepare an input.json file with those values from your own records and the website's request schema. Nested input-object fields are not inferred. Do not guess them.\n3. For browser login, run \`npm install\` in this directory. Chrome must be installed. Alternatively run \`npx playwright-core@1.56.0 install chromium\` and add \`--browser chromium\` to the next command. Installation downloads dependencies; it does not submit website data.\n4. Run \`node cli.js OPERATION --input input.json --login\`. This is a command template: replace OPERATION and prepare the file first. Log in in the temporary browser and press Enter in the terminal to send the request. Writes also require \`--confirm-write OPERATION\`. Each invocation starts a fresh login and closes it after the request. No credentials are saved.\n\nYou can also run \`npm start -- --help\`. After \`npm link\`, the package command is \`${name} --help\`. The JavaScript API still accepts an authorized Fetch transport.\n\n## Results and failures\n\nJSON results are printed to stdout and may contain private data. For a REST response such as a PDF, add \`--output NEW_FILE\`. This creates a private new file and never replaces an existing file. Failed downloads may leave partial files; inspect them before retrying. A download does not establish submission, reimbursement or payment.\n\nNo automatic write retries are made. If a write fails, check the website before retrying because it may already have succeeded. If login fails, verify Chrome or install Chromium as above, then start a fresh command. Application-specific CSRF headers and browser challenges may require an authorized custom session; browser login alone does not solve these. Operation help documents the advanced \`--session-stdin\` format. No credential helper is bundled.\n\n## Coverage and JavaScript API\n\nSee discovery.json for missing operations and verification limits. Generating a command does not prove it works with the live website. Raw endpoint commands do not automatically implement multi-step workflows such as uploading a receipt and then creating its expense. Binary upload bodies and service-specific validation still need reviewed service code.\n\nInject an authorized Fetch transport into WebsiteClient and call named methods with GraphQL variables or REST input { path, query, body }. JavaScript writes require allowMutations: true and per-call { confirmMutation: true }. Authentication remains caller-owned.\n`;
  return { files, report };
}

const GENERATED_CLIENT = `import { operations, restEndpoints } from './operations.js';

export class WebsiteClient {
  constructor({ fetch, allowMutations = false }) {
    if (typeof fetch !== 'function') throw new Error('A Fetch transport is required');
    this.fetch = fetch;
    this.allowMutations = allowMutations === true;
    for (const name of [...Object.keys(operations), ...Object.keys(restEndpoints)]) {
      if (name in this) throw new Error('Endpoint name conflicts with client API');
      Object.defineProperty(this, name, { value: (input, options) => this.request(name, input, options) });
    }
  }
  async request(name, input = {}, { confirmMutation = false, rawResponse = false } = {}) {
    const operation = Object.hasOwn(operations, name) ? operations[name] : null;
    const rest = Object.hasOwn(restEndpoints, name) ? restEndpoints[name] : null;
    if (!operation && !rest) throw new Error('Unknown operation');
    const mutates = operation ? operation.kind === 'mutation' : !['GET', 'HEAD'].includes(rest.method);
    if (mutates && !(this.allowMutations && confirmMutation === true)) throw new Error('Mutation is not enabled and confirmed');
    let url, options;
    if (operation) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !operation.variables.some(v => v.name === k)) || operation.variables.some(v => v.required && input[v.name] == null)) throw new Error('Invalid operation variables');
      url = operation.endpoint;
      options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({operationName: operation.operationName, query: operation.query, variables: input}) };
    } else {
      let path = rest.pathTemplate.replace(/\\{([A-Za-z][A-Za-z0-9_]*)\\}/g, (_, key) => {
        const value = input.path?.[key];
        if (!['string', 'number'].includes(typeof value) || !String(value).length || ['.', '..'].includes(String(value))) throw new Error('Missing or invalid path parameter');
        return encodeURIComponent(String(value));
      });
      url = new URL(path, rest.origin);
      for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, String(value));
      if (['GET', 'HEAD'].includes(rest.method) && input.body !== undefined) throw new Error('Read requests cannot contain a body');
      options = {method: rest.method, ...(input.body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(input.body)})};
    }
    let response;
    try { response = await this.fetch(url, {...options, redirect: 'manual'}); }
    catch { throw new Error(mutates ? 'Write outcome unknown; reconcile before retrying' : 'Request transport failed'); }
    if (!response.ok) throw new Error(mutates ? 'Write not verified; reconcile before retrying' : 'Request failed');
    if (rawResponse && rest) return response;
    if (response.status === 204 || options.method === 'HEAD') return null;
    let result;
    try { result = await response.json(); } catch { throw new Error('Response could not be verified'); }
    if (operation && (!result || typeof result !== 'object' || (result.errors != null && (!Array.isArray(result.errors) || result.errors.length)) || result.data == null)) throw new Error('Operation returned an unverified response');
    return operation ? result.data : result;
  }
}
`;
