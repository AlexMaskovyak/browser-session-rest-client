import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserObservation, generateWithBrowserLogin } from '../src/browser-login.js';
import { main } from '../src/cli.js';

const origin = 'https://example.test';
const endpoint = `${origin}/graphql?operationName=List`;
const query = 'query List($first: Int) { items(first: $first) { id } }';
const source = 'const document={body:`query List($first: Int) { items(first: $first) { id } } mutation Create($input: ItemInput!) { create(input:$input) { id } }`};';
const observed = (change = {}) => ({ url: () => endpoint, resourceType: () => 'fetch', method: () => 'POST', frame: () => ({ url: () => `${origin}/app` }), postData: () => JSON.stringify({ operationName:'List', query, variables:{first:10, privateValue:'secret-variable'} }), ...change });

test('observes contracts without retaining headers, variables, login payloads or inline private values', () => {
  const observer = createBrowserObservation({origin});
  observer.observe(observed({headers:()=>assert.fail('Headers must not be accessed')}));
  observer.observe(observed({url:()=>`${origin}/login`,postData:()=>assert.fail('Login body must not be accessed')}));
  observer.observe(observed({postData:()=>JSON.stringify({operationName:'AuthToken',query:'mutation AuthToken { login }',variables:{password:'private-password'}})}));
  observer.observe(observed({postData:()=>JSON.stringify({operationName:'Private',query:'query Private { person(email:"private-person@example.test") { id } }'})}));
  const snapshot=observer.snapshot();
  assert.equal(snapshot.graphqlDocuments.length,1);
  assert.equal(snapshot.graphqlEndpoint('List'),endpoint);
  assert.equal(snapshot.graphqlEndpoint('Create'),`${origin}/graphql?operationName=Create`);
  assert.ok(!JSON.stringify(snapshot).includes('secret-variable'));
  assert.ok(!JSON.stringify(snapshot).includes('private-password'));
  assert.ok(!JSON.stringify(snapshot).includes('private-person'));
});

test('observation bounds, SSO isolation and conflicting endpoint mappings fail closed', () => {
  const observer=createBrowserObservation({origin,maxRequests:3});
  observer.observe(observed({frame:()=>({url:()=> 'https://sso.example.test/login'})}));
  observer.observe(observed());
  observer.observe(observed({url:()=>`${origin}/other-graphql`}));
  observer.observe(observed());
  observer.observe(observed());
  const snapshot=observer.snapshot();
  assert.equal(snapshot.graphqlEndpoint('List'),null);
  assert.equal(snapshot.coverage().omittedObservations,1);
});

function harness() {
  const browser=new EventEmitter();
  const context=new EventEmitter();
  const page=new EventEmitter();
  const state={browserClosed:0,contextClosed:0,assetsDisposed:0,authenticated:false,requests:[]};
  page.url=()=>`${origin}/app`;
  page.goto=async()=>{
    context.emit('request', observed({url:()=>`${origin}/app.js`,resourceType:()=> 'script'}));
    context.emit('request', observed());
  };
  page.content=async()=>'<p>private-account-content</p><script src="/app.js"></script>';
  page.locator=()=>({count:async()=>0});
  context.newPage=async()=>page;
  context.close=async()=>{state.contextClosed++;};
  context.request={fetch:async(url,options)=>{
    assert.equal(state.authenticated,true,'Login cookie must be available to source requests');
    assert.equal(options.method,'GET'); assert.equal(options.maxRedirects,0);
    state.requests.push(url);
    return {ok:()=>true,status:()=>200,url:()=>url,headers:()=>({'content-type':'text/javascript'}),body:async()=>Buffer.from(source)};
  }};
  browser.newContext=async(options)=>{assert.deepEqual(options,{acceptDownloads:false});return context;};
  browser.close=async()=>{state.browserClosed++;};
  const dependencies={launch:async channel=>{assert.equal(channel,'chrome');return browser;},confirm:async()=>{state.authenticated=true;},progress:()=>{},createAssets:async()=>({dispose:async()=>{state.assetsDisposed++;},fetch:()=>assert.fail('Unexpected third-party source')})};
  return {browser,context,page,state,dependencies};
}

test('login hands its authenticated context to the generator and closes everything afterward', async () => {
  const h=harness();
  const result=await generateWithBrowserLogin({url:`${origin}/app`},h.dependencies);
  assert.deepEqual(result.report.generatedOperations,['List','Create']);
  assert.equal(result.report.browserSession.authentication,'user-confirmed-browser-session');
  assert.equal(result.report.browserSession.sharedEndpointBindings,1);
  assert.equal(result.report.liveVerified,false);
  assert.equal(h.state.requests.length,1);
  assert.ok(!JSON.stringify(result.files).includes('secret-variable'));
  assert.ok(!JSON.stringify(result.files).includes('private-account-content'));
  assert.equal(h.state.browserClosed,1); assert.equal(h.state.contextClosed,1); assert.equal(h.state.assetsDisposed,1);
});

test('login and generation failures are redacted and close the owned browser', async () => {
  for(const phase of ['confirm','generate']) {
    const h=harness();
    h.dependencies[phase]=async()=>{throw Error('private-token-value');};
    await assert.rejects(generateWithBrowserLogin({url:`${origin}/app`},h.dependencies),error=>error.code==='BROWSER_LOGIN'&&!error.message.includes('private-token-value'));
    assert.equal(h.state.browserClosed,1); assert.equal(h.state.contextClosed,1);
  }
});

test('an unfinished login, closed browser, cancellation or launch failure generates no client', async () => {
  const pending=harness(); pending.page.locator=()=>({count:async()=>1});
  await assert.rejects(generateWithBrowserLogin({url:`${origin}/app`},pending.dependencies),/Login is not complete/);
  assert.equal(pending.state.browserClosed,1);
  const disconnected=harness(); disconnected.dependencies.confirm=async()=>{disconnected.browser.emit('disconnected');await new Promise(()=>{});};
  await assert.rejects(generateWithBrowserLogin({url:`${origin}/app`},disconnected.dependencies),/closed/);
  assert.equal(disconnected.state.browserClosed,1);
  const cancelled=harness(); const controller=new AbortController();
  cancelled.dependencies.confirm=async()=>{controller.abort();await new Promise(()=>{});};
  await assert.rejects(generateWithBrowserLogin({url:`${origin}/app`},{...cancelled.dependencies,signal:controller.signal}),/cancelled/);
  assert.equal(cancelled.state.contextClosed,1);
  await assert.rejects(generateWithBrowserLogin({url:`${origin}/app`},{launch:async()=>{throw Error('private-path');},progress:()=>{}}),error=>!error.message.includes('private-path'));
});

test('CLI --login generates files without stdin headers and checks output before opening a browser', async () => {
  const directory=await mkdtemp(join(tmpdir(),'browser-login-cli-'));
  const output=join(directory,'client');
  const h=harness();
  await main(['--url',`${origin}/app`,'--output',output,'--login'],h.dependencies);
  assert.match(await readFile(join(output,'index.js'),'utf8'),/WebsiteClient/);
  const report=JSON.parse(await readFile(join(output,'discovery.json'),'utf8'));
  assert.equal(report.browserSession.observedGraphqlOperations,1);
  const existing=join(directory,'existing'); await mkdir(existing);
  await assert.rejects(main(['--url',origin,'--output',existing,'--login'],{launch:()=>assert.fail('Existing output opened browser')}),/already exists/);
  await assert.rejects(main(['--url',origin,'--output',join(directory,'other'),'--login','--session-stdin']),/do not combine/);
});
