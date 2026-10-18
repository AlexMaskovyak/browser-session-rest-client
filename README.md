# Browser Session REST Client

Reusable, read-only artifact collection through an authenticated browser request context.

The project separates endpoint discovery, runtime authentication, service adapters, and verified artifact staging. Request manifests and result ledgers are credential-free. Authentication remains in the browser context or process memory; an explicitly supplied storage-state file is also supported.

Service-specific behavior belongs in independent client repositories accepting an injected Fetch function. Real account identifiers, manifests, storage state, and downloaded artifacts do not belong here.

## Design

An injected transport performs GET/HEAD with the browser's authenticated request context. The collector validates a credential-free manifest, writes each response atomically, verifies content, hashes the result, and records a redacted resume ledger. Service behavior lives in separate packages.

`createAuthenticatedFetch({ origin, headers })` accepts explicitly supplied runtime headers and returns a Fetch-compatible function. It permits GET/HEAD to that exact origin and follows only same-origin redirects. `createFetchTransport(fetch)` adapts it for the collector. `readCredentialsFromStdin()` reads bounded JSON containing `origin`, `headers`, and any caller-owned runtime configuration; it never writes or logs the input. Supply credentials through a private stdin pipe, never command arguments or a manifest.

Some authenticated services reject ordinary HTTP stacks while accepting browser requests. `createBrowserCompatibleFetch()` provides an optional `curl_cffi` worker with a Chrome TLS and HTTP fingerprint. Inject it as `fetchImpl` into `createAuthenticatedFetch` to retain the same origin and redirect restrictions. It runs `uv run --with curl_cffi==0.16.3 python` by default; an existing environment can use `{ command: pythonExecutable, args: [] }`. Requests pass through stdin, responses through captured stdout, and no credential files are created. `uv` and Python are required only for this optional transport.

Direct HTTP transports require Node 18 or newer. The storage-state adapter loads Playwright only when selected; current Playwright releases require Node 20 or newer. Direct transports do not load Playwright.

See [the implementation plan](PLAN.md).
