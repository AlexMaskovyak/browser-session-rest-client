import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema, graphql } from 'graphql';

export async function startPrivateSite() {
  const directory = await mkdtemp(join(tmpdir(), 'website-client-ca-'));
  const rootKey = join(directory, 'root.key');
  const rootCert = join(directory, 'root.crt');
  const key = join(directory, 'server.key');
  const csr = join(directory, 'server.csr');
  const cert = join(directory, 'server.crt');
  const extensions = join(directory, 'extensions.cnf');
  const openssl = (args) => execFileSync('openssl', args, { stdio: 'ignore' });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', rootKey, '-out', rootCert, '-subj', '/CN=Website Client E2E Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
  await writeFile(extensions, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n');
  openssl(['x509', '-req', '-in', csr, '-CA', rootCert, '-CAkey', rootKey, '-CAcreateserial', '-days', '1', '-out', cert, '-extfile', extensions]);
  // This isolated container's browser trusts the fixture CA. The real CLI is
  // never given ignoreHTTPSErrors, certificate-bypass flags or a fake transport.
  const nss = join(process.env.HOME, '.pki', 'nssdb');
  await mkdir(nss, { recursive: true });
  execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]);
  execFileSync('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'website-client-e2e', '-t', 'C,,', '-i', rootCert]);

  const nonce = randomUUID();
  const secrets = {
    username: `test-${nonce}@example.test`, password: `password-${nonce}`,
    cookie: `cookie-${nonce}`, challenge: `challenge-${nonce}`,
    variable: `variable-${nonce}`, response: `response-${nonce}`, otp: '123456'
  };
  const counts = { passwordLogins: 0, mfaLogins: 0, reads: 0, mutations: 0, moduleReads: 0, refusedModuleReads: 0 };
  const schema = buildSchema('type Item { id: ID! } input ItemInput { label: String } type Query { items(first: Int): [Item!]! } type Mutation { create(input: ItemInput!): Item! }');
  const rootValue = {
    items: () => { counts.reads++; return [{ id: secrets.response }]; },
    create: () => { counts.mutations++; return { id: 'unexpected-mutation' }; }
  };
  const source = `const definition={body:\`query List($first: Int) { items(first: $first) { id } } mutation Create($input: ItemInput!) { create(input: $input) { id } }\`};
fetch('/graphql?operationName=List',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'List',query:'query List($first: Int) { items(first: $first) { id } }',variables:{first:10,privateValue:${JSON.stringify(secrets.variable)}}})});`;
  const form = (mfa) => mfa ? '<form method="POST" action="/login/mfa"><label>Verification code<input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>' : '<form method="POST" action="/login"><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>';
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const path = new URL(request.url, 'https://localhost').pathname;
    const cookie = request.headers.cookie ?? '';
    const authenticated = cookie.includes(`session=${secrets.cookie}`);
    const redirect = (location, cookies) => { response.writeHead(303, { location, ...(cookies ? { 'set-cookie': cookies } : {}) }); response.end(); };
    const html = (value) => { response.setHeader('content-type', 'text/html'); response.end(value); };
    const body = (read) => {
      let value = '';
      request.on('data', (chunk) => { value += chunk; if (value.length > 4096) request.destroy(); });
      request.on('end', () => read(value));
    };
    if (path === '/login' && request.method === 'POST') {
      body((value) => {
        const fields = new URLSearchParams(value);
        if (fields.get('username') !== secrets.username || fields.get('password') !== secrets.password) { response.writeHead(401); response.end(); return; }
        counts.passwordLogins++;
        redirect('/login/mfa', `challenge=${secrets.challenge}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      }); return;
    }
    if (path === '/login/mfa' && request.method === 'POST') {
      body((value) => {
        if (!cookie.includes(`challenge=${secrets.challenge}`) || new URLSearchParams(value).get('code') !== secrets.otp) { response.writeHead(401); response.end(); return; }
        counts.mfaLogins++;
        redirect('/app', `session=${secrets.cookie}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      }); return;
    }
    if (path === '/login' || path === '/login/mfa') { html(form(path.endsWith('/mfa'))); return; }
    if (!authenticated) {
      if (path === '/private-client.js') counts.refusedModuleReads++;
      redirect('/login'); return;
    }
    if (path === '/private-client.js') {
      counts.moduleReads++; response.setHeader('content-type', 'text/javascript'); response.end(source); return;
    }
    if (path === '/graphql') {
      body(async (value) => {
        let payload;
        try { payload = JSON.parse(value); } catch { response.writeHead(400); response.end(); return; }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(await graphql({ schema, rootValue, source: payload.query, variableValues: payload.variables, operationName: payload.operationName })));
      }); return;
    }
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    html(`<h1>Private app</h1><p>${secrets.username}</p><script src="/private-client.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}/app`, rootCert, directory, secrets, counts,
    reset() { for (const key of Object.keys(counts)) counts[key] = 0; },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  };
}
