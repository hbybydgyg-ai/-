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
const APP_VERSION = '1.6.1';
const ADMIN_USER = process.env.ADMIN_EMAIL || 'hsydgyg5@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SrIraq!9vQ#4mL7@xK2';
const FIXED_RECEIVER = process.env.ASIACELL_RECEIVER || '07763308188';
const FIXED_RATE = 1250; // 1 USD = 1,250 IQD
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_BUCKETS = new Map();
const RATE_RULES = { auth:{window:60_000,max:12}, provider:{window:60_000,max:20}, order:{window:60_000,max:20}, general:{window:60_000,max:60} };
function clientIp(req){ return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim(); }
function rateLimit(req,bucket='general'){ const r=RATE_RULES[bucket]||RATE_RULES.general; const key=clientIp(req)+'|'+bucket; const now=Date.now(); let x=RATE_BUCKETS.get(key); if(!x||now-x.started>r.window)x={started:now,count:0}; x.count++; RATE_BUCKETS.set(key,x); if(x.count>r.max){ return Math.ceil((x.started+r.window-now)/1000); } return 0; }
setInterval(()=>{ const now=Date.now(); for(const [k,v] of RATE_BUCKETS) if(now-v.started>120_000) RATE_BUCKETS.delete(k); for(const [k,v] of sessions) if(now-(v.createdAt||0)>SESSION_TTL_MS) sessions.delete(k); }, 120_000).unref();

function ensureData() { if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, {recursive:true}); }
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
    out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function sid(req){ return parseCookies(req).sadairaq_sid || ''; }
function session(req){ const id=sid(req); if(!id) return null; const v=sessions.get(id); if(!v) return null; if(Date.now()-(v.createdAt||0)>SESSION_TTL_MS){sessions.delete(id);return null;} return v;}
function setSession(res, value){
  const id=crypto.randomBytes(24).toString('hex');
  sessions.set(id,{...value,createdAt:Date.now()});
  const secure = (String(process.env.COOKIE_SECURE||'auto').toLowerCase()==='true' || (String(process.env.COOKIE_SECURE||'auto').toLowerCase()==='auto' && String(res._forwardedProto||'').toLowerCase()==='https')) ? 'Secure; ' : '';
  res.setHeader('Set-Cookie',`sadairaq_sid=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=86400`);
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
function providerStore(){ return readJSON('providers.json',{activeProvider:'',providers:{}}); }
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
async function validateProviderUrl(raw){
  const u=new URL(String(raw||'').trim());
  if(!/^https?:$/.test(u.protocol)) throw new Error('API URL يجب أن يبدأ بـ http:// أو https://');
  const h=u.hostname.toLowerCase(); if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')) throw new Error('عنوان المزود غير مسموح');
  const records=await dns.lookup(h,{all:true,verbatim:true}); if(!records.length) throw new Error('تعذر حل اسم مزود API');
  if(records.some(x=>isPrivateAddress(x.address))) throw new Error('عنوان API داخلي أو خاص غير مسموح');
  return u;
}

async function providerRequest(prov,params,timeoutMs=30000){
  if(!prov?.url||!prov?.key) throw new Error('بيانات المزود غير مكتملة');
  const rawUrl=String(prov.url).trim();
  await validateProviderUrl(rawUrl);
  const base=rawUrl.replace(/\/+$/,'');
  const endpoints=[base,base+'/'].filter((v,i,a)=>a.indexOf(v)===i);
  const payload=new URLSearchParams();
  payload.set('key',String(prov.key));
  Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&String(v)!=='')payload.set(k,String(v));});
  let lastError=null;
  for(const endpoint of endpoints){
    for(let attempt=1;attempt<=3;attempt++){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json,text/plain,*/*','User-Agent':'SadaIraq/1.6.0'},body:payload.toString(),redirect:'follow',signal:controller.signal});
        const text=await r.text();
        let d={};
        try{d=text?JSON.parse(text):{};}catch(_){d={raw:text};}
        if(!r.ok){
          const err=new Error(`مزود SMM أعاد HTTP ${r.status}`); err.retryable=r.status===408||r.status===425||r.status===429||r.status>=500; throw err;
        }
        if(d&&typeof d==='object'&&d.error) throw new Error(String(d.error));
        return d;
      }catch(e){
        lastError=e;
        const retryable=e?.name==='AbortError'||e?.retryable;
        if(retryable&&attempt<3){await new Promise(r=>setTimeout(r,250*attempt));continue;}
        break;
      }finally{clearTimeout(timer);}
    }
  }
  // Compatibility fallbacks for READ operations only. Never retry order creation here,
  // because a provider could accept an order even when the response is unusual.
  if(['balance','services'].includes(String(params?.action||''))){
    for(const endpoint of endpoints){
      const variants = [
        {method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json,text/plain,*/*','User-Agent':'SadaIraq/1.6.0'}, body:JSON.stringify(Object.fromEntries(payload.entries()))},
        {method:'GET', headers:{'Accept':'application/json,text/plain,*/*','User-Agent':'SadaIraq/1.6.0'}, body:null, url:endpoint+'?'+payload.toString()}
      ];
      for(const v of variants){
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
        try{
          const r=await fetch(v.url||endpoint,{method:v.method,headers:v.headers,body:v.body,redirect:'follow',signal:controller.signal});
          const t=await r.text(); let d={}; try{d=t?JSON.parse(t):{};}catch(_){d={raw:t};}
          if(!r.ok) continue;
          if(d&&typeof d==='object'&&d.error) continue;
          return d;
        }catch(_){
          // keep trying compatible read formats
        }finally{clearTimeout(timer);}
      }
    }
  }
  if(lastError?.name==='AbortError') throw lastError;
  throw lastError||new Error('تعذر الاتصال بالمزود');
}
function userFromSession(req){ const s=session(req); return s?.role==='user' ? String(s.username||'') : ''; }
function appendJsonLedger(file,entry){ const arr=readJSON(file,[]); const next=Array.isArray(arr)?arr:[]; next.push(entry); writeJSON(file,next.slice(-5000)); }
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
  const store=readJSON('providers.json',{activeProvider:'',providers:{}});
  const providerId=String(urlObj.searchParams.get('provider')||store.activeProvider||'');
  let prov=(store.providers||{})[providerId];
  if(!prov)return json(res,404,{error:'لا يوجد مزود محفوظ أو جلسة الإدارة منتهية'});
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

