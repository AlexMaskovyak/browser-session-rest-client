export class PlaywrightTransport {
  constructor(requestContext) { this.requestContext = requestContext; }

  async request({ method, url }) {
    const response = await this.requestContext.fetch(url, { method, failOnStatusCode: false });
    return {
      status: response.status(),
      headers: response.headers(),
      body: await response.body(),
      url: response.url()
    };
  }
}

