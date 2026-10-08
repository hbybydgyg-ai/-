const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const {URL} = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const APP_NAME = 'صدى العراق';
const APP_VERSION = '1.5.31';
const BUILD_ID = 'SADA-1.5.31-CATEGORY-SERVICE-DEFINITIVE-FIX-20261008';
const ADMIN_USER = process.env.ADMIN_EMAIL || 'hsydgyg5@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SrIraq!9vQ#4mL7@xK2';
const FIXED_RECEIVER = process.env.ASIACELL_RECEIVER || '07763308188';
const FIXED_RATE = 1250; // 1 USD = 1,250 IQD
// v1.5.31: signed stateless sessions survive Railway restarts/instance changes.
const sessions = new Map(); // legacy sessions kept only during rolling deployments
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'sadairaq-session-secret-change-me');
const SESSION_COOKIE = 'sadairaq_sid';
const SESSION_TOKEN_HEADER = 'x-sada-session';
const RATE_BUCKETS = new Map();
const RATE_RULES = { auth:{window:60_000,max:12}, provider:{window:60_000,max:20}, order:{window:60_000,max:20}, api:{window:60_000,max:60}, general:{window:60_000,max:60} };
function clientIp(req){ return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim(); }
function rateLimit(req,bucket='general'){ const r=RATE_RULES[bucket]||RATE_RULES.general; const key=clientIp(req)+'|'+bucket; const now=Date.now(); let x=RATE_BUCKETS.get(key); if(!x||now-x.started>r.window)x={started:now,count:0}; x.count++; RATE_BUCKETS.set(key,x); if(x.count>r.max){ return Math.ceil((x.started+r.window-now)/1000); } return 0; }
setInterval(()=>{ const now=Date.now(); for(const [k,v] of RATE_BUCKETS) if(now-v.started>120_000) RATE_BUCKETS.delete(k); for(const [k,v] of sessions) if(now-(v.createdAt||0)>SESSION_TTL_MS) sessions.delete(k); }, 120_000).unref();


function ensureTelegramDefaults(){
  const cfg=readJSON('settings.json',{});
  const tg=cfg.telegram&&typeof cfg.telegram==='object'?{...cfg.telegram}:{};
  if(tg.enabled===undefined) tg.enabled=true;
  if(!tg.token) tg.token=String(process.env.TELEGRAM_BOT_TOKEN||'');
  if(!tg.chat) tg.chat=String(process.env.TELEGRAM_CHAT_ID||'');
  if(tg.token||tg.chat||cfg.telegram) { cfg.telegram=tg; writeJSON('settings.json',cfg); }
}

