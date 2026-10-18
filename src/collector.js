import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactUrl, validateManifest } from './manifest.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function readLedger(ledgerPath) {
  try { return JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, results: {} }; throw error; }
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.part-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function completedArtifact(target, prior) {
  if (!prior || prior.status !== 'complete') return false;
  try {
    const bytes = await readFile(target);
    return bytes.length === prior.bytes && sha256(bytes) === prior.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function verify(artifact, response) {
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  const expected = artifact.expected ?? {};
  const contentType = response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? '';
  if (expected.contentType && !contentType.toLowerCase().includes(expected.contentType.toLowerCase())) {
    throw new Error(`Unexpected content type: ${contentType || 'missing'}`);
  }
  if (expected.minBytes && response.body.length < expected.minBytes) throw new Error('Response is too small');
  if (expected.magic && !response.body.subarray(0, Buffer.byteLength(expected.magic)).equals(Buffer.from(expected.magic))) {
    throw new Error('Response signature does not match');
  }
  return contentType;
}

const transientStatus = (status) => status === 408 || status === 429 || status >= 500;

async function requestWithRetry(artifact, transport, maxAttempts, sleep) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await transport.request({ method: artifact.method ?? 'GET', url: artifact.url });
      if (!transientStatus(response.status) || attempt === maxAttempts) return { response, attempts: attempt };
      const retryAfter = Number(response.headers?.['retry-after']);
      await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30000) : 100 * (2 ** (attempt - 1)));
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw Object.assign(error, { attempts: attempt });
      await sleep(100 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export async function collect({ manifest, outputDir, ledgerPath, transport, maxAttempts = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  validateManifest(manifest);
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const ledger = await readLedger(ledgerPath);

  for (const artifact of manifest.artifacts) {
    const target = path.join(outputDir, artifact.filename);
    if (await completedArtifact(target, ledger.results[artifact.id])) continue;
    const temporary = `${target}.part-${process.pid}`;
    let attempts = 0;
    try {
      const requested = await requestWithRetry(artifact, transport, maxAttempts, sleep);
      const { response } = requested;
      attempts = requested.attempts;
      const contentType = verify(artifact, response);
      await writeFile(temporary, response.body, { mode: 0o600 });
      await rename(temporary, target);
      const file = await stat(target);
      ledger.results[artifact.id] = {
        status: 'complete', filename: artifact.filename, url: redactUrl(response.url ?? artifact.url),
        bytes: file.size, sha256: sha256(response.body), contentType, attempts
      };
    } catch (error) {
      attempts = error.attempts ?? (attempts || 1);
      await unlink(temporary).catch(() => {});
      ledger.results[artifact.id] = {
        status: 'failed', filename: artifact.filename, url: redactUrl(artifact.url), error: error.message, attempts
      };
    }
    await writeJsonAtomic(ledgerPath, ledger);
  }
  return ledger;
}
