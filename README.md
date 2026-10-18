# Browser Session REST Client

Reusable, read-only artifact collection through an authenticated browser request context.

The project separates endpoint discovery, runtime authentication, service adapters, and verified artifact staging. Request manifests and result ledgers are credential-free. Authentication remains in the browser context or in an explicitly supplied runtime-only storage state.

Service-specific behavior belongs in separate client repositories that depend on this package. Real account identifiers, manifests, storage state, and downloaded artifacts do not belong here.

## Design

An injected transport performs GET/HEAD with the browser's authenticated request context. The collector validates a credential-free manifest, writes each response atomically, verifies content, hashes the result, and records a redacted resume ledger. Service behavior lives in separate packages.

See [the implementation plan](PLAN.md).