function ensureData() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, {recursive:true});
  const defaults={
    'users.json':{users:{}},
    'orders.json':[],
    'provider_failures.json':[],
    'payments.json':[],
    'notifications.json':[],
    'telegram_notifications.json':[],
    'notification_seen.json':{},
    'providers.json':{activeProvider:'',providers:{},deletedProviderIds:[]},
    // Provider state is stored separately so code updates do not overwrite it.
    'providers.runtime.json':{activeProvider:'',providers:{},deletedProviderIds:[]},
    'settings.json':{},
    'api_services.json':[],
    'balance_ledger.json':[],
    'api_keys.json':{},
    'stats_state.json':{resetAt:null}
  };
  for(const [file,def] of Object.entries(defaults)){
    const full=path.join(DATA,file);
    let cur=null, ok=true;
    try{cur=JSON.parse(fs.readFileSync(full,'utf8'));}catch(_){ok=false;}
    if(file==='users.json') ok=!!(cur&&typeof cur==='object'&&cur.users&&typeof cur.users==='object'&&!Array.isArray(cur.users));
    else if(file==='orders.json'||file==='provider_failures.json'||file==='payments.json'||file==='notifications.json'||file==='telegram_notifications.json') ok=Array.isArray(cur);
    else if(file==='notification_seen.json') ok=!!(cur&&typeof cur==='object'&&!Array.isArray(cur));
    else if(file==='providers.json') ok=!!(cur&&typeof cur==='object'&&cur.providers&&typeof cur.providers==='object'&&!Array.isArray(cur.providers));
    else if(file==='settings.json'||file==='api_keys.json'||file==='stats_state.json') ok=!!(cur&&typeof cur==='object'&&!Array.isArray(cur));
    else if(file==='api_services.json'||file==='balance_ledger.json') ok=Array.isArray(cur);
    if(!ok){ fs.writeFileSync(full,JSON.stringify(def,null,2),'utf8'); }
  }
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA,file), 'utf8')); }
  catch (_) { return fallback; }
}
function writeJSON(file, value) {
  ensureData();
  const target = path.join(DATA,file);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value,null,2), 'utf8');
  fs.renameSync(tmp, target);
}
function json(res, status, obj, extra={}) {
  res.statusCode = status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
  for (const [k,v] of Object.entries(extra)) res.setHeader(k,v);
  res.end(JSON.stringify(obj));
}
function parseCookies(req){
  const out={};
  for(const part of String(req.headers.cookie||'').split(';')){
    const i=part.indexOf('='); if(i<0) continue;
    try{ out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim()); }catch(_){}
  }
  return out;
}
function sid(req){
  const header=String(req.headers[SESSION_TOKEN_HEADER]||'').trim();
  if(header) return header;
  const auth=String(req.headers.authorization||'').trim();
  if(/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i,'').trim();
  return parseCookies(req)[SESSION_COOKIE] || '';
}
function sessionSig(payload){ return crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('base64url'); }
function encodeSession(value){
  const payload=Buffer.from(JSON.stringify({...value,iat:Date.now()}),'utf8').toString('base64url');
  return payload+'.'+sessionSig(payload);
}
function decodeSession(token){
  const [payload,sig]=String(token||'').split('.');
  if(!payload||!sig) return null;
  if(!safeEqual(sig,sessionSig(payload))) return null;
  try{
    const v=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!v||!v.username||Date.now()-Number(v.iat||0)>SESSION_TTL_MS)return null;
    return v;
  }catch(_){return null;}
}
function session(req){
  const token=sid(req); if(!token)return null;
  const stateless=decodeSession(token);
  if(stateless){
    if(!/^[a-zA-Z0-9_@.\-]+$/.test(String(stateless.username||''))) return null;
    if(stateless.role==='admin' && String(stateless.username)!==String(ADMIN_USER)) return null;
    // v1.5.31: do NOT require users.json for an already signed user session.
    // Firebase/custom-app users may outlive Railway's ephemeral local filesystem.
    return stateless;
  }
  const v=sessions.get(token);
  if(!v)return null;
  if(Date.now()-(v.createdAt||0)>SESSION_TTL_MS){sessions.delete(token);return null;}
  return v;
}
function setSession(res, value){
  const token=encodeSession(value);
  sessions.set(token,{...value,createdAt:Date.now()});
  const forwarded=String(res._forwardedProto||'').toLowerCase();
  const secure=(String(process.env.COOKIE_SECURE||'auto').toLowerCase()==='true' || (String(process.env.COOKIE_SECURE||'auto').toLowerCase()==='auto' && forwarded==='https'))?'Secure; ':'';
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=86400`);
  res.setHeader('X-Sada-Session',token);
  return token;
}
async function bodyJSON(req){
  const limit=256*1024; let raw='';
  for await (const chunk of req){ raw += chunk; if(Buffer.byteLength(raw,'utf8')>limit){ const e=new Error('حجم الطلب أكبر من المسموح'); e.statusCode=413; throw e; } }
  if(!raw) return {};
  try{return JSON.parse(raw)}catch(_){ const e=new Error('JSON غير صالح'); e.statusCode=400; throw e; }
}
function cookieRefresh(res, req){ const s=session(req); if(s) { const id=sid(req); if(id) res.setHeader('X-Session','ok'); } }
function isAdmin(req){ return session(req)?.role === 'admin'; }
function safeEqual(a,b){ const aa=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||'')); if(aa.length!==bb.length) return false; return crypto.timingSafeEqual(aa,bb); }
function hashPassword(password){ const salt=crypto.randomBytes(16).toString('hex'); const hash=crypto.scryptSync(String(password),salt,64).toString('hex'); return `scrypt$${salt}$${hash}`; }
function verifyPassword(password,stored){ const v=String(stored||''); if(!v.startsWith('scrypt$')) return safeEqual(password,v); const parts=v.split('$'); if(parts.length!==3) return false; try{return safeEqual(crypto.scryptSync(String(password),parts[1],64).toString('hex'),parts[2]);}catch(_){return false;} }
function adminPasswordValid(password){ return process.env.ADMIN_PASSWORD_HASH ? verifyPassword(password,process.env.ADMIN_PASSWORD_HASH) : safeEqual(password,ADMIN_PASSWORD); }
function envProvider(){
  const id=String(process.env.SMM_PROVIDER_ID||process.env.PROVIDER_ID||'').trim();
  const name=String(process.env.SMM_PROVIDER_NAME||process.env.PROVIDER_NAME||'').trim() || id;
  const url=String(process.env.SMM_API_URL||process.env.SMM_URL||process.env.PROVIDER_URL||'').trim();
  const key=String(process.env.SMM_API_KEY||process.env.SMM_KEY||process.env.PROVIDER_KEY||'').trim();
  if(!id||!url||!key) return null;
  return {id,name,url,key,source:'environment'};
}
function providerStore(){
  // Never use the deployable providers.json as the authoritative store.
  // providers.runtime.json is intentionally NOT shipped in release ZIPs, so code updates cannot erase it.
  let local=readJSON('providers.runtime.json',null);
  if(!local || !local.providers || typeof local.providers!=='object'){
    const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
    local=legacy;
    if(legacy && legacy.providers && Object.keys(legacy.providers).length){
      try{writeJSON('providers.runtime.json',legacy);}catch(_){}
    }
  }
  const providers={...(local&&local.providers&&typeof local.providers==='object'?local.providers:{})};
  const deleted=new Set(Array.isArray(local?.deletedProviderIds)?local.deletedProviderIds.map(String):[]);
  const env=envProvider();
  if(env && !deleted.has(env.id)) providers[env.id]={...(providers[env.id]||{}),...env};
  let active=String(local?.activeProvider||'');
  if(!active || !providers[active]) active=Object.keys(providers)[0]||'';
  return {activeProvider:active,providers,deletedProviderIds:deleted,envProvider:env};
}
function getProviderById(id){ const store=providerStore(); const pid=String(id||store.activeProvider||''); return {store,pid,prov:(store.providers||{})[pid]||null}; }
function normalizeProviderStatus(v){ const x=String(v||'').trim().toLowerCase(); const map={pending:'pending',queued:'pending',processing:'processing','in progress':'processing',completed:'completed',complete:'completed',partial:'partial',canceled:'cancelled',cancelled:'cancelled',failed:'failed',error:'failed',refunded:'refunded'}; return map[x]||'unknown'; }
function normalizeProviderBalance(d){
  const vals=[];
  const add=(v)=>{ if(v!==undefined&&v!==null&&String(v).trim()!=='') vals.push(v); };
  const walk=(x,depth=0)=>{
    if(x===null||x===undefined||depth>3) return;
    if(typeof x==='object' && !Array.isArray(x)){
      for(const k of ['balance','credits','credit','amount','available_balance','availableBalance','wallet_balance','walletBalance']) add(x[k]);
      for(const k of ['data','result','response','account','wallet','user']) walk(x[k],depth+1);
    }
  };
  add(d?.balance); add(d?.credits); add(d?.credit); walk(d);
  for(const v of vals){
    const raw=String(v).trim().replace(/,/g,'');
    const direct=Number(raw.replace(/^[$€£\s]+/,'').trim());
    if(Number.isFinite(direct)) return direct;
    const m=raw.match(/[-+]?\d+(?:\.\d+)?/);
    if(m){ const n=Number(m[0]); if(Number.isFinite(n)) return n; }
  }
  return null;
}
function normalizeProviderOrderId(d){
  const vals=[
    d?.order,d?.order_id,d?.orderId,d?.providerOrderId,d?.id,
    d?.data?.order,d?.data?.order_id,d?.data?.orderId,d?.data?.id,
    d?.result?.order,d?.result?.order_id,d?.result?.orderId,d?.result?.id
  ];
  for(const v of vals){ if(v!==undefined&&v!==null&&String(v).trim()!=='') return String(v).trim(); }
  return '';
}
function providerReturnedError(d){
  if(!d || typeof d!=='object' || Array.isArray(d)) return false;
  const seen=new Set();
  const walk=(x,depth=0)=>{
    if(x===null||x===undefined||depth>3||typeof x!=='object'||seen.has(x)) return false;
    seen.add(x);
    const e=x.error;
    if(e===true) return true;
    if(typeof e==='string' && e.trim()!=='') return true;
    if(e && typeof e==='object') return true;
    for(const k of ['data','result','response','account','wallet']) if(x[k] && walk(x[k],depth+1)) return true;
    return false;
  };
  return walk(d);
}
function providerErrorText(d){
  if(!d||typeof d!=='object') return '';
  const vals=[d.error,d.message,d.msg,d.reason,d.data?.error,d.data?.message,d.result?.error,d.result?.message];
  for(const v of vals) if(typeof v==='string'&&v.trim()) return v.trim();
  return '';
}
function safeProviderResponse(d){
  if(d===undefined) return null;
  try{return JSON.parse(JSON.stringify(d));}catch(_){return String(d);} 
}

function normalizeProviderCurrency(d){
  return String(d?.currency||d?.data?.currency||d?.result?.currency||d?.account?.currency||'USD').toUpperCase();
}

function normalizeProviderServices(d){
  if(Array.isArray(d)) return d;
  if(Array.isArray(d?.services)) return d.services;
  if(Array.isArray(d?.data)) return d.data;
  if(Array.isArray(d?.result)) return d.result;
  if(Array.isArray(d?.items)) return d.items;
  for(const key of ['services','data','result','items']){
    const obj=d?.[key];
    if(obj && typeof obj==='object' && !Array.isArray(obj)) return Object.entries(obj).map(([service,v])=>({service,...(v&&typeof v==='object'?v:{value:v})}));
  }
  return [];
}

function providerActionSucceeded(action,d,orderId=''){
  if(action!=='cancel') return true;
  const okCancel=(v)=>v===1||v==='1'||v===true||(v&&typeof v==='object'&&!v.error&&(v.cancel===1||v.success===true));
  if(Array.isArray(d)) return d.some(x=>String(x?.order||'')===String(orderId) && okCancel(x?.cancel));
  return okCancel(d?.cancel)||d?.success===true||String(d?.status||'').toLowerCase()==='cancelled';
}
function normalizeWhatsAppUrl(v){
  const raw=String(v||'').trim();
  if(/^https?:\/\/wa\.me\//i.test(raw)) return raw.replace(/\s+/g,'');
  const digits=raw.replace(/\D/g,'');
  if(!digits) return 'https://wa.me/9647762267959';
  const intl=digits.startsWith('964')?digits:(digits.startsWith('0')?'964'+digits.slice(1):digits);
  return 'https://wa.me/'+intl;
}
function normalizeWhatsAppNumber(v){
  const url=normalizeWhatsAppUrl(v); const m=url.match(/wa\.me\/(\d+)/i); return m?m[1]: '9647762267959';
}
function isPrivateAddress(address){
  const a=String(address||'').toLowerCase();
  if(net.isIPv4(a)){ const p=a.split('.').map(Number); return p[0]===10 || p[0]===127 || (p[0]===169&&p[1]===254) || p[0]===0 || (p[0]===192&&p[1]===168) || (p[0]===172&&p[1]>=16&&p[1]<=31); }
  if(net.isIPv6(a)){ return a==='::1'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe8')||a.startsWith('fe9')||a.startsWith('fea')||a.startsWith('feb'); }
  return false;
}
function normalizeProviderApiUrl(raw){
  const u=new URL(String(raw||'').trim());
  const host=u.hostname.toLowerCase();
  // YlaFollow documents https://ylafollow.com/api/v2. Accept the older/common typo /apiv2.
  if(host==='ylafollow.com' && /^\/apiv2\/?$/i.test(u.pathname)) u.pathname='/api/v2';
  // Keep the documented v2 path normalized for YlaFollow.
  return u.toString().replace(/\/$/,'');
}

async function validateProviderUrl(raw){
  const u=new URL(String(raw||'').trim());
  if(!/^https?:$/.test(u.protocol)) throw new Error('API URL يجب أن يبدأ بـ http:// أو https://');
  const h=u.hostname.toLowerCase();
  const localTest = process.env.NODE_ENV==='test' && process.env.ALLOW_LOCAL_PROVIDER_TEST==='1';
  if(!localTest && (h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal'))) throw new Error('عنوان المزود غير مسموح');
  const records=await dns.lookup(h,{all:true,verbatim:true}); if(!records.length) throw new Error('تعذر حل اسم مزود API');
  if(!localTest && records.some(x=>isPrivateAddress(x.address))) throw new Error('عنوان API داخلي أو خاص غير مسموح');
  return u;
}

async function providerRequest(prov,params,timeoutMs=30000){
  if(!prov?.url||!prov?.key) throw new Error('بيانات المزود غير مكتملة');
  const rawUrl=normalizeProviderApiUrl(String(prov.url).trim());
  await validateProviderUrl(rawUrl);
  const base=rawUrl.replace(/\/+$/,'');
  const action=String(params?.action||'');
  // Read operations may try both slash variants and limited retries.
  // Order creation must be exactly-once from our side: never retry add automatically.
  const endpoints=[base,base+'/'].filter((v,i,a)=>a.indexOf(v)===i);
  const payload=new URLSearchParams();
  payload.set('key',String(prov.key));
  Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&String(v)!=='')payload.set(k,String(v));});

  async function callForm(endpoint,attempts){
    let lastError=null;
    for(let attempt=1;attempt<=attempts;attempt++) {
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json,text/plain,*/*','User-Agent':`SadaIraq/${APP_VERSION}`},body:payload.toString(),redirect:'follow',signal:controller.signal});
        const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch(_){d={raw:text};}
        if(!r.ok){ const err=new Error(`مزود SMM أعاد HTTP ${r.status}${text?': '+String(text).slice(0,180):''}`); err.providerRejected=r.status>=400&&r.status<500&&![408,425,429].includes(r.status); err.retryable=[408,425,429].includes(r.status)||r.status>=500; throw err; }
        if(providerReturnedError(d)){ const err=new Error(providerErrorText(d)||'المزود رفض العملية'); err.providerRejected=true; throw err; }
        return d;
      }catch(e){
        lastError=e; const retryable=e?.name==='AbortError'||e?.retryable;
        if(retryable&&attempt<attempts){await new Promise(r=>setTimeout(r,300*attempt));continue;}
        break;
      }finally{clearTimeout(timer);}
    }
    throw lastError||new Error('تعذر الاتصال بالمزود');
  }

  if(action==='add'){
    // Exactly one outbound order-create attempt. A timeout/5xx is surfaced to the UI
    // instead of blindly creating duplicates.
    return callForm(endpoints[0],1);
  }

  let lastError=null;
  for(const endpoint of endpoints){
    try{return await callForm(endpoint,3);}catch(e){lastError=e;}
  }

  // Compatibility fallbacks for READ operations only. Never use them for order creation.
  if(['balance','services'].includes(action)){
    for(const endpoint of endpoints){
      const variants=[
        {method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json,text/plain,*/*','User-Agent':`SadaIraq/${APP_VERSION}`},body:JSON.stringify(Object.fromEntries(payload.entries()))},
        {method:'GET',headers:{'Accept':'application/json,text/plain,*/*','User-Agent':`SadaIraq/${APP_VERSION}`},body:null,url:endpoint+'?'+payload.toString()}
      ];
      for(const v of variants){
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
        try{
          const r=await fetch(v.url||endpoint,{method:v.method,headers:v.headers,body:v.body,redirect:'follow',signal:controller.signal});
          const t=await r.text(); let d={}; try{d=t?JSON.parse(t):{};}catch(_){d={raw:t};}
          if(!r.ok||providerReturnedError(d)) continue;
          return d;
        }catch(_){ } finally{clearTimeout(timer);}
      }
    }
  }
  if(lastError?.name==='AbortError') throw lastError;
  throw lastError||new Error('تعذر الاتصال بالمزود');
}

function userFromSession(req){ const s=session(req); return s?.role==='user' ? String(s.username||'') : ''; }
function appendJsonLedger(file,entry){ const arr=readJSON(file,[]); const next=Array.isArray(arr)?arr:[]; next.push(entry); writeJSON(file,next.slice(-5000)); }

let SITE_ORDER_LOCK=Promise.resolve();
function withSiteOrderLock(fn){ const run=SITE_ORDER_LOCK.catch(()=>{}).then(fn); SITE_ORDER_LOCK=run.finally(()=>{}); return run; }
async function nextSiteOrderId(){
  return withSiteOrderLock(async()=>{
    const cfg=readJSON('settings.json',{}); const n=Math.max(0,Number(cfg.orderCounter||0))+1;
    cfg.orderCounter=n; writeJSON('settings.json',cfg); return String(n);
  });
}
function siteOrderById(id){ return readJSON('orders.json',[]).find(o=>String(o.id||'')===String(id||''))||null; }

function normalizedPath(p){
  if (p.endsWith('.php')) return p.slice(0,-4);
  return p;
}

function acHeaders(){
  return {
    'User-Agent':'okhttp/5.0.0-alpha.2',
    'Connection':'Keep-Alive',
    'Accept-Encoding':'gzip',
    'X-ODP-API-KEY':crypto.randomBytes(16).toString('hex'),
    'DeviceID':crypto.randomUUID(),
    'X-OS-Version':'11',
    'X-Device-Type':'[Android]',
    'X-ODP-APP-VERSION':'4.3.7',
    'X-FROM-APP':'odp',
    'X-ODP-CHANNEL':'mobile',
    'Content-Type':'application/json; charset=UTF-8'
  };
}
async function fetchJSON(url, options={}, timeoutMs=30000){
  const controller = new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{...options,signal:controller.signal,redirect:'follow'});
    const text=await r.text();
    let data={}; try{data=text?JSON.parse(text):{};}catch(_){data={raw:text};}
    if(!r.ok) throw new Error(`HTTP ${r.status}${data?.message?': '+data.message:''}`);
    return data;
  }finally{clearTimeout(timer);}
}
async function acPost(url, headers, payload){
  return fetchJSON(url,{method:'POST',headers,body:JSON.stringify(payload)},30000);
}
function cleanPhone(v){
  let p=String(v||'').replace(/\D/g,'');
  if(p.startsWith('00964')) p='0'+p.slice(5);
  else if(p.startsWith('964')) p='0'+p.slice(3);
  return /^07\d{9}$/.test(p)?p:null;
}

async function apiAsiacell(req,res){
  const inBody=await bodyJSON(req); const action=String(inBody.action||'');
  let s=session(req)?.asiacell;
  if(action==='reset'){ const ss=session(req); if(ss) delete ss.asiacell; return json(res,200,{ok:true}); }
  if(action==='login'){
    const phone=cleanPhone(inBody.phone); if(!phone) return json(res,422,{error:'رقم آسياسيل غير صحيح. استخدم 077xxxxxxxx'});
    const headers=acHeaders();
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/login?lang=en',headers,{captchaCode:'',username:phone});
      const next=String(d.nextUrl||''); const m=next.match(/PID=([a-f0-9-]+)/i);
      if(!m) throw new Error(d.message || 'فشل إرسال رمز SMS');
      const ses=session(req); if(!ses) return json(res,401,{error:'جلسة الموقع منتهية، أعد المحاولة'});
      ses.asiacell={phone,headers,pid:m[1],step:'sms',createdAt:Date.now()};
      return json(res,200,{ok:true,message:'تم إرسال رمز SMS إلى الرقم.'});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(!s) return json(res,409,{error:'جلسة آسياسيل منتهية، ابدأ من جديد'});
  if(action==='verify_sms'){
    if(s.step!=='sms') return json(res,409,{error:'الخطوة غير الصحيحة'});
    const code=String(inBody.passcode||'').trim(); if(!/^\d{4,8}$/.test(code)) return json(res,422,{error:'رمز SMS غير صحيح'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/smsvalidation?lang=en',s.headers,{PID:s.pid,passcode:code,token:''});
      if(!d.success || !d.access_token) throw new Error(d.message || 'رمز SMS غير صحيح');
      s.headers.Authorization='Bearer '+d.access_token; s.step='amount';
      return json(res,200,{ok:true,message:'تم التحقق من الرقم بنجاح.'});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(action==='start_transfer'){
    if(s.step!=='amount') return json(res,409,{error:'تحقق من الرقم أولاً'});
    const amount=Number(inBody.amount||0);
    if(!Number.isInteger(amount) || amount<1000 || amount>10000 || amount%1000!==0) return json(res,422,{error:'المبلغ يجب أن يكون بين 1,000 و10,000 د.ع وبمضاعفات 1,000'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/credit-transfer/start?lang=ar',s.headers,{amount,receiverMsisdn:FIXED_RECEIVER});
      if(!d.PID) throw new Error(d.message || 'فشل بدء التحويل');
      s.pid_transfer=String(d.PID); s.amount=amount; s.step='transfer_sms';
      return json(res,200,{ok:true,message:'تم إرسال رمز تأكيد التحويل.',usd:amount/FIXED_RATE,transferPid:s.pid_transfer});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(action==='confirm_transfer'){
    if(s.step!=='transfer_sms') return json(res,409,{error:'لا توجد عملية تحويل بانتظار التأكيد'});
    const code=String(inBody.passcode||'').trim(); if(!/^\d{4,8}$/.test(code)) return json(res,422,{error:'رمز التأكيد غير صحيح'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/credit-transfer/do-transfer?lang=ar',s.headers,{PID:s.pid_transfer,passcode:code});
      if(!d.success) throw new Error(d.message || 'فشل التحويل');
      s.step='completed';
      const amount=Number(s.amount); return json(res,200,{ok:true,message:'تم التحويل بنجاح',usd:amount/FIXED_RATE,amountIQD:amount,phone:s.phone||'',transferPid:s.pid_transfer});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  return json(res,422,{error:'عملية غير معروفة'});
}

async function apiSmm(req,res,urlObj){
  const wait=rateLimit(req,'provider'); if(wait) return json(res,429,{error:'طلبات المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
  if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
  const store=providerStore();
  const providerId=String(urlObj.searchParams.get('provider')||store.activeProvider||'');
  let prov=(store.providers||{})[providerId];
  // أثناء إضافة/اختبار مزود قبل أول حفظ، اسمح للإدارة فقط بإرسال بيانات الاختبار مؤقتاً.
  if(!prov){
    const tempUrl=String(urlObj.searchParams.get('_url')||'').trim();
    const tempKey=String(urlObj.searchParams.get('_key')||'').trim();
    if(tempUrl&&tempKey&&providerId){
      try{prov={id:providerId,name:providerId,url:normalizeProviderApiUrl(tempUrl),key:tempKey};}
      catch(_){return json(res,422,{error:'رابط API للمزود غير صالح'});}
    }
  }
  if(!prov)return json(res,404,{error:'لا يوجد مزود محفوظ أو بيانات مزود صالحة'});
  const action=String(urlObj.searchParams.get('action')||'balance');
  if(!['balance','services','add','status','cancel'].includes(action))return json(res,422,{error:'عملية غير مدعومة'});
  if(!isAdmin(req))return json(res,403,{error:'غير مصرح'});
  const payload={action}; for(const k of ['service','link','quantity','order','orders']){if(urlObj.searchParams.has(k))payload[k]=urlObj.searchParams.get(k);} if(action==='cancel' && payload.orders===undefined && payload.order!==undefined){payload.orders=payload.order;delete payload.order;}
  try{
    const d=await providerRequest(prov,payload);
    if(action==='balance'){
      const balance=normalizeProviderBalance(d);
      if(balance===null) return json(res,502,{error:'المزود لم يرجع رصيداً رقمياً صالحاً',providerResponse:d});
      return json(res,200,{ok:true,balance,currency:normalizeProviderCurrency(d),providerId,providerName:prov.name||providerId,raw:d,checkedAt:new Date().toISOString()});
    }
    return json(res,200,d);
  }catch(e){return json(res,502,{error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
}


function readNotifications(){ return readJSON('notifications.json',[]); }
function writeNotifications(v){ writeJSON('notifications.json',Array.isArray(v)?v:[]); }
function readNotificationSeen(){ return readJSON('notification_seen.json',{}); }
function writeNotificationSeen(v){ writeJSON('notification_seen.json',v&&typeof v==='object'?v:{}); }
function notifId(){ return 'N'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'); }
function sanitizeNotification(n){ return {id:String(n.id||''),title:String(n.title||''),message:String(n.message||''),url:String(n.url||''),required:!!n.required,active:n.active!==false,createdAt:n.createdAt||new Date().toISOString(),updatedAt:n.updatedAt||n.createdAt||new Date().toISOString()}; }

function ownedProviderOrder(username,providerId,providerOrderId){
  const rows=readJSON('orders.json',[]); return Array.isArray(rows) && rows.some(x=>String(x.user||'')===String(username||'') && String(x.providerId||'')===String(providerId||'') && String(x.providerOrderId||'')===String(providerOrderId||''));
}


function nowISO(){ return new Date().toISOString(); }
function sha256(v){ return crypto.createHash('sha256').update(String(v||'')).digest('hex'); }
function apiCipherKey(){ return crypto.createHash('sha256').update(String(SESSION_SECRET)).digest(); }
function encryptSecret(plain){
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',apiCipherKey(),iv);
  const enc=Buffer.concat([c.update(String(plain||''),'utf8'),c.final()]);
  const tag=c.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString('base64url');
}
function decryptSecret(blob){
  try{
    const b=Buffer.from(String(blob||''),'base64url'); if(b.length<28)return '';
    const iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28);
    const d=crypto.createDecipheriv('aes-256-gcm',apiCipherKey(),iv);d.setAuthTag(tag);
    return Buffer.concat([d.update(enc),d.final()]).toString('utf8');
  }catch(_){ return ''; }
}
function newApiKey(){ return 'sr_'+crypto.randomBytes(32).toString('base64url'); }
const API_USER_LOCKS=new Map();
async function withApiUserLock(username,fn){
  const k=String(username||''); let tail=API_USER_LOCKS.get(k)||Promise.resolve();
  const run=tail.catch(()=>{}).then(fn); API_USER_LOCKS.set(k,run.finally(()=>{if(API_USER_LOCKS.get(k)===run)API_USER_LOCKS.delete(k)}));
  return run;
}
const FIREBASE_DATABASE_URL=String(process.env.FIREBASE_DATABASE_URL||'https://tiktokzoom-97c9d-default-rtdb.firebaseio.com').replace(/\/$/,'');
function firebaseSafeKey(value){ const s=String(value??''); return Array.from(s).map(ch=>{const cp=ch.codePointAt(0); return /^[A-Za-z0-9_-]$/.test(ch)?ch:'_x'+cp.toString(16)+'_';}).join('')||'_empty'; }
async function firebaseGetJson(pathname,timeoutMs=8000){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{ const u=FIREBASE_DATABASE_URL+'/'+String(pathname).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')+'.json'; const r=await fetch(u,{headers:{'Accept':'application/json'},signal:controller.signal}); if(!r.ok) throw new Error('Firebase HTTP '+r.status); return await r.json(); }
  finally{ clearTimeout(timer); }
}
async function firebaseServiceByKey(fbKey){ const k=firebaseSafeKey(fbKey); const v=await firebaseGetJson('services/'+k); return v&&typeof v==='object'?{...v,fbKey:String(fbKey)}:null; }
async function firebaseUserByUsername(username){ const k=firebaseSafeKey(username); const v=await firebaseGetJson('users/'+k); return v&&typeof v==='object'?v:null; }
function apiKeyFromRequest(req){
  const h=String(req.headers['x-api-key']||'').trim(); if(h)return h;
  const a=String(req.headers.authorization||'').trim(); if(/^Bearer\s+/i.test(a))return a.replace(/^Bearer\s+/i,'').trim();
  return '';
}
function apiKeyUser(req){
  const raw=apiKeyFromRequest(req); if(!raw||raw.length<20)return null;
  const keys=readJSON('api_keys.json',{}); const rec=keys[sha256(raw)];
  if(!rec||rec.revokedAt)return null;
  const users=readJSON('users.json',{users:{}}).users||{}; const u=users[rec.username];
  if(!u)return null;
  return {raw,username:rec.username,record:rec,user:u};
}
function redactSecretObject(value,depth=0){
  if(depth>5)return '[truncated]';
  if(Array.isArray(value))return value.slice(0,100).map(v=>redactSecretObject(v,depth+1));
  if(value&&typeof value==='object'){
    const o={}; for(const [k,v] of Object.entries(value)){
      if(/^(key|api[_-]?key|token|password|secret|authorization)$/i.test(k)) o[k]='[redacted]';
      else o[k]=redactSecretObject(v,depth+1);
    } return o;
  }
  if(typeof value==='string' && value.length>2000)return value.slice(0,2000)+'…';
  return value;
}
// Replace the old raw provider response sanitizer with a redacting version.
safeProviderResponse = function(d){ return redactSecretObject(d); };
function providerAuthErrorText(t){ return /invalid|incorrect|wrong|unauthori[sz]ed|authentication|api\s*key|access\s*denied|expired|login|sign\s*in/i.test(String(t||'')); }
function telegramConfig(){
  const cfg=readJSON('settings.json',{}).telegram||{};
  return {enabled:cfg.enabled!==false,token:String(cfg.token||process.env.TELEGRAM_BOT_TOKEN||'').trim(),chat:String(cfg.chat||process.env.TELEGRAM_CHAT_ID||'').trim()};
}
function telegramLog(entry){
  const arr=readJSON('telegram_notifications.json',[]);
  arr.push({...entry,createdAt:entry.createdAt||nowISO()});
  writeJSON('telegram_notifications.json',arr.slice(-300));
}
async function telegramRequest(method,payload,timeoutMs=8000){
  const cfg=telegramConfig();
  if(!cfg.enabled) return {ok:false,skipped:true,error:'إشعارات القناة غير مفعلة'};
  if(!cfg.token||!cfg.chat) return {ok:false,error:'Bot Token أو Chat ID غير محفوظ'};
  const apiBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(`${apiBase}/bot${encodeURIComponent(cfg.token)}/${method}`,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch(_){d={description:text};}
    return {ok:!!(r.ok&&d.ok!==false),status:r.status,description:String(d.description||''),messageId:d.result?.message_id||null,raw:r.ok?undefined:redactSecretObject(d)};
  }catch(e){return {ok:false,error:e?.name==='AbortError'?'انتهت مهلة Telegram':String(e?.message||e)};}
  finally{clearTimeout(timer);}
}
async function telegramTestConnection(){const r=await telegramRequest('getMe',{});telegramLog({kind:'connection_test',ok:r.ok,status:r.status,description:r.description||r.error||'',messageId:r.messageId||null});return r;}
async function sendTelegramDetailed(text,meta={}){
  const cfg=telegramConfig();
  const caption=String(text||'').slice(0,1024);
  let r;
  const imagePath=path.join(ROOT,'telegram-notification.png');
  if(cfg.enabled!==false && cfg.token && cfg.chat && fs.existsSync(imagePath)){
    try{
      const apiBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
      const fd=new FormData();
      fd.append('chat_id',String(cfg.chat));
      fd.append('photo',new Blob([fs.readFileSync(imagePath)],{type:'image/png'}),'telegram-notification.png');
      fd.append('caption',caption);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
      try{
        const rr=await fetch(`${apiBase}/bot${encodeURIComponent(cfg.token)}/sendPhoto`,{method:'POST',body:fd,signal:controller.signal});
        const tx=await rr.text(); let dd={}; try{dd=tx?JSON.parse(tx):{};}catch(_){dd={description:tx};}
        r={ok:!!(rr.ok&&dd.ok!==false),status:rr.status,description:String(dd.description||''),messageId:dd.result?.message_id||null,raw:rr.ok?undefined:redactSecretObject(dd)};
      }finally{clearTimeout(timer);}
      // إذا فشل رفع الصورة، لا نفقد الإشعار النصي.
      if(!r.ok){
        const fallback=await telegramRequest('sendMessage',{chat_id:cfg.chat,text:caption,disable_web_page_preview:true});
        if(fallback.ok) r={...fallback,description:'تم إرسال النص بعد تعذر إرسال الصورة'};
      }
    }catch(e){
      r={ok:false,error:e?.name==='AbortError'?'انتهت مهلة Telegram':String(e?.message||e)};
    }
  }else{
    r=await telegramRequest('sendMessage',{chat_id:cfg.chat,text:caption,disable_web_page_preview:true});
  }
  telegramLog({kind:meta.kind||'message',ok:r.ok,status:r.status,description:r.description||r.error||'',messageId:r.messageId||null,orderId:meta.orderId||null,media:'photo'});
  return r;
}
async function sendTelegram(text){return (await sendTelegramDetailed(text,{kind:'message'})).ok;}

async function notifyOrderStatusChange(order, oldStatus, newStatus){
  if(!order || String(oldStatus||'')===String(newStatus||'')) return false;
  const labels={processing:'🔄 Processing',completed:'✅ Completed',partial:'⚠️ Partial',cancelled:'❌ Canceled',failed:'❌ Failed',refunded:'💰 Refunded',pending:'⏳ Pending'};
  const msg=`تحديث حالة طلب\n🆔 رقم الطلب: #${order.id}\n👤 المستخدم: ${order.user||'—'}\n📦 الخدمة: ${order.serviceName||'—'}\n🔢 الكمية: ${Number(order.quantity||0).toLocaleString('en-US')}\n💰 السعر: $${Number(order.chargeUsd||Number(order.total||0)/FIXED_RATE).toFixed(2)}\n📊 الحالة: ${labels[newStatus]||newStatus}\n🕐 الوقت: ${new Date().toLocaleString('en-GB',{hour12:false})}`;
  return sendTelegram(msg);
}

