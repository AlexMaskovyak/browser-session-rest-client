# Docker end-to-end tests

From the repository root:

```sh
npm run test:docker
```

Requires a running Docker engine. The command builds a Linux image, runs all normal JavaScript and Python worker tests, then runs six interactive CLI end-to-end scenarios. The image uses a digest-pinned Node 22 Debian base, `npm ci`, and the Chromium revision selected by the locked Playwright version. No host Node installation, browser, profile or node_modules directory is used by the tests.

## What runs

The image packs the repository and installs that tarball into `/opt/website-client`. Tests launch its real `website-client --login --browser chromium` executable through a Python PTY. Chromium runs headed under Xvfb. A separate test-only CDP driver fills a synthetic website's login and MFA forms; the test sends Enter or Ctrl+C through the CLI's actual terminal. The CLI receives no `main()` imports, fake login callbacks or injected application transports.

The synthetic HTTPS site has a container-local CA trusted by Chromium and the CLI's Node process. TLS checks are not bypassed. Its GraphQL endpoint executes against a real schema. The scenarios assert:

1. Login + MFA → authenticated private-source discovery → terminal Enter → generated files → a working generated read method.
2. A fresh CLI run starts logged out and cannot generate before login completes.
3. Ctrl+C cancels through the real terminal and removes the owned browser/profile.
4. Closing the login browser exits without creating a client.
5. Existing output is preserved and rejected before browser startup.
6. Piped stdin is rejected as noninteractive, with no output or surviving browser.

The successful path also checks that generated files exclude synthetic credentials, cookies, request variables and response data; mutation replay stays at zero; generation waits for terminal confirmation; and the browser listener and temporary profile are removed.

After generation closes the login browser, the generated client is imported and given a fixture-authenticated HTTPS transport through its normal Fetch interface. Its read method calls the real local GraphQL server; no canned response is substituted. This checks the generated method, not persistence of the browser session. Mutations remain disabled by default. An exit deadline fails the test rather than turning a forced termination into a successful cleanup assertion.

## Isolation and limits

Runtime uses a non-root user, `--network none`, dropped Linux capabilities, no-new-privileges, an init process and private shared memory. There are no host filesystem or Docker socket mounts and no published ports. The CDP listener is test-only and loopback-only inside the disposable container. The Docker context is allowlisted and excludes host dependencies, Git data and unrelated files. Image construction needs network access for official base layers and dependencies; test execution uses loopback only.

No production account or Gusto endpoint is involved. Passing establishes the installed Linux CLI's synthetic login-to-generation behavior, not universal website compatibility. The older Mac/browser smoke test remains separately opt-in; Docker's interactive suite does not use that test's injected launch/confirmation functions.

Containers are removed after execution; the reusable test image and Docker build cache remain. All test credentials, certificates and generated clients are created inside the disposable container, not the checkout.

## Recorded verification

On October 20, 2026, `npm run test:docker` completed with exit status 0 using Docker Desktop's Linux/arm64 engine, Node 22.23.3 and Chromium 141.0.7390.37 (Playwright build 1194). All six interactive scenarios passed. The same container also passed 50 JavaScript tests (the older opt-in Mac smoke test was skipped) and all five Python worker tests. Linux/amd64 and production websites were not exercised in this run.
