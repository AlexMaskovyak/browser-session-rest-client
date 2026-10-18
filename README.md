# Browser Session REST Client

Reusable, read-only artifact collection through an authenticated browser request context.

The project separates endpoint discovery, runtime authentication, service adapters, and verified artifact staging. Request manifests and result ledgers are credential-free. Authentication remains in the browser context or process memory; an explicitly supplied storage-state file is also supported.

Service-specific behavior belongs in independent client repositories accepting an injected Fetch function. Real account identifiers, manifests, storage state, and downloaded artifacts do not belong here.

## Design

An injected transport performs GET/HEAD with the browser's authenticated request context. The collector validates a credential-free manifest, writes each response atomically, verifies content, hashes the result, and records a redacted resume ledger. Service behavior lives in separate packages.

`createAuthenticatedFetch({ origin, headers })` accepts explicitly supplied runtime headers and returns a Fetch-compatible function. It permits GET/HEAD to that exact origin and follows only same-origin redirects. `createFetchTransport(fetch)` adapts it for the collector. `readCredentialsFromStdin()` reads bounded JSON containing `origin`, `headers`, and any caller-owned runtime configuration; it never writes or logs the input. Supply credentials through a private stdin pipe, never command arguments or a manifest.

See [the implementation plan](PLAN.md).
