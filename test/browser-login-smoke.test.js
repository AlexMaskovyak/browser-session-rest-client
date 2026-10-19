import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

test('real Chrome login -> cookie-authenticated discovery -> CLI client files, with no API mutations', {skip:process.env.RUN_BROWSER_SMOKE !== '1',timeout:30000}, async () => {
  const directory=await mkdtemp(join(tmpdir(),'browser-login-smoke-'));
  const key=join(directory,'test-key.pem'), cert=join(directory,'test-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=localhost'],{stdio:'ignore'});
  const {chromium}=await import('playwright-core');
  const counts={logins:0,reads:0,mutations:0,authenticatedModuleReads:0};
  const secret='synthetic-session-secret';
  const source='const definition={body:`query List { items { id } } mutation Create($input: ItemInput!) { create(input:$input) { id } }`}; fetch("/graphql?operationName=List",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationName:"List",query:"query List { items { id } }",variables:{privateValue:"synthetic-private-variable"}})});';
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},(request,response)=>{
    const authenticated=request.headers.cookie?.includes(`session=${secret}`);
    if(request.url==='/login' && request.method==='POST') {
      counts.logins++;response.writeHead(303,{'set-cookie':`session=${secret}; Path=/; Secure; HttpOnly`,location:'/app'});response.end();return;
    }
    if(request.url==='/login') {response.setHeader('content-type','text/html');response.end('<form action="/login" method="POST"><input name="password" type="password"><button>Sign in</button></form>');return;}
    if(!authenticated) {response.writeHead(302,{location:'/login'});response.end();return;}
    if(request.url==='/private-client.js') {counts.authenticatedModuleReads++;response.setHeader('content-type','text/javascript');response.end(source);return;}
    if(request.url?.startsWith('/graphql')) {
      let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
        const payload=JSON.parse(body);
        if(payload.operationName==='List')counts.reads++;else counts.mutations++;
        response.setHeader('content-type','application/json');response.end(JSON.stringify({data:{items:[{id:'synthetic-private-id'}]}}));
      });return;
    }
    response.setHeader('content-type','text/html');response.end('<h1>Private app</h1><script src="/private-client.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`https://localhost:${server.address().port}/app`;
  let browser;
  try {
    await main(['--url',url,'--output',join(directory,'client'),'--login'],{
      launch:async()=>{
        browser=await chromium.launch({channel:'chrome',headless:true});
        const newContext=browser.newContext.bind(browser);
        // Only the synthetic localhost certificate is ignored in this injected test launcher.
        browser.newContext=options=>newContext({...options,ignoreHTTPSErrors:true});
        return browser;
      },
      confirm:async({page})=>{
        await page.locator('input[type=password]').fill('synthetic-password');
        const loaded=page.waitForResponse(response=>response.url().includes('/graphql?operationName=List'));
        await page.getByRole('button',{name:'Sign in'}).click();
        await loaded;
      },progress:()=>{}
    });
    const operations=await readFile(join(directory,'client','operations.js'),'utf8');
    const report=JSON.parse(await readFile(join(directory,'client','discovery.json'),'utf8'));
    assert.match(operations,/Create/);assert.match(operations,/List/);
    for(const privateValue of [secret,'synthetic-password','synthetic-private-variable','synthetic-private-id']) assert.ok(!operations.includes(privateValue));
    assert.equal(counts.logins,1);assert.equal(counts.reads,1);assert.equal(counts.mutations,0);
    assert.ok(counts.authenticatedModuleReads>=2,'Source discovery must reuse the browser login cookie');
    assert.equal(report.browserSession.authentication,'user-confirmed-browser-session');
    assert.equal(browser.isConnected(),false);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
