import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startPrivateSite } from './private-site.mjs';

const cli = process.env.WEBSITE_CLIENT_CLI;
const debugUrl = 'http://127.0.0.1:9222';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch { /* Retry a transient startup/cleanup condition. */ }
    await delay(75);
  }
  throw new Error(message);
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function profiles() { return (await readdir(tmpdir())).filter((name) => name.startsWith('playwright_chromiumdev_profile-')); }
async function noOwnedBrowser(baseline) {
  await eventually(async () => {
    try { await fetch(`${debugUrl}/json/version`); return false; } catch { return true; }
  }, 'CLI-owned browser debug listener did not close');
  await eventually(async () => (await profiles()).every((name) => baseline.includes(name)), 'CLI-owned temporary profile was not removed');
}

function startCli(site, output, { interactive = true } = {}) {
  const args = ['--url', site.url, '--output', output, '--login', '--browser', 'chromium'];
  const child = interactive ? spawn('python3', ['docker/e2e/terminal_bridge.py', cli, ...args], { env: { ...process.env, NODE_EXTRA_CA_CERTS: site.rootCert } }) :
    spawn(cli, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: site.rootCert } });
  let transcript = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { transcript += chunk; if (transcript.length > 512 * 1024) child.kill('SIGTERM'); });
  let status;
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { status = { code, signal }; resolve(status); }); });
  return {
    child, exited, transcript: () => transcript,
    async prompt() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (status) throw new Error(`CLI exited before terminal login prompt: ${transcript}`);
        if (transcript.includes('press Enter here to generate')) return;
        await delay(75);
      }
      throw new Error(`CLI did not reach its real interactive login prompt: ${transcript}`);
    },
    enter() { child.stdin.write('\n'); }, cancel() { child.stdin.write('\x03'); },
    async wait() {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CLI did not exit within 20 seconds: ${transcript}`)), 20000); });
      try { return await Promise.race([exited, deadline]); } finally { clearTimeout(timer); }
    },
    async stop() { if (!status) { child.kill('SIGTERM'); await Promise.race([exited, delay(3000)]); } }
  };
}

async function browserPage(site) {
  await eventually(async () => (await fetch(`${debugUrl}/json/version`)).ok, 'CLI Chromium CDP listener did not start');
  const driver = await chromium.connectOverCDP(debugUrl, { timeout: 5000 });
  const page = await eventually(() => driver.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith(site.origin)), 'CLI did not display the fixture website');
  page.setDefaultTimeout(5000);
  return { driver, page };
}

async function authenticate(page, site) {
  // The test drives the real website form and MFA, not CLI callbacks or tokens.
  await page.getByLabel('Username').fill(site.secrets.username);
  await page.getByLabel('Password').fill(site.secrets.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill(site.secrets.otp);
  const loaded = page.waitForResponse((response) => response.url() === `${site.origin}/graphql?operationName=List`);
  await page.getByRole('button', { name: 'Verify' }).click();
  await loaded;
  assert.equal(page.url(), site.url);
}

async function generatedFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await generatedFiles(path));
    else result.push({ path, content: await readFile(path, 'utf8') });
  }
  return result;
}

async function authenticatedReadFetch(site) {
  const ca = await readFile(site.rootCert);
  return (url, options) => new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ca, method: options.method, headers: { ...options.headers, cookie: `session=${site.secrets.cookie}` } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

test('installed CLI: clean Linux container, real PTY, headed Chromium and trusted HTTPS', { timeout: 150000 }, async (suite) => {
  assert.equal(process.platform, 'linux');
  assert.notEqual(process.getuid(), 0, 'Container tests must run as non-root');
  assert.ok(cli?.startsWith('/opt/website-client/'), 'Invoke the separately packed/installed CLI');
  assert.equal(await exists('/var/run/docker.sock'), false, 'No host Docker socket');
  console.log(`Container runtime: ${process.platform}/${process.arch}, Node ${process.version}; CLI installed from npm pack; browser headed under Xvfb`);
  const site = await startPrivateSite();
  const root = await mkdtemp(join(tmpdir(), 'website-client-docker-e2e-'));
  try {
    await suite.test('login + MFA + terminal Enter generates a callable client without secrets or mutation replay', async () => {
      site.reset();
      const output = join(root, 'client');
      const baseline = await profiles();
      const process = startCli(site, output);
      let driver;
      try {
        await process.prompt();
        const attached = await browserPage(site); driver = attached.driver;
        await authenticate(attached.page, site);
        assert.equal(await exists(output), false, 'Generation must wait for actual terminal confirmation');
        process.enter();
        assert.equal((await process.wait()).code, 0, process.transcript());
        await noOwnedBrowser(baseline);
        assert.equal(driver.isConnected(), false);
        assert.deepEqual({ password: site.counts.passwordLogins, mfa: site.counts.mfaLogins, reads: site.counts.reads, mutations: site.counts.mutations }, { password: 1, mfa: 1, reads: 1, mutations: 0 });
        assert.ok(site.counts.moduleReads >= 2, 'Both browser and generator must authenticate for private source');
        assert.equal(site.counts.refusedModuleReads, 0);
        const files = await generatedFiles(output);
        for (const { content } of files) for (const [name, secret] of Object.entries(site.secrets)) {
          if (name !== 'otp') assert.ok(!content.includes(secret), `Generated file leaked synthetic ${name}`);
        }
        const report = JSON.parse(await readFile(join(output, 'discovery.json'), 'utf8'));
        assert.deepEqual(report.generatedOperations, ['List', 'Create']);
        assert.equal(report.browserSession.authentication, 'user-confirmed-browser-session');
        assert.equal(report.liveVerified, false);
        const { WebsiteClient } = await import(pathToFileURL(join(output, 'index.js')));
        const client = new WebsiteClient({ fetch: await authenticatedReadFetch(site) });
        assert.deepEqual(await client.List({ first: 5 }), { items: [{ id: site.secrets.response }] });
        await assert.rejects(client.Create({ input: {} }), /Mutation is not enabled/);
        assert.equal(site.counts.reads, 2);
        assert.equal(site.counts.mutations, 0);
      } finally { await process.stop(); await driver?.close().catch(() => {}); }
    });

    await suite.test('a new CLI run starts logged out; unfinished login cannot generate a client', async () => {
      site.reset();
      const output = join(root, 'unfinished');
      const baseline = await profiles();
      const process = startCli(site, output);
      let driver;
      try {
        await process.prompt();
        const attached = await browserPage(site); driver = attached.driver;
        assert.equal(new URL(attached.page.url()).pathname, '/login');
        process.enter();
        assert.notEqual((await process.wait()).code, 0);
        assert.match(process.transcript(), /Login is not complete/);
        assert.equal(await exists(output), false);
        assert.equal(site.counts.mfaLogins, 0);
        await noOwnedBrowser(baseline);
      } finally { await process.stop(); await driver?.close().catch(() => {}); }
    });

    await suite.test('Ctrl+C through the real terminal closes the browser and writes no client', async () => {
      const output = join(root, 'cancelled');
      const baseline = await profiles();
      const process = startCli(site, output);
      try {
        await process.prompt();
        process.cancel();
        assert.notEqual((await process.wait()).code, 0);
        assert.match(process.transcript(), /cancelled/);
        assert.equal(await exists(output), false);
        await noOwnedBrowser(baseline);
      } finally { await process.stop(); }
    });

    await suite.test('closing the login browser exits the real CLI without generating output', async () => {
      const output = join(root, 'closed');
      const baseline = await profiles();
      const process = startCli(site, output);
      try {
        await process.prompt();
        const { driver } = await browserPage(site);
        const session = await driver.newBrowserCDPSession();
        await session.send('Browser.close');
        assert.notEqual((await process.wait()).code, 0);
        assert.match(process.transcript(), /closed|cancelled/);
        assert.equal(await exists(output), false);
        await noOwnedBrowser(baseline);
      } finally { await process.stop(); }
    });

    await suite.test('existing output is preserved and rejected before browser startup', async () => {
      const output = join(root, 'existing');
      await mkdir(output); await writeFile(join(output, 'sentinel'), 'keep-original');
      const baseline = await profiles();
      const process = startCli(site, output);
      try {
        assert.notEqual((await process.wait()).code, 0);
        assert.match(process.transcript(), /Output directory already exists/);
        assert.equal(await readFile(join(output, 'sentinel'), 'utf8'), 'keep-original');
        assert.deepEqual(await readdir(output), ['sentinel']);
        await noOwnedBrowser(baseline);
      } finally { await process.stop(); }
    });

    await suite.test('piped stdin cannot impersonate interactive login and leaves no browser or output', async () => {
      const output = join(root, 'not-a-terminal');
      const baseline = await profiles();
      const process = startCli(site, output, { interactive: false });
      try {
        assert.notEqual((await process.wait()).code, 0);
        assert.match(process.transcript(), /interactive terminal/);
        assert.equal(await exists(output), false);
        await noOwnedBrowser(baseline);
      } finally { await process.stop(); }
    });
  } finally { await site.close(); }
});
