import { rename, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Test-only browser wrapper. The CLI still launches its normal headed browser
// through Playwright's pipe; a loopback CDP port lets an external driver act as
// the human. No application dependency or prompt is replaced/injected.
const executable = chromium.executablePath();
const original = `${executable}.e2e-original`;
await rename(executable, original);
await writeFile(executable, ['#!/bin/sh', `exec ${JSON.stringify(original)} --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "$@"`, ''].join('\n'), { mode: 0o755 });
