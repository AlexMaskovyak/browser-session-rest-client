# Pin the multi-architecture Node image; install only the exact Chromium revision
# selected by package-lock.json instead of downloading unrelated browsers.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /work
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools python3 python3-venv openssl xauth && apt-get clean
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium

FROM dependencies AS e2e
COPY requirements-test.lock ./
RUN python3 -m venv /opt/website-client-python && /opt/website-client-python/bin/pip install --require-hashes -r requirements-test.lock
COPY pyproject.toml ./
COPY python ./python
COPY tests_python ./tests_python
COPY src ./src
COPY test ./test
COPY docs ./docs
COPY README.md LICENSE ./
COPY docker ./docker
RUN /opt/website-client-python/bin/python -m build --wheel --no-isolation && /opt/website-client-python/bin/pip install --no-deps dist/*.whl
# Install the package as a consumer would; tests invoke its executable, not main().
RUN archive="$(npm pack --pack-destination /tmp --silent)" && npm install --prefix /opt/website-client --ignore-scripts "/tmp/$archive"
RUN node docker/e2e/install-browser-observer.mjs
USER node
ENV HOME=/home/node
ENV WEBSITE_CLIENT_CLI=/opt/website-client/node_modules/.bin/website-client
ENV TERM=xterm
CMD ["sh", "-c", "npm test && npm run test:worker && /opt/website-client-python/bin/python -m pytest -q -p no:cacheprovider tests_python && xvfb-run -a -s '-screen 0 1280x900x24' node --test docker/e2e/cli-login.e2e.mjs"]
