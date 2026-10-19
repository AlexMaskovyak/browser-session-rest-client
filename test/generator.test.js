import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateWebsiteClient } from '../src/generator.js';

const url = 'https://example.test/expenses';
const endpoint = 'https://api.example.test/graphql';
const moduleSource = 'const document={body:`query List { items { id } } mutation Create($input: ItemInput!) { create(input:$input) { id } }`};';
const website = async () => new Response('<script src="https://cdn.example.test/app.js"></script>');
const options = { url, fetch: website, assetFetch: async () => new Response(moduleSource), assetOrigins: ['https://cdn.example.test'], graphqlEndpoint: endpoint };
async function load(files) {
  const directory = await mkdtemp(join(tmpdir(), 'website-client-test-'));
  await mkdir(join(directory, 'operations'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  return (await import(pathToFileURL(join(directory, 'index.js')))).WebsiteClient;
}

test('website-to-client discovery produces working named methods, not just descriptors', async () => {
  const result = await generateWebsiteClient(options);
  assert.deepEqual(result.report.generatedOperations, ['List', 'Create']);
  assert.equal(result.report.liveVerified, false);
  const Client = await load(result.files);
  const calls = [];
  const fetch = async (url, init) => { calls.push({url, init}); return Response.json({data:{items:[]}}); };
  const client = new Client({fetch});
  assert.deepEqual(await client.List(), {items:[]});
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.redirect, 'manual');
  await assert.rejects(client.Create({input:{amount:'1.00'}}), /Mutation/);
  await assert.rejects(new Client({fetch, allowMutations:true}).Create({}), /Mutation/);
  await assert.rejects(new Client({fetch, allowMutations:true}).Create({}, {confirmMutation:true}), /variables/);
  await new Client({fetch, allowMutations:true}).Create({input:{}}, {confirmMutation:true});
  assert.equal(calls.length, 2);
});

test('reuses the session only at the website origin and follows discovered module references', async () => {
  const requests = [];
  const result = await generateWebsiteClient({...options,
    fetch: async (target, init) => { requests.push(['session', target]); assert.equal(init.method, 'GET'); return new Response('<script src="https://cdn.example.test/app.js"></script><script src="https://unapproved.test/evil.js"></script>'); },
    assetFetch: async (target) => { requests.push(['asset', target]); return new Response(target.endsWith('app.js') ? 'import "./form.js"; throw Error("not executed");' : moduleSource); }
  });
  assert.deepEqual(requests.map(r=>r[0]), ['session','asset','asset']);
  assert.equal(result.report.sourceCount, 2);
  assert.equal(requests.some(r=>r[1].includes('unapproved')), false);
});

test('makes bounds and unreadable source gaps explicit; never invents endpoint mappings', async () => {
  const bounded = await generateWebsiteClient({...options, maxModules:1, assetFetch: async () => new Response(moduleSource+';import "./more.js";')});
  assert.equal(bounded.report.bounded, true);
  await assert.rejects(generateWebsiteClient({...options, graphqlEndpoint:undefined}), /Observed GraphQL endpoint/);
  await assert.rejects(generateWebsiteClient({...options, assetFetch:async()=>new Response('', {status:403})}), /No supported/);
  await assert.rejects(generateWebsiteClient({...options, operationNames:['Invented']}), /not discovered/);
  await assert.rejects(generateWebsiteClient({...options, maxSourceBytes:5}), /limit/);
});

test('supports reviewed REST paths without persisting runtime IDs, query values or bodies', async () => {
  const result = await generateWebsiteClient({...options, operationNames:[], restEndpoints:[{name:'GetItem',origin:'https://api.example.test',method:'GET',pathTemplate:'/items/{id}'}, {name:'CreateItem',origin:'https://api.example.test',method:'POST',pathTemplate:'/items'}]});
  const Client = await load(result.files);
  let sent;
  const client = new Client({fetch:async(url,init)=>{sent={url:String(url),init};return Response.json({id:'runtime-private'});}});
  await client.GetItem({path:{id:'runtime-private'},query:{search:'secret-query'}});
  assert.equal(sent.url, 'https://api.example.test/items/runtime-private?search=secret-query');
  assert.ok(!JSON.stringify(result.files).includes('runtime-private'));
  await assert.rejects(client.GetItem({path:{id:'..'}}), /path parameter/);
  await assert.rejects(client.GetItem({path:{id:'x'},body:{}}), /Read requests/);
  await assert.rejects(client.CreateItem({body:{amount:'1.00'}}), /Mutation/);
});

test('rejects credential-bearing descriptors, conflicting names and unsupported contracts', async () => {
  for (const restEndpoints of [[{name:'constructor',origin:'https://api.example.test',method:'GET',pathTemplate:'/items'}], [{name:'Get',origin:'https://api.example.test',method:'GET',pathTemplate:'//evil.test'}]]) await assert.rejects(generateWebsiteClient({...options,restEndpoints}));
  await assert.rejects(generateWebsiteClient({...options, graphqlEndpoint:`${endpoint}?token=secret`}));
});
test('generates static REST methods with unverified scaffolding reported explicitly', async () => {
  const result=await generateWebsiteClient({...options,graphqlEndpoint:undefined,assetFetch:async()=>new Response(`fetch('/api/items'); fetch('/api/items',{method:'POST',body:JSON.stringify({secret:'private-value'})}); fetch('https://unapproved.test/track');`)});
  assert.equal(result.report.staticRestEndpoints.length,2);
  assert.equal(result.report.generatedOperations.length,0);
  assert.ok(!JSON.stringify(result.files).includes('private-value'));
  assert.ok(!JSON.stringify(result.files).includes('unapproved.test'));
  const Client=await load(result.files);
  let calls=0;
  const client=new Client({fetch:async()=>{calls++;return Response.json([]);}});
  const descriptors=JSON.parse(result.files['operations.js'].split('export const restEndpoints = ')[1].slice(0,-2));
  for(const [name,descriptor] of Object.entries(descriptors)) {
    if(descriptor.method==='GET') await client[name](); else await assert.rejects(client[name]({body:{}}),/Mutation/);
  }
  assert.equal(calls,1);
});
test('explicit browser-observed modules are visited ahead of general page preload tables', async () => {
  const result=await generateWebsiteClient({...options,moduleUrls:['https://cdn.example.test/target.js'],maxModules:1,fetch:async()=>new Response('<link href="https://cdn.example.test/unrelated.js">'),assetFetch:async target=>{assert.ok(target.endsWith('target.js'));return new Response(moduleSource);}});
  assert.equal(result.report.sourceCount,1);
  assert.equal(result.report.bounded,true);
});
test('browser endpoint ambiguity leaves explicit coverage gaps rather than guessing or discarding mapped operations', async () => {
  const graphqlEndpoint=name=>name==='List'?endpoint:undefined;
  const result=await generateWebsiteClient({...options,graphqlEndpoint});
  assert.deepEqual(result.report.generatedOperations,['List']);
  assert.deepEqual(result.report.unboundOperations,['Create']);
  await assert.rejects(generateWebsiteClient({...options,graphqlEndpoint,operationNames:['Create']}),/Missing operation endpoint/);
});
