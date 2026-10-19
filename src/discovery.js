import { parse, print, visit } from 'graphql';
import { parse as parseJavaScript } from 'acorn';

/** Static fetch calls only; computed URLs/options require observed runtime evidence. */
export function discoverStaticFetchEndpoints(source, websiteUrl) {
  let ast;
  try { ast = parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { return []; }
  const found = new Map();
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const callee = node.callee;
    const isFetch = callee?.type === 'Identifier' && callee.name === 'fetch' ||
      callee?.type === 'MemberExpression' && !callee.computed && ['window', 'globalThis'].includes(callee.object?.name) && callee.property?.name === 'fetch';
    if (node.type === 'CallExpression' && isFetch && typeof node.arguments[0]?.value === 'string') {
      const options = node.arguments[1];
      const properties = options?.type === 'ObjectExpression' ? options.properties : [];
      const methodField = properties.find((p) => (p.key?.name ?? p.key?.value) === 'method');
      const method = methodField?.value?.value ?? 'GET';
      if ((!options || options.type === 'ObjectExpression') && !properties.some((p) => p.type === 'SpreadElement') && (!methodField || typeof methodField.value?.value === 'string') && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        try {
          const url = new URL(node.arguments[0].value, websiteUrl);
          if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) found.set(`${method} ${url.href}`, { origin: url.origin, method, pathTemplate: url.pathname });
        } catch { /* Unsupported URL literal. */ }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return [...found.values()];
}

/** Passive candidate discovery. Never evaluates downloaded JavaScript. */
export function discoverModuleReferences(source, sourceUrl) {
  const base = new URL(sourceUrl);
  const result = new Set();
  for (const match of source.matchAll(/["'`]((?:\.\.?\/|assets\/)[^"'`\s$]+\.js)["'`]/g)) {
    const url = new URL(match[1].startsWith('assets/') ? `../${match[1]}` : match[1], base);
    if (url.origin === base.origin && !url.username && !url.password) result.add(url.href);
  }
  return [...result];
}

/** Extract GraphQL source literals emitted by graphql-tag loaders. */
export function discoverGraphqlDocuments(source) {
  const documents = new Set();
  for (const match of source.matchAll(/\bbody:\s*`((?:\\.|[^`\\])*)`/gs)) {
    if (match[1].includes('${')) continue;
    const value = match[1].replace(/\\([\\`nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
    try { parse(value); documents.add(value); } catch { /* Not a GraphQL source literal. */ }
  }
  return [...documents];
}

/** Generate a dependency-free descriptor for one operation and its fragments. */
export function generateGraphqlOperationModule({ documents, operationName, endpoint }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid operation endpoint');
  if ([...url.searchParams.keys()].some((key) => /token|key|secret|credential|signature|password|auth/i.test(key))) throw new Error('Credential-bearing operation endpoint is not allowed');
  const definitions = new Map();
  for (const document of documents) {
    for (const definition of parse(document).definitions) {
      if (!definition.name) throw new Error('Anonymous definitions are not supported');
      const name = definition.name.value;
      if (definitions.has(name) && print(definitions.get(name)) !== print(definition)) throw new Error('Conflicting GraphQL definitions');
      definitions.set(name, definition);
    }
  }
  const operation = definitions.get(operationName);
  if (operation?.kind !== 'OperationDefinition' || !['query', 'mutation'].includes(operation.operation)) throw new Error('Named query or mutation required');
  const selected = [];
  const completed = new Set();
  function include(definition, active = new Set()) {
    const name = definition.name.value;
    if (active.has(name)) throw new Error('Cyclic GraphQL fragments');
    if (completed.has(name)) return;
    active = new Set([...active, name]);
    selected.push(definition);
    visit(definition, { FragmentSpread(node) {
      const fragment = definitions.get(node.name.value);
      if (fragment?.kind !== 'FragmentDefinition') throw new Error('Missing GraphQL fragment');
      include(fragment, active);
    } });
    completed.add(name);
  }
  include(operation);
  const descriptor = { endpoint: url.href, operationName, kind: operation.operation, query: print({ kind: 'Document', definitions: selected }) };
  return `// Generated from inspected frontend operation definitions.\nexport default Object.freeze(${JSON.stringify(descriptor, null, 2)});\n`;
}
