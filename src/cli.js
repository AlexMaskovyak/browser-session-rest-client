#!/usr/bin/env node
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { generateWebsiteClient } from './generator.js';
import { createAuthenticatedFetch, readCredentialsFromStdin } from './authenticated-fetch.js';
import { createBrowserCompatibleFetch } from './browser-compatible-fetch.js';
import { generateWithBrowserLogin } from './browser-login.js';

const usage = 'website-client --url HTTPS_URL --output NEW_DIRECTORY [--login] [--browser chrome|chromium|msedge] [--session-stdin] [--browser-compatible] [--graphql-endpoint HTTPS_URL] [--asset-origin HTTPS_ORIGIN] [--operation NAME] [--keyword TEXT] [--max-modules N]';
const usageError = (message) => Object.assign(new Error(message), { code: 'CLI_USAGE' });

export async function main(args = process.argv.slice(2), browserDependencies = {}) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--login', '--session-stdin', '--browser-compatible'].includes(args[i])) options[args[i]] = true;
    else if (['--url', '--output', '--browser', '--name', '--graphql-endpoint', '--asset-origin', '--operation', '--keyword', '--max-modules'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = args[i++];
      (options[key] ??= []).push(args[i]);
    } else throw usageError('Unsupported or incomplete argument. Run website-client --help.');
  }
  if (!options['--url']?.[0] || !options['--output']?.[0]) throw usageError(usage);
  if (options['--login'] && (options['--session-stdin'] || options['--browser-compatible'])) throw usageError('--login manages its own browser session; do not combine it with --session-stdin or --browser-compatible.');
  if (options['--browser'] && !options['--login']) throw usageError('--browser requires --login.');
  const url = options['--url'][0];
  const output = resolve(options['--output'][0]);
  try { await lstat(output); throw usageError('Output directory already exists. Choose a new --output path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let result;
  const common = { url, operationNames: options['--operation'], assetOrigins: options['--asset-origin'], graphqlEndpoint: options['--graphql-endpoint']?.[0], keywords: options['--keyword'] ?? [], name: options['--name']?.[0] ?? 'website-client', maxModules: options['--max-modules'] ? Number(options['--max-modules'][0]) : 80 };
  if (!Number.isSafeInteger(common.maxModules) || common.maxModules < 1 || !/^[a-z][a-z0-9-]*$/.test(common.name)) throw usageError('Invalid --max-modules or --name. Run website-client --help.');
  if (options['--browser'] && !['chrome', 'chromium', 'msedge'].includes(options['--browser'][0])) throw usageError('Supported login browsers: chrome, chromium, msedge.');
  if (options['--login']) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try { result = await generateWithBrowserLogin({ ...common, browser: options['--browser']?.[0] ?? 'chrome' }, { ...browserDependencies, signal: controller.signal }); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  } else {
    const runtime = options['--session-stdin'] ? await readCredentialsFromStdin() : { origin: new URL(url).origin, headers: {} };
    if (new URL(url).origin !== runtime.origin) throw usageError('Website does not match session origin.');
    const fetchImpl = options['--browser-compatible'] ? createBrowserCompatibleFetch() : globalThis.fetch;
    result = await generateWebsiteClient({ ...common, fetch: createAuthenticatedFetch({ origin: runtime.origin, headers: runtime.headers, fetchImpl }),
    assetFetch: fetchImpl, assetOrigins: options['--asset-origin'] ?? runtime.assetOrigins ?? [], apiOrigins:runtime.apiOrigins ?? [], graphqlEndpoint: options['--graphql-endpoint']?.[0] ?? runtime.graphqlEndpoint,
    moduleUrls: runtime.moduleUrls ?? [], restEndpoints: runtime.restEndpoints ?? [] });
  }
  // Exclusive directory creation is the overwrite boundary. Do not remove partial output automatically.
  await mkdir(output);
  for (const [relative, source] of Object.entries(result.files)) {
    if (relative.includes('/')) await mkdir(join(output, 'operations'), { recursive: true });
    await writeFile(join(output, relative), source, { flag: 'wx' });
  }
  console.log(JSON.stringify({ generated: result.report.generatedOperations.length, rest: result.report.reviewedRestEndpoints.length + result.report.staticRestEndpoints.length, unbound: result.report.unboundOperations?.length ?? 0, sources: result.report.sourceCount, bounded: result.report.bounded, failedSources: result.report.failed.length, liveVerified: false }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(['CLI_USAGE', 'BROWSER_LOGIN'].includes(error.code) ? error.message : 'Client generation failed. No endpoint operations were invoked; inspect any partial output before retrying.'); process.exitCode = 1; });
