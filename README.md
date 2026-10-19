# Browser Session REST Client

Turn a website's discoverable API into a standalone JavaScript client, using an existing authorized browser session when needed.

Give it a URL. It reads the page and its JavaScript modules, finds GraphQL operations and static REST calls, and generates callable methods. Generation never executes downloaded code or invokes discovered API operations.

## Generate a client

Install from this Git repository, then run:

```sh
website-client --url https://example.com/app --output ./example-client
```

For a logged-in website, the browser integration supplies the current URL and temporary session through stdin:

```sh
session-provider | website-client --url https://example.com/app \
  --output ./example-client --session-stdin
```

`session-provider` represents your browser integration, not a bundled login command. The companion agent skill handles this handoff. The CLI does not attach to arbitrary Chrome tabs or extract cookies itself. Credentials never belong in command arguments or generated files.

The stdin object contains `{ origin, headers }`. Optional fields: `assetOrigins` (approved CDNs), `apiOrigins` (approved REST origins), `moduleUrls` (observed modules), `graphqlEndpoint` (observed endpoint URL or operation-name-to-URL map), and `restEndpoints` (reviewed `{ name, origin, method, pathTemplate }` contracts). No runtime headers, variables or receipt contents enter generated source.

Flags: `--graphql-endpoint`; repeatable `--asset-origin`, `--operation`, `--keyword`; `--max-modules` (default 80); `--browser-compatible` for the optional Chrome-fingerprint transport. Assets receive no application credentials. Existing output directories are never overwritten.

## Use the generated client

```js
import { WebsiteClient } from './example-client/index.js';
const client = new WebsiteClient({ fetch: authenticatedFetch });
const result = await client.ListItems({ first: 20 }); // Discovered operation name
```

Output: `index.js`, operation definitions, `package.json`, and `discovery.json`. The generated client has no dependency on this package. GraphQL methods accept variables; REST methods accept `{ path, query, body }`. Writes require both `allowMutations: true` at construction and `{ confirmMutation: true }` per call. No automatic write retries.

For integrations, `generateWebsiteClient({ url, fetch, assetFetch, ...options })` returns `{ files, report }` without writing to disk. Use it to extend an existing service repository, not replace hand-maintained domain logic. `generateGraphqlOperationModule()` generates just one operation and its fragments.

## Discovery limits

- GraphQL source definitions produce named methods with required-variable checks. Supply an observed GraphQL endpoint; API routes are not guessed.
- Literal `fetch()` calls produce REST scaffolds. Computed URLs, runtime-only calls, custom wrappers and payload semantics require browser evidence and reviewed contracts.
- `discovery.json` reports sources, failures, remaining modules and bounds. A bounded scan is not complete website coverage. Generated methods are not live-verified until tested through an authorized session.

The workflow is discovery → generation → service-specific validation → authorized live verification. Generating a client does not authorize its mutations.

## Transport and downloads

Also included: origin-scoped authenticated Fetch, explicitly guarded JSON/binary writes, and atomic hash-verified artifact downloads. Authentication stays in the browser context or process memory. Service-specific rules belong in independent clients.

See [transport and collection](docs/transports.md). Node 18+; Playwright is optional. MIT licensed; npm registry publication is disabled. Tests: `npm test` and `npm run test:worker`.