async function routeAPI(req,res,urlObj){
  const p=normalizedPath(urlObj.pathname);
  if(p==='/api/config'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); return json(res,200,{appName:APP_NAME,version:APP_VERSION,currency:'USD',exchangeRate:FIXED_RATE,fixedRecharge:'5000 IQD = 4 USD',rateTable:[1000,2000,3000,4000,5000,6000,7000,8000,9000,10000].map(i=>({iqd:i,usd:i/FIXED_RATE})),supportWhatsappUrl:waUrl,supportWhatsappNumber:normalizeWhatsAppNumber(waUrl),telegramChannelUrl:'https://t.me/jbhbhg58'}); }
  if(p==='/api/auth' && req.method==='POST'){
    const wait=rateLimit(req,'auth'); if(wait) return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req); const u=String(b.username||'').trim(); const pw=String(b.password||'');
    if(String(b.action||'')==='register'){
      if(!/^[a-zA-Z0-9_]+$/.test(u)) return json(res,422,{ok:false,error:'اسم المستخدم يجب أن يكون بالإنجليزية والأرقام فقط'});
      if(pw.length<4) return json(res,422,{ok:false,error:'كلمة المرور يجب أن تكون 4 أحرف على الأقل'});
      if(u===ADMIN_USER) return json(res,409,{ok:false,error:'اسم المستخدم محجوز'});
      const store=readJSON('users.json',{users:{}}); if(store.users[u]) return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً'});
      const user={name:u,passwordHash:hashPassword(pw),balance:0,level:'مبتدئ',telegram:String(b.telegram||''),phone:String(b.phone||''),joined:new Date().toISOString(),totalSpent:0,totalOrders:0,role:'user'};
      store.users[u]=user; writeJSON('users.json',store); setSession(res,{role:'user',username:u});
      const safeUser={...user}; delete safeUser.password; delete safeUser.passwordHash; return json(res,200,{ok:true,role:'user',username:u,user:safeUser});
    }
    if(u===ADMIN_USER && adminPasswordValid(pw)){ setSession(res,{role:'admin',username:ADMIN_USER}); return json(res,200,{ok:true,role:'admin',username:ADMIN_USER}); }
    const store=readJSON('users.json',{users:{}}); const user=store.users?.[u];
    if(user && verifyPassword(pw,user.passwordHash || user.password || '')){ const role=user.role==='admin'?'admin':'user'; setSession(res,{role,username:u}); const clean={...user}; delete clean.password; delete clean.passwordHash; return json(res,200,{ok:true,role,username:u,user:clean}); }
    return json(res,401,{ok:false,error:'بيانات الدخول غير صحيحة'});
  }
  if(p==='/api/session' && req.method==='GET'){ const s=session(req); if(!s)return json(res,200,{ok:false,authenticated:false}); if(s.role==='admin')return json(res,200,{ok:true,authenticated:true,role:'admin',username:s.username}); const store=readJSON('users.json',{users:{}}); const u=store.users?.[s.username]; if(!u)return json(res,200,{ok:false,authenticated:false}); const clean={...u}; delete clean.password; delete clean.passwordHash; return json(res,200,{ok:true,authenticated:true,role:'user',username:s.username,user:clean}); }
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
    const b=await bodyJSON(req); const providerId=String(b.providerId||''); const serviceId=String(b.serviceId||''); const link=String(b.link||'').trim(); const quantity=Number(b.quantity);
    if(!providerId||!serviceId||!link||!Number.isInteger(quantity)||quantity<=0)return json(res,422,{ok:false,error:'بيانات الطلب غير مكتملة'});
    const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالخدمة غير موجود'});
    try{
      const bd=await providerRequest(prov,{action:'balance'});
      const balance=normalizeProviderBalance(bd);
      if(balance===null) return json(res,502,{ok:false,error:'تعذر التحقق من رصيد المزود الحقيقي قبل إنشاء الطلب'});
      const d=await providerRequest(prov,{action:'add',service:serviceId,link,quantity});
      if(!d||d.order===undefined||d.order===null||String(d.order)==='')return json(res,502,{ok:false,error:'المزود لم يرجع رقم طلب حقيقي',providerResponse:d});
      const providerOrderId=String(d.order);
      appendJsonLedger('orders.json',{localId:String(b.localId||''),user:username,providerId,providerOrderId,serviceId,link,quantity,status:'pending',providerBalanceBefore:balance,createdAt:new Date().toISOString()});
      return json(res,200,{ok:true,providerId,providerName:prov.name||providerId,providerOrderId,providerRaw:d,providerBalanceBefore:balance,createdAt:new Date().toISOString()});
    }catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/status' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'}); const b=await bodyJSON(req); const providerId=String(b.providerId||''); const providerOrderId=String(b.providerOrderId||''); if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات التحقق ناقصة'}); if(!ownedProviderOrder(username,providerId,providerOrderId))return json(res,403,{ok:false,error:'هذا الطلب لا يتبع حسابك'}); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{const d=await providerRequest(prov,{action:'status',order:providerOrderId}); const status=String(d.status||''); return json(res,200,{ok:true,providerOrderId,status,normalizedStatus:normalizeProviderStatus(status),remains:d.remains,startCount:d.start_count??d.startCount,charge:d.charge,currency:d.currency||'USD',raw:d,checkedAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/cancel' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'}); const b=await bodyJSON(req); const providerId=String(b.providerId||''); const providerOrderId=String(b.providerOrderId||''); if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات الإلغاء ناقصة'}); if(!ownedProviderOrder(username,providerId,providerOrderId))return json(res,403,{ok:false,error:'هذا الطلب لا يتبع حسابك'}); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{const d=await providerRequest(prov,{action:'cancel',orders:providerOrderId}); if(!providerActionSucceeded('cancel',d,providerOrderId)) return json(res,502,{ok:false,error:'المزود لم يؤكد إلغاء الطلب',providerRaw:d}); appendJsonLedger('orders.json',{event:'cancel',user:username,providerId,providerOrderId,status:'cancelled',createdAt:new Date().toISOString(),providerRaw:d}); return json(res,200,{ok:true,providerOrderId,status:'cancelled',providerRaw:d,updatedAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/logout'){
    const id=sid(req); if(id) sessions.delete(id); res.setHeader('Set-Cookie','sadairaq_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return json(res,200,{ok:true});
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
  if(p==='/api/provider/secret' && req.method==='GET') {
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const id=String(urlObj.searchParams.get('provider')||''); const {prov}=getProviderById(id); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    return json(res,200,{ok:true,providerId:id,key:String(prov.key||'')});
  }
  if(p==='/api/providers'){
    const store=readJSON('providers.json',{activeProvider:'',providers:{}});
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
        const id=String(item.id||'').replace(/[^a-zA-Z0-9_-]/g,''); const name=String(item.name||'').trim(); const apiUrl=String(item.url||'').trim(); const key=String(item.key||'').trim();
        const preserved=String((store.providers||{})[id]?.key||''); if(id&&name&&/^https?:\/\//i.test(apiUrl)&&(key||preserved)) incoming[id]={name,url:apiUrl,key:key||preserved};
      }
      const out = b.mode==='merge' ? {...(store.providers||{}), ...incoming} : incoming;
      const active = String(b.activeProvider!==undefined ? b.activeProvider : (store.activeProvider||''));
      writeJSON('providers.json',{activeProvider:active,providers:out,updatedAt:new Date().toISOString()});
      return json(res,200,{ok:true,count:Object.keys(out).length,activeProvider:active});
    }
  }
  if(p==='/api/smm') return apiSmm(req,res,urlObj);
  if(p==='/api/asiacell' && req.method==='POST') return apiAsiacell(req,res);
  if(p==='/api/health') return json(res,200,{ok:true,app:APP_NAME,version:APP_VERSION,time:new Date().toISOString(),node:process.version});
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
