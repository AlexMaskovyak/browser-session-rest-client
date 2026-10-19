#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWebsiteClient } from './generator.js';
import { createAuthenticatedFetch, readCredentialsFromStdin } from './authenticated-fetch.js';
import { createBrowserCompatibleFetch } from './browser-compatible-fetch.js';

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('website-client --url HTTPS_URL --output NEW_DIRECTORY [--session-stdin] [--browser-compatible] [--graphql-endpoint HTTPS_URL] [--asset-origin HTTPS_ORIGIN] [--operation NAME] [--keyword TEXT] [--max-modules N]');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--session-stdin', '--browser-compatible'].includes(args[i])) options[args[i]] = true;
    else if (['--url', '--output', '--name', '--graphql-endpoint', '--asset-origin', '--operation', '--keyword', '--max-modules'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = args[i++];
      (options[key] ??= []).push(args[i]);
    } else throw new Error('Unsupported or incomplete argument');
  }
  if (!options['--url']?.[0] || !options['--output']?.[0]) throw new Error('Usage: website-client --url HTTPS_URL --output NEW_DIRECTORY [--session-stdin] [--graphql-endpoint HTTPS_URL] [--asset-origin HTTPS_ORIGIN] [--operation NAME]');
  const url = options['--url'][0];
  const runtime = options['--session-stdin'] ? await readCredentialsFromStdin() : { origin: new URL(url).origin, headers: {} };
  if (new URL(url).origin !== runtime.origin) throw new Error('Website does not match session origin');
  const fetchImpl = options['--browser-compatible'] ? createBrowserCompatibleFetch() : globalThis.fetch;
  const result = await generateWebsiteClient({ url, fetch: createAuthenticatedFetch({ origin: runtime.origin, headers: runtime.headers, fetchImpl }),
    assetFetch: fetchImpl, assetOrigins: options['--asset-origin'] ?? runtime.assetOrigins ?? [], apiOrigins:runtime.apiOrigins ?? [], graphqlEndpoint: options['--graphql-endpoint']?.[0] ?? runtime.graphqlEndpoint,
    operationNames: options['--operation'], moduleUrls: runtime.moduleUrls ?? [], keywords: options['--keyword'] ?? [], restEndpoints: runtime.restEndpoints ?? [], name: options['--name']?.[0] ?? 'website-client', maxModules: options['--max-modules'] ? Number(options['--max-modules'][0]) : 80 });
  const output = resolve(options['--output'][0]);
  // Exclusive directory creation is the overwrite boundary. Do not remove partial output automatically.
  await mkdir(output);
  for (const [relative, source] of Object.entries(result.files)) {
    if (relative.includes('/')) await mkdir(join(output, 'operations'), { recursive: true });
    await writeFile(join(output, relative), source, { flag: 'wx' });
  }
  console.log(JSON.stringify({ generated: result.report.generatedOperations.length, rest: result.report.reviewedRestEndpoints.length + result.report.staticRestEndpoints.length, sources: result.report.sourceCount, bounded: result.report.bounded, failedSources: result.report.failed.length, liveVerified: false }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch(() => { console.error('Client generation failed. No endpoint operations were invoked; inspect any partial output before retrying.'); process.exitCode = 1; });
