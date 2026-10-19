# Browser Session REST Client

Endpoint discovery, guarded requests, and verified artifact collection through an authenticated browser request context.

The project separates endpoint discovery, runtime authentication, service adapters, and verified artifact staging. Request manifests and result ledgers are credential-free. Authentication remains in the browser context or process memory; an explicitly supplied storage-state file is also supported.

Service-specific behavior belongs in independent client repositories accepting an injected Fetch function. Real account identifiers, manifests, storage state, and downloaded artifacts do not belong here.

## Design

An injected transport performs GET/HEAD with the browser's authenticated request context. The collector validates a credential-free manifest, writes each response atomically, verifies content, hashes the result, and records a redacted resume ledger. Service behavior lives in separate packages.

`createAuthenticatedFetch({ origin, headers })` accepts explicitly supplied runtime headers and returns a Fetch-compatible function. It permits GET/HEAD to that exact origin and follows only same-origin redirects. `createFetchTransport(fetch)` adapts it for the collector. `readCredentialsFromStdin()` reads bounded JSON containing `origin`, `headers`, and any caller-owned runtime configuration; it never writes or logs the input. Supply credentials through a private stdin pipe, never command arguments or a manifest.

For a known read-only API query that requires POST, both Fetch factories accept `authorizePost({ url, body })`. The caller's synchronous predicate must verify the exact endpoint and query body and return `true`. POST requires an explicit string body of at most 1 MiB; Request body streams and all POST redirects are rejected. Pass the guard to both factories when composing them. Other methods remain disabled, and artifact manifests remain GET/HEAD only.

Some authenticated services reject ordinary HTTP stacks while accepting browser requests. `createBrowserCompatibleFetch()` provides an optional `curl_cffi` worker with a Chrome TLS and HTTP fingerprint. Inject it as `fetchImpl` into `createAuthenticatedFetch` to retain the same origin and redirect restrictions. It runs `uv run --with curl_cffi==0.16.3 python` by default; an existing environment can use `{ command: pythonExecutable, args: [] }`. Requests pass through stdin, responses through captured stdout, and no credential files are created. `uv` and Python are required only for this optional transport.

Direct HTTP transports require Node 18 or newer. The storage-state adapter loads Playwright only when selected; current Playwright releases require Node 20 or newer. Direct transports do not load Playwright.

Install from the repository's Git URL. Install the optional `playwright-core` peer dependency only when using a Playwright adapter. The package is MIT licensed; npm registry publication is currently disabled.

Run `npm test` for the JavaScript suite and `npm run test:worker` for the Python worker tests.

## Extending a service client

Use the injected authenticated transport to fetch the application's HTML and discovered module URLs. `discoverModuleReferences(source, sourceUrl)` finds same-origin literal JavaScript candidates (including Vite dependency tables). `discoverGraphqlDocuments(source)` extracts GraphQL source literals. Neither evaluates downloaded code. Discovery is deliberately passive and does not prove that an endpoint is authorized or live-compatible.

`generateGraphqlOperationModule({ documents, operationName, endpoint })` selects one named query/mutation and its transitive fragments and returns a standalone JavaScript descriptor. Apply that generated source in the service repository; it has no runtime dependency on this package. Review definitions and input construction before use. Never feed account HTML, runtime variables, headers, or captured authenticated requests into generated source.

For separately authorized mutations, both Fetch factories accept `authorizeWrite({ url, method, body, headers })`. It must synchronously approve the exact request. Only POST/PUT with explicit strings or Uint8Array bodies up to 16 MiB are accepted. Binary bodies are copied before authorization. Supply the same predicate at both transport layers. A write predicate takes precedence over `authorizePost`; combine approved read operations explicitly if needed. GET/HEAD defaults and GET-only artifact manifests are unchanged. Writes are never redirected or retried by these factories.

Use a separate credential-free, origin-scoped transport for signed storage uploads. Restrict it to the exact URL, bytes, and required headers, and never send application cookies to storage. Do not persist signed URLs or tokens. An interrupted write may have succeeded; reconcile service state before retrying. A receipt upload is not an expense submission.

See [the implementation plan](PLAN.md).