function providerSafeName(p){return String(p?.name||p?.id||'مزود');}
async function authoritativeWebsiteService(providerId, serviceId, firebaseServiceKey){
  const pid=String(providerId||'').trim(), sid=String(serviceId||'').trim(), fkey=String(firebaseServiceKey||'').trim();
  let cached=findInternalApiService(sid);
  if(cached && String(cached.providerId||'')===pid) return cached;
  if(fkey){
    try{
      const fb=await firebaseServiceByKey(fkey);
      if(fb){
        const providerServiceId=String(fb.smmpartyId||fb.providerServiceId||fb.serviceId||'').trim();
        const p=String(fb.providerId||'').trim();
        if(p===pid && (!providerServiceId || providerServiceId===sid)) return {id:providerServiceId||sid,fbId:fkey,name:String(fb.name||'خدمة'),category:String(fb.category||((fb.groups||[])[0]||'عام')),sellingUsd:Number(fb.sellingUsd??0),rateUsd:Number(fb.sellingUsd??fb.smmRateUsd??fb.rateUsd??(Number(fb.price||0)/FIXED_RATE)),min:Number(fb.min||100),max:Number(fb.max||10000),providerId:p,providerServiceId:providerServiceId||sid,smmRateUsd:Number(fb.smmRateUsd||fb.rate||0),refill:!!fb.refill,cancel:!!fb.cancel};
      }
    }catch(_){}
  }
  return null;
}

