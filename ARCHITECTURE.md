# Python generator

The generator turns website request definitions into standalone Python clients.
Browser login is the first milestone. Discovery and Python package generation
follow through the same generator, rather than through handwritten service clients.

## Ownership and flow

The website owns accounts and authentication. The human signs in and completes
verification codes in a browser launched by Python Playwright. Playwright is a
browser automation library; it controls Chrome or Chromium. Python is the public
CLI and library interface. Playwright's bundled driver is an internal dependency,
so users do not install or run Node commands.

The Python browser-session component owns the temporary browser and its lifetime.
It passes the open session to the next component in memory. The initial login
command checks that the user returned to the requested website and that no visible
password field remains. This is user-confirmed readiness, not proof that a service
API accepts the session. No generic page heuristic can prove that for every site.

Discovery will own endpoint evidence and coverage. Generation will own standalone
endpoint source, CLI commands and help. Generated service packages must not depend
on this generator. Service repositories own domain validation and multi-request
workflows. Private orchestration owns real records and operational ledgers.

## Mutation and credential boundaries

Login navigates the website and allows the human to authenticate. Website scripts
run normally. The generator does not submit discovered business operations during
login or discovery. Generated writes will require explicit operation confirmation.
No production write is part of this rewrite's tests.

Credentials stay in the temporary browser or process memory. Do not export cookies,
storage state, HAR recordings, screenshots, headers or tokens. Python session
handles must not expose credentials in their printed representation. Browser-managed
temporary profile files can exist on disk and are removed on normal close.

## Failure and recovery

Ctrl+C, termination, browser closure and failed navigation must close owned browser
resources and return nonzero. Errors expose bounded messages, not raw browser
diagnostics or credential-bearing URLs. A subsequent command starts a fresh login.
Forced process termination can leave temporary browser files.

## Verification

Unit tests cover input and lifecycle failures. Docker tests install the actual
Python package and drive its CLI through a real terminal and headed browser using
synthetic HTTPS login and MFA. These establish the CLI's behavior, not compatibility
with Gusto or completeness of any production account. Python generation and live
service reads each need their own later evidence.
