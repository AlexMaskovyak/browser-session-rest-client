const redirects = new Set([301, 302, 303, 307, 308]);

function failure(message) {
  return Object.assign(new Error(message), { retryable: false });
}

function validatedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('Invalid authentication origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value !== url.origin) {
    throw failure('Authentication origin must be an exact HTTP or HTTPS origin');
  }
  return url.origin;
}

function validatedHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Invalid authentication headers');
  if (Object.values(value).some((entry) => typeof entry !== 'string')) throw failure('Authentication header values must be strings');
  try { return new Headers(value); } catch { throw failure('Invalid authentication headers'); }
}

/** Credentials are supplied by the caller and retained only in this closure. */
export function createAuthenticatedFetch({ origin, headers, fetchImpl = globalThis.fetch, maxRedirects = 5, authorizePost, authorizeWrite }) {
  const allowedOrigin = validatedOrigin(origin);
  const authentication = validatedHeaders(headers);
  if (typeof fetchImpl !== 'function') throw failure('A Fetch implementation is required');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw failure('Invalid redirect limit');

  return async function authenticatedFetch(input, init = {}) {
    let url = requestUrl(input);
    if (url.origin !== allowedOrigin) throw failure('Request origin is not allowed');
    const { method, body } = authorizeRequest(input, init, url, authorizePost, authorizeWrite);
    let requestHeaders;
    try { requestHeaders = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)); }
    catch { throw failure('Invalid request headers'); }
    for (const [name, value] of authentication) requestHeaders.set(name, value);

    for (let hop = 0; ; hop += 1) {
      if (url.origin !== allowedOrigin || url.username || url.password) throw failure('Request origin is not allowed');
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method, headers: requestHeaders, redirect: 'manual',
          ...(!['GET', 'HEAD'].includes(method) ? { body } : {}),
          signal: init.signal ?? (input instanceof Request ? input.signal : undefined)
        });
      } catch { throw new Error('Authenticated request failed'); }
      if (!['GET', 'HEAD'].includes(method) && response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw failure(`${method} redirects are not allowed`);
      }
      if (!redirects.has(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw failure('Redirect response is missing a location');
      if (hop >= maxRedirects) throw failure('Redirect limit exceeded');
      try { url = new URL(location, url); }
      catch { throw failure('Invalid redirect location'); }
    }
  };
}

/** Read a single private runtime configuration, without creating a credential file. */
export async function readCredentialsFromStdin(stream = process.stdin, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw failure('Runtime configuration exceeds the size limit');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error.retryable === false) throw error;
    throw failure('Could not read runtime configuration');
  }
  let configuration;
  try { configuration = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('Runtime configuration must be valid JSON'); }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw failure('Runtime configuration must be an object');
  }
  validatedOrigin(configuration.origin);
  validatedHeaders(configuration.headers);
  return configuration;
}
import { authorizeRequest, requestUrl } from './request-policy.js';
