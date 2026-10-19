import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
 for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match || process.env[match[1]] !== undefined) continue;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.env[match[1]] = value;
 }
} catch {}
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'state.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const API_TIMEOUT = 9000;
const SCAN_INTERVAL = envNumber('SCAN_INTERVAL_MS',15_000,10_000,60_000,true);
const PRICE_INTERVAL = envNumber('PRICE_INTERVAL_MS',15_000,10_000,60_000,true);
const GECKO_SCAN_INTERVAL = envNumber('GECKO_SCAN_INTERVAL_MS',60_000,30_000,300_000,true);
const SECURITY_CACHE_MS = 30 * 60_000;
const MAX_SECURITIES_PER_SCAN = 3;
const MAX_TRACKED_OUTCOMES = 600;
const MAX_CANDIDATES_PER_SCAN = 200;
function envNumber(name,fallback,min,max,integer=false){const value=Number(process.env[name]);const safe=Number.isFinite(value)?clamp(value,min,max):fallback;return integer?Math.round(safe):safe}
const DEFAULTS = {
  enabled: false, mode: 'PAPER', bankroll: 100, size: envNumber('POSITION_SIZE_PCT',5,1,10),
  maxOpen: envNumber('MAX_OPEN_TRADES',2,1,4,true), maxDrawdownPct: envNumber('MAX_DRAWDOWN_PCT',8,2,20),
  minLiquidity: envNumber('MIN_LIQUIDITY_USD',12_000,2_000,1_000_000), minScore: envNumber('MIN_MOONSHOT_SCORE',78,55,95,true),
  maxEntryAgeMinutes: envNumber('MAX_ENTRY_AGE_MINUTES',15,2,60), requireVerifiedSecurity: process.env.REQUIRE_SECURITY_CHECK !== 'false',
  maxMarketCap: envNumber('MAX_MARKET_CAP_USD',2_000_000,50_000,25_000_000),
  minBuyFlow5m: envNumber('MIN_BUY_FLOW_5M',0.58,0.5,0.9),
  maxPriceImpulse5mPct: envNumber('MAX_PRICE_IMPULSE_5M_PCT',35,5,100),
  liquidityCrashPct: envNumber('LIQUIDITY_CRASH_PCT',45,20,80),
  entryStopPct: envNumber('ENTRY_STOP_PCT',18,8,35),
  trailingStartX: envNumber('TRAILING_START_X',1.5,1.2,10),
  trailingDrawdownPct: envNumber('TRAILING_DRAWDOWN_PCT',22,10,45),
  maxEntryLatencyMs: envNumber('MAX_ENTRY_LATENCY_MS',30_000,10_000,90_000,true),
  lastScan: 0, lastTick: 0, lastDiscoveryCount: 0, lastCandidates: [], lastSourceErrors: [],
  lastGeckoScanByNetwork: {}, geckoNextAllowedByNetwork: {}, gecko429CountByNetwork: {},
  providerCooldownByHost: {}, provider429CountByHost: {},
  recentDiscoveryTokens: [], recentDiscoveryTokensAt: 0
};
const NETWORKS = ['solana','eth','bsc','base','arbitrum','polygon_pos','avalanche','optimism'];
const RESULT_MILESTONES = [2,5,10,15,25,50,101];
const CRYPTO_CHAINS = new Set(['solana','ethereum','bsc','base','arbitrum','polygon','avalanche','optimism']);
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
let state;
let scanBusy = false;
let priceBusy = false;
let scanTimer;
let priceTimer;
const listeners = new Set();