function publicApiService(s){
  const rate=Number(s?.sellingUsd); const rateUsd=Number.isFinite(rate)&&rate>=0?rate:Number(s?.price||0)/FIXED_RATE;
  return {id:String(s?.smmpartyId||s?.providerServiceId||s?.serviceId||s?.fbKey||''),name:String(s?.name||'خدمة'),category:String(s?.category||((Array.isArray(s?.groups)&&s.groups[0])||'عام')),rate:Number((Number(rateUsd)||0).toFixed(6)),min:Number(s?.min||100),max:Number(s?.max||10000),refill:!!s?.refill,cancel:!!s?.cancel};
}
function internalApiServices(){ return readJSON('api_services.json',[]).filter(x=>x&&x.id); }
function findInternalApiService(id){ const sid=String(id||''); return internalApiServices().find(x=>String(x.id)===sid)||null; }
function apiOrderPublic(o){ return {order_id:String(o.id||''),status:String(o.status||'pending'),service:String(o.serviceId||''),quantity:Number(o.quantity||0),chargeUsd:Number(o.chargeUsd||0),createdAt:o.createdAt||null}; }
function calcApiChargeUsd(s,qty,user){
  const pct=Math.max(0,Math.min(100,Number(user?.discountPct)||0));
  const total=Math.max(0,Number(qty)/1000*Number(s.sellingUsd||s.rateUsd||s.rate||0)*(1-pct/100));
  return {pct,total:Number(total.toFixed(6))};
}
function statsSnapshot(range='all'){
  const orders=readJSON('orders.json',[]); const reset=readJSON('stats_state.json',{resetAt:null}).resetAt; let since=reset?new Date(reset):null; const now=new Date(); if(range==='today')since=new Date(now.getTime()-24*60*60*1000); else if(range==='7d')since=new Date(now.getTime()-7*24*60*60*1000); else if(range==='month')since=new Date(now.getFullYear(),now.getMonth(),1); const list=Array.isArray(orders)?orders.filter(o=>{const d=new Date(o.createdAt||0);return (!since||d>since)}):[];
  const counts={total:0,today:0,completed:0,processing:0,pending:0,cancelled:0,failed:0,refunded:0,partial:0}; let sales=0,cost=0;
  const todayNow=new Date(); const day=todayNow.toISOString().slice(0,10); const services={}; const users={}; const profits={};
  for(const o of list){ counts.total++; const st=normalizeProviderStatus(o.status||'pending'); if(st in counts)counts[st]++; if(String(o.createdAt||'').slice(0,10)===day)counts.today++;
    const sale=Number(o.chargeUsd!==undefined?o.chargeUsd:(Number(o.total||0)/FIXED_RATE)); const providerCost=Number(o.providerCostUsd!==undefined?o.providerCostUsd:(Number(o.providerRateUsd||o.smmRateUsd||0)*Number(o.quantity||0)/1000)); sales+=Number.isFinite(sale)?sale:0; cost+=Number.isFinite(providerCost)?providerCost:0;
    const sn=String(o.serviceName||o.serviceId||'خدمة'); services[sn]=(services[sn]||0)+1; profits[sn]=(profits[sn]||0)+(Number.isFinite(sale)?sale:0)-(Number.isFinite(providerCost)?providerCost:0); const un=String(o.user||''); users[un]=(users[un]||0)+1;
  }
  const vals=list.map(o=>Number(o.chargeUsd!==undefined?o.chargeUsd:Number(o.total||0)/FIXED_RATE)).filter(Number.isFinite);
  const serviceMost=Object.entries(services).sort((a,b)=>b[1]-a[1])[0]||null, userMost=Object.entries(users).sort((a,b)=>b[1]-a[1])[0]||null, profitMost=Object.entries(profits).sort((a,b)=>b[1]-a[1])[0]||null;
  return {counts,salesUsd:Number(sales.toFixed(6)),providerCostUsd:Number(cost.toFixed(6)),profitUsd:Number((sales-cost).toFixed(6)),highestOrderUsd:vals.length?Math.max(...vals):0,lowestOrderUsd:vals.length?Math.min(...vals):0,mostOrderedService:serviceMost?.[0]||null,mostOrderingUser:userMost?.[0]||null,highestProfitService:profitMost?{name:profitMost[0],profitUsd:Number(Number(profitMost[1]).toFixed(6))}:null,resetAt:reset||null};
}

