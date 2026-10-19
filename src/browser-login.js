import { createInterface } from 'node:readline/promises';
import { parse, visit } from 'graphql';
import { createPlaywrightFetch } from './playwright-fetch.js';
import { generateWebsiteClient } from './generator.js';

const authPattern = /login|log_in|sign.?in|oauth|password|credential|authentication|authorize|access.?token/i;
const sensitiveOperation = /auth|token|password|credential|session|log.?in|sign.?in/i;
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Browser login requires a bounded HTTPS URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Browser login requires a credential-free HTTPS URL');
  return url;
}

/** Observe contracts only. Never retain request headers or runtime variables. */
export function createBrowserObservation({ origin, maxRequests = 1000, maxDefinitionBytes = 4 * 1024 * 1024 } = {}) {
  const modules = new Set();
  const endpoints = new Map();
  const documents = new Set();
  let seen = 0;
  let unmodeled = 0;
  let omitted = 0;
  let sharedBindings = 0;
  let definitionBytes = 0;
  return {
    observe(request) {
      if (seen >= maxRequests) { omitted++; return; }
      try {
        // Requests from SSO/other sites are not discovery inputs.
        if (new URL(request.frame().url()).origin !== origin) return;
        const url = safeUrl(request.url());
        const resource = request.resourceType();
        if (!['script', 'fetch', 'xhr'].includes(resource)) return;
        seen++;
        if (authPattern.test(url.pathname)) return;
        if (resource === 'script') {
          if (![...url.searchParams.keys()].some((key) => /token|key|secret|signature|auth/i.test(key))) modules.add(url.href);
          return;
        }
        if (request.method() !== 'POST') { unmodeled++; return; }
        const raw = request.postData();
        if (!raw || Buffer.byteLength(raw) > 1024 * 1024) { unmodeled++; return; }
        const { query, operationName } = JSON.parse(raw);
        if (typeof query !== 'string' || typeof operationName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(operationName) || sensitiveOperation.test(operationName)) { unmodeled++; return; }
        if ([...url.searchParams.keys()].some((key) => key !== 'operationName')) { omitted++; return; }
        const document = parse(query);
        const operation = document.definitions.find((definition) => definition.kind === 'OperationDefinition' && definition.name?.value === operationName);
        if (!operation) return;
        const previous = endpoints.get(operationName);
        if (endpoints.has(operationName) && previous === null) return;
        if (previous && previous !== url.href) { endpoints.set(operationName, null); return; }
        endpoints.set(operationName, url.href);
        // Literal argument/default values can contain account data. Use public
        // module definitions instead when such a request is observed.
        let hasLiterals = false;
        visit(document, { StringValue() { hasLiterals = true; }, IntValue() { hasLiterals = true; }, FloatValue() { hasLiterals = true; } });
        if (!hasLiterals && !documents.has(query)) {
          const bytes = Buffer.byteLength(query);
          if (definitionBytes + bytes > maxDefinitionBytes) omitted++;
          else { documents.add(query); definitionBytes += bytes; }
        }
      } catch { /* Login bodies, non-GraphQL requests and unavailable frames are not retained. */ }
    },
    snapshot() {
      const targets = [...endpoints.values()].filter(Boolean);
      const bases = new Set(targets.map((target) => { const url = new URL(target); url.searchParams.delete('operationName'); return url.href; }));
      const resolveEndpoint = (name) => {
        if (endpoints.has(name)) return endpoints.get(name);
        if (bases.size !== 1 || targets.length === 0) return undefined;
        const url = new URL(targets[0]);
        if (url.searchParams.has('operationName')) url.searchParams.set('operationName', name);
        sharedBindings++;
        return url.href;
      };
      return { moduleUrls: [...modules], assetOrigins: [...new Set([...modules].map((url) => new URL(url).origin))], graphqlDocuments: [...documents], graphqlEndpoint: resolveEndpoint,
        coverage: () => ({ observedRequests: seen, observedGraphqlOperations: targets.length, runtimeRequestsNotModeled: unmodeled, omittedObservations: omitted, sharedEndpointBindings: sharedBindings, authentication: 'user-confirmed-browser-session', liveVerified: false }) };
    }
  };
}

async function launchBrowser(channel) {
  try {
    const { chromium } = await import('playwright-core');
    return await chromium.launch({ channel, headless: false });
  } catch { throw new Error('Could not open the login browser. Install Chrome, or use --browser chromium after running npx playwright-core install chromium.'); }
}

async function confirmLogin({ signal }) {
  if (!process.stdin.isTTY) throw new Error('--login requires an interactive terminal; it cannot read login confirmation from a pipe');
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  signal?.addEventListener('abort', abort, { once: true });
  terminal.once('SIGINT', abort);
  terminal.once('close', abort);
  try { await terminal.question('Log in in the new browser, open the pages to cover, then press Enter here to generate. Ctrl+C cancels.\n', { signal: cancellation.signal }); }
  catch { throw new Error('Client generation cancelled'); }
  finally { signal?.removeEventListener('abort', abort); terminal.close(); }
}

