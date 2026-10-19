# Transport and collection

`createAuthenticatedFetch({ origin, headers, fetchImpl })` permits GET/HEAD to one exact origin and follows only same-origin read redirects. Credentials remain in the closure. `readCredentialsFromStdin()` accepts bounded runtime JSON without persisting or logging it. `createFetchTransport(fetch)` adapts Fetch for the atomic collector, which validates manifests, content and hashes and maintains a redacted resume ledger.

`createPlaywrightFetch(context.request)` uses an authorized browser request context. The bundled Playwright library is loaded only for browser features. `generateWithBrowserLogin(options)` owns an isolated browser, human login/MFA handoff, observed contract capture, generation and cleanup; it backs the CLI's `--login` path. It does not attach to or alter an existing Chrome profile.

## Browser-login generation

The human opens the relevant pages in the CLI-owned browser and confirms in the terminal. Discovery uses the rendered page and the same context's request API for authenticated source reads. Third-party assets use a separate empty request context. Observations are bounded and omit headers, variables, login operations and literal-bearing runtime query definitions. Source definitions take precedence over runtime definitions with added `__typename` fields. A credential-free operation descriptor and coverage report are the only durable discovery outputs.

Permission to log in and inspect does not authorize generated mutations. Browser navigation naturally runs the website's own scripts and background requests; the generator does not replay API requests. Generated clients require their own authorized runtime transport later—the CLI does not bake a reusable session into public code.

Advanced noninteractive integrations retain `--session-stdin` with runtime JSON `{ origin, headers }`; optional fields are `assetOrigins`, `apiOrigins`, `moduleUrls`, `graphqlEndpoint` (URL or operation map), and reviewed `restEndpoints`. Never put credentials in CLI arguments. This mode is separate from `--login`; manual header capture is not the normal interactive workflow.

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
