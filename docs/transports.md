# Transport and collection

`createAuthenticatedFetch({ origin, headers, fetchImpl })` permits GET/HEAD to one exact origin and follows only same-origin read redirects. Credentials remain in the closure. `readCredentialsFromStdin()` accepts bounded runtime JSON without persisting or logging it. `createFetchTransport(fetch)` adapts Fetch for the atomic collector, which validates manifests, content and hashes and maintains a redacted resume ledger.

`createPlaywrightFetch(context.request)` uses an authorized browser request context. Install `playwright-core` only for a Playwright adapter; direct transports do not need it. Browser attachment and login belong to the integration.

## Explicit write guards

For a known read-only GraphQL query, supply `authorizePost({ url, body })` to both Fetch layers. It must synchronously verify the exact endpoint/query and bounded variables and return `true`. POST bodies must be explicit strings of at most 1 MiB.

For separately authorized mutations or uploads, use `authorizeWrite({ url, method, body, headers })`. It takes precedence over `authorizePost` and permits only explicit POST/PUT strings or Uint8Array bodies up to 16 MiB. Binary bodies are copied before authorization. Match the exact URL, method, bytes and headers—not all POSTs. Other write methods remain unsupported by these adapters; generated REST methods describing them require another separately authorized transport.

All write redirects are rejected. Fetch factories never retry writes. Artifact collection remains GET/HEAD only. Interrupted writes may have succeeded: reconcile service state before retrying. Receipt upload and reimbursement creation are separate effects.

Use a separate credential-free origin-scoped transport for signed storage uploads. Never send application cookies, bearer credentials or CSRF tokens to storage. Never persist signed URLs.

## Browser-compatible HTTP

`createBrowserCompatibleFetch({ authorizePost, authorizeWrite })` uses an optional `curl_cffi` worker with a Chrome TLS/HTTP fingerprint. Inject it as `fetchImpl` into `createAuthenticatedFetch`, passing the same guard at both layers. Requests pass through subprocess stdin, not arguments or files. Redirects are disabled.

Default worker: `uv run --with curl_cffi==0.16.3 python`. An existing Python environment can use `{ command: pythonExecutable, args: [] }`. Python/uv are needed only for this adapter. Prove an authenticated request before bulk work; selecting a browser-compatible transport establishes no authorization.

## Passive discovery helpers

`discoverModuleReferences(source, sourceUrl)` finds module references, including Vite dependency tables. `discoverGraphqlDocuments(source)` extracts GraphQL source literals. `discoverStaticFetchEndpoints(source, websiteUrl)` parses literal fetch calls without executing code. These find candidates, not complete API specifications. Generated descriptors contain endpoint/query definitions only; keep captured headers, runtime variables and private artifacts out of public clients.