function now(){return Date.now()}
function n(value){const x=Number(value);return Number.isFinite(x)?x:0}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x))}
function money(value){return '$'+n(value).toLocaleString('en-US',{maximumFractionDigits:0})}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function csvCell(value){let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`}
export { csvCell };
function freshState(){return {config:{...DEFAULTS},openTrades:[],closedTrades:[],candidates:[],logs:[],outcomes:[],securityCache:{},pnl:0,peakBankroll:n(DEFAULTS.bankroll)||100}}
export function poolAgeMinutes(createdAt,at=Date.now()){const created=n(createdAt);if(!created||created>at)return null;return (at-created)/60_000}
export function milestoneAlert(highestX,alreadyAlerted=[],milestones=[15,25,50,101]){const reached=milestones.filter(x=>x<=n(highestX)&&!alreadyAlerted.includes(x));return reached.length?{notify:reached[reached.length-1],mark:milestones.filter(x=>x<=n(highestX))}:null}
export function securityDueCandidates(candidates,cache,at=Date.now(),budget=MAX_SECURITIES_PER_SCAN){return candidates.filter(candidate=>{const cached=cache[`${candidate.chain}:${candidate.address}`];const ttl=cached?.status==='UNVERIFIED'?5*60_000:SECURITY_CACHE_MS;return !cached||at-n(cached.checkedAt)>=ttl}).slice(0,budget)}
export function geckoScanDue(network,lastScan={},cooldown={},at=Date.now(),interval=60_000){return n(cooldown[network])<=at&&at-n(lastScan[network])>=interval}
export function geckoRetryDelay(retryAfterMs,previous429s=0){const backoff=Math.min(15*60_000,60_000*2**Math.min(4,Math.max(0,previous429s)));return Math.max(backoff,Math.min(15*60_000,Math.max(0,n(retryAfterMs))))}
export function providerRetryDelay(retryAfterMs,previous429s=0){return geckoRetryDelay(retryAfterMs,previous429s)}
async function loadState(){await fs.mkdir(DATA_DIR,{recursive:true,mode:0o700});try{const d=JSON.parse(await fs.readFile(DB_FILE,'utf8'));const config={...DEFAULTS,...(d.config||{})};config.mode='PAPER';config.enabled=config.enabled===true;config.bankroll=clamp(n(config.bankroll)||100,1,10_000_000);config.size=clamp(n(config.size)||5,1,10);config.maxOpen=clamp(Math.round(n(config.maxOpen)||2),1,4);config.maxDrawdownPct=clamp(n(config.maxDrawdownPct)||8,2,20);config.minLiquidity=clamp(n(config.minLiquidity)||12_000,2_000,1_000_000);config.minScore=clamp(Math.round(n(config.minScore)||78),55,95);config.maxEntryAgeMinutes=clamp(n(config.maxEntryAgeMinutes)||15,2,60);config.maxMarketCap=clamp(n(config.maxMarketCap)||2_000_000,50_000,25_000_000);config.minBuyFlow5m=clamp(n(config.minBuyFlow5m)||.58,.5,.9);config.maxPriceImpulse5mPct=clamp(n(config.maxPriceImpulse5mPct)||35,5,100);config.liquidityCrashPct=clamp(n(config.liquidityCrashPct)||45,20,80);config.entryStopPct=clamp(n(config.entryStopPct)||18,8,35);config.trailingStartX=clamp(n(config.trailingStartX)||1.5,1.2,10);config.trailingDrawdownPct=clamp(n(config.trailingDrawdownPct)||22,10,45);config.maxEntryLatencyMs=clamp(n(config.maxEntryLatencyMs)||30_000,10_000,90_000);config.requireVerifiedSecurity=config.requireVerifiedSecurity!==false;config.lastCandidates=Array.isArray(config.lastCandidates)?config.lastCandidates.slice(0,60):[];config.lastSourceErrors=Array.isArray(config.lastSourceErrors)?config.lastSourceErrors.slice(0,20):[];config.lastGeckoScanByNetwork=config.lastGeckoScanByNetwork&&typeof config.lastGeckoScanByNetwork==='object'?config.lastGeckoScanByNetwork:{};config.geckoNextAllowedByNetwork=config.geckoNextAllowedByNetwork&&typeof config.geckoNextAllowedByNetwork==='object'?config.geckoNextAllowedByNetwork:{};config.gecko429CountByNetwork=config.gecko429CountByNetwork&&typeof config.gecko429CountByNetwork==='object'?config.gecko429CountByNetwork:{};config.recentDiscoveryTokens=Array.isArray(config.recentDiscoveryTokens)?config.recentDiscoveryTokens.slice(0,200):[];config.recentDiscoveryTokensAt=n(config.recentDiscoveryTokensAt);config.lastDiscoveryCount=clamp(Math.round(n(config.lastDiscoveryCount)),0,MAX_CANDIDATES_PER_SCAN);state={...freshState(),...d,config,openTrades:Array.isArray(d.openTrades)?d.openTrades.slice(0,4):[],closedTrades:Array.isArray(d.closedTrades)?d.closedTrades.slice(0,5000):[],candidates:Array.isArray(d.candidates)?d.candidates.slice(0,MAX_CANDIDATES_PER_SCAN):[],logs:Array.isArray(d.logs)?d.logs.slice(0,120):[],outcomes:Array.isArray(d.outcomes)?d.outcomes.slice(0,3000):[],securityCache:d.securityCache&&typeof d.securityCache==='object'?d.securityCache:{},peakBankroll:clamp(n(d.peakBankroll)||config.bankroll,1,10_000_000),pnl:n(d.pnl)}}catch{state=freshState();await persist()}}
let persistQueue=Promise.resolve();
function persist(){const snapshot=JSON.stringify(state,null,2);persistQueue=persistQueue.then(async()=>{await fs.mkdir(DATA_DIR,{recursive:true,mode:0o700});const temp=DB_FILE+'.tmp';await fs.writeFile(temp,snapshot,{mode:0o600});await fs.chmod(temp,0o600);await fs.rename(temp,DB_FILE)}).catch(e=>console.error('persist:',e.message));return persistQueue}
function log(message){state.logs.unshift({at:now(),message:String(message).slice(0,500)});state.logs=state.logs.slice(0,120);}
function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length||!a.length)return false;return crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b))}
function authorized(req){const expected=process.env.ADMIN_TOKEN;if(!expected)return true;const header=req.headers.authorization||'';return header.startsWith('Bearer ')&&safeEqual(header.slice(7).trim(),expected)}
function browserRequestAllowed(req){
 const hostHeader=String(req.headers.host||'').toLowerCase();
 let host;try{host=new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g,'')}catch{return false}
 if(req.headers['sec-fetch-site']==='cross-site')return false;
 const origin=req.headers.origin;
 if(['127.0.0.1','localhost','::1'].includes(host)){
  if(!origin)return true;
  try{const parsed=new URL(origin);const originHost=parsed.hostname.toLowerCase().replace(/^\[|\]$/g,'');return ['127.0.0.1','localhost','::1'].includes(originHost)&&parsed.host.toLowerCase()===hostHeader}catch{return false}
 }
 if(!origin||!process.env.PUBLIC_ORIGIN||req.headers['x-forwarded-proto']!=='https')return false;
 try{
  const expected=new URL(process.env.PUBLIC_ORIGIN),actual=new URL(origin);
  return expected.protocol==='https:'&&expected.pathname==='/'&&!expected.search&&!expected.hash&&!expected.username&&!expected.password&&actual.origin===expected.origin&&hostHeader===expected.host.toLowerCase();
 }catch{return false}
}
export { browserRequestAllowed };
function reqJson(res,status,obj){res.writeHead(status,jsonHeaders);res.end(JSON.stringify(obj))}
async function readBody(req){if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw Object.assign(new Error('JSON required'),{statusCode:415});let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>128*1024)throw Object.assign(new Error('Request too large'),{statusCode:413})}try{return JSON.parse(raw||'{}')}catch{throw Object.assign(new Error('Invalid JSON'),{statusCode:400})}}
export async function fetchJson(url){
 const host=new URL(url).host.toLowerCase(),until=n(state?.config?.providerCooldownByHost?.[host]);
 if(until>now()){const error=new Error(`${host} local cooldown after HTTP 429`);error.statusCode=429;error.retryAfterMs=until-now();error.localCooldown=true;throw error}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),API_TIMEOUT);
 try{
  const response=await fetch(url,{headers:{accept:'application/json','user-agent':'Kamal-Moonshot-Local/1.0'},signal:controller.signal});
  if(!response.ok){
   const error=new Error(`${host} HTTP ${response.status}`);error.statusCode=response.status;
   const retryAfter=response.headers.get('retry-after');error.retryAfterMs=retryAfter?(Number.isFinite(Number(retryAfter))?Number(retryAfter)*1000:Math.max(0,Date.parse(retryAfter)-now())):0;
   if(response.status===429&&state?.config){
    const counts=state.config.provider429CountByHost||{},cooldowns=state.config.providerCooldownByHost||{},count=n(counts[host]);
    state.config.provider429CountByHost={...counts,[host]:count+1};
    state.config.providerCooldownByHost={...cooldowns,[host]:now()+providerRetryDelay(error.retryAfterMs,count)};
    void persist();
   }
   throw error;
  }
  if(state?.config){
   const counts={...state.config.provider429CountByHost},cooldowns={...state.config.providerCooldownByHost};
   delete counts[host];delete cooldowns[host];
   state.config.provider429CountByHost=counts;state.config.providerCooldownByHost=cooldowns;
  }
  return await response.json();
 }finally{clearTimeout(timer)}
}
function chainFromGecko(id){return ({eth:'ethereum',polygon_pos:'polygon',op_bnb:'opbnb'})[id]||id}
function candidatesFromPair(pair){
 const liq=n(pair?.liquidity?.usd),vol24=n(pair?.volume?.h24),vol1=n(pair?.volume?.h1),vol5=n(pair?.volume?.m5);
 const buys5=n(pair?.txns?.m5?.buys),sells5=n(pair?.txns?.m5?.sells),buys1=n(pair?.txns?.h1?.buys),sells1=n(pair?.txns?.h1?.sells);
 const total5=buys5+sells5,total1=buys1+sells1;
 const flow5=total5?buys5/total5:.5,flow1=total1?buys1/total1:.5;
 const pairAgeMinutes=poolAgeMinutes(pair?.pairCreatedAt),ageHours=pairAgeMinutes==null?999:pairAgeMinutes/60;
 const pc5=n(pair?.priceChange?.m5),pc1=n(pair?.priceChange?.h1);
 const txScore=clamp(Math.log10(1+buys5+sells5)*22,0,100);
 const liquidityScore=clamp((Math.log10(Math.max(liq,1))-3)/2.5*100,0,100);
 const volumeScore=clamp(Math.log10(1+vol1)/4.5*100,0,100);
 const buyScore=clamp((flow5*.65+flow1*.35)*100,0,100);
 const growthScore=clamp(50+pc5*1.4+pc1*.32,0,100);
 const youthScore=ageHours<1?75:ageHours<6?95:ageHours<24?84:ageHours<72?58:30;
 const score=Math.round(clamp(liquidityScore*.17+volumeScore*.16+buyScore*.25+growthScore*.16+txScore*.12+youthScore*.14,0,100));
 const marketCap=n(pair?.marketCap)||n(pair?.fdv);
 const stage=pc5>3&&flow5>=state.config.minBuyFlow5m?'IGNITION':pc1>15&&flow1>.55?'EXPLOSION':'WATCH';
 const riskReasons=[];
 if(!Number(pair?.priceUsd)||Number(pair.priceUsd)<=0)riskReasons.push('INVALID_PRICE');
 if(pairAgeMinutes==null)riskReasons.push('PAIR_AGE_UNKNOWN');
 else if(pairAgeMinutes>state.config.maxEntryAgeMinutes)riskReasons.push('POOL_TOO_OLD');
 if(marketCap<=0)riskReasons.push('MARKET_CAP_MISSING');
 else if(marketCap>state.config.maxMarketCap)riskReasons.push('MARKET_CAP_TOO_HIGH');
 if(liq<state.config.minLiquidity)riskReasons.push('LOW_LIQUIDITY');
 if(score<state.config.minScore)riskReasons.push('SCORE_BELOW_THRESHOLD');
 if(total5<2)riskReasons.push('INSUFFICIENT_ACTIVITY');
 if(flow5<state.config.minBuyFlow5m)riskReasons.push('WEAK_BUY_FLOW');
 if(pc5>state.config.maxPriceImpulse5mPct)riskReasons.push('PRICE_IMPULSE_TOO_EXTENDED');
 const security=state.securityCache[`${pair.chainId}:${pair.baseToken?.address}`]||{status:'UNVERIFIED',checkedAt:0,flags:[]};
 if(state.config.requireVerifiedSecurity&&security.status!=='CHECKED')riskReasons.push('SECURITY_NOT_VERIFIED');
 if(security.status==='CRITICAL')riskReasons.push('CRITICAL_SECURITY_FLAGS');
 return {chain:pair.chainId||'',symbol:pair.baseToken?.symbol||'TOKEN',address:pair.baseToken?.address||'',pairAddress:pair.pairAddress||'',price:n(pair.priceUsd),marketCap,stage,entryReady:riskReasons.length===0,entryReasons:riskReasons,score,moonshotScore:score,x100Score:Math.round(clamp(score*.75+growthScore*.25,0,100)),explosionScore:Math.round(growthScore),ignitionScore:Math.round(buyScore),risk:100-score,liquidity:liq,ageHours,pairAgeMinutes,pairCreatedAt:n(pair.pairCreatedAt),flow5,flow1,pc5,pc1,volume1h:vol1,volume24h:vol24,buys5,sells5,securityStatus:security.status,securityRisk:security.risk||0,securityFlags:security.flags||[],priceUpdatedAt:now()};
}
function priceIsPlausible(previous,previousAt,current,at=now()){
 const old=n(previous),price=n(current),elapsed=at-n(previousAt);
 if(!old||!price||elapsed<0||elapsed>10*60_000)return Boolean(price);
 const ratio=price/old;return Number.isFinite(ratio)&&ratio<1000&&ratio>0.001;
}
export { priceIsPlausible };
export function paperExitReason(trade,config){
 if(n(trade.current)<=n(trade.stopPrice))return 'PAPER HARD STOP';
 const entryLiquidity=n(trade.liquidityAtEntry);
 const currentLiquidity=trade.liquidityNow==null?null:Number(trade.liquidityNow);
 if(entryLiquidity>0&&currentLiquidity!==null&&Number.isFinite(currentLiquidity)&&currentLiquidity<=entryLiquidity*(1-n(config.liquidityCrashPct)/100))return 'PAPER LIQUIDITY COLLAPSE';
 if(n(trade.maxX)>=n(config.trailingStartX)&&n(trade.current)<=n(trade.highPrice)*(1-n(config.trailingDrawdownPct)/100))return 'PAPER TRAILING RISK EXIT';
 return '';
}
function trackSignals(rows){
 const indexed=new Map(state.outcomes.map(o=>[`${o.chain}:${String(o.address).toLowerCase()}`,o]));
 let active=state.outcomes.filter(o=>!o.resolved).length;
 for(const c of rows.slice(0,MAX_CANDIDATES_PER_SCAN)){
  const key=`${c.chain}:${String(c.address).toLowerCase()}`;if(!c.address||!c.price)continue;
  let o=indexed.get(key);
  if(!o||(o.resolved&&n(c.ageHours)*60<=state.config.maxEntryAgeMinutes)){if(active>=MAX_TRACKED_OUTCOMES)continue;o={id:crypto.randomUUID(),chain:c.chain,address:c.address,symbol:c.symbol,signalAt:now(),entry:c.price,signalPrice:c.price,currentPrice:c.price,lastSeenAt:now(),lastPriceAt:now(),highestX:1,alertedMilestones:[],entered:false,resolved:false,trackingEndsAt:now()+7*24*60*60_000,score:c.score,securityStatus:c.securityStatus};state.outcomes.unshift(o);indexed.set(key,o);active++}
  else if(!o.resolved){if(!priceIsPlausible(o.currentPrice,o.lastSeenAt||o.signalAt,c.price)){log(`Price outlier quarantined for candidate ${o.symbol}`);continue}o.currentPrice=c.price;o.lastSeenAt=now();o.lastPriceAt=now();o.highestX=Math.max(n(o.highestX),c.price/Math.max(n(o.signalPrice||o.entry),1e-18))}
  if(!o.resolved&&now()>=n(o.trackingEndsAt)){o.resolved=true;o.resolution='7_DAY_WINDOW_COMPLETE';o.resolvedAt=now()}
 }
 if(state.outcomes.length>3000){const activeRows=state.outcomes.filter(o=>!o.resolved).slice(0,MAX_TRACKED_OUTCOMES);const resolvedRows=state.outcomes.filter(o=>o.resolved).slice(0,2400);state.outcomes=[...activeRows,...resolvedRows]}
}
async function discover(){
 const failures=[];const tokens=new Map();
 const absorb=(rows)=>{for(const t of Array.isArray(rows)?rows:[]){const chain=t.chainId||t.chain||'';const address=t.tokenAddress||t.address||t.baseToken?.address;if(chain&&address)tokens.set(`${chain}:${address}`,{chain,address})}};
 if(now()-n(state.config.recentDiscoveryTokensAt)<=5*60_000)absorb(state.config.recentDiscoveryTokens);
 if(now()-n(state.config.lastProfileScan)>=60_000){
  await Promise.all([['profiles','https://api.dexscreener.com/token-profiles/latest/v1'],['boosts','https://api.dexscreener.com/token-boosts/latest/v1']].map(async([label,url])=>{try{absorb(await fetchJson(url))}catch(e){failures.push(`${label}: ${e.message}`)}}));
  state.config.lastProfileScan=now();
 }
 const priorityNetwork='solana';const rotatingNetworks=NETWORKS.filter(network=>network!==priorityNetwork);const rotation=Number(state.config.geckoCursor||0)%rotatingNetworks.length;const selected=[priorityNetwork,rotatingNetworks[rotation]];state.config.geckoCursor=(rotation+1)%rotatingNetworks.length;
 await Promise.all(selected.map(async network=>{
  const at=now();const last=state.config.lastGeckoScanByNetwork||{};const cooldown=state.config.geckoNextAllowedByNetwork||{};
  if(!geckoScanDue(network,last,cooldown,at,GECKO_SCAN_INTERVAL)){if(n(cooldown[network])>at)failures.push(`gecko ${network}: cooldown ${Math.ceil((n(cooldown[network])-at)/1000)}s after provider rate limit`);return}
  state.config.lastGeckoScanByNetwork[network]=at;
  try{
   const payload=await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/new_pools?page=1`);
   state.config.gecko429CountByNetwork[network]=0;delete state.config.geckoNextAllowedByNetwork[network];
   for(const item of payload?.data||[]){const attrs=item.attributes||{};const base=String(attrs.base_token_address||'');const ch=chainFromGecko(network);if(base)tokens.set(`${ch}:${base}`,{chain:ch,address:base});}
  }catch(e){
   failures.push(`gecko ${network}: ${e.message}`);
   if(e.statusCode===429){
    if(e.localCooldown)state.config.geckoNextAllowedByNetwork[network]=Math.max(n(state.config.geckoNextAllowedByNetwork[network]),at+n(e.retryAfterMs));
    else{const count=n(state.config.gecko429CountByNetwork[network]);state.config.gecko429CountByNetwork[network]=count+1;state.config.geckoNextAllowedByNetwork[network]=at+geckoRetryDelay(e.retryAfterMs,count)}
    log(`GeckoTerminal ${network} rate-limited; cooling down ${Math.ceil((state.config.geckoNextAllowedByNetwork[network]-at)/1000)}s`);
   }
  }
 }));
 if(tokens.size){state.config.recentDiscoveryTokens=[...tokens.values()].slice(0,200);state.config.recentDiscoveryTokensAt=now()}
 const byChain=new Map();for(const t of tokens.values()){if(!CRYPTO_CHAINS.has(t.chain))continue;if(!byChain.has(t.chain))byChain.set(t.chain,[]);if(byChain.get(t.chain).length<25)byChain.get(t.chain).push(t.address)}
 const pairs=[];
 await Promise.all([...byChain].map(async([chain,addresses])=>{for(let i=0;i<addresses.length;i+=25){try{const result=await fetchJson(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${addresses.slice(i,i+25).map(encodeURIComponent).join(',')}`);if(Array.isArray(result))pairs.push(...result)}catch(e){failures.push(`pairs ${chain}: ${e.message}`)}}}));
 const best=new Map();for(const p of pairs){const addr=p?.baseToken?.address;if(!addr||!p.priceUsd)continue;const key=`${p.chainId}:${addr}`;const old=best.get(key);if(!old||n(p.liquidity?.usd)>n(old.liquidity?.usd))best.set(key,p)}
 const scored=[...best.values()].map(candidatesFromPair).sort((a,b)=>b.score-a.score||(a.chain==='solana'?-1:b.chain==='solana'?1:0));
 const securityDue=securityDueCandidates(scored,state.securityCache,now(),MAX_SECURITIES_PER_SCAN);
 await checkSecurity(securityDue);
 const rows=scored.map(c=>{const sec=state.securityCache[`${c.chain}:${c.address}`]||{status:'UNVERIFIED',flags:[]};const reasons=c.entryReasons.filter(r=>!['SECURITY_NOT_VERIFIED','CRITICAL_SECURITY_FLAGS','SECURITY_CAUTION_REVIEW'].includes(r));if(state.config.requireVerifiedSecurity&&sec.status!=='CHECKED')reasons.push('SECURITY_NOT_VERIFIED');if(sec.status==='CRITICAL')reasons.push('CRITICAL_SECURITY_FLAGS');if(sec.status==='CAUTION')reasons.push('SECURITY_CAUTION_REVIEW');return {...c,securityStatus:sec.status,securityRisk:sec.risk||0,securityFlags:sec.flags||[],entryReady:reasons.length===0,entryReasons:reasons}});
 trackSignals(rows);state.config.lastScan=now();state.config.lastTick=now();state.config.lastDiscoveryCount=rows.length;state.config.lastCandidates=rows.slice(0,60);state.config.lastSourceErrors=failures.slice(0,20);state.candidates=rows;log(`Discovery finished: ${rows.length} token pairs, ${failures.length} source errors`);await persist();
 if(state.config.enabled)await openQualifyingTrades(rows);
 return rows;
}
async function checkSecurity(candidates){
 await Promise.all(candidates.map(async c=>{
  const key=`${c.chain}:${c.address}`;const cached=state.securityCache[key];const cacheWindow=cached?.status==='UNVERIFIED'?5*60_000:SECURITY_CACHE_MS;if(cached&&now()-n(cached.checkedAt)<cacheWindow)return;
  let result={status:'UNVERIFIED',checkedAt:now(),risk:0,flags:[]};
  try{
   if(c.chain==='solana'){
    const payload=await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(c.address)}/report`);
    if(!payload||typeof payload!=='object'||(!(Array.isArray(payload.risks)&&payload.risks.length>0)&&!(payload.score!=null&&Number.isFinite(Number(payload.score)))))throw new Error('Unexpected RugCheck response');
    const risks=Array.isArray(payload?.risks)?payload.risks:[];const critical=risks.filter(r=>/critical|danger/i.test(String(r.level||''))||/honeypot|mint authority|freeze authority/i.test(String(r.name||r.description||'')));
    result={status:critical.length?'CRITICAL':risks.length?'CAUTION':'CHECKED',checkedAt:now(),risk:n(payload?.score),flags:risks.slice(0,6).map(r=>String(r.name||r.description||r.level||'RISK').slice(0,80))};
   } else {
    const chainIds={ethereum:'1',bsc:'56',base:'8453',arbitrum:'42161',polygon:'137',avalanche:'43114',optimism:'10'};const chain=chainIds[c.chain];
    if(!chain)throw new Error('No supported security checker for chain');
    const payload=await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${encodeURIComponent(c.address)}`);
    const row=payload?.result?.[c.address.toLowerCase()]||Object.values(payload?.result||{})[0];if(!row)throw new Error('Security result missing');
    const checkedFields=['is_honeypot','cannot_sell_all','is_blacklisted','is_mintable','owner_change_balance'];if(!checkedFields.some(field=>['0','1'].includes(String(row[field]))))throw new Error('Incomplete GoPlus security response');
    const flags=[];for(const [field,label] of [['is_honeypot','HONEYPOT'],['cannot_sell_all','SELL_RESTRICTED'],['is_blacklisted','BLACKLIST'],['is_mintable','MINTABLE'],['owner_change_balance','OWNER_BALANCE_CONTROL'],['is_proxy','PROXY_CONTRACT'],['hidden_owner','HIDDEN_OWNER'],['is_anti_whale','TRANSFER_LIMIT']])if(String(row[field])==='1')flags.push(label);if(String(row.is_open_source)==='0')flags.push('NOT_OPEN_SOURCE');
    for(const [field,label] of [['buy_tax','HIGH_BUY_TAX'],['sell_tax','HIGH_SELL_TAX']]){const tax=Number(row[field]);if(Number.isFinite(tax)&&tax>=0.1)flags.push(label)}
    const critical=flags.some(x=>['HONEYPOT','SELL_RESTRICTED','BLACKLIST'].includes(x));result={status:critical?'CRITICAL':flags.length?'CAUTION':'CHECKED',checkedAt:now(),risk:flags.length?Math.min(100,flags.length*20):0,flags};
   }
  }catch(error){result={...result,error:String(error.message||error).slice(0,160)}}
  state.securityCache[key]=result;
 }));
 const cutoff=now()-24*60*60_000;const cacheRows=Object.entries(state.securityCache).filter(([,value])=>n(value?.checkedAt)>=cutoff).sort((a,b)=>n(b[1]?.checkedAt)-n(a[1]?.checkedAt)).slice(0,1500);state.securityCache=Object.fromEntries(cacheRows);
}
function equity(){return n(state.config.bankroll)+n(state.pnl)+state.openTrades.reduce((sum,t)=>sum+unrealized(t),0)}
function unrealized(t){return n(t.notional)*((n(t.current)/Math.max(n(t.entry),1e-18))-1)}
function drawdown(){const top=Math.max(1,n(state.peakBankroll),n(state.config.bankroll));return Math.max(0,(top-equity())/top*100)}
function realizedDayPnl(){const date=new Date();date.setUTCHours(0,0,0,0);const start=date.getTime();return state.closedTrades.filter(t=>n(t.closedAt)>=start).reduce((sum,t)=>sum+n(t.pnl),0)}
function updateRisk(){state.peakBankroll=Math.max(n(state.peakBankroll),equity());if(drawdown()>=state.config.maxDrawdownPct&&state.config.enabled){state.config.enabled=false;log(`Drawdown breaker stopped new paper entries at ${drawdown().toFixed(2)}%`);}}
async function openQualifyingTrades(rows){
 if(drawdown()>=state.config.maxDrawdownPct){updateRisk();return}
 for(const c of rows){if(state.openTrades.length>=state.config.maxOpen)break;if(!c.entryReady)continue;
  const discoveryAge=now()-n(c.priceUpdatedAt);if(discoveryAge>state.config.maxEntryLatencyMs){log(`PAPER entry skipped ${c.symbol}: stale signal ${discoveryAge}ms`);continue}
  if(!CRYPTO_CHAINS.has(c.chain)){log(`PAPER entry skipped ${c.symbol}: unsupported non-crypto chain`);continue}
  if(state.openTrades.some(t=>t.chain===c.chain&&t.address.toLowerCase()===c.address.toLowerCase()))continue;
  const notional=n(state.config.bankroll)*state.config.size/100;if(notional<=0)continue;
  const trade={id:crypto.randomUUID(),chain:c.chain,address:c.address,symbol:c.symbol,mode:'PAPER',entry:c.price,current:c.price,marketCap:c.marketCap,liquidityAtEntry:c.liquidity,liquidityNow:c.liquidity,notional,openedAt:now(),maxX:1,peakX:1,highPrice:c.price,stopPrice:c.price*(1-state.config.entryStopPct/100),stage:c.stage,status:'OPEN',securityStatus:c.securityStatus,score:c.score,realizedPnl:0,lastAlertX:0};
  state.openTrades.push(trade);const outcome=state.outcomes.find(o=>o.chain===trade.chain&&String(o.address).toLowerCase()===String(trade.address).toLowerCase());if(outcome){outcome.entered=true;outcome.tradeId=trade.id;outcome.entry=trade.entry;outcome.openedAt=trade.openedAt}else state.outcomes.unshift({id:crypto.randomUUID(),tradeId:trade.id,chain:trade.chain,address:trade.address,symbol:trade.symbol,signalAt:trade.openedAt,entry:trade.entry,signalPrice:trade.entry,currentPrice:trade.current,highestX:1,entered:true,resolved:false,trackingEndsAt:trade.openedAt+7*24*60*60_000});log(`PAPER OPEN ${trade.symbol} ${trade.chain} score=${trade.score}`);await sendTelegram(trade,'PAPER OPEN',`Signal score ${trade.score}/100`);await persist();
 }
}
async function pollPricesInternal(){
 for(const o of state.outcomes.filter(x=>!x.resolved&&now()>=n(x.trackingEndsAt))){o.resolved=true;o.resolution=o.lastSeenAt?'7_DAY_WINDOW_COMPLETE':'DATA_UNAVAILABLE';o.resolvedAt=now()}
 const activeOutcomes=state.outcomes.filter(o=>!o.resolved);if(!state.openTrades.length&&!activeOutcomes.length)return;const groups=new Map();for(const t of [...state.openTrades,...activeOutcomes]){if(!groups.has(t.chain))groups.set(t.chain,new Set());groups.get(t.chain).add(t.address)}
 for(const [chain,addressSet]of groups){const addresses=[...addressSet];for(let offset=0;offset<addresses.length;offset+=30){const batch=addresses.slice(offset,offset+30);const batchSet=new Set(batch.map(a=>String(a).toLowerCase()));try{const payload=await fetchJson(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${batch.map(encodeURIComponent).join(',')}`);if(!Array.isArray(payload))continue;const best=new Map();for(const p of payload){const tokenKey=String(p.baseToken?.address||'').toLowerCase();if(tokenKey&&(!best.has(tokenKey)||n(p.liquidity?.usd)>n(best.get(tokenKey)?.liquidity?.usd)))best.set(tokenKey,p)}
  for(const o of state.outcomes.filter(x=>x.chain===chain&&!x.resolved&&batchSet.has(String(x.address).toLowerCase()))){const p=best.get(String(o.address).toLowerCase());if(!p||!n(p.priceUsd))continue;const observed=n(p.priceUsd),timestamp=now();if(!priceIsPlausible(o.currentPrice,o.lastPriceAt||o.lastSeenAt||o.signalAt,observed,timestamp)){log(`Price outlier quarantined for candidate ${o.symbol}`);continue}o.currentPrice=observed;o.lastSeenAt=timestamp;o.lastPriceAt=timestamp;o.highestX=Math.max(n(o.highestX),o.currentPrice/Math.max(n(o.signalPrice||o.entry),1e-18));o.alertedMilestones=Array.isArray(o.alertedMilestones)?o.alertedMilestones:[];const alert=milestoneAlert(o.highestX,o.alertedMilestones);if(alert){o.alertedMilestones=alert.mark;log(`RADAR OBSERVED ${o.symbol} ${alert.notify}X from first signal; not a held trade`);await sendTelegram({alertOnly:true,symbol:o.symbol,chain:o.chain,entry:o.signalPrice||o.entry,current:o.currentPrice,notional:0,maxX:o.highestX,marketCap:n(p.marketCap)||n(p.fdv)},`RADAR OBSERVED ${alert.notify}X`,`Crossed price-multiple milestones: ${alert.mark.join('X, ')}X. Relative to first recorded signal only; token may not have been entered and this is not realized profit.`)}if(now()>=n(o.trackingEndsAt)){o.resolved=true;o.resolution='7_DAY_WINDOW_COMPLETE';o.resolvedAt=now()}}
  for(const t of state.openTrades.filter(x=>x.chain===chain&&batchSet.has(String(x.address).toLowerCase()))){const p=best.get(String(t.address).toLowerCase());if(!p||!n(p.priceUsd))continue;const observed=n(p.priceUsd),timestamp=now();if(!priceIsPlausible(t.current,t.lastPriceAt||t.openedAt,observed,timestamp)){log(`Price outlier quarantined for open trade ${t.symbol}`);continue}t.current=observed;t.marketCap=n(p.marketCap)||n(p.fdv)||t.marketCap;if(p.liquidity&&Object.prototype.hasOwnProperty.call(p.liquidity,'usd')&&p.liquidity.usd!=null)t.liquidityNow=n(p.liquidity.usd);t.highPrice=Math.max(n(t.highPrice),t.current);t.maxX=Math.max(n(t.maxX),t.current/t.entry);t.peakX=t.maxX;t.lastPriceAt=timestamp;const outcome=state.outcomes.find(x=>x.tradeId===t.id);if(outcome){outcome.highestX=Math.max(outcome.highestX,t.maxX);outcome.currentPrice=t.current;outcome.updatedAt=now()}
   const milestone=RESULT_MILESTONES.find(x=>t.maxX>=x&&t.lastAlertX<x);if(milestone){t.lastAlertX=milestone;log(`PAPER MILESTONE ${t.symbol} ${milestone}X observed`);await sendTelegram(t,`PAPER MILESTONE ${milestone}X`,`Observed peak ${t.maxX.toFixed(2)}X. This is a price multiple from simulated entry, not a guaranteed/realized return. PAPER unrealized P&L: ${unrealized(t).toFixed(2)} USD`)}
   const exitReason=paperExitReason(t,state.config);
   if(exitReason)await closeTrade(t,exitReason);
  }
 }catch(e){log(`Price poll ${chain}: ${e.message}`)}}}
 updateRisk();state.config.lastTick=now();await persist();
}
async function pollPrices(){if(priceBusy)return;priceBusy=true;try{return await pollPricesInternal()}finally{priceBusy=false}}
async function closeTrade(t,reason){t.status='CLOSED';t.closedAt=now();t.exit=t.current;t.exitReason=reason;t.pnl=unrealized(t)-t.notional*.006;state.pnl+=t.pnl;state.openTrades=state.openTrades.filter(x=>x.id!==t.id);state.closedTrades.unshift(t);const outcome=state.outcomes.find(x=>x.tradeId===t.id);if(outcome){outcome.closedAt=t.closedAt;outcome.exit=t.exit;outcome.exitReason=reason;outcome.realizedPnl=t.pnl}log(`${reason} ${t.symbol} P&L ${t.pnl.toFixed(2)} USD`);await sendTelegram(t,reason,`PAPER P&L after estimated costs: ${t.pnl.toFixed(2)} USD · Peak ${t.maxX.toFixed(2)}X`);await persist()}
async function sendTelegram(t,title,detail){
 const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;if(!token||!chat)return {ok:false,skipped:true,error:'Telegram secrets not configured'};
 const move=(n(t.current)/Math.max(n(t.entry),1e-18));const cap=n(t.marketCap)?`\nMarket cap / FDV (provider): <code>${esc(money(t.marketCap))}</code>`:'';const pnlLabel=t.status==='CLOSED'?'PAPER realized':'PAPER unrealized';const pnlValue=t.status==='CLOSED'?n(t.pnl):unrealized(t);const resultLine=t.alertOnly?`Observed price multiple from first signal: <b>${n(t.maxX).toFixed(2)}X</b> (${((move-1)*100).toFixed(2)}%).\n<i>This is a radar observation, not a position or realized profit.</i>`:`Observed peak: <b>${n(t.maxX).toFixed(2)}X</b>\n${pnlLabel}: <b>${pnlValue.toFixed(2)} USD</b> (${((move-1)*100).toFixed(2)}%)`;const msg=`<b>KAMAL MOONSHOT · ${esc(title)}</b>\n\n<b>${esc(t.symbol)}</b> · ${esc(t.chain)}\nSignal / entry reference: <code>${esc(t.entry)}</code>\nCurrent: <code>${esc(t.current)}</code>${cap}\n${resultLine}\n${esc(detail)}\n\n<i>Paper simulation only. No live order. Multiples are not guaranteed.</i>`;
 try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text:msg,parse_mode:'HTML',disable_web_page_preview:true}),signal:controller.signal});clearTimeout(timer);const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.description||`Telegram HTTP ${response.status}`);return {ok:true}}catch(e){log(`Telegram send failed: ${e.message}`);return {ok:false,error:e.message}}
}
function publicState(){const cfg={...state.config,mode:'PAPER'};return {ok:true,engine:cfg.enabled?'ON':'OFF',mode:'PAPER',equity:equity(),floatingPnl:state.openTrades.reduce((s,t)=>s+unrealized(t),0),riskManagement:state.openTrades.length>0,config:cfg,openTrades:state.openTrades.map(t=>({...t,unrealizedPnl:unrealized(t),totalPnl:unrealized(t)})),tradesCount:state.openTrades.length+state.closedTrades.length,dayPnl:realizedDayPnl(),logs:state.logs,serverTime:now(),lastScan:cfg.lastScan,lastTick:cfg.lastTick,lastDiscoveryCount:cfg.lastDiscoveryCount,lastCandidates:cfg.lastCandidates,lastSourceErrors:cfg.lastSourceErrors,bankroll:cfg.bankroll,peakBankroll:state.peakBankroll,drawdownPct:drawdown(),securityHealth:{verified:state.candidates.filter(x=>x.securityStatus==='CHECKED').length,unverified:state.candidates.filter(x=>x.securityStatus==='UNVERIFIED').length,critical:state.candidates.filter(x=>x.securityStatus==='CRITICAL').length}}}
async function route(req,res){const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/')){
 if(!browserRequestAllowed(req)){reqJson(res,403,{ok:false,error:'Local-only request rejected'});return}
 if(!authorized(req)){reqJson(res,401,{ok:false,error:'Unauthorized'});return}
 const route=url.pathname.slice(4);
 if(req.method==='GET'&&route==='/state'){reqJson(res,200,publicState());return}
 if(req.method==='POST'&&route==='/control'){const body=await readBody(req);if(body.mode&&body.mode!=='PAPER'){reqJson(res,400,{ok:false,error:'PAPER_ONLY'});return}state.config.bankroll=clamp(n(body.bankroll)||state.config.bankroll,1,10_000_000);state.config.size=clamp(n(body.size)||state.config.size,1,10);state.config.maxDrawdownPct=clamp(n(body.maxDrawdownPct)||state.config.maxDrawdownPct,2,20);state.config.enabled=body.enabled===true;log(`Engine ${state.config.enabled?'started':'stopped'} · PAPER only`);await persist();if(state.config.enabled&&!state.candidates.length&&!scanBusy){scanBusy=true;void discover().catch(e=>log(e.message)).finally(()=>scanBusy=false)}reqJson(res,200,publicState());return}
 if(req.method==='POST'&&route==='/kill'){state.config.enabled=false;log('KILL SWITCH · new PAPER entries disabled');await persist();reqJson(res,200,publicState());return}
 if(req.method==='POST'&&route==='/tick'){if(scanBusy){reqJson(res,409,{ok:false,error:'SCAN_ALREADY_RUNNING'});return}scanBusy=true;try{await discover();await pollPrices();reqJson(res,200,publicState())}catch(e){reqJson(res,502,{ok:false,error:e.message})}finally{scanBusy=false}return}
 if(req.method==='GET'&&route==='/telegram/status'){const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;if(!token||!chat){reqJson(res,200,{ok:true,configured:false,bot:null,chat:null,error:'Set local Telegram environment variables'});return}try{const [me,destination]=await Promise.all([fetchJson(`https://api.telegram.org/bot${token}/getMe`),fetchJson(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chat)}`)]);reqJson(res,200,{ok:true,configured:true,bot:{username:me.result?.username,name:me.result?.first_name},chat:{id:destination.result?.id,title:destination.result?.title||destination.result?.username||destination.result?.first_name}})}catch(e){reqJson(res,200,{ok:false,configured:true,error:e.message})}return}
 if(req.method==='POST'&&route==='/telegram/test'){const result=await sendTelegram({symbol:'TEST',chain:'LOCAL',entry:1,current:1,notional:0,maxX:1},'TEST MESSAGE','Standalone local engine connection test');reqJson(res,result.ok?200:502,{ok:result.ok,configured:Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID),error:result.error||null});return}
 if(req.method==='GET'&&route==='/outcomes'){const outcomes=state.outcomes;const measured=outcomes.filter(o=>o.resolution==='7_DAY_WINDOW_COMPLETE');const unavailable=outcomes.filter(o=>o.resolution==='DATA_UNAVAILABLE').length;const summary={total:outcomes.length,resolved:measured.length,active:outcomes.filter(o=>!o.resolved).length,dataUnavailable:unavailable,entered:measured.filter(o=>o.entered).length,hit2x:measured.filter(o=>o.highestX>=2).length,hit5x:measured.filter(o=>o.highestX>=5).length,hit10x:measured.filter(o=>o.highestX>=10).length,hit15x:measured.filter(o=>o.highestX>=15).length,hit101x:measured.filter(o=>o.highestX>=101).length,observed15x:outcomes.filter(o=>n(o.highestX)>=15).length,active15x:outcomes.filter(o=>!o.resolved&&n(o.highestX)>=15).length,observed101x:outcomes.filter(o=>n(o.highestX)>=101).length,active101x:outcomes.filter(o=>!o.resolved&&n(o.highestX)>=101).length,closedPnl:state.closedTrades.reduce((sum,t)=>sum+n(t.pnl),0),positivePnl:state.closedTrades.filter(t=>t.pnl>0).length,negativePnl:state.closedTrades.filter(t=>t.pnl<=0).length};const missed=measured.filter(o=>!o.entered&&o.highestX>=2).sort((a,b)=>b.highestX-a.highestX).slice(0,40);const watch15x=outcomes.filter(o=>n(o.highestX)>=15).sort((a,b)=>n(b.highestX)-n(a.highestX)).slice(0,100);const watch101x=outcomes.filter(o=>n(o.highestX)>=101).sort((a,b)=>n(b.highestX)-n(a.highestX)).slice(0,100);reqJson(res,200,{ok:true,count:outcomes.length,summary,recent:outcomes.slice(0,100),missed,watch15x,watch101x});return}
 if(req.method==='GET'&&route==='/outcomes/export'){const rows=[['symbol','chain','signal_at','entry','highest_x','entered','resolved','resolution','exit_reason','realized_pnl'],...state.outcomes.map(o=>[o.symbol,o.chain,new Date(o.signalAt).toISOString(),o.entry,o.highestX,o.entered,o.resolved,o.resolution||'',o.exitReason||'',o.realizedPnl??''])];res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="local-paper-outcomes.csv"'});res.end(rows.map(r=>r.map(csvCell).join(',')).join('\n'));return}
 reqJson(res,404,{ok:false,error:'Not found'});return
 }
 const pathname=decodeURIComponent(url.pathname);const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');const target=path.resolve(ROOT,'public',relative);if(!target.startsWith(path.resolve(ROOT,'public')+path.sep)){res.writeHead(403);res.end('Forbidden');return}try{const data=await fs.readFile(target);const ext=path.extname(target);const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'? 'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/octet-stream';res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(data)}catch{res.writeHead(404);res.end('Not found')}
}
export async function start({host=HOST,port=PORT,background=true}={}){
 if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Remote network binding is not supported. Keep HOST=127.0.0.1 and use the documented HTTPS reverse-proxy setup.');
 if(process.env.PUBLIC_ORIGIN){
  let publicOrigin;try{publicOrigin=new URL(process.env.PUBLIC_ORIGIN)}catch{throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin, for example https://scanner.example.com')}
  if(publicOrigin.protocol!=='https:'||publicOrigin.pathname!=='/'||publicOrigin.search||publicOrigin.hash||publicOrigin.username||publicOrigin.password)throw new Error('PUBLIC_ORIGIN must contain only an HTTPS scheme and hostname, with no path, query, or credentials.');
  if(!process.env.ADMIN_TOKEN||process.env.ADMIN_TOKEN.length<32)throw new Error('VPS mode requires a random ADMIN_TOKEN of at least 32 characters.');
 }
 await loadState();const server=http.createServer((req,res)=>{route(req,res).catch(e=>{if(!res.headersSent)reqJson(res,e.statusCode||500,{ok:false,error:e.statusCode===413?'REQUEST_TOO_LARGE':e.statusCode===415?'JSON_REQUIRED':e.statusCode===400?'INVALID_JSON':'INTERNAL_ERROR'});else res.destroy()})});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});const address=server.address();console.log(`Kamal Moonshot Local running at http://${host}:${typeof address==='object'?address.port:port}`);console.log(`Mode: PAPER only · Data file: ${DB_FILE}`);if(process.env.PUBLIC_ORIGIN)console.log(`HTTPS reverse-proxy mode · Public origin: ${new URL(process.env.PUBLIC_ORIGIN).origin}`);if(!process.env.TELEGRAM_BOT_TOKEN||!process.env.TELEGRAM_CHAT_ID)console.log('Telegram not configured; add local Telegram environment variables to receive alerts.');if(background){scanTimer=setInterval(()=>{if(!scanBusy){scanBusy=true;discover().catch(e=>{log(`Discovery failed: ${e.message}`);state.config.lastSourceErrors=[e.message];void persist()}).finally(()=>scanBusy=false)}},SCAN_INTERVAL);priceTimer=setInterval(()=>pollPrices().catch(e=>log(`Price polling error: ${e.message}`)),PRICE_INTERVAL);void discover().catch(e=>{log(`Initial discovery failed: ${e.message}`);state.config.lastSourceErrors=[e.message];void persist()})}server.on('close',()=>{clearInterval(scanTimer);clearInterval(priceTimer);void persist()});return server}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))start().catch(e=>{console.error(e.message);process.exit(1)});
