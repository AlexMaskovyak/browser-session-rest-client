const MAX_POST_BYTES = 1024 * 1024;

export const requestFailure = (message) => Object.assign(new Error(message), { retryable: false });

export function requestUrl(input) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : input); }
  catch { throw requestFailure('Invalid request URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw requestFailure('Request origin is not allowed');
  }
  return url;
}

export function authorizeRequest(input, init, url, authorizePost) {
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    if (init.body != null || (input instanceof Request && input.body !== null)) {
      throw requestFailure('Read-only requests must not contain a body');
    }
    return { method };
  }
  if (method !== 'POST' || typeof authorizePost !== 'function') {
    throw requestFailure('Only GET and HEAD requests are supported without explicit POST authorization');
  }
  if ((input instanceof Request && input.body !== null) || typeof init.body !== 'string'
    || Buffer.byteLength(init.body, 'utf8') > MAX_POST_BYTES) {
    throw requestFailure('POST requests require an explicit string body of at most 1 MiB');
  }
  let authorized;
  try { authorized = authorizePost({ url: url.toString(), body: init.body }); }
  catch { throw requestFailure('POST authorization failed'); }
  if (authorized !== true) {
    Promise.resolve(authorized).catch(() => {});
    throw requestFailure('POST request is not authorized');
  }
  return { method, body: init.body };
}
