# Plan

Build a read-only artifact client around an authenticated Playwright request context.

- [x] Validate credential-free manifests and safe destination paths.
- [x] Download atomically with bounded retries, SHA-256, and resume.
- [x] Redact credentials and sensitive query values from all durable output.
- [x] Expose a small adapter interface for service-specific clients.
- [x] Test duplicate IDs, unsafe paths, auth failure, bad content, retries, and resume.
- [x] Accept explicitly supplied runtime credentials through bounded stdin JSON.
- [x] Provide a Fetch adapter restricted to GET/HEAD and one origin, including redirects.
- [x] Verify credential isolation, sanitized failures, and collector integration.
- [x] Add optional browser-compatible HTTP transport for sessions rejected by ordinary HTTP stacks.
- [x] Test private subprocess input, binary responses, failures, and cancellation.
- [x] Load Playwright only when its storage-state adapter is selected; verify direct transports on Node 18.
- [x] Close manifest path and URL-redaction gaps; test synthetic secret-bearing URLs.
- [x] Package public source with a permissive license and optional Playwright dependency; verify strict Node 18 consumption.

Authentication remains in the browser context or process memory. The caller owns credential capture; this package owns request restrictions and collection. Runtime headers flow through an injected Fetch adapter; manifests and ledgers contain no headers. Cross-origin redirects fail before another request is sent. Authentication failures return their HTTP status; transport failures expose no underlying error text. Recovery uses a fresh credential handoff and the existing verified resume ledger.

The library performs GET/HEAD and writes only to staging. Existing evidence and downstream records are never modified. Done means the full test suite passes and service clients can use either authenticated transport without private configuration entering this repository.

The optional browser-compatible transport runs a small Python worker using `curl_cffi`. The worker receives each request through stdin and returns one response through captured stdout. It follows no redirects and writes no credential or response files. The authenticated wrapper remains responsible for origin restrictions.