async function routeAPI(req,res,urlObj){
  const p=normalizedPath(urlObj.pathname);

  // -------------------- Public API key management --------------------
  if(p==='/api/user/api-key' && req.method==='GET'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const keys=readJSON('api_keys.json',{}); const rec=Object.values(keys).find(x=>x&&x.username===u&&!x.revokedAt);
    return json(res,200,{ok:true,exists:!!rec,masked:rec?.masked||null});
  }
  if(p==='/api/user/api-key' && req.method==='POST'){
    const wait=rateLimit(req,'auth'); if(wait)return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const keys=readJSON('api_keys.json',{}); for(const [h,v] of Object.entries(keys)){if(v?.username===u&&!v.revokedAt)delete keys[h];}
    const raw=newApiKey(); keys[sha256(raw)]={username:u,createdAt:nowISO(),masked:raw.slice(0,7)+'…'+raw.slice(-4),encrypted:encryptSecret(raw),version:1}; writeJSON('api_keys.json',keys);
    return json(res,200,{ok:true,apiKey:raw,masked:raw.slice(0,7)+'…'+raw.slice(-4),createdAt:keys[sha256(raw)].createdAt});
  }
  if(p==='/api/user/api-key/revoke' && req.method==='POST'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const keys=readJSON('api_keys.json',{}); let found=0;for(const [h,v] of Object.entries(keys)){if(v?.username===u&&!v.revokedAt){v.revokedAt=nowISO();found++;}}writeJSON('api_keys.json',keys);return json(res,200,{ok:true,revoked:found});
  }
  if(p==='/api/user/api-key/reveal' && req.method==='POST'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const b=await bodyJSON(req); if(String(b.confirm||'')!=='reveal')return json(res,422,{ok:false,error:'تأكيد الإظهار مطلوب'});
    const keys=readJSON('api_keys.json',{}); const rec=Object.values(keys).find(x=>x&&x.username===u&&!x.revokedAt); if(!rec?.encrypted)return json(res,404,{ok:false,error:'لا يوجد مفتاح API نشط'});
    const raw=decryptSecret(rec.encrypted); if(!raw)return json(res,500,{ok:false,error:'تعذر فك مفتاح API'}); return json(res,200,{ok:true,apiKey:raw});
  }

  // -------------------- Public customer API (backend only) --------------------
  if(p==='/api/v1/services' && req.method==='GET'){
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{error:'Too Many Requests'},{'Retry-After':String(wait)});
    if(!apiKeyUser(req))return json(res,401,{error:'Invalid API key'}); return json(res,200,internalApiServices().map(publicApiService));
  }
  if(p==='/api/v1/balance' && req.method==='GET'){
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{error:'Too Many Requests'},{'Retry-After':String(wait)});
    const au=apiKeyUser(req); if(!au)return json(res,401,{error:'Invalid API key'}); const usd=Number(au.user.balance||0)/FIXED_RATE; return json(res,200,{balance:Number(usd.toFixed(6)),currency:'USD'});
  }
  if(p==='/api/v1/orders' && req.method==='GET'){
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{error:'Too Many Requests'},{'Retry-After':String(wait)}); const au=apiKeyUser(req);if(!au)return json(res,401,{error:'Invalid API key'});const rows=readJSON('orders.json',[]).filter(o=>String(o.user||'')===au.username);const limit=Math.min(100,Math.max(1,Number(urlObj.searchParams.get('limit')||50)));return json(res,200,rows.slice(-limit).reverse().map(apiOrderPublic));
  }
  const apiOrderMatch=p.match(/^\/api\/v1\/order\/([^/]+)$/);
  if(apiOrderMatch && req.method==='GET'){
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{error:'Too Many Requests'},{'Retry-After':String(wait)}); const au=apiKeyUser(req);if(!au)return json(res,401,{error:'Invalid API key'});const id=decodeURIComponent(apiOrderMatch[1]);const o=readJSON('orders.json',[]).find(x=>String(x.id||'')===id&&String(x.user||'')===au.username);if(!o)return json(res,404,{error:'Order not found'});return json(res,200,apiOrderPublic(o));
  }
  if(p==='/api/v1/order' && req.method==='POST'){
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{error:'Too Many Requests'},{'Retry-After':String(wait)}); const au=apiKeyUser(req);if(!au)return json(res,401,{error:'Invalid API key'});
    const idem=String(req.headers['idempotency-key']||'').trim(); const b=await bodyJSON(req); const serviceId=String(b.service||'').trim();const link=String(b.link||'').trim();const quantity=Number(b.quantity);if(!serviceId||!/^https?:\/\//i.test(link)||!Number.isInteger(quantity)||quantity<=0)return json(res,422,{error:'service, link and positive integer quantity are required'});
    const existing=readJSON('orders.json',[]).find(o=>String(o.user||'')===au.username&&idem&&String(o.idempotencyKey||'')===idem); if(existing)return json(res,200,apiOrderPublic(existing));
    const svc=findInternalApiService(serviceId); if(!svc)return json(res,404,{error:'Service not found'}); const s={...svc,sellingUsd:Number(svc.sellingUsd??svc.rateUsd??svc.rate??0)}; if(quantity<Number(s.min)||quantity>Number(s.max))return json(res,422,{error:'Quantity outside service limits'});
    const {pct,total}=calcApiChargeUsd(s,quantity,au.user); const iqd=Number((total*FIXED_RATE).toFixed(4)); const {prov}=getProviderById(s.providerId); if(!prov)return json(res,502,{error:'Provider unavailable'});
    const result=await withApiUserLock(au.username,async()=>{
      const keys=readJSON('api_keys.json',{}); const live=Object.values(keys).find(x=>x&&x.username===au.username&&!x.revokedAt); if(!live)return {authRevoked:true};
      const users=readJSON('users.json',{users:{}}); const u=users.users?.[au.username]; if(!u)return {notFound:true};
      const before=Number(u.balance||0); if(before<iqd)return {insufficient:true,balanceUsd:Number((before/FIXED_RATE).toFixed(6))};
      if(readJSON('orders.json',[]).some(o=>String(o.user||'')===au.username&&idem&&String(o.idempotencyKey||'')===idem)) return {duplicate:true};
      // Reserve the user's balance BEFORE contacting the provider. This closes the concurrent-spend race.
      u.balance=Number((before-iqd).toFixed(4)); users.users[au.username]=u; writeJSON('users.json',users);
      try{
        const d=await providerRequest(prov,{action:'add',service:String(s.providerServiceId||s.smmpartyId),link,quantity}); const po=normalizeProviderOrderId(d);
        if(!po){
          if(false){ }
          throw Object.assign(new Error('Provider did not return an order id'),{providerRejected:false,uncertain:true});
        }
        const settings=readJSON('settings.json',{}); const id=String(Number(settings.orderCounter||0)+1); settings.orderCounter=Number(id); writeJSON('settings.json',settings);
        const ord={id,user:au.username,serviceId,serviceName:s.name||'خدمة',link,quantity,unitSellingUsd:Number(s.sellingUsd||0),discountPct:pct,chargeUsd:total,total:iqd,providerRateUsd:Number(s.providerRateUsd||s.smmRateUsd||0),providerCostUsd:Number(s.providerRateUsd||s.smmRateUsd||0)*quantity/1000,status:'pending',providerId:s.providerId,providerName:prov.name||s.providerId,providerOrderId:String(po),idempotencyKey:idem||null,createdAt:nowISO()};
        appendJsonLedger('orders.json',ord); appendJsonLedger('balance_ledger.json',{user:au.username,type:'order',amountUSD:total,amountIQD:iqd,before,after:u.balance,reason:'API order',admin:'api',reference:id,createdAt:nowISO()});
        return {ok:true,order:ord};
      }catch(e){
        // A definite provider rejection is safe to refund. A timeout/5xx is not safe to refund because the provider may have accepted it.
        if(e.providerRejected){ const latest=readJSON('users.json',{users:{}}); const lu=latest.users?.[au.username]; if(lu){lu.balance=Number((Number(lu.balance||0)+iqd).toFixed(4));latest.users[au.username]=lu;writeJSON('users.json',latest);appendJsonLedger('balance_ledger.json',{user:au.username,type:'refund',amountUSD:total,amountIQD:iqd,before:u.balance,after:lu.balance,reason:'Provider rejected API order',admin:'api',createdAt:nowISO()});} }
        appendJsonLedger('provider_failures.json',{stage:'api_order',uncertain:!e.providerRejected,username:au.username,providerId:s.providerId,serviceId,quantity,error:String(e.message||e),createdAt:nowISO()});
        return {error:String(e.message||e),uncertain:!e.providerRejected,authFailure:providerAuthErrorText(e.message)};
      }
    });
    if(result?.authRevoked)return json(res,401,{error:'Invalid API key'}); if(result?.notFound)return json(res,404,{error:'User not found'}); if(result?.insufficient)return json(res,402,{error:'Insufficient balance',balance:result.balanceUsd}); if(result?.duplicate)return json(res,409,{error:'Duplicate order'}); if(result?.error)return json(res,502,{error:result.authFailure?'Provider API key rejected':result.error,uncertain:!!result.uncertain});
    if(result?.ok){ sendTelegram(`🆕 طلب جديد\n🆔 رقم الطلب: #${result.order.id}\n👤 المستخدم: ${au.username}\n📦 الخدمة: ${result.order.serviceName}\n🔗 الرابط: ${link}\n🔢 الكمية: ${quantity.toLocaleString('en-US')}\n💰 السعر: $${total.toFixed(2)}\n📊 الحالة: Pending\n🕐 الوقت: ${new Date().toLocaleString('en-GB',{hour12:false})}`).catch(()=>{}); return json(res,200,apiOrderPublic(result.order)); }
    return json(res,500,{error:'تعذر إنشاء الطلب'});
  }

  // -------------------- Admin API / audit / stats --------------------
  if(p==='/api/admin/service-sync' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const list=Array.isArray(b.services)?b.services:[];if(list.length>25000)return json(res,413,{ok:false,error:'عدد الخدمات كبير جداً'});
    const safe=list.map(s=>{const providerServiceId=String(s?.smmpartyId||s?.providerServiceId||s?.serviceId||'').trim();const fbId=String(s?.fbKey||s?.id||'').trim();return {id:providerServiceId,fbId,name:String(s?.name||'خدمة'),category:String(s?.category||((Array.isArray(s?.groups)&&s.groups[0])||'عام')),sellingUsd:Number(s?.sellingUsd||0),rateUsd:Number(s?.sellingUsd||s?.smmRateUsd||s?.rateUsd||0),min:Number(s?.min||100),max:Number(s?.max||10000),refill:!!s?.refill,cancel:!!s?.cancel,providerId:String(s?.providerId||''),providerServiceId,smmRateUsd:Number(s?.smmRateUsd||s?.rate||0),updatedAt:nowISO()};}).filter(x=>x.id&&x.providerId);
    writeJSON('api_services.json',safe);return json(res,200,{ok:true,count:safe.length,syncedAt:nowISO()});
  }
  if(p==='/api/admin/sync-users' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const list=Array.isArray(b.users)?b.users:[];const store=readJSON('users.json',{users:{}});let n=0;for(const x of list.slice(0,10000)){const u=String(x?.username||'').trim();const bal=Number(x?.balance);if(!u||!Number.isFinite(bal)||bal<0)continue;store.users[u]={...(store.users[u]||{name:u,role:'user'}),balance:Number(bal.toFixed(4)),totalSpent:Number(x?.totalSpent||store.users[u]?.totalSpent||0),totalOrders:Number(x?.totalOrders||store.users[u]?.totalOrders||0),discountPct:Number(x?.discountPct??store.users[u]?.discountPct??0)};n++;}writeJSON('users.json',store);return json(res,200,{ok:true,count:n});
  }
  if(p==='/api/admin/stats' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const range=String(urlObj.searchParams.get('range')||'all');if(!['today','7d','month','all'].includes(range))return json(res,422,{ok:false,error:'نطاق غير صالح'});return json(res,200,{ok:true,range,stats:statsSnapshot(range)});}
  if(p==='/api/admin/stats/reset' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);if(String(b.confirm||'')!=='RESET_STATS')return json(res,422,{ok:false,error:'تأكيد التصفير غير صحيح'});const now=nowISO();writeJSON('stats_state.json',{resetAt:now});return json(res,200,{ok:true,resetAt:now});}
  if(p==='/api/admin/balance-adjust' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const username=String(b.username||'').trim(); const usd=Number(b.usd); const type=String(b.type||''); const reason=String(b.reason||'').trim();
    if(!username||!Number.isFinite(usd)||usd<=0||usd>1000000||!['charge','deduct'].includes(type)||!reason||reason.length>500)return json(res,422,{ok:false,error:'المستخدم والمبلغ والنوع والسبب مطلوبة'});
    const result=await withApiUserLock(username,async()=>{
      const store=readJSON('users.json',{users:{}}); const u=store.users?.[username]; if(!u)return {notFound:true};
      const amount=Number((usd*FIXED_RATE).toFixed(4)); const before=Number(u.balance||0);
      if(type==='deduct'&&before<amount)return {insufficient:true,beforeUsd:Number((before/FIXED_RATE).toFixed(6))};
      const after=Number((type==='charge'?before+amount:before-amount).toFixed(4)); u.balance=after; u.updatedAt=nowISO(); store.users[username]=u; writeJSON('users.json',store);
      appendJsonLedger('balance_ledger.json',{user:username,type,amountUSD:usd,amountIQD:amount,before,after,reason,admin:session(req)?.username||'admin',createdAt:nowISO()});
      return {ok:true,after,before};
    });
    if(result?.notFound)return json(res,404,{ok:false,error:'المستخدم غير موجود'}); if(result?.insufficient)return json(res,409,{ok:false,error:'الرصيد لا يكفي',balanceUsd:result.beforeUsd});
    return json(res,200,{ok:true,username,balanceUsd:Number((result.after/FIXED_RATE).toFixed(6)),beforeUsd:Number((result.before/FIXED_RATE).toFixed(6)),afterUsd:Number((result.after/FIXED_RATE).toFixed(6))});
  }
  if(p==='/api/admin/balance-ledger' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const user=String(urlObj.searchParams.get('user')||'');const rows=readJSON('balance_ledger.json',[]).filter(x=>!user||String(x.user||'')===user).slice(-500).reverse();return json(res,200,{ok:true,ledger:rows});}
  if(p==='/api/admin/user-finance' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const username=String(urlObj.searchParams.get('username')||'').trim();if(!username)return json(res,422,{ok:false,error:'اسم المستخدم مطلوب'});const u=readJSON('users.json',{users:{}}).users?.[username];if(!u)return json(res,404,{ok:false,error:'المستخدم غير موجود'});const orders=readJSON('orders.json',[]).filter(o=>String(o.user||'')===username);const ledger=readJSON('balance_ledger.json',[]).filter(x=>String(x.user||'')===username);const deposits=ledger.filter(x=>['charge','deposit'].includes(String(x.type||''))).reduce((a,x)=>a+Number(x.amountUSD||Number(x.amountIQD||0)/FIXED_RATE||0),0);const spent=orders.reduce((a,o)=>a+Number(o.chargeUsd??Number(o.total||0)/FIXED_RATE),0);return json(res,200,{ok:true,user:{username,name:String(u.name||username),balanceUsd:Number((Number(u.balance||0)/FIXED_RATE).toFixed(6)),totalDepositsUsd:Number(deposits.toFixed(6)),totalSpentUsd:Number(spent.toFixed(6)),totalOrders:orders.length,discountPct:Number(u.discountPct||0)}});}
  if(p==='/api/admin/telegram' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const cfg=readJSON('settings.json',{}).telegram||{};return json(res,200,{ok:true,telegram:{enabled:cfg.enabled!==false,tokenSet:!!cfg.token,chat:cfg.chat||''}});}
  if(p==='/api/admin/telegram' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const cfg=readJSON('settings.json',{});const tg=cfg.telegram||{};if(b.enabled!==undefined)tg.enabled=!!b.enabled;if(b.token!==undefined&&String(b.token).trim())tg.token=String(b.token).trim();if(b.chat!==undefined)tg.chat=String(b.chat).trim();cfg.telegram=tg;writeJSON('settings.json',cfg);return json(res,200,{ok:true,telegram:{enabled:tg.enabled!==false,tokenSet:!!tg.token,chat:tg.chat||''}});}
  if(p==='/api/admin/telegram/test' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const r=await sendTelegramDetailed(String(b.text||'✅ اختبار إشعارات صدى العراق'),{kind:'manual_test'});return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'تم إرسال اختبار Telegram':(r.description||r.error||'فشل إرسال اختبار Telegram'),status:r.status||null,messageId:r.messageId||null});}
  if(p==='/api/admin/telegram/test-connection' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const r=await telegramTestConnection();return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'اتصال Telegram ناجح':(r.description||r.error||'فشل الاتصال بـ Telegram'),status:r.status||null});}
  if(p==='/api/admin/telegram/test-order' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const sample='🧪 اختبار إشعار طلب\n🆔 رقم طلب صدى العراق: #TEST-001\n👤 المستخدم: اختبار\n📦 الخدمة: خدمة تجريبية\n🔗 الرابط: https://example.com\n🔢 الكمية: 1,000\n💰 السعر: $0.50\n📊 الحالة: Pending\n🕐 الوقت: '+new Date().toLocaleString('en-GB',{hour12:false});const r=await sendTelegramDetailed(sample,{kind:'test_order',orderId:'TEST-001'});return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'تم إرسال إشعار طلب تجريبي':(r.description||r.error||'فشل إرسال إشعار الطلب'),status:r.status||null,messageId:r.messageId||null});}
  if(p==='/api/admin/telegram/logs' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});return json(res,200,{ok:true,logs:readJSON('telegram_notifications.json',[]).slice(-50).reverse()});}

  if(p==='/api/config'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); return json(res,200,{appName:APP_NAME,version:APP_VERSION,buildId:BUILD_ID,currency:'USD',exchangeRate:FIXED_RATE,fixedRecharge:'5000 IQD = 4 USD',rateTable:[1000,2000,3000,4000,5000,6000,7000,8000,9000,10000].map(i=>({iqd:i,usd:i/FIXED_RATE})),supportWhatsappUrl:waUrl,supportWhatsappNumber:normalizeWhatsAppNumber(waUrl),telegramChannelUrl:'https://t.me/jbhbhg58'}); }
  if(p==='/api/auth' && req.method==='POST'){
    const wait=rateLimit(req,'auth'); if(wait) return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req); const u=String(b.username||'').trim(); const pw=String(b.password||'');
    if(String(b.action||'')==='register'){
      if(!/^[a-zA-Z0-9_]+$/.test(u)) return json(res,422,{ok:false,error:'اسم المستخدم يجب أن يكون بالإنجليزية والأرقام فقط'});
      if(pw.length<4) return json(res,422,{ok:false,error:'كلمة المرور يجب أن تكون 4 أحرف على الأقل'});
      if(u===ADMIN_USER) return json(res,409,{ok:false,error:'اسم المستخدم محجوز'});
      const store=readJSON('users.json',{users:{}}); if(store.users[u]) return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً'});
      const user={name:u,passwordHash:hashPassword(pw),balance:0,level:'مبتدئ',telegram:String(b.telegram||''),phone:String(b.phone||''),joined:new Date().toISOString(),totalSpent:0,totalOrders:0,role:'user'};
      store.users[u]=user; writeJSON('users.json',store); const sessionToken=setSession(res,{role:'user',username:u});
      const safeUser={...user}; delete safeUser.password; delete safeUser.passwordHash; return json(res,200,{ok:true,role:'user',username:u,user:safeUser,sessionToken});
    }
    if(u===ADMIN_USER && adminPasswordValid(pw)){ const sessionToken=setSession(res,{role:'admin',username:ADMIN_USER}); return json(res,200,{ok:true,role:'admin',username:ADMIN_USER,sessionToken}); }
    const store=readJSON('users.json',{users:{}}); const user=store.users?.[u];
    if(user && verifyPassword(pw,user.passwordHash || user.password || '')){ const role=user.role==='admin'?'admin':'user'; const sessionToken=setSession(res,{role,username:u}); const clean={...user}; delete clean.password; delete clean.passwordHash; return json(res,200,{ok:true,role,username:u,user:clean,sessionToken}); }
    return json(res,401,{ok:false,error:'بيانات الدخول غير صحيحة'});
  }
  if(p==='/api/session' && req.method==='GET'){
    const token=sid(req); const s=session(req);
    if(!s)return json(res,200,{ok:false,authenticated:false});
    // Re-issue a fresh signed token/header so the browser can keep using a header even
    // when a Railway proxy/browser drops HttpOnly cookie state.
    const fresh=setSession(res,{role:s.role,username:s.username});
    if(s.role==='admin')return json(res,200,{ok:true,authenticated:true,role:'admin',username:s.username,sessionToken:fresh});
    const store=readJSON('users.json',{users:{}}); const u=store.users?.[s.username]||null;
    const clean=u?{...u}:{}; delete clean.password; delete clean.passwordHash;
    return json(res,200,{ok:true,authenticated:true,role:'user',username:s.username,user:Object.keys(clean).length?clean:null,sessionToken:fresh,localUserRecord:!!u});
  }
  if(p==='/api/settings' && req.method==='GET'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); return json(res,200,{ok:true,settings:{waUrl,waNum:normalizeWhatsAppNumber(waUrl)}}); }
  if(p==='/api/settings' && req.method==='POST'){ if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const b=await bodyJSON(req); const cfg=readJSON('settings.json',{}); if(b.waUrl!==undefined) cfg.waUrl=normalizeWhatsAppUrl(b.waUrl); else if(b.waNum!==undefined) cfg.waUrl=normalizeWhatsAppUrl(b.waNum); cfg.waNum=normalizeWhatsAppNumber(cfg.waUrl); writeJSON('settings.json',cfg); return json(res,200,{ok:true,settings:{waUrl:cfg.waUrl,waNum:cfg.waNum}}); }
  if(p==='/api/mastercard' && req.method==='GET'){
    const cfg=readJSON('settings.json',{}); const mc=cfg.mastercard||{};
    return json(res,200,{ok:true,mastercard:{enabled:mc.enabled!==false,number:'3494089927',image:'',updatedAt:mc.updatedAt||null}});
  }
  if(p==='/api/mastercard' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const cfg=readJSON('settings.json',{}); const old=cfg.mastercard||{};
    const image='';
    cfg.mastercard={enabled:b.enabled!==undefined?!!b.enabled:(old.enabled!==false),number:'3494089927',image,updatedAt:new Date().toISOString()}; writeJSON('settings.json',cfg);
    return json(res,200,{ok:true,mastercard:cfg.mastercard});
  }
  if(p==='/api/provider/diagnostics' && req.method==='POST'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات فحص المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const prov={name:String(b.name||'مزود'),url:String(b.url||'').trim(),key:String(b.key||'').trim()};
    if(!/^https?:\/\//i.test(prov.url)||!prov.key)return json(res,422,{ok:false,error:'رابط API أو مفتاح API غير صالح'});
    const out={connection:{ok:false},balance:{ok:false},services:{ok:false}};
    try{
      const bd=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(bd);
      if(balance===null) throw new Error('API لم يرجع رصيداً رقمياً');
      out.connection={ok:true}; out.balance={ok:true,balance,currency:normalizeProviderCurrency(bd),raw:bd};
    }catch(e){ out.balance={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الرصيد':e.message}; }
    try{
      const sd=await providerRequest(prov,{action:'services'}); const list=normalizeProviderServices(sd);
      if(!list.length) throw new Error('المزود لم يرجع أي خدمات');
      out.services={ok:true,count:list.length}; out.connection={ok:true};
    }catch(e){ out.services={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الخدمات':e.message}; }
    if(!out.connection.ok) out.connection={ok:false,error:out.balance.error||out.services.error||'فشل الاتصال بالمزود'};
    return json(res,200,{ok:out.connection.ok&&out.balance.ok&&out.services.ok,diagnostics:out});
  }
  if(p==='/api/admin/notifications' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); return json(res,200,{ok:true,notifications:readNotifications().map(sanitizeNotification)});
  }
  if(p==='/api/admin/notifications' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const b=await bodyJSON(req); const title=String(b.title||'').trim(), message=String(b.message||'').trim(), url=String(b.url||'').trim();
    if(!title||!message)return json(res,422,{ok:false,error:'العنوان والنص مطلوبان'}); const all=readNotifications(); const n=sanitizeNotification({id:notifId(),title,message,url,required:!!b.required,active:b.active!==false,createdAt:new Date().toISOString()}); all.unshift(n); writeNotifications(all.slice(0,500)); return json(res,200,{ok:true,notification:n});
  }
  if(p==='/api/admin/notifications' && req.method==='PATCH'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const b=await bodyJSON(req); const all=readNotifications(); const i=all.findIndex(x=>String(x.id)===String(b.id)); if(i<0)return json(res,404,{ok:false,error:'الإشعار غير موجود'}); if(b.action==='delete')all.splice(i,1); else {all[i]={...sanitizeNotification(all[i]),...(b.active!==undefined?{active:!!b.active}:{}),...(b.required!==undefined?{required:!!b.required}:{}),updatedAt:new Date().toISOString()};} writeNotifications(all); return json(res,200,{ok:true});
  }
  if(p==='/api/notifications' && req.method==='GET'){
    const s=session(req); if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const seen=readNotificationSeen()[s.username]||{}; const items=readNotifications().filter(n=>n.active!==false).map(sanitizeNotification).filter(n=>!seen[n.id]); return json(res,200,{ok:true,notifications:items});
  }
  if(p==='/api/notifications/seen' && req.method==='POST'){
    const s=session(req); if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const b=await bodyJSON(req); const id=String(b.id||''); if(!id)return json(res,422,{ok:false,error:'معرف الإشعار مطلوب'}); const seen=readNotificationSeen(); seen[s.username]=seen[s.username]||{}; seen[s.username][id]=new Date().toISOString(); writeNotificationSeen(seen); return json(res,200,{ok:true});
  }
  if(p==='/api/provider/balance' && req.method==='GET'){ const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات الرصيد كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)}); if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const {prov,pid}=getProviderById(urlObj.searchParams.get('provider')); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'}); try{const d=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(d); if(balance===null)return json(res,502,{ok:false,error:'المزود لم يرجع قيمة رصيد صالحة',raw:d}); return json(res,200,{ok:true,providerId:pid,providerName:prov.name||pid,balance,currency:normalizeProviderCurrency(d),raw:d,checkedAt:new Date().toISOString()});}catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});} }
  if(p==='/api/provider/test' && req.method==='POST'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات اختبار المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const prov={name:String(b.name||'مزود مؤقت'),url:String(b.url||'').trim(),key:String(b.key||'').trim()};
    if(!/^https?:\/\//i.test(prov.url)||!prov.key) return json(res,422,{ok:false,error:'رابط API أو مفتاح API غير صالح'});
    const out={connection:{ok:false},balance:{ok:false},services:{ok:false}};
    try{ const d=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(d); if(balance===null) throw new Error('API لم يرجع رصيداً رقمياً'); out.connection={ok:true}; out.balance={ok:true,balance,currency:normalizeProviderCurrency(d)}; }
    catch(e){ out.balance={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الرصيد':e.message}; }
    try{ const d=await providerRequest(prov,{action:'services'}); const list=normalizeProviderServices(d); out.services={ok:Array.isArray(list)&&list.length>0,count:Array.isArray(list)?list.length:0,error:Array.isArray(list)&&list.length?'':'لم يرجع خدمات'}; if(out.services.ok && !out.connection.ok) out.connection={ok:true}; }
    catch(e){ out.services={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الخدمات':e.message}; }
    if(!out.connection.ok) out.connection={ok:false,error:out.balance.error||out.services.error||'فشل الاتصال بالمزود'};
    return json(res,200,{ok:out.connection.ok&&out.balance.ok&&out.services.ok,providerName:prov.name,diagnostics:out,checkedAt:new Date().toISOString()});
  }
  if(p==='/api/order/create' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req); const providerId=String(b.providerId||'').trim(); const serviceId=String(b.serviceId||'').trim(); const firebaseServiceKey=String(b.firebaseServiceKey||'').trim(); const link=String(b.link||'').trim(); const quantity=Number(b.quantity); const localId=String(b.localId||'').trim();
    if(!providerId||!serviceId||!link||!Number.isInteger(quantity)||quantity<=0)return json(res,422,{ok:false,error:'بيانات الطلب غير مكتملة',stage:'validate'});
    if(!/^https?:\/\//i.test(link))return json(res,422,{ok:false,error:'الرابط غير صالح',stage:'validate'});
    const existing=readJSON('orders.json',[]).find(x=>String(x.user||'')===username&&String(x.localId||'')===localId&&localId&&String(x.providerOrderId||''));
    if(existing) return json(res,200,{ok:true,idempotent:true,providerId:String(existing.providerId||providerId),providerName:String(existing.providerName||''),providerOrderId:String(existing.providerOrderId),providerRaw:existing.providerRaw||null,createdAt:existing.createdAt||new Date().toISOString()});
    const svc=await authoritativeWebsiteService(providerId,serviceId,firebaseServiceKey);
    if(!svc)return json(res,409,{ok:false,error:'لم أستطع التحقق من الخدمة وربطها بالمزود. أعد تحميل الخدمات من لوحة الإدارة. ',stage:'service_lookup'});
    const mn=Math.max(1,Number(svc.min||100)),mx=Math.max(mn,Number(svc.max||10000)); if(quantity<mn||quantity>mx)return json(res,422,{ok:false,error:'الكمية خارج حدود الخدمة',stage:'validate'});
    const serviceRate=Number(svc.sellingUsd??svc.rateUsd??0); const localUser=readJSON('users.json',{users:{}}).users?.[username]||{}; const userDiscount=Math.max(0,Math.min(100,Number(localUser.discountPct??0)||0)); const chargeUsd=Number((Math.max(0,quantity/1000*serviceRate*(1-userDiscount/100))).toFixed(6)); const chargeIqd=Number((chargeUsd*FIXED_RATE).toFixed(4));
    const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالخدمة غير موجود',stage:'provider_lookup'});
    const result=await withApiUserLock(username,async()=>{
      // The website wallet is Firebase; use a single transaction as the authoritative reservation.
      let reserved=false,before=0,after=0;
      if(chargeIqd>0){
        // The browser performs the authoritative Firebase transaction before calling this endpoint.
        // The server uses its synchronized local wallet as a second safety check and does not depend on
        // an outbound Firebase call (which would make Railway provider orders fail when Firebase is unreachable).
        const localWallet=readJSON('users.json',{users:{}}).users?.[username];
        const startBal=Number(localWallet?.balance||0); before=startBal;
        if(localWallet && startBal<chargeIqd)return {insufficient:true,balanceUsd:Number((startBal/FIXED_RATE).toFixed(6))};
      }
      try{
        const d=await providerRequest(prov,{action:'add',service:String(svc.providerServiceId||serviceId),link,quantity});
        const providerOrderId=normalizeProviderOrderId(d);
        if(!providerOrderId){appendJsonLedger('provider_failures.json',{stage:'provider_response',uncertain:true,user:username,providerId,serviceId,link,quantity,error:'المزود لم يرجع رقم طلب واضح',providerResponse:safeProviderResponse(d),createdAt:nowISO()});return {error:'المزود لم يرجع رقم طلب واضح بعد عملية الإرسال',uncertain:true};}
        const createdAt=nowISO(); const ord={id:String(localId||('EXT_'+Date.now())),localId,user:username,providerId,providerName:prov.name||providerId,providerOrderId,serviceId,serviceName:String(svc.name||'خدمة'),link,quantity,unitSellingUsd:serviceRate,discountPct:userDiscount,chargeUsd,total:chargeIqd,status:'pending',providerRaw:safeProviderResponse(d),createdAt}; appendJsonLedger('orders.json',ord);
        return {ok:true,order:ord};
      }catch(e){
        const rejected=!!e.providerRejected; const authFail=providerAuthErrorText(e.message); appendJsonLedger('provider_failures.json',{stage:'website_provider_add',uncertain:!rejected,authFailure:authFail,user:username,providerId,serviceId,link,quantity,error:String(e.message||e),createdAt:nowISO()}); return {error:authFail?'مفتاح API للمزود مرفوض أو منتهي':String(e.message||e),uncertain:!rejected,authFailure:authFail};
      }
    });
    if(result?.insufficient)return json(res,402,{ok:false,error:'رصيد المستخدم غير كافٍ',balanceUsd:result.balanceUsd});
    if(result?.error)return json(res,502,{ok:false,error:result.error,uncertain:!!result.uncertain,authFailure:!!result.authFailure});
    if(result?.ok){const siteId=String(result.order.id||localId||'');sendTelegramDetailed(`🆕 طلب جديد\n🆔 رقم طلب صدى العراق: #${siteId}\n👤 المستخدم: ${username}\n📦 الخدمة: ${result.order.serviceName}\n🔗 الرابط: ${link}\n🔢 الكمية: ${quantity.toLocaleString('en-US')}\n💰 السعر: $${chargeUsd.toFixed(2)}\n🔢 رقم المزود: ${result.order.providerOrderId}\n📊 الحالة: Pending\n🕐 الوقت: ${new Date().toLocaleString('en-GB',{hour12:false})}`,{kind:'order',orderId:siteId}).catch(()=>{});return json(res,200,{ok:true,siteOrderId:siteId,providerId,providerName:prov.name||providerId,providerOrderId:String(result.order.providerOrderId),providerRaw:result.order.providerRaw,providerBalanceBefore:null,chargeUsd,totalIQD:chargeIqd,discountPct:userDiscount,createdAt:result.order.createdAt});}
    return json(res,500,{ok:false,error:'تعذر إنشاء الطلب'});
  }

  if(p==='/api/order/status' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req); const providerId=String(b.providerId||'').trim(); const providerOrderId=String(b.providerOrderId||'').trim();
    if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات التحقق ناقصة'});
    if(!ownedProviderOrder(username,providerId,providerOrderId))return json(res,403,{ok:false,error:'هذا الطلب لا يتبع حسابك'});
    const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{
      const d=await providerRequest(prov,{action:'status',order:providerOrderId});
      const normalized=normalizeProviderStatus(d.status||''); const checkedAt=nowISO();
      const rows=readJSON('orders.json',[]); const idx=rows.findIndex(x=>String(x.user||'')===username&&String(x.providerId||'')===providerId&&String(x.providerOrderId||'')===providerOrderId);
      let siteOrderId='';
      if(idx>=0){const ord=rows[idx];const oldStatus=normalizeProviderStatus(ord.status||'pending');siteOrderId=String(ord.id||'');ord.providerStatus=String(d.status||'');if(normalized!=='unknown')ord.status=normalized;ord.remains=d.remains;ord.startCount=d.start_count??d.startCount;ord.providerCharge=d.charge;ord.providerCurrency=d.currency||'USD';ord.lastCheckedAt=checkedAt;ord.providerRaw=safeProviderResponse(d);rows[idx]=ord;writeJSON('orders.json',rows);if(oldStatus!==normalizeProviderStatus(ord.status||oldStatus))notifyOrderStatusChange(ord,oldStatus,normalizeProviderStatus(ord.status||oldStatus)).catch(()=>{});}
      return json(res,200,{ok:true,siteOrderId,providerOrderId,status:String(d.status||''),normalizedStatus:normalized,remains:d.remains,startCount:d.start_count??d.startCount,charge:d.charge,currency:d.currency||'USD',raw:d,checkedAt});
    }catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/cancel' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'}); const b=await bodyJSON(req); const providerId=String(b.providerId||''); const providerOrderId=String(b.providerOrderId||''); if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات الإلغاء ناقصة'}); if(!ownedProviderOrder(username,providerId,providerOrderId))return json(res,403,{ok:false,error:'هذا الطلب لا يتبع حسابك'}); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{const d=await providerRequest(prov,{action:'cancel',orders:providerOrderId}); if(!providerActionSucceeded('cancel',d,providerOrderId)) return json(res,502,{ok:false,error:'المزود لم يؤكد إلغاء الطلب',providerRaw:d}); appendJsonLedger('orders.json',{event:'cancel',user:username,providerId,providerOrderId,status:'cancelled',createdAt:new Date().toISOString(),providerRaw:d}); return json(res,200,{ok:true,providerOrderId,status:'cancelled',providerRaw:d,updatedAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/logout'){
    const id=sid(req); if(id) sessions.delete(id); res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); return json(res,200,{ok:true});
  }

  if(p==='/api/admin/orders' && req.method==='GET'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();
    const st=String(urlObj.searchParams.get('status')||'').trim().toLowerCase();
    const rows=readJSON('orders.json',[]).filter(o=>{
      const hay=[o.id,o.user,o.link,o.serviceName,o.providerOrderId].map(v=>String(v||'').toLowerCase()).join(' ');
      const norm=normalizeProviderStatus(o.status||'pending');
      return (!q||hay.includes(q))&&(!st||st==='all'||norm===st);
    }).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,500);
    return json(res,200,{ok:true,orders:rows});
  }
  if(p==='/api/admin/order-status' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const siteId=String(b.orderId||'').trim();
    if(!siteId) return json(res,422,{ok:false,error:'رقم طلب الموقع مطلوب'});
    const rows=readJSON('orders.json',[]); const idx=rows.findIndex(o=>String(o.id||'')===siteId);
    if(idx<0) return json(res,404,{ok:false,error:'طلب الموقع غير موجود'});
    const order=rows[idx]; if(!order.providerId||!order.providerOrderId) return json(res,409,{ok:false,error:'هذا الطلب لا يملك طلباً مرتبطاً بالمزود'});
    const {prov}=getProviderById(order.providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{
      const d=await providerRequest(prov,{action:'status',order:String(order.providerOrderId)});
      const oldStatus=normalizeProviderStatus(order.status||'pending'); const newStatus=normalizeProviderStatus(d.status||order.status||'pending');
      order.providerStatus=String(d.status||''); order.status=newStatus==='unknown'?(order.status||'pending'):newStatus;
      order.remains=d.remains; order.startCount=d.start_count??d.startCount; order.lastCheckedAt=nowISO(); order.providerRaw=safeProviderResponse(d);
      rows[idx]=order; writeJSON('orders.json',rows); notifyOrderStatusChange(order,oldStatus,order.status).catch(()=>{});
      return json(res,200,{ok:true,siteOrderId:siteId,providerOrderId:String(order.providerOrderId),status:order.status,providerStatus:order.providerStatus,remains:order.remains,startCount:order.startCount,checkedAt:order.lastCheckedAt});
    }catch(e){
      appendJsonLedger('provider_failures.json',{stage:'admin_order_status',siteOrderId:siteId,providerId:order.providerId,providerOrderId:order.providerOrderId,error:String(e.message||e),createdAt:nowISO()});
      return json(res,502,{ok:false,error:String(e.message||e)});
    }
  }

  if(p==='/api/admin/data-summary' && req.method==='GET'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const users=readJSON('users.json',{users:{}})?.users||{};
    const orders=readJSON('orders.json',[]); const payments=readJSON('payments.json',[]);
    return json(res,200,{ok:true,counts:{users:Object.keys(users).length,orders:Array.isArray(orders)?orders.length:0,payments:Array.isArray(payments)?payments.length:0}});
  }
  if(p==='/api/admin/reset' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const now=new Date().toISOString();
    writeJSON('users.json',{users:{}});
    writeJSON('orders.json',[]);
    writeJSON('payments.json',[]);
    writeJSON('settings.json',{...readJSON('settings.json',{}),orderCounter:0,resetAt:now});
    writeJSON('providers.json',readJSON('providers.json',{activeProvider:'',providers:{}}));
    return json(res,200,{ok:true,message:'تم تنظيف بيانات Railway والبدء من جديد'});
  }
  if(p==='/api/admin/user-balance' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const username=String(b.username||'').trim(); const balance=Number(b.balance);
    if(!username||!Number.isFinite(balance)||balance<0)return json(res,422,{ok:false,error:'بيانات رصيد المستخدم غير صالحة'});
    const store=readJSON('users.json',{users:{}}); const user=store.users?.[username];
    if(!user)return json(res,404,{ok:false,error:'المستخدم غير موجود في قاعدة Railway'});
    user.balance=Number(balance); user.updatedAt=new Date().toISOString(); writeJSON('users.json',store);
    return json(res,200,{ok:true,username,balance:user.balance,updatedAt:user.updatedAt});
  }
  if(p==='/api/provider/secret' && req.method==='GET') {
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const id=String(urlObj.searchParams.get('provider')||''); const {prov}=getProviderById(id); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    return json(res,200,{ok:true,providerId:id,key:String(prov.key||'')});
  }
  if(p.startsWith('/api/providers/') && req.method==='DELETE'){
    if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
    const pid=decodeURIComponent(p.slice('/api/providers/'.length)).trim();
    if(!pid) return json(res,400,{error:'معرف المزود مفقود'});
    const store=providerStore();
    if(!store.providers[pid]) return json(res,404,{error:'المزود غير موجود'});
    const out={...(store.providers||{})};
    delete out[pid];
    const deletedIds=new Set(store.deletedProviderIds||[]);
    if(store.envProvider?.id===pid) deletedIds.add(pid); else deletedIds.delete(pid);
    let active=String(store.activeProvider||'');
    if(active===pid) active=Object.keys(out)[0]||'';
    writeJSON('providers.runtime.json',{activeProvider:active,providers:out,deletedProviderIds:[...deletedIds],updatedAt:new Date().toISOString()});
    return json(res,200,{ok:true,deleted:pid,activeProvider:active,count:Object.keys(out).length});
  }
  if(p==='/api/providers'){
    const store=providerStore();
    if(req.method==='GET'){
      if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
      const safe={}; for(const [id,v] of Object.entries(store.providers||{})) safe[id]={id,name:v.name||id,url:v.url||'',hasKey:!!v.key};
      return json(res,200,{activeProvider:store.activeProvider||'',providers:safe});
    }
    if(req.method==='POST'){
      if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
      const b=await bodyJSON(req); const list=Array.isArray(b.providers)?b.providers:[];
      const incoming={};
      for(const item of list){
        if(!item||typeof item!=='object') continue;
        const id=String(item.id||'').replace(/[^a-zA-Z0-9_-]/g,''); const name=String(item.name||'').trim(); let apiUrl=String(item.url||'').trim(); const key=String(item.key||'').trim();
        try{apiUrl=normalizeProviderApiUrl(apiUrl);}catch(_){}
        const preserved=String((store.providers?.[id]?.key) || (store.envProvider?.id===id ? (envProvider()?.key || '') : ''));
        if(id&&name&&/^https?:\/\//i.test(apiUrl)&&(key||preserved)) incoming[id]={name,url:apiUrl,key:key||preserved};
      }
      const out = b.mode==='replace' ? incoming : {...(store.providers||{}), ...incoming};
      const deletedIds=new Set(store.deletedProviderIds||[]);
      for(const id of Object.keys(incoming)) deletedIds.delete(id);
      if(b.mode==='replace' && store.envProvider?.id && !incoming[store.envProvider.id]) deletedIds.add(store.envProvider.id);
      const activeCandidate=String(b.activeProvider!==undefined ? b.activeProvider : (store.activeProvider||''));
      const active=activeCandidate && out[activeCandidate] ? activeCandidate : (Object.keys(out)[0]||'');
      writeJSON('providers.runtime.json',{activeProvider:active,providers:out,deletedProviderIds:[...deletedIds],updatedAt:new Date().toISOString()});
      return json(res,200,{ok:true,count:Object.keys(out).length,activeProvider:active});
    }
  }
  if(p==='/api/smm') return apiSmm(req,res,urlObj);
  if(p==='/api/asiacell' && req.method==='POST') return apiAsiacell(req,res);
  if(p==='/api/health') return json(res,200,{ok:true,app:APP_NAME,version:APP_VERSION,buildId:BUILD_ID,time:new Date().toISOString(),node:process.version});
  return json(res,404,{error:'API endpoint not found'});
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
function serveStatic(req,res,urlObj){
  let p=decodeURIComponent(urlObj.pathname); if(p==='/'||p==='') p='/index.html';
  if(/^\/data(?:\/|$)/i.test(p) || /(?:^|\/)\.(?:env|git|npmrc)/i.test(p)) return json(res,403,{error:'Forbidden'});
  const file=path.normalize(path.join(ROOT,p));
  if(!file.startsWith(ROOT)) return json(res,403,{error:'Forbidden'});
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()) return json(res,404,{error:'Not found'});
    const ext=path.extname(file).toLowerCase();
    res.statusCode=200; res.setHeader('Content-Type',MIME[ext]||'application/octet-stream');
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
    if(ext==='.html') res.setHeader('Pragma','no-cache');
    fs.createReadStream(file).pipe(res);
  });
}

ensureData();
ensureTelegramDefaults();
const server=http.createServer(async (req,res)=>{
  try{
    res._forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(res._forwardedProto==='https') res.setHeader('Strict-Transport-Security','max-age=15552000; includeSubDomains');
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname.startsWith('/api/')) return routeAPI(req,res,u);
    return serveStatic(req,res,u);
  }catch(e){ const st=Number(e?.statusCode)||500; return json(res,st,{error:st===500?'Server error':e.message}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`${APP_NAME} running on port ${PORT}`));
