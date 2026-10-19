# Browser Session REST Client

Log into a website in a browser opened by the CLI, then generate a standalone JavaScript API client from the pages you visit.

The command manages the browser session and discovers modules and GraphQL endpoints while you browse. It then generates callable methods and a coverage report. It never replays captured API operations or submits forms on your behalf.

## Generate a client

Run directly from this Git repository:

```sh
npx --yes --package=github:AlexMaskovyak/browser-session-rest-client website-client \
  --url https://example.com/app --output ./example-client --login
```

Or, from a checkout after `npm ci`:

```sh
node src/cli.js --url https://example.com/app --output ./example-client --login
```

1. A separate Chrome window opens. Your normal Chrome profile is not used.
2. Log in normally, including MFA, and open the relevant pages on the requested website. You enter credentials into the website, not the terminal.
3. Return to the terminal and press Enter. The CLI discovers and generates the client, then closes its browser session.

No copied cookies, DevTools commands, or session-provider program are required. Ctrl+C cancels and closes the owned session. The command requires an interactive terminal. Choose a new output directory; existing clients are never overwritten, and this is checked before opening the browser.

Chrome must be installed. Alternatives: `--browser msedge`, or install Playwright Chromium with `npx playwright-core@1.56.0 install chromium` and use `--browser chromium`. The Playwright library is included automatically; no extension or remote-debugging setup is needed.

The session is temporary: no saved login, storage-state, HAR or credential export is created by the tool. Browser-managed temporary profile files are cleaned on normal close; forced termination can leave temporary browser files. Fresh runs require login again. Cookies, request headers, login bodies, variables and response data are not copied into the client.

For a public page, omit `--login`. For narrower discovery, use repeatable `--operation`, `--keyword`, or `--max-modules` (default 80). Observed modules and their CDN origins are included automatically in login mode. Advanced integrations can still supply endpoint hints and transient headers; see [transport and collection](docs/transports.md).

## Use the generated client

```js
import { WebsiteClient } from './example-client/index.js';
const client = new WebsiteClient({ fetch: authenticatedFetch });
const result = await client.ListItems({ first: 20 }); // Discovered operation name
```

Output: `index.js`, operation definitions, `package.json`, and `discovery.json`. The generated client has no dependency on this package. GraphQL methods accept variables; REST methods accept `{ path, query, body }`. Writes require both `allowMutations: true` at construction and `{ confirmMutation: true }` per call. No automatic write retries.

For integrations, `generateWebsiteClient({ url, fetch, assetFetch, ...options })` returns `{ files, report }` without writing to disk. Use it to extend an existing service repository, not replace hand-maintained domain logic. `generateGraphqlOperationModule()` generates just one operation and its fragments.

## Discovery limits

- Login mode observes POST GraphQL endpoint mappings automatically. A single shared endpoint can bind additional source operations, but those unexecuted operations are not live-verified. With multiple endpoints, mapped operations are generated and unbound operations are reported as gaps; use narrower browsing or `--graphql-endpoint` to resolve them.
- Literal `fetch()` calls produce REST scaffolds. Computed URLs, runtime-only calls, custom wrappers and payload semantics require browser evidence and reviewed contracts.
- `discovery.json` reports sources, failures, remaining modules and bounds. A bounded scan is not complete website coverage. Generated methods are not live-verified until tested through an authorized session.

The workflow is discovery → generation → service-specific validation → authorized live verification. Generating a client does not authorize its mutations.

## Transport and downloads

Also included: origin-scoped authenticated Fetch, explicitly guarded JSON/binary writes, and atomic hash-verified artifact downloads. Authentication stays in the browser context or process memory. Service-specific rules belong in independent clients.

See [transport and collection](docs/transports.md). Node 18+. MIT licensed; npm registry publication is disabled. Tests: `npm test` and `npm run test:worker`; `RUN_BROWSER_SMOKE=1 npm test` also tests real Chrome login against a synthetic private site.
