# Website Client

Website Client is being rewritten in Python to turn website endpoints into
standalone Python clients with an installed command and help for each operation.
The first working step opens a browser so you can log in normally, including
verification codes. Endpoint discovery and Python client generation are not
implemented yet. The earlier [JavaScript generator](docs/javascript-client.md)
remains available separately.

## Install from this checkout

You need Python 3.11 or newer and Google Chrome. Run these commands in this
repository. They create a local Python environment and install the CLI and its
browser library; they do not access your accounts.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/website-client --help
```

The help should list `login`. Use the explicit `.venv/bin/website-client` path to
avoid accidentally running an older Node executable with the same name. Once
this Python environment is activated, `website-client` is the equivalent command.
You do not need a separate Node installation for the Python CLI. Playwright,
the browser automation library, includes its own internal driver.

## Open a browser and log in

For example, to open Gusto:

```sh
.venv/bin/website-client login --url https://app.gusto.com
```

1. A separate Chrome window opens with a temporary profile.
2. Sign into the website and complete its verification steps in that window.
3. Return to the requested website if sign-in took you to another service.
4. Press Enter in the terminal when you are ready. The command checks that you
   returned to the website, closes its browser and prints a result.

A successful handoff prints:

```json
{"sessionReady": true, "authentication": "user-confirmed", "apiVerified": false, "sessionClosed": true, "clientGenerated": false}
```

This confirms your handoff and basic page checks. It does not prove an
authenticated API request. This initial command closes the session without
generating a client or saving a login for the next run. The Python session
component keeps the browser open inside a context manager so subsequent
discovery and generation can reuse the same session when implemented.

The website runs its normal scripts during login. The tool does not replay
business operations, submit receipts, or download account records. Enter
passwords and verification codes only into the website, never the terminal.

Ctrl+C cancels and closes the browser. Closing the browser also ends the command
with an error. Run it again to start a fresh session. Piped input is rejected;
this command needs an interactive terminal.

If Chrome cannot open, check that it is installed. Alternatively, install
Chromium and select it explicitly:

```sh
.venv/bin/python -m playwright install chromium
.venv/bin/website-client login --url https://app.gusto.com --browser chromium
```

If login is reported as incomplete, finish signing in and return to the requested
website before confirming. Network or browser failures require a fresh run. No
cookies, authentication headers, recordings or saved browser state are exported.
Browser-managed temporary files are removed on normal close; forced termination
can leave temporary profile files.

## Development and verification

Install test dependencies and run Python tests:

```sh
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m pytest -q
```

The Docker suite installs the actual Python command, opens headed Chromium and
drives a synthetic HTTPS login with verification codes through a real terminal.
It also runs the earlier JavaScript tests. Docker and npm are required only for
this combined development suite:

```sh
npm run test:docker
```

These tests use no production credentials. They establish the login command's
behavior, not production service compatibility or completed Python generation.
See [architecture](ARCHITECTURE.md) for ownership and [plan](PLAN.md) for the
remaining rewrite milestones.
