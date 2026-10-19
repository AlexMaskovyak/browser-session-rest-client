export function createPlaywrightFetch(requestContext) {
  return async function playwrightFetch(input, init = {}) {
    const url = input instanceof URL ? input.toString() : String(input);
    const response = await requestContext.fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      data: init.body,
      maxRedirects: 0,
      failOnStatusCode: false
    });
    const body = await response.body();
    const headers = response.headers();
    return {
      ok: response.ok(),
      status: response.status(),
      url: response.url(),
      headers,
      text: async () => body.toString('utf8'),
      json: async () => JSON.parse(body.toString('utf8')),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    };
  };
}
