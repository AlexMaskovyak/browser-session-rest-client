/** Adapt a Fetch-compatible function to the artifact collector interface. */
export function createFetchTransport(fetchImpl) {
  return {
    async request({ method = 'GET', url }) {
      const response = await fetchImpl(url, { method });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
        url: response.url || url
      };
    }
  };
}
