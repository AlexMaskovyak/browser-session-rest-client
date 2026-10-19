import { parse, print, visit } from 'graphql';

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
