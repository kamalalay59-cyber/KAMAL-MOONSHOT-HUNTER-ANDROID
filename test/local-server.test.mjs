import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tempData=fs.mkdtempSync(path.join(os.tmpdir(),'kamal-moonshot-tests-'));
process.env.DATA_DIR=tempData;
process.env.HOST='127.0.0.1';
const {browserRequestAllowed,csvCell,fetchJson,geckoRetryDelay,geckoScanDue,milestoneAlert,paperExitReason,poolAgeMinutes,priceIsPlausible,providerRetryDelay,securityDueCandidates,start}=await import('../server.mjs');
const localServer=await start({host:'127.0.0.1',port:0,background:false});
const baseUrl=`http://127.0.0.1:${localServer.address().port}`;
function api(pathname,{method='GET',body,headers={}}={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:localServer.address().port,path:pathname,method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},agent:false},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,text,json:()=>JSON.parse(text)})})});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end()})}
test.after(async()=>{const closed=new Promise(resolve=>localServer.close(resolve));localServer.closeAllConnections();localServer.closeIdleConnections();await closed;await new Promise(resolve=>setTimeout(resolve,30));fs.rmSync(tempData,{recursive:true,force:true})});

test('standalone package uses Node built-ins and needs no Cloudflare or runtime dependencies',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(pkg.scripts.start,'node server.mjs');
 assert.equal(pkg.dependencies,undefined);
 const source=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
 assert.match(source,/from 'node:http'/);
 assert.doesNotMatch(source,/cloudflare:workers|wrangler|DurableObject/);
});
test('Android companion is HTTPS-only, opens the remote dashboard, and contains no embedded secrets',()=>{
 const appRoot=path.join(root,'android-app');
 const manifest=fs.readFileSync(path.join(appRoot,'app/src/main/AndroidManifest.xml'),'utf8');
 const activity=fs.readFileSync(path.join(appRoot,'app/src/main/java/com/kamal/moonshot/MainActivity.java'),'utf8');
 assert.match(manifest,/usesCleartextTraffic="false"/);
 assert.match(manifest,/android\.permission\.INTERNET/);
 assert.match(activity,/!"https"\.equalsIgnoreCase\(uri\.getScheme\(\)\)/);
 assert.match(activity,/settings\.setMixedContentMode\(WebSettings\.MIXED_CONTENT_NEVER_ALLOW\)/);
 assert.match(activity,/webView\.loadUrl\(allowedOrigin\)/);
 assert.doesNotMatch(activity,/TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|ADMIN_TOKEN\s*=/);
 assert.ok(fs.existsSync(path.join(appRoot,'app/build.gradle')));
});
test('GitHub Android APK workflow builds from android-app and uploads the actual APK location',()=>{
 const workflow=fs.readFileSync(path.join(root,'.github/workflows/android.yml'),'utf8');
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/branches:\s*\n\s+- main/);
 assert.match(workflow,/gradle-version:\s*["']?8\.9/);
 assert.match(workflow,/working-directory:\s*android-app/);
 assert.match(workflow,/gradle --no-daemon assembleDebug/);
 assert.match(workflow,/android-app\/app\/build\/outputs\/apk\/debug\/\*\.apk/);
 assert.match(workflow,/if-no-files-found:\s*error/);
});
test('server exposes local API routes and blocks LIVE mode by construction',()=>{
 const source=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
 assert.ok(source.includes("route==='/state'"));
 assert.ok(source.includes("route==='/telegram/status'"));
 assert.ok(source.includes("route==='/telegram/test'"));
 assert.ok(source.includes("body.mode&&body.mode!=='PAPER'"));
 assert.ok(source.includes("route==='/kill'"));
 assert.ok(source.includes('observed15x'));
 assert.ok(source.includes('observed101x'));
 assert.ok(source.includes('watch15x'));
 assert.ok(source.includes('watch101x'));
 assert.ok(source.includes('MAX_ENTRY_AGE_MINUTES'));
 assert.ok(source.includes('PAPER LIQUIDITY COLLAPSE'));
 assert.ok(source.includes('PAPER TRAILING RISK EXIT'));
 assert.ok(source.includes('RESULT_MILESTONES = [2,5,10,15,25,50,101]'));
});
test('dashboard makes newborn crypto meme scope and relative 101X target explicit',()=>{
 const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
 assert.match(html,/KAMAL_BACKEND_ENABLED=true/);
 assert.match(html,/name="product-scope" content="crypto-meme-only; not-forex"/);
 assert.match(html,/name="multiple-definition" content="101x-from-first-signal"/);
 assert.match(html,/15-minute liquidity-pair age gate/);
});
test('API blocks cross-site browser requests and untrusted Host headers',()=>{
 assert.equal(browserRequestAllowed({headers:{host:'127.0.0.1:8787','sec-fetch-site':'same-origin',origin:'http://127.0.0.1:8787'}}),true);
 assert.equal(browserRequestAllowed({headers:{host:'127.0.0.1:8787','sec-fetch-site':'cross-site',origin:'http://evil.example'}}),false);
 assert.equal(browserRequestAllowed({headers:{host:'evil.example','sec-fetch-site':'same-origin',origin:'http://evil.example'}}),false);
 assert.equal(browserRequestAllowed({headers:{host:'127.0.0.1:8787',origin:'null'}}),false);
});
test('VPS proxy mode accepts only the configured HTTPS origin and rejects hostile or plain HTTP origins',()=>{
 const previous=process.env.PUBLIC_ORIGIN;
 process.env.PUBLIC_ORIGIN='https://scanner.example.com';
 try{
  assert.equal(browserRequestAllowed({headers:{host:'scanner.example.com','x-forwarded-proto':'https','sec-fetch-site':'same-origin',origin:'https://scanner.example.com'}}),true);
  assert.equal(browserRequestAllowed({headers:{host:'scanner.example.com','x-forwarded-proto':'https','sec-fetch-site':'cross-site',origin:'https://scanner.example.com'}}),false);
  assert.equal(browserRequestAllowed({headers:{host:'scanner.example.com','x-forwarded-proto':'https',origin:'https://evil.example'}}),false);
  assert.equal(browserRequestAllowed({headers:{host:'scanner.example.com','x-forwarded-proto':'http',origin:'http://scanner.example.com'}}),false);
  assert.equal(browserRequestAllowed({headers:{host:'scanner.example.com','x-forwarded-proto':'https',origin:'https://scanner.example.com:8443'}}),false);
  assert.equal(browserRequestAllowed({headers:{host:'evil.example','x-forwarded-proto':'https',origin:'https://scanner.example.com'}}),false);
 }finally{
  if(previous===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=previous;
 }
});
test('public VPS mode refuses to start without HTTPS origin and a 32-character admin token',async()=>{
 const previousOrigin=process.env.PUBLIC_ORIGIN,previousToken=process.env.ADMIN_TOKEN;
 process.env.PUBLIC_ORIGIN='https://scanner.example.com';
 delete process.env.ADMIN_TOKEN;
 try{
  await assert.rejects(start({host:'127.0.0.1',port:0,background:false}),/random ADMIN_TOKEN of at least 32 characters/);
  process.env.ADMIN_TOKEN='short';
  await assert.rejects(start({host:'127.0.0.1',port:0,background:false}),/random ADMIN_TOKEN of at least 32 characters/);
  process.env.ADMIN_TOKEN='x'.repeat(32);
  process.env.PUBLIC_ORIGIN='http://scanner.example.com';
  await assert.rejects(start({host:'127.0.0.1',port:0,background:false}),/HTTPS scheme/);
 }finally{
  if(previousOrigin===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=previousOrigin;
  if(previousToken===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=previousToken;
 }
});
test('VPS-proxied API requires the admin token and matching HTTPS origin at request time',async()=>{
 const previousOrigin=process.env.PUBLIC_ORIGIN,previousToken=process.env.ADMIN_TOKEN;
 process.env.PUBLIC_ORIGIN='https://scanner.example.com';
 process.env.ADMIN_TOKEN='a'.repeat(64);
 const headers={'host':'scanner.example.com','x-forwarded-proto':'https','sec-fetch-site':'same-origin','origin':'https://scanner.example.com'};
 const requestThroughProxy=extra=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:localServer.address().port,path:'/api/state',method:'GET',headers:{...headers,...extra}},res=>{
   res.resume();res.on('end',()=>resolve(res.statusCode));
  });
  req.on('error',reject);req.end();
 });
 try{
  assert.equal(await requestThroughProxy({authorization:`Bearer ${process.env.ADMIN_TOKEN}`}),200);
  assert.equal(await requestThroughProxy({}),401);
  assert.equal(await requestThroughProxy({origin:'https://attacker.example',authorization:`Bearer ${process.env.ADMIN_TOKEN}`}),403);
 }finally{
  if(previousOrigin===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=previousOrigin;
  if(previousToken===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=previousToken;
 }
});
test('price outlier gate quarantines impossible jumps but allows plausible moves',()=>{
 assert.equal(priceIsPlausible(1,1_000,15,2_000),true);
 assert.equal(priceIsPlausible(1,1_000,101,2_000),true,'the 101X research target must remain measurable');
 assert.equal(priceIsPlausible(1,1_000,1000,2_000),false);
 assert.equal(priceIsPlausible(1,1_000,.001,2_000),false);
 assert.equal(priceIsPlausible(1,1_000,150,12*60_000),true);
});
test('PAPER exits cover entry loss, liquidity collapse, and peak drawdown',()=>{
 const cfg={liquidityCrashPct:45,trailingStartX:1.5,trailingDrawdownPct:22};
 const base={entry:1,current:1,stopPrice:.82,liquidityAtEntry:10_000,liquidityNow:10_000,maxX:1,highPrice:1};
 assert.equal(paperExitReason({...base,current:.8},cfg),'PAPER HARD STOP');
 assert.equal(paperExitReason({...base,liquidityNow:5_000},cfg),'PAPER LIQUIDITY COLLAPSE');
 assert.equal(paperExitReason({...base,maxX:2,highPrice:2,current:1.55},cfg),'PAPER TRAILING RISK EXIT');
 assert.equal(paperExitReason({...base,liquidityNow:null,maxX:1.2},cfg),'');
});
test('new-pool gate uses actual minutes and rejects unknown/future timestamps',()=>{
 const now=1_000_000;
 assert.equal(poolAgeMinutes(now-15*60_000,now),15);
 assert.equal(poolAgeMinutes(now-15*60_000-1,now)>15,true);
 assert.equal(poolAgeMinutes(0,now),null);
 assert.equal(poolAgeMinutes(now+1,now),null);
});
test('radar milestone alerts do not spam skipped thresholds on a fast price jump',()=>{
 assert.deepEqual(milestoneAlert(15,[]),{notify:15,mark:[15]});
 assert.deepEqual(milestoneAlert(101,[]),{notify:101,mark:[15,25,50,101]});
 assert.deepEqual(milestoneAlert(51,[15,25,50]),null);
 assert.deepEqual(milestoneAlert(26,[15,25]),null);
 assert.deepEqual(milestoneAlert(101,[15,25,50]),{notify:101,mark:[15,25,50,101]});
});
test('security budget rotates past cached top-ranked contracts instead of starving lower-ranked launches',()=>{
 const candidates=Array.from({length:7},(_,i)=>({chain:'solana',address:`token${i}`}));
 const cache=Object.fromEntries(candidates.slice(0,3).map((c,i)=>[`${c.chain}:${c.address}`,{status:'CHECKED',checkedAt:1000+i}]));
 assert.deepEqual(securityDueCandidates(candidates,cache,2000,3).map(c=>c.address),['token3','token4','token5']);
 const partial={...cache,'solana:token3':{status:'UNVERIFIED',checkedAt:1999}};
 assert.deepEqual(securityDueCandidates(candidates,partial,2000,3).map(c=>c.address),['token4','token5','token6']);
});
test('GeckoTerminal scans are rate-limited per network and 429 cooldown backs off safely',()=>{
 const at=1_000_000;
 assert.equal(geckoScanDue('solana',{}, {},at,60_000),true);
 assert.equal(geckoScanDue('solana',{solana:at-30_000},{},at,60_000),false);
 assert.equal(geckoScanDue('solana',{solana:at-90_000},{solana:at+10_000},at,60_000),false);
 assert.equal(geckoScanDue('base',{base:at-90_000},{solana:at+10_000},at,60_000),true);
 assert.equal(geckoRetryDelay(0,0),60_000);
 assert.equal(geckoRetryDelay(0,2),240_000);
 assert.equal(geckoRetryDelay(10_000,0),60_000);
 assert.equal(geckoRetryDelay(120_000,0),120_000);
 assert.equal(geckoRetryDelay(20*60_000,0),15*60_000);
 assert.equal(providerRetryDelay(30_000,1),120_000);
});
test('HTTP 429 gets a durable per-provider cooldown and subsequent calls do not hammer the host',async()=>{
 const originalFetch=global.fetch;let calls=0;
 try{
  global.fetch=async()=>{calls++;return new Response('rate limited',{status:429,headers:{'retry-after':'120'}})};
  await assert.rejects(fetchJson('https://ratelimit-test.example/data'),/HTTP 429/);
  global.fetch=async()=>{calls++;return Response.json({ok:true})};
  await assert.rejects(fetchJson('https://ratelimit-test.example/another'),error=>error.statusCode===429&&error.localCooldown===true);
  assert.equal(calls,1,'the second request must be blocked locally during cooldown');
 }finally{global.fetch=originalFetch}
});
test('CSV export neutralizes spreadsheet formula prefixes and escapes quotes',()=>{
 assert.equal(csvCell('=1+1'),"\"'=1+1\"");
 assert.equal(csvCell('plain \"symbol\"'),'"plain ""symbol"""');
 assert.equal(csvCell('-TOKEN'),"\"'-TOKEN\"");
});
test('starter settings bind to loopback and include optional local Telegram variables',()=>{
 const env=fs.readFileSync(path.join(root,'.env.example'),'utf8');
 assert.match(env,/HOST=127\.0\.0\.1/);assert.match(env,/TELEGRAM_BOT_TOKEN=/);assert.match(env,/TELEGRAM_CHAT_ID=/);assert.match(env,/REQUIRE_SECURITY_CHECK=true/);
 assert.match(env,/MAX_ENTRY_AGE_MINUTES=15/);assert.match(env,/SCAN_INTERVAL_MS=15000/);assert.match(env,/ENTRY_STOP_PCT=18/);
 assert.match(fs.readFileSync(path.join(root,'start-local.bat'),'utf8'),/Node\.js 20 or newer/);
 assert.match(fs.readFileSync(path.join(root,'start-local.sh'),'utf8'),/process\.versions\.node/);
 assert.match(fs.readFileSync(path.join(root,'README_AR.md'),'utf8'),/101X/);
 assert.match(fs.readFileSync(path.join(root,'VALIDATION_PLAN_AR.md'),'utf8'),/DATA_UNAVAILABLE/);
});
test('mocked live-feed end-to-end: a fresh checked meme pair opens a PAPER position, LIVE stays blocked',async()=>{
 const originalFetch=global.fetch;
 const tokens={
  solana:'So11111111111111111111111111111111111111111',
  ethereum:'0x1234567890abcdef1234567890abcdef12345678'
 };
 let marketPrice=0.0000123;
 const originalTelegramToken=process.env.TELEGRAM_BOT_TOKEN,originalTelegramChat=process.env.TELEGRAM_CHAT_ID,telegramMessages=[];
 process.env.TELEGRAM_BOT_TOKEN='fake-test-bot-token';process.env.TELEGRAM_CHAT_ID='fake-test-chat';
 global.fetch=async(input,options={})=>{
  const url=new URL(String(input));
  if(url.hostname==='api.telegram.org'){telegramMessages.push(JSON.parse(options.body||'{}').text||'');return new Response(JSON.stringify({ok:true,result:{message_id:telegramMessages.length}}),{status:200})}
  if(url.hostname==='api.dexscreener.com'&&(url.pathname.includes('token-profiles')||url.pathname.includes('token-boosts')))return new Response(JSON.stringify([{chainId:'solana',tokenAddress:tokens.solana},{chainId:'ethereum',tokenAddress:tokens.ethereum}]),{status:200});
  if(url.hostname==='api.geckoterminal.com'){const network=url.pathname.includes('/solana/')?'solana':'eth';const address=tokens[network==='eth'?'ethereum':'solana'];return new Response(JSON.stringify({data:[{attributes:{base_token_address:address}}]}),{status:200})}
  if(url.hostname==='api.dexscreener.com'&&url.pathname.includes('/tokens/v1/')){
   const chain=url.pathname.split('/')[3];const address=url.pathname.split('/')[4];const token=chain==='solana'?tokens.solana:tokens.ethereum;if(!address?.includes(token))return new Response('[]',{status:200});
   const pair={chainId:chain,baseToken:{address:token,symbol:chain==='solana'?'FRESH':'BLOOM'},quoteToken:{symbol:'SOL'},pairAddress:`pair-${chain}`,pairCreatedAt:Date.now()-4*60_000,priceUsd:String(marketPrice),marketCap:500000,fdv:500000,liquidity:{usd:180000},volume:{m5:140000,h1:600000,h24:1500000},txns:{m5:{buys:100,sells:5},h1:{buys:500,sells:70},h24:{buys:1300,sells:200}},priceChange:{m5:10,h1:60,h6:75,h24:100}};
   return new Response(JSON.stringify([pair]),{status:200});
  }
  if(url.hostname==='api.rugcheck.xyz')return new Response(JSON.stringify({score:0,risks:[]}),{status:200});
  if(url.hostname==='api.gopluslabs.io'){const address=tokens.ethereum;return new Response(JSON.stringify({result:{[address]:{is_honeypot:'0',cannot_sell_all:'0',is_blacklisted:'0',is_mintable:'0',owner_change_balance:'0',is_proxy:'0',hidden_owner:'0',is_open_source:'0',is_anti_whale:'0',buy_tax:'0',sell_tax:'0'}}}),{status:200})}
  throw new Error(`Unexpected mock request: ${url.href}`);
 };
 try{
  const started=await api('/api/control',{method:'POST',body:{enabled:true,mode:'PAPER',bankroll:100,size:5}});
  assert.equal(started.status,200);
  let current;
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,25));current=(await api('/api/state')).json();if(current.lastScan&&current.openTrades.length)break}
  assert.ok(current.lastScan>0,'scanner completed a market discovery cycle');
  assert.ok(current.openTrades.length>0,`fresh checked candidates become PAPER positions; discovery=${JSON.stringify(current.lastCandidates)} errors=${JSON.stringify(current.lastSourceErrors)}`);
  assert.ok(current.openTrades.every(t=>t.mode==='PAPER'&&t.chain==='solana'),'the cautionary EVM candidate must not be entered');
  assert.ok(current.lastCandidates.some(c=>c.chain==='ethereum'&&c.securityStatus==='CAUTION'&&!c.entryReady));
  assert.ok(current.lastCandidates.some(c=>c.ageHours<.25&&c.securityStatus==='CHECKED'));
  marketPrice*=101;
  let tick;for(let i=0;i<40;i++){tick=await api('/api/tick',{method:'POST',body:{}});if(tick.status!==409)break;await new Promise(r=>setTimeout(r,25))}
  assert.equal(tick.status,200);
  const outcomes=(await api('/api/outcomes')).json();
  assert.ok(outcomes.summary.observed101x>0,'the scanner records the 101X multiple from the first signal');
  assert.ok(telegramMessages.some(text=>text.includes('RADAR OBSERVED 101X')),'the 101X first-signal observation reaches the configured Telegram bot');
  const afterJump=(await api('/api/state')).json();
  assert.ok(afterJump.logs.some(x=>x.message.includes('RADAR OBSERVED')&&x.message.includes('101X')),'the 101X milestone is emitted as a radar observation');
  const live=await api('/api/control',{method:'POST',body:{enabled:true,mode:'LIVE'}});
  assert.equal(live.status,400);assert.equal(live.json().error,'PAPER_ONLY');
  const killed=await api('/api/kill',{method:'POST',body:{}});
  assert.equal(killed.json().engine,'OFF');
 }finally{global.fetch=originalFetch;if(originalTelegramToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=originalTelegramToken;if(originalTelegramChat===undefined)delete process.env.TELEGRAM_CHAT_ID;else process.env.TELEGRAM_CHAT_ID=originalTelegramChat}
});
