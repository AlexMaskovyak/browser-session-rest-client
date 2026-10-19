# Plan

## CLI browser login and generation

- [x] Add `--login`: launch an isolated browser, let the user authenticate and browse, then continue on terminal confirmation. Supply Playwright automatically; use installed Chrome by default.
- [x] Observe modules and named GraphQL contracts, bind observed endpoints, and invoke the existing generator through the same browser session. Do not require copied headers or a session-provider command.
- [x] Test login-to-generation, cookie continuity, secret exclusion, cancellation, missing browser, ambiguous discovery, cleanup and existing-output protection. Run an actual browser against a synthetic authenticated site.
- [x] Document the executable command, update the installed skill, run full suites and commit/push targeted steps.

Verification: `RUN_BROWSER_SMOKE=1 npm test` passes all 51 tests, including real Chrome -> synthetic login -> cookie-authenticated source reads -> CLI-written client files. The synthetic app observed one login, one normal browser read and zero mutations. All 5 Python worker tests pass. No production account was used for this authentication test.

The CLI owns browser lifecycle and terminal handoff; the human owns login/MFA and navigation. Playwright's isolated temporary context owns authentication; no storage-state, HAR, trace, screenshots or credential exports are written. Browser-managed temporary profile files are removed on normal close. The observer retains only bounded endpoint/query definitions and module references, never login bodies, variables or headers. Asset fetching uses a separate credential-free context. Generation does not execute API operations. Failure/cancellation closes owned contexts and leaves existing clients untouched; retry starts a fresh login. Observed shared GraphQL endpoints may bind unexecuted source definitions, but that is not live mutation verification.

## Read-only query transport

- [x] Inspect the service's actual browser request before expanding beyond GET/HEAD.
- [x] If required for a GraphQL query, add an explicit, origin/path/body-scoped POST authorization hook; default behavior remains GET/HEAD only.
- [x] Carry the authorized body through the optional browser-compatible worker via stdin. Deny redirected POSTs and never persist or echo request bodies/headers.
- [x] Test default denial, allowlist scope, body validation, redirects, credential isolation, cancellation, and existing GET/HEAD compatibility before a live proof.
- [x] Verify an authenticated read-only query against a live service through both guarded Fetch factories.

Service-specific query semantics belong to the service client and caller-supplied request guard. This package owns authentication scope and transport. No mutation permission is implied by enabling a single query; failure must occur before sending an unapproved request.

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

The artifact collector performs GET/HEAD and writes only to staging. Fetch adapters also support caller-authorized read-only POST queries. Existing evidence and downstream records are never modified. Done means the full test suite passes and service clients can use either authenticated transport without private configuration entering this repository.

The optional browser-compatible transport runs a small Python worker using `curl_cffi`. The worker receives each request through stdin and returns one response through captured stdout. It follows no redirects and writes no credential or response files. The authenticated wrapper remains responsible for origin restrictions.
# Endpoint discovery and guarded writes

- [x] Add passive frontend-module and GraphQL-document discovery; generate standalone operation descriptors without executing fetched code.
- [x] Add explicit, bounded POST/PUT authorization for JSON and binary writes, retaining read-only defaults and rejecting write redirects.
- [x] Test discovery, generated output, byte limits, body immutability, origin isolation, worker behavior, and redaction; document limits and commit changes.

The caller supplies already-discovered source URLs and approved request contracts. Source analysis discovers candidates, not proof of live compatibility. Generated descriptors contain only endpoint/query definitions, never request variables or credentials. Service clients own domain validation. Each write requires a synchronous exact-request predicate; storage uploads use a separate credential-free origin-scoped transport. No implicit retries or cross-origin redirects are allowed for writes. Ambiguous write outcomes require service-side reconciliation before retrying.

## Website-to-client entrypoint

- [x] Provide one bounded discovery/generation API and command: website URL plus optional in-memory session, endpoint hints, and operation selection -> standalone client files and a coverage report.
- [x] Reuse authenticated Fetch for the website and credential-free Fetch for approved asset origins. Traverse discovered module references without executing source. Generate named GraphQL methods and reviewed REST methods; refuse missing or ambiguous endpoint mappings.
- [x] Test the complete website-to-generated-client flow with synthetic websites, including writes disabled by default, private input exclusion, partial coverage, and existing-output protection. Run the entrypoint against the live inspected application without invoking mutations.
- [x] Rewrite the README around that workflow and update the installed skill to invoke it rather than manually recreate discovery.

Verification: 43 JavaScript tests and 5 Python worker tests pass. The CLI generated a selected operation from an authenticated application's inspected module, with bounded coverage explicitly reported; its descriptor matched the separately inspected source. No generated mutation was executed. Browser attachment remains the integration/skill's responsibility; computed runtime-only contracts still require observed request evidence.

The generator owns passive source discovery and reusable client scaffolding, not universal API inference. Browser automation supplies the current URL/session and observed endpoint mapping when the website does not expose it. The generated client owns no authentication or bookkeeping data. Generation does not execute discovered operations. Coverage must expose unreadable modules, bounds and unsupported runtime-only contracts; never claim the entire website is understood. Output is created exclusively in a new directory; interrupted generation is recoverable by inspecting that directory, never overwriting an existing client.
