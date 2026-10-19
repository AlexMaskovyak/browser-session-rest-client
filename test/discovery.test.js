import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModuleReferences, discoverGraphqlDocuments, generateGraphqlOperationModule } from '../src/discovery.js';

test('discovers literal module candidates without executing source', () => {
  assert.deepEqual(discoverModuleReferences('import "./form.js"; ["assets/shared.js", "./form.js", `./${secret}.js`]; throw Error()', 'https://example.test/assets/app.js'), ['https://example.test/assets/form.js', 'https://example.test/assets/shared.js']);
});
test('extracts only parseable non-interpolated GraphQL source literals', () => {
  assert.deepEqual(discoverGraphqlDocuments('x={body:`query Read { viewer { id } }`}; y={body:`not graphql`}; z={body:`query ${evil}`};'), ['query Read { viewer { id } }']);
});
test('generates standalone descriptors with transitive fragments but no other operations', async () => {
  const source = generateGraphqlOperationModule({ endpoint: 'https://example.test/graphql', operationName: 'Create', documents: ['mutation Create($input: CreateInput!) { create(input:$input) { ...Fields } } query Other { secret } fragment Fields on Item { id ...More } fragment More on Item { name }'] });
  const { default: operation } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal(operation.kind, 'mutation');
  assert.match(operation.query, /fragment More/);
  assert.doesNotMatch(operation.query, /Other|secret/);
  assert.equal(Object.isFrozen(operation), true);
});
test('rejects missing, conflicting and cyclic definitions and unsafe endpoints', () => {
  const make = (documents, endpoint = 'https://example.test/graphql') => generateGraphqlOperationModule({ documents, endpoint, operationName: 'Read' });
  for (const docs of [['query Other { id }'], ['query Read { ...Missing }'], ['query Read { ...A } fragment A on Item { ...B } fragment B on Item { ...A }'], ['query Read { id }', 'query Read { name }']]) assert.throws(() => make(docs));
  assert.throws(() => make(['query Read { id }'], 'https://user:password@example.test/graphql'));
});
