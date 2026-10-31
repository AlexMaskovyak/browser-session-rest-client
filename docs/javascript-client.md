# Earlier JavaScript generator

This documents the earlier implementation. The Python rewrite's current entry
point and limitations are described in the [project README](../README.md).

Log into a website, then generate a standalone client you can use from your terminal or JavaScript. Every generated operation gets a command and help explaining its endpoint, inputs and whether it changes remote data.

The generator manages the browser session and discovers JavaScript files and GraphQL endpoints while you browse. GraphQL is a request format used by some websites. It generates commands, callable methods and a report of what was found or missed. Generation never replays captured API operations. Running a generated operation is a separate action that can read or change website data.

## Generate a client

You need Node 18+, npm, Chrome and permission to access the target website. The URLs below are examples: replace the URL with your website and choose a new output directory. Installation downloads dependencies. Generation writes that directory and opens a browser for your manual login, including any verification code.

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

For a public page, omit `--login`. For narrower discovery, use repeatable `--operation`, `--keyword`, or `--max-modules` (default 80). JavaScript files observed while browsing and their hosting servers are included automatically in login mode. Advanced integrations can still supply endpoint hints and temporary authentication headers; see [transport and collection](transports.md).

## Use the generated client

Start in the directory the generator created:

```sh
cd example-client
node cli.js --help
```

Help lists the discovered operation names, endpoints and READ or WRITE labels. It reads local files only and does not log in or send requests. Then ask for help with a listed operation. For example, **if the generated list includes `ListItems`**:

```sh
node cli.js ListItems --help
```

The operation help shows known inputs and which are required. Put your values in a JSON file. For a GraphQL operation this is the variables object; for a REST operation it contains `path`, `query` and optionally `body`. REST means ordinary HTTP endpoints such as a PDF download URL. Nested input-object fields and REST body schemas are not inferred; obtain them from the service schema or a reviewed website request.

After preparing `input.json`, install the browser library and run the operation:

```sh
npm install
node cli.js ListItems --input input.json --login
```

This is an example for that operation name, not a verified payload for every website. Omit `--input` if the operation needs no values. Chrome opens in a fresh session. Log in, return to the terminal and press Enter to send the request. The browser closes afterward. JSON results print to stdout and may be private. No session is saved; the next invocation requires login again.

For a WRITE operation, review the input and add `--confirm-write` followed by its exact name. Without that confirmation the CLI sends no request. A failed write may already have succeeded; check the website before retrying. No automatic write retries occur.

For a REST download, add `--output NEW_FILE`, for example a new PDF path. Existing files are never overwritten. A failure can leave a partial file; inspect it before retrying. Downloading a receipt does not prove submission or payment.

No additional runner script is needed. `npm start -- --help` also works. `npm link` installs the package command locally, using the generator's `--name` value (default `website-client`). Advanced callers can provide current session headers through `--session-stdin`; operation help describes the format. No credential helper is bundled. Never pass tokens in command arguments or commit them to files.

Browser login uses cookie authentication. Applications requiring additional CSRF headers, which protect against unintended requests from other sites, or browser challenges may need a custom authorized session. Those are not automatically solved. If the browser does not open, check Chrome or install Chromium as described above and add `--browser chromium`. Run operation help again for input errors; never blindly retry a write.

### JavaScript usage

For an application that supplies its own authenticated Fetch function:

```js
import { WebsiteClient } from './example-client/index.js';
const client = new WebsiteClient({ fetch: authenticatedFetch });
const result = await client.ListItems({ first: 20 }); // Discovered operation name
```

Output includes `cli.js`, `index.js`, operation definitions, `package.json`, usage instructions and `discovery.json`. The generated client has no dependency on this generator; browser login uses `playwright-core`. GraphQL methods accept variables; REST methods accept `{ path, query, body }`. JavaScript writes require both `allowMutations: true` at construction and `{ confirmMutation: true }` per call. No automatic write retries.

For integrations, `generateWebsiteClient({ url, fetch, assetFetch, ...options })` returns `{ files, report }` without writing to disk. Use it to extend an existing service repository, not replace hand-maintained domain logic. `generateGraphqlOperationModule()` generates just one operation and its fragments.

## Discovery limits

- Login mode observes the URL used by each GraphQL request. When several operations share one URL, source definitions can supply commands for operations you did not execute, but those commands have not been verified against the live website. When several API URLs exist, only operations with an observed URL become commands; others are listed as missing. Browse a narrower set of pages or supply `--graphql-endpoint` after inspecting the actual requests.
- Literal `fetch()` calls produce REST commands, but their required body fields may still be unknown. URLs calculated while the page runs and requests hidden behind custom functions need browser evidence and reviewed request definitions.
- `discovery.json` reports sources, failures, remaining modules and bounds. A bounded scan is not complete website coverage. Generated methods are not live-verified until tested through an authorized session.
- A command executes one discovered operation. It does not automatically connect several operations into a service workflow, such as receipt metadata creation, binary upload and expense submission. Binary upload bodies and service-specific validation still require reviewed service code. Existing hand-maintained clients are not upgraded in place by generating a new directory.

Discovery and generation come before service-specific validation and authorized testing against the live website. Generating commands is not permission to run commands that change remote data.

## Transport and downloads

Also included: origin-scoped authenticated Fetch, explicitly guarded JSON/binary writes, and atomic hash-verified artifact downloads. Authentication stays in the browser context or process memory. Service-specific rules belong in independent clients.

See [transport and collection](transports.md). Node 18+. MIT licensed; npm registry publication is disabled. Tests: `npm test` and `npm run test:worker`; `RUN_BROWSER_SMOKE=1 npm test` also tests real Chrome login against a synthetic private site.

For a clean Linux environment, run `npm run test:docker`. It tests the packed CLI's actual interactive login/MFA-to-generation flow under Chromium/Xvfb, without host browser state or callback injection. See [Docker end-to-end tests](docker-tests.md).
