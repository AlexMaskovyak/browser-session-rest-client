import path from 'node:path';

const SECRET_KEY = /(authorization|cookie|csrf|password|secret|storage.?state|token)/i;

export function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error('Manifest must have version 1 and an artifacts array');
  }
  rejectSecrets(manifest);
  const ids = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact.id || typeof artifact.id !== 'string') throw new Error('Artifact id is required');
    if (ids.has(artifact.id)) throw new Error(`Duplicate artifact id: ${artifact.id}`);
    ids.add(artifact.id);
    if (!artifact.url || !URL.canParse(artifact.url)) throw new Error(`Invalid URL for ${artifact.id}`);
    const method = artifact.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) throw new Error(`Unsupported method for ${artifact.id}: ${method}`);
    if (typeof artifact.filename !== 'string' || !artifact.filename || ['.', '..'].includes(artifact.filename)
      || /[/\\\0]/.test(artifact.filename) || path.basename(artifact.filename) !== artifact.filename) {
      throw new Error(`Unsafe filename for ${artifact.id}`);
    }
  }
  return manifest;
}

function rejectSecrets(value, key = '') {
  if (SECRET_KEY.test(key)) throw new Error(`Secret-bearing manifest field is not allowed: ${key}`);
  if (Array.isArray(value)) return value.forEach((item) => rejectSecrets(item));
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) rejectSecrets(child, childKey);
  }
}

export function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/(auth|cookie|credential|csrf|key|password|role|secret|session|signature|storage.?state|token)/i.test(key)) {
      url.searchParams.set(key, 'REDACTED');
    }
  }
  return url.toString();
}