/** Human browser handoff -> existing generator. No credential export or API replay. */
export async function generateWithBrowserLogin(options, {
  launch = launchBrowser, confirm = confirmLogin, generate = generateWebsiteClient,
  createAssets = async () => (await import('playwright-core')).request.newContext(),
  progress = (message) => console.error(message), signal
} = {}) {
  const website = safeUrl(options.url);
  if (!['chrome', 'chromium', 'msedge'].includes(options.browser ?? 'chrome')) throw new Error('Supported login browsers: chrome, chromium, msedge');
  let browser, context, assets;
  let closed;
  const aborted = new Promise((_, reject) => {
    closed = () => reject(new Error('Login browser closed or operation cancelled; no client was generated'));
  });
  // Rejection is also observed when setup fails before the handoff starts.
  aborted.catch(() => {});
  const onAbort = () => closed();
  try {
    if (signal?.aborted) throw new Error('Client generation cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    progress('Opening a separate temporary browser. Your normal browser session is not used.');
    browser = await launch(options.browser ?? 'chrome');
    browser.on('disconnected', closed);
    context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.on('close', closed);
    const observations = createBrowserObservation({ origin: website.origin });
    const observe = (request) => observations.observe(request);
    context.on('request', observe);
    await Promise.race([page.goto(website.href, { waitUntil: 'domcontentloaded', timeout: 60000 }), aborted]);
    const confirmation = new AbortController();
    try { await Promise.race([confirm({ page, signal: confirmation.signal }), aborted]); }
    finally { confirmation.abort(); }
    const current = safeUrl(page.url());
    if (current.origin !== website.origin || authPattern.test(current.pathname) || await page.locator('input[type="password"]:visible').count() > 0) throw new Error('Login is not complete. Return to the requested website before pressing Enter.');
    context.off('request', observe);
    const observed = observations.snapshot();
    const sessionFetch = createPlaywrightFetch(context.request);
    // Browser DOM supplies the rendered authenticated shell, including dynamic modules.
    const html = await page.content();
    const fetch = async (input, init) => String(input) === current.href ? new Response(html, { headers: { 'content-type': 'text/html' } }) : sessionFetch(input, init);
    assets = await createAssets(); // No browser cookies, bearer headers or saved state.
    progress('Discovering endpoint definitions and generating the standalone client. No API operations are replayed.');
    const { browser: ignored, ...generationOptions } = options;
    const result = await Promise.race([generate({ ...generationOptions, url: current.href, fetch, assetFetch: createPlaywrightFetch(assets),
      moduleUrls: [...observed.moduleUrls, ...(options.moduleUrls ?? [])], assetOrigins: [...new Set([...observed.assetOrigins, ...(options.assetOrigins ?? [])])],
      graphqlEndpoint: options.graphqlEndpoint ?? observed.graphqlEndpoint, graphqlDocuments: observed.graphqlDocuments }), aborted]);
    result.report.browserSession = observed.coverage();
    result.files['discovery.json'] = `${JSON.stringify(result.report, null, 2)}\n`;
    progress('Generation finished. Closing the temporary login session.');
    return result;
  } catch (error) {
    // Never include browser/network diagnostics that can contain credentials or URLs.
    const safe = ['Could not open the login browser.', '--login requires', 'Supported login browsers:', 'Login is not complete.', 'Login browser closed', 'Client generation cancelled', 'Browser login requires', 'No supported endpoint', 'Selected operation was not discovered', 'Missing operation endpoint mapping'];
    const prefix = safe.find((prefix) => error?.message?.startsWith(prefix));
    const message = prefix ? {
      'Could not open the login browser.': 'Could not open the login browser. Install Chrome, or run npx playwright-core install chromium and use --browser chromium.',
      '--login requires': '--login requires an interactive terminal, not a pipe.',
      'Supported login browsers:': 'Supported login browsers: chrome, chromium, msedge.',
      'Login is not complete.': 'Login is not complete. Return to the requested website before pressing Enter.',
      'Login browser closed': 'Login browser closed or operation cancelled; no client was generated.',
      'Client generation cancelled': 'Client generation cancelled.',
      'Browser login requires': 'Browser login requires a credential-free HTTPS URL.',
      'No supported endpoint': 'No supported endpoint definitions discovered. Log in and open relevant pages before generating.',
      'Selected operation was not discovered': 'Selected operation was not discovered in this browser session.',
      'Missing operation endpoint mapping': 'Multiple API endpoints observed. Select operations captured in this session or provide --graphql-endpoint.'
    }[prefix] : 'Browser-session generation failed; no credentials were exported. Retry with a fresh login.';
    throw Object.assign(new Error(message), { code: 'BROWSER_LOGIN' });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await assets?.dispose().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
