# Plan

Build a read-only artifact client around an authenticated Playwright request context.

- [x] Validate credential-free manifests and safe destination paths.
- [x] Download atomically with bounded retries, SHA-256, and resume.
- [x] Redact credentials and sensitive query values from all durable output.
- [x] Expose a small adapter interface for service-specific clients.
- [x] Test duplicate IDs, unsafe paths, auth failure, bad content, retries, and resume.

Authentication remains in the browser context. The library performs GET/HEAD and writes only to staging. Existing evidence and downstream records are never modified. Done means the test suite passes and `gusto-client` can consume the released interface without private configuration entering this repository.
