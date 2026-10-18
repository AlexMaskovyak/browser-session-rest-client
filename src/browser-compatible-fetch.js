import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./curl-cffi-worker.py', import.meta.url));

/** Optional HTTP transport retaining browser-compatible TLS and HTTP fingerprints. */
export function createBrowserCompatibleFetch({
  command = 'uv', args = ['run', '--with', 'curl_cffi==0.16.3', 'python'],
  timeoutMs = 60000, maxResponseBytes = 64 * 1024 * 1024
} = {}) {
  return async function browserCompatibleFetch(input, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD requests are supported');
    if (init.signal?.aborted) throw new Error('Browser-compatible request was aborted');
    const request = {
      url: String(input), method, headers: Object.fromEntries(new Headers(init.headers)),
      timeout: Math.max(1, Math.floor(timeoutMs / 1000))
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, [...args, workerPath], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', abort);
        if (error) { child.kill(); reject(error); } else resolve(value);
      };
      const abort = () => finish(new Error('Browser-compatible request was aborted'));
      const timer = setTimeout(() => finish(new Error('Browser-compatible request timed out')), timeoutMs);
      init.signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new Error('Could not start browser-compatible transport')));
      child.stdin.on('error', () => finish(new Error('Could not send browser-compatible request')));
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) return finish(new Error('Browser-compatible response exceeds the size limit'));
        chunks.push(chunk);
      });
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error('Browser-compatible request failed'));
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('Invalid browser-compatible response')); }
      });
      child.stdin.end(JSON.stringify(request));
    });
    try {
      const body = method === 'HEAD' || [204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, 'base64');
      const response = new Response(body, { status: result.status, headers: result.headers });
      Object.defineProperty(response, 'url', { value: result.url });
      return response;
    } catch { throw new Error('Invalid browser-compatible response'); }
  };
}
