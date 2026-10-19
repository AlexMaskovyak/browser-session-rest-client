import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.js';

test('CLI generates a client and refuses to overwrite an existing directory', async () => {
  const parent=await mkdtemp(join(tmpdir(),'website-cli-test-'));
  const output=join(parent,'client');
  const saved=globalThis.fetch;
  globalThis.fetch=async url=>new Response(String(url).endsWith('.js') ? `fetch('/api/items')` : '<script src="/app.js"></script>');
  try {
    const args=['--url','https://example.test','--output',output];
    await main(args);
    const source=await readFile(join(output,'index.js'),'utf8');
    assert.match(source,/WebsiteClient/);
    await assert.rejects(main(args),{code:'CLI_USAGE'});
    assert.equal(await readFile(join(output,'index.js'),'utf8'),source);
    await assert.rejects(main(['--unknown']));
  } finally { globalThis.fetch=saved; }
});
test('CLI runs through an installed-style executable symlink', async () => {
  const parent=await mkdtemp(join(tmpdir(),'website-cli-bin-'));
  const executable=join(parent,'website-client');
  await symlink(fileURLToPath(new URL('../src/cli.js',import.meta.url)),executable);
  assert.match(execFileSync(executable,['--help'],{encoding:'utf8'}),/website-client --url HTTPS_URL/);
});
