const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const dns = require('dns').promises;
const net = require('net');
const {URL} = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const LEGACY_DATA = path.join(ROOT, 'data');
// Prefer a Railway Volume or explicit persistent directory; only fall back to release-local data.
const DATA = path.resolve(process.env.SADA_DATA_DIR || process.env.DATA_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sada-data') : LEGACY_DATA));
const DATA_IS_EXTERNAL = path.resolve(DATA) !== path.resolve(LEGACY_DATA);
const APP_NAME = 'صدى العراق';
const APP_VERSION = '1.5.76';
const BUILD_ID = 'SADA-1.5.76-HOME-ORDERS-ADMIN-TELEGRAM-PERSISTENCE-20261010';
const ADMIN_USER = process.env.ADMIN_EMAIL || 'hsydgyg5@gmail.com';
// Restored the default administrator login from the supplied original release. Set ADMIN_PASSWORD in Railway to override it.
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'SrIraq!9vQ#4mL7@xK2');
const FIXED_RECEIVER = process.env.ASIACELL_RECEIVER || '07763308188';
const FIXED_RATE = 1250; // 1 USD = 1,250 IQD
// v1.5.40: signed stateless sessions survive Railway restarts/instance changes.
const sessions = new Map(); // legacy sessions kept only during rolling deployments
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// Legacy fallback retained for compatibility with the supplied original release; configure a strong SESSION_SECRET in production.
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'sadairaq-session-secret-change-me');
const SESSION_COOKIE = 'sadairaq_sid';
const SESSION_TOKEN_HEADER = 'x-sada-session';
const RATE_BUCKETS = new Map();
// AsiaCell OTP state must persist across separate stateless-cookie API requests.
// Keep access tokens server-side, keyed by a hash of the site's session token; never put them in the cookie.
const ASIACELL_SESSIONS = new Map();
const ASIACELL_SESSION_TTL_MS = 20 * 60 * 1000;
setInterval(()=>{const now=Date.now();for(const [k,v] of ASIACELL_SESSIONS){if(now-Number(v.updatedAt||v.createdAt||0)>ASIACELL_SESSION_TTL_MS)ASIACELL_SESSIONS.delete(k);}if(ASIACELL_SESSIONS.size>5000){for(const [k,v] of ASIACELL_SESSIONS){if(now-Number(v.updatedAt||v.createdAt||0)>ASIACELL_SESSION_TTL_MS)ASIACELL_SESSIONS.delete(k);}}},60_000).unref();
const RATE_RULES = { auth:{window:60_000,max:12}, captcha:{window:60_000,max:30}, email:{window:10*60_000,max:5}, provider:{window:60_000,max:20}, order:{window:60_000,max:20}, api:{window:60_000,max:60}, general:{window:60_000,max:60} };
function clientIp(req){ return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim(); }
function rateLimit(req,bucket='general'){ const r=RATE_RULES[bucket]||RATE_RULES.general; const key=clientIp(req)+'|'+bucket; const now=Date.now(); let x=RATE_BUCKETS.get(key); if(!x||now-x.started>r.window)x={started:now,count:0}; x.count++; RATE_BUCKETS.set(key,x); if(x.count>r.max){ return Math.ceil((x.started+r.window-now)/1000); } return 0; }
setInterval(()=>{ const now=Date.now(); for(const [k,v] of RATE_BUCKETS) if(now-v.started>120_000) RATE_BUCKETS.delete(k); for(const [k,v] of sessions) if(now-(v.createdAt||0)>SESSION_TTL_MS) sessions.delete(k); }, 120_000).unref();


function ensureTelegramDefaults(){
  const cfg=readJSON('settings.json',{});
  const tg=cfg.telegram&&typeof cfg.telegram==='object'?{...cfg.telegram}:{};
  if(tg.enabled===undefined) tg.enabled=true;
  // Keep the public destination in settings, but never persist TELEGRAM_BOT_TOKEN from env.
  if(!tg.chat || String(tg.chat).trim()==='@jbhbhg58') tg.chat=String(process.env.TELEGRAM_CHAT_ID||'@jbhbhg58');
  if(tg.chat||cfg.telegram) { cfg.telegram=tg; writeJSON('settings.json',cfg); }
}

function ensureData() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, {recursive:true});
  // On the first boot with a persistent directory, safely migrate any existing JSON data.
  if(DATA_IS_EXTERNAL && fs.existsSync(LEGACY_DATA)){
    try{for(const file of fs.readdirSync(LEGACY_DATA)){if(!file.endsWith('.json'))continue;const from=path.join(LEGACY_DATA,file),to=path.join(DATA,file);if(!fs.existsSync(to)&&fs.statSync(from).isFile())fs.copyFileSync(from,to);}}catch(e){console.warn('Data migration to persistent directory failed:',e.message)}
  }
  const defaults={
    'users.json':{users:{}},
    'google_accounts.json':{},
    'telegram_order_state.json':{initialized:false,seen:{}},
    'orders.json':[],
    'provider_failures.json':[],
    'payments.json':[],
    'notifications.json':[],
    'telegram_notifications.json':[],
    'notification_seen.json':{},
    'user_notifications.json':{},
    'earn_requests.json':[],
    'providers.json':{activeProvider:'',providers:{},deletedProviderIds:[]},
    // Provider state is stored separately so code updates do not overwrite it.
    'providers.runtime.json':{activeProvider:'',providers:{},deletedProviderIds:[]},
    'settings.json':{},
    'api_services.json':[],
    'balance_ledger.json':[],
    'refunds.json':[],
    'api_keys.json':{},
    'stats_state.json':{resetAt:null},
    'order_audit_state.json':{alerts:{}},
    'email_challenges.json':{}
  };
  for(const [file,def] of Object.entries(defaults)){
    const full=path.join(DATA,file);
    let cur=null, ok=true;
    try{cur=JSON.parse(fs.readFileSync(full,'utf8'));}catch(_){ok=false;}
    if(file==='users.json') ok=!!(cur&&typeof cur==='object'&&cur.users&&typeof cur.users==='object'&&!Array.isArray(cur.users));
    else if(file==='orders.json'||file==='provider_failures.json'||file==='payments.json'||file==='notifications.json'||file==='telegram_notifications.json') ok=Array.isArray(cur);
    else if(file==='notification_seen.json'||file==='user_notifications.json') ok=!!(cur&&typeof cur==='object'&&!Array.isArray(cur));
    else if(file==='providers.json') ok=!!(cur&&typeof cur==='object'&&cur.providers&&typeof cur.providers==='object'&&!Array.isArray(cur.providers));
    else if(file==='settings.json'||file==='api_keys.json'||file==='stats_state.json'||file==='order_audit_state.json'||file==='google_accounts.json'||file==='telegram_order_state.json'||file==='email_challenges.json') ok=!!(cur&&typeof cur==='object'&&!Array.isArray(cur));
    else if(file==='api_services.json'||file==='balance_ledger.json'||file==='refunds.json'||file==='earn_requests.json') ok=Array.isArray(cur);
    if(!ok){
      // Never silently discard unreadable legacy data: retain a byte-for-byte recovery copy first.
      if(fs.existsSync(full)){try{const stamp=new Date().toISOString().replace(/[:.]/g,'-');const backup=full+'.corrupt-'+stamp+'.bak';fs.copyFileSync(full,backup);console.error('Invalid JSON preserved for recovery:',path.basename(full),'backup:',path.basename(backup));}catch(e){console.error('Could not back up invalid data file:',path.basename(full),String(e.message||e));throw e;}}
      fs.writeFileSync(full,JSON.stringify(def,null,2),'utf8');
    }
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
function issueProviderOrderTrackingToken({username,providerId,providerOrderId,siteOrderId}){
  const claims={v:1,username:String(username||''),providerId:String(providerId||''),providerOrderId:String(providerOrderId||''),siteOrderId:String(siteOrderId||''),issuedAt:Date.now()};
  if(!claims.username||!claims.providerId||!claims.providerOrderId||!claims.siteOrderId) return '';
  const payload=Buffer.from(JSON.stringify(claims),'utf8').toString('base64url');
  return payload+'.'+sessionSig(payload);
}
function verifyProviderOrderTrackingToken(token,expected={}){
  const parts=String(token||'').split('.'); if(parts.length!==2||!parts[0]||!parts[1])return null;
  if(!safeEqual(parts[1],sessionSig(parts[0])))return null;
  try{
    const c=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    if(!c||c.v!==1||!c.username||!c.providerId||!c.providerOrderId||!c.siteOrderId)return null;
    for(const [claim,key] of [['username','username'],['providerId','providerId'],['providerOrderId','providerOrderId'],['siteOrderId','siteOrderId']]){
      const want=String(expected[key]||''); if(want && String(c[claim])!==want)return null;
    }
    return c;
  }catch(_){return null;}
}
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
    // A signed admin session remains valid during an admin-email setting change until TTL expiry.
    // v1.5.40: do NOT require users.json for an already signed user session.
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
function adminPasswordValid(password){ if(String(process.env.ADMIN_PASSWORD_HASH||'').startsWith('scrypt$')) return verifyPassword(password,process.env.ADMIN_PASSWORD_HASH); if(process.env.ADMIN_PASSWORD) return safeEqual(password,process.env.ADMIN_PASSWORD); const stored=readJSON('settings.json',{}).adminPasswordHash; if(String(stored||'').startsWith('scrypt$'))return verifyPassword(password,stored); return !!ADMIN_PASSWORD && safeEqual(password,ADMIN_PASSWORD); }

function normalizeEmail(value){return String(value||'').trim().toLowerCase();}
function validEmail(value){const e=normalizeEmail(value);return e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);}
function decodeFirebaseSafeKey(value){return String(value||'').replace(/_x([0-9a-f]{1,6})_/gi,(_,hex)=>{try{return String.fromCodePoint(parseInt(hex,16));}catch(_){return _;}});}
function emailChallengeKey(email,purpose){return String(purpose)+':'+sha256(normalizeEmail(email));}
function emailCodeDigest(email,purpose,username,code){return crypto.createHmac('sha256',SESSION_SECRET).update([normalizeEmail(email),String(purpose),String(username||''),String(code||'')].join('|')).digest('hex');}
function htmlEscapeAuth(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function sendTransactionalEmail({to,subject,text,html}){
  const apiKey=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM||'').trim();
  if(!apiKey||!from)throw Object.assign(new Error('خدمة البريد غير مهيأة. أضف RESEND_API_KEY وRESEND_FROM_EMAIL في متغيرات الاستضافة.'),{statusCode:503,code:'email_not_configured'});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+apiKey,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({from,to:[normalizeEmail(to)],subject,text,html}),signal:controller.signal});
    const bodyText=await response.text();let data={};try{data=bodyText?JSON.parse(bodyText):{}}catch(_){data={message:bodyText};}
    if(!response.ok||!data.id){const reason=String(data.message||data.error||data.name||('HTTP '+response.status)).slice(0,220);throw Object.assign(new Error('رفضت خدمة البريد الإرسال: '+reason),{statusCode:502,code:'email_provider_rejected'});}
    return {id:String(data.id),sentAt:nowISO()};
  }catch(e){if(e.name==='AbortError')throw Object.assign(new Error('انتهت مهلة خدمة البريد دون تأكيد الإرسال.'),{statusCode:504,code:'email_timeout'});throw e;}
  finally{clearTimeout(timer);}
}
async function beginEmailChallenge(email,purpose,username,subjectPrefix){
  const normalized=normalizeEmail(email);if(!validEmail(normalized))throw Object.assign(new Error('أدخل عنوان بريد إلكتروني صحيحاً.'),{statusCode:422});
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  const safePurpose=String(purpose);const expiresAt=Date.now()+10*60*1000;
  const purposeText=safePurpose==='register'?'تأكيد البريد الإلكتروني':safePurpose==='reset'?'استعادة كلمة المرور':'تغيير البريد الإلكتروني';
  const html='<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.9;color:#142033"><h2>صدى العراق</h2><p>استخدم رمز '+htmlEscapeAuth(purposeText)+' التالي:</p><div style="font-size:32px;font-weight:bold;letter-spacing:7px;padding:15px;background:#edf4ff;border-radius:12px;display:inline-block">'+code+'</div><p>تنتهي صلاحية الرمز خلال 10 دقائق. لا تشارك الرمز مع أي شخص.</p><p style="color:#667085;font-size:12px">إذا لم تطلب هذه العملية، تجاهل الرسالة.</p></div>';
  const mail=await sendTransactionalEmail({to:normalized,subject:'صدى العراق — '+purposeText,text:'رمز '+purposeText+': '+code+'\nتنتهي صلاحية الرمز خلال 10 دقائق. لا تشارك الرمز مع أي شخص.',html});
  const store=readJSON('email_challenges.json',{});const key=emailChallengeKey(normalized,safePurpose);
  store[key]={email:normalized,purpose:safePurpose,username:String(username||''),codeDigest:emailCodeDigest(normalized,safePurpose,username,code),createdAt:nowISO(),expiresAt,attempts:0,emailProvider:'resend',providerMessageId:mail.id};
  writeJSON('email_challenges.json',store);
  return {expiresInSeconds:600,sent:true};
}
function consumeEmailChallenge(email,purpose,code,expectedUsername=''){
  const normalized=normalizeEmail(email),key=emailChallengeKey(normalized,purpose),store=readJSON('email_challenges.json',{}),row=store[key];
  if(!row||row.email!==normalized||row.purpose!==String(purpose))return {ok:false,error:'رمز التحقق غير موجود أو انتهت صلاحيته. أرسل رمزاً جديداً.'};
  if(Number(row.expiresAt||0)<Date.now()){delete store[key];writeJSON('email_challenges.json',store);return {ok:false,error:'انتهت صلاحية رمز التحقق. أرسل رمزاً جديداً.'};}
  if(Number(row.attempts||0)>=5){delete store[key];writeJSON('email_challenges.json',store);return {ok:false,error:'تم تجاوز عدد محاولات التحقق. أرسل رمزاً جديداً.'};}
  if(expectedUsername&&String(row.username||'')!==String(expectedUsername)){return {ok:false,error:'رمز التحقق لا يطابق هذا الحساب.'};}
  row.attempts=Number(row.attempts||0)+1;
  const good=/^\d{6}$/.test(String(code||''))&&safeEqual(row.codeDigest,emailCodeDigest(normalized,purpose,row.username,code));
  if(!good){store[key]=row;if(row.attempts>=5)delete store[key];writeJSON('email_challenges.json',store);return {ok:false,error:'رمز التحقق غير صحيح.'};}
  delete store[key];writeJSON('email_challenges.json',store);return {ok:true,username:String(row.username||'')};
}
async function findRemoteUserByUsername(username){
  const wanted=String(username||'').trim();if(!wanted)return null;let lastError=null;
  for(const pathName of ['users/'+firebaseSafeKey(wanted),'users/'+wanted]){try{const v=await firebaseGetJson(pathName,3200);if(v&&typeof v==='object'&&!Array.isArray(v))return {username:String(v.username||wanted),user:v,firebasePath:pathName};}catch(e){lastError=e;}}
  try{const all=await firebaseGetJson('users',5000);if(all&&typeof all==='object'&&!Array.isArray(all)){const found=Object.entries(all).find(([key,v])=>v&&typeof v==='object'&&(String(v.username||'').trim().toLowerCase()===wanted.toLowerCase()||decodeFirebaseSafeKey(key).trim().toLowerCase()===wanted.toLowerCase()||String(key).trim().toLowerCase()===wanted.toLowerCase()));if(found)return {username:String(found[1].username||decodeFirebaseSafeKey(found[0])||wanted),user:found[1],firebasePath:'users/'+found[0]};}return null;}catch(e){lastError=e;}
  if(lastError)throw lastError;return null;
}
async function findAccountByEmail(email){
  const normalized=normalizeEmail(email),store=readJSON('users.json',{users:{}}),users=store.users||{};
  const local=Object.entries(users).find(([key,u])=>u&&normalizeEmail(u.email||u.mail||u.emailAddress)===normalized);
  if(local)return {username:local[0],user:local[1],firebasePath:'users/'+firebaseSafeKey(local[0]),source:'local'};
  if(normalized===normalizeEmail(ADMIN_USER))return {username:ADMIN_USER,user:{email:ADMIN_USER,role:'admin'},source:'admin'};
  try{const all=await firebaseGetJson('users',5000);if(all&&typeof all==='object'&&!Array.isArray(all)){const found=Object.entries(all).find(([key,u])=>u&&typeof u==='object'&&normalizeEmail(u.email||u.mail||u.emailAddress)===normalized);if(found)return {username:String(found[1].username||decodeFirebaseSafeKey(found[0])||found[0]),user:found[1],firebasePath:'users/'+found[0],source:'firebase'};}return null;}catch(e){throw e;}
}
function envProvider(){
  const id=String(process.env.SMM_PROVIDER_ID||process.env.PROVIDER_ID||'').trim();
  const name=String(process.env.SMM_PROVIDER_NAME||process.env.PROVIDER_NAME||'').trim() || id;
  const url=String(process.env.SMM_API_URL||process.env.SMM_URL||process.env.PROVIDER_URL||'').trim();
  const key=String(process.env.SMM_API_KEY||process.env.SMM_KEY||process.env.PROVIDER_KEY||'').trim();
  if(!id||!url||!key) return null;
  return {id,name,url,key,source:'environment'};
}
function normalizeProviderId(value){
  return String(value??'').trim().replace(/[^a-zA-Z0-9_-]/g,'');
}
function usableProviderKey(value){
  const key=String(value??'').trim();
  if(!key) return '';
  // The admin UI may submit a masked placeholder instead of the actual secret.
  if(/^\[(?:hidden|masked|مخفي)\]$/i.test(key) || /^(?:hidden|masked)$/i.test(key) || /^[*•●·＿_\s-]{4,}$/.test(key)) return '';
  return key;
}
function providerIdInStore(store,value){
  const providers=store?.providers||{};
  const wanted=String(value??'').trim();
  if(wanted && Object.prototype.hasOwnProperty.call(providers,wanted)) return wanted;
  const norm=normalizeProviderId(wanted);
  if(norm && Object.prototype.hasOwnProperty.call(providers,norm)) return norm;
  const keys=Object.keys(providers);
  return keys.find(k=>normalizeProviderId(k)===norm && norm) || keys.find(k=>k.toLowerCase()===wanted.toLowerCase() && wanted) || '';
}
function providerStore(){
  // Runtime state is authoritative; deploy archives never ship live provider state.
  const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
  let runtime=readJSON('providers.runtime.json',null);
  if(!runtime || !runtime.providers || typeof runtime.providers!=='object') runtime={activeProvider:'',providers:{},deletedProviderIds:[]};
  const providers={};
  const mergeOne=(id,source)=>{
    if(!source || typeof source!=='object') return;
    const prev=providers[id]||{};
    const merged={...prev,...source};
    for(const field of ['id','name','url']){
      if(!String(merged[field]??'').trim() && String(prev[field]??'').trim()) merged[field]=prev[field];
    }
    const incomingKey=usableProviderKey(source.key);
    const previousKey=usableProviderKey(prev.key);
    merged.key=incomingKey||previousKey||'';
    providers[id]={...merged,id:String(merged.id||id)};
  };
  if(legacy?.providers&&typeof legacy.providers==='object') for(const [id,v] of Object.entries(legacy.providers)) mergeOne(String(id),v);
  if(runtime?.providers&&typeof runtime.providers==='object') for(const [id,v] of Object.entries(runtime.providers)) mergeOne(String(id),v);
  const deleted=new Set([
    ...(Array.isArray(legacy?.deletedProviderIds)?legacy.deletedProviderIds.map(String):[]),
    ...(Array.isArray(runtime?.deletedProviderIds)?runtime.deletedProviderIds.map(String):[])
  ]);
  for(const id of deleted){ for(const key of Object.keys(providers)) if(key===id || normalizeProviderId(key)===normalizeProviderId(id)) delete providers[key]; }
  const env=envProvider();
  if(env && !deleted.has(env.id)) mergeOne(env.id,env);
  let active=String(runtime?.activeProvider||legacy?.activeProvider||'');
  let activeKey=providerIdInStore({providers},active);
  if(!activeKey || !providers[activeKey]?.url || !providers[activeKey]?.key){
    activeKey=Object.keys(providers).find(k=>providers[k]?.url&&providers[k]?.key)||'';
  }
  return {activeProvider:activeKey,providers,deletedProviderIds:deleted,envProvider:env};
}
function getProviderById(id, options={}){
  const store=providerStore();
  const requested=String(id??'').trim();
  let pid=providerIdInStore(store,requested || store.activeProvider);
  let prov=pid?store.providers[pid]:null;
  if((!prov?.url||!prov?.key) && options.allowSingleFallback===true){
    const valid=Object.entries(store.providers||{}).filter(([,v])=>v?.url&&v?.key);
    if(valid.length===1){pid=valid[0][0];prov=valid[0][1];}
  }
  return {store,pid,prov};
}
function normalizeProviderStatus(v){ const x=String(v||'').trim().toLowerCase().replace(/[\s_-]+/g,' '); const map={pending:'pending',waiting:'pending',awaiting:'pending',queued:'pending',processing:'processing','in progress':'processing',inprogress:'processing',completed:'completed',complete:'completed',finished:'completed',partial:'partial','partially completed':'partial',canceled:'cancelled',cancelled:'cancelled',failed:'failed',error:'failed',refunded:'refunded'}; return map[x]||'unknown'; }
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
        {method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json,text/plain,*/*','User-Agent':`SadaIraq/${APP_VERSION}`},body:JSON.stringify(Object.fromEntries(payload.entries()))}
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

// Resolve saved provider credentials server-side for the provider-list test button.
// The list endpoint intentionally returns hasKey rather than the secret itself.
async function resolveProviderDiagnosticsInput(body={}){
  const providerId=String(body.providerId||body.provider||body.id||'').trim();
  let prov={name:String(body.name||'مزود').trim(),url:String(body.url||'').trim(),key:usableProviderKey(body.key)};
  if(providerId && !prov.key){
    await ensureProviderRuntime(providerId);
    const saved=getProviderById(providerId,{allowSingleFallback:false}).prov;
    if(saved?.url && saved?.key){
      prov={...saved,name:String(body.name||saved.name||providerId).trim()};
    }
  }
  return prov;
}

function userFromSession(req){ const s=session(req); return (s?.role==='user'||s?.role==='admin') ? String(s.username||'') : ''; }
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
  const webSession=session(req), rawSid=String(sid(req)||'').trim();
  if(!webSession||!rawSid) return json(res,401,{error:'سجّل الدخول إلى حساب صدى العراق أولاً ثم أعد عملية الشحن.'});
  const stateKey=sha256(rawSid);
  let s=ASIACELL_SESSIONS.get(stateKey);
  if(s&&(s.owner!==String(webSession.username||'')||Date.now()-Number(s.updatedAt||s.createdAt||0)>ASIACELL_SESSION_TTL_MS)){
    ASIACELL_SESSIONS.delete(stateKey);s=null;
  }
  if(action==='reset'){ASIACELL_SESSIONS.delete(stateKey);return json(res,200,{ok:true});}
  if(action==='login'){
    const phone=cleanPhone(inBody.phone); if(!phone) return json(res,422,{error:'رقم آسياسيل غير صحيح. استخدم 077xxxxxxxx'});
    const headers=acHeaders();
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/login?lang=en',headers,{captchaCode:'',username:phone});
      const next=String(d.nextUrl||''); const m=next.match(/PID=([a-f0-9-]+)/i);
      if(!m) throw new Error(d.message || 'فشل إرسال رمز SMS');
      ASIACELL_SESSIONS.set(stateKey,{owner:String(webSession.username),phone,headers,pid:m[1],step:'sms',createdAt:Date.now(),updatedAt:Date.now()});
      return json(res,200,{ok:true,message:'تم إرسال رمز SMS إلى الرقم.'});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(!s) return json(res,409,{error:'انتهت جلسة آسياسيل أو أعيد تشغيل الخادم. ابدأ بخطوة إرسال رمز SMS من جديد.'});
  if(action==='verify_sms'){
    if(s.step!=='sms') return json(res,409,{error:'خطوة التحقق غير متاحة؛ أعد إرسال رمز SMS.'});
    const code=String(inBody.passcode||'').trim(); if(!/^\d{4,8}$/.test(code)) return json(res,422,{error:'رمز SMS غير صحيح'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/smsvalidation?lang=en',s.headers,{PID:s.pid,passcode:code,token:''});
      if(!d.success || !d.access_token) throw new Error(d.message || 'رمز SMS غير صحيح');
      s.headers.Authorization='Bearer '+d.access_token; s.step='amount'; s.updatedAt=Date.now();
      return json(res,200,{ok:true,message:'تم التحقق من الرقم بنجاح.'});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(action==='start_transfer'){
    if(s.step!=='amount') return json(res,409,{error:'تحقق من رقم آسياسيل أولاً.'});
    const amount=Number(inBody.amount||0);
    if(!Number.isInteger(amount) || amount<1000 || amount>10000 || amount%1000!==0) return json(res,422,{error:'المبلغ يجب أن يكون بين 1,000 و10,000 د.ع وبمضاعفات 1,000'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/credit-transfer/start?lang=ar',s.headers,{amount,receiverMsisdn:FIXED_RECEIVER});
      if(!d.PID) throw new Error(d.message || 'فشل بدء التحويل');
      s.pid_transfer=String(d.PID); s.amount=amount; s.step='transfer_sms'; s.updatedAt=Date.now();
      return json(res,200,{ok:true,message:'تم إرسال رمز تأكيد التحويل.',usd:amount/FIXED_RATE,transferPid:s.pid_transfer});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(action==='confirm_transfer'){
    if(s.step!=='transfer_sms') return json(res,409,{error:'لا توجد عملية تحويل بانتظار التأكيد أو سبق تأكيدها.'});
    const code=String(inBody.passcode||'').trim(); if(!/^\d{4,8}$/.test(code)) return json(res,422,{error:'رمز التأكيد غير صحيح'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/credit-transfer/do-transfer?lang=ar',s.headers,{PID:s.pid_transfer,passcode:code});
      if(!d.success) throw new Error(d.message || 'فشل التحويل');
      s.step='completed'; s.updatedAt=Date.now();
      const amount=Number(s.amount); return json(res,200,{ok:true,message:'تم تأكيد التحويل بنجاح من آسياسيل.',usd:amount/FIXED_RATE,amountIQD:amount,phone:s.phone||'',transferPid:s.pid_transfer});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  return json(res,422,{error:'عملية غير معروفة'});
}

async function apiSmm(req,res,urlObj){
  const wait=rateLimit(req,'provider');
  if(wait) return json(res,429,{error:'طلبات المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
  if(!isAdmin(req)) return json(res,403,{error:'غير مصرح — جلسة الإدارة غير صالحة. حدّث الجلسة أو سجّل الدخول من جديد.'});
  if(req.method!=='GET' && req.method!=='POST') return json(res,405,{error:'طريقة الطلب غير مدعومة'});
  let body={};
  if(req.method==='POST') { try { body=await bodyJSON(req); } catch(_) { return json(res,400,{error:'بيانات طلب المزود غير صالحة'}); } }
  const requestedId=String(body.provider||body.providerId||urlObj.searchParams.get('provider')||'').trim();
  const action=String(body.action||urlObj.searchParams.get('action')||'balance');
  if(!['balance','services','add','status','cancel'].includes(action)) return json(res,422,{error:'عملية غير مدعومة'});
  let store=await ensureProviderRuntime(requestedId);
  let resolved=getProviderById(requestedId,{allowSingleFallback:!requestedId});
  let {pid:providerId,prov}=resolved;
  const suppliedUrl=String(body.url||body.apiUrl||urlObj.searchParams.get('_url')||'').trim();
  const suppliedKey=String(body.key||body.apiKey||urlObj.searchParams.get('_key')||'').trim();
  if(body.syncProvider===true && requestedId && suppliedUrl && suppliedKey){
    try{
      const id=providerIdInStore(store,requestedId)||normalizeProviderId(requestedId);
      if(!id) throw new Error('معرّف المزود غير صالح');
      const url=normalizeProviderApiUrl(suppliedUrl);
      const name=String(body.name||prov?.name||store.providers?.[id]?.name||id).trim();
      const saved={...(store.providers?.[id]||{}),id,name,url,key:suppliedKey,source:'admin'};
      const providers={...(store.providers||{}),[id]:saved};
      const deleted=[...(store.deletedProviderIds||[])].filter(x=>normalizeProviderId(x)!==normalizeProviderId(id));
      const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
      const legacyDeleted=(Array.isArray(legacy.deletedProviderIds)?legacy.deletedProviderIds:[]).filter(x=>normalizeProviderId(x)!==normalizeProviderId(id));
      writeJSON('providers.json',{...legacy,deletedProviderIds:legacyDeleted});
      const nextActive=body.activateProvider===true?id:(providerIdInStore(store,store.activeProvider)||id);
      writeJSON('providers.runtime.json',{activeProvider:nextActive,providers,deletedProviderIds:deleted,updatedAt:nowISO()});
      const k=firebaseSafeKey(id);
      await Promise.allSettled([
        firebaseWriteJson('config/smmProviders/'+k,{id,name,url,hasKey:true}),
        firebaseWriteJson('config/smmProviderSecrets/'+k,{id,name,url,key:suppliedKey}),
        firebaseWriteJson('config/smmActive',nextActive)
      ]);
      store=providerStore(); resolved=getProviderById(id,{allowSingleFallback:false});
      providerId=resolved.pid||id; prov=resolved.prov||saved;
    }catch(e){return json(res,422,{error:'تعذر تثبيت بيانات المزود: '+String(e.message||e)});}
  } else if((!prov?.url||!prov?.key) && suppliedUrl && suppliedKey){
    try{prov={...(prov||{}),id:providerId||requestedId,name:String(body.name||prov?.name||providerId||requestedId),url:normalizeProviderApiUrl(suppliedUrl),key:suppliedKey};}
    catch(_){return json(res,422,{error:'رابط API للمزود غير صالح'});}
  }
  if(!prov?.url||!prov?.key){
    await ensureProviderRuntime(requestedId).catch(()=>{});
    resolved=getProviderById(requestedId,{allowSingleFallback:!requestedId}); providerId=resolved.pid||requestedId; prov=resolved.prov;
  }
  if(!prov?.url||!prov?.key){
    const current=providerStore();
    const available=Object.entries(current.providers||{}).filter(([,v])=>v?.url&&v?.key).map(([id,v])=>({id,name:String(v.name||id)}));
    return json(res,404,{error:'تعذر العثور على مفتاح API المحفوظ لهذا المزود. أعد تحميل إعدادات المزود أو افتح التعديل وأعد حفظ المفتاح.',providerId:requestedId||null,availableProviders:available});
  }
  const payload={...body,action};
  for(const k of ['provider','providerId','url','apiUrl','key','apiKey','syncProvider','activateProvider','name']) delete payload[k];
  for(const k of ['service','link','quantity','order','orders']) if(payload[k]===undefined && urlObj.searchParams.has(k)) payload[k]=urlObj.searchParams.get(k);
  if(action==='cancel' && payload.orders===undefined && payload.order!==undefined){payload.orders=payload.order;delete payload.order;}
  try{
    const d=await providerRequest(prov,payload);
    if(action==='balance'){
      const balance=normalizeProviderBalance(d);
      if(balance===null) return json(res,502,{error:'المزود لم يرجع رصيداً رقمياً صالحاً',providerId,providerName:prov.name||providerId});
      return json(res,200,{ok:true,balance,currency:normalizeProviderCurrency(d),providerId,providerName:prov.name||providerId,checkedAt:new Date().toISOString()});
    }
    return json(res,200,d);
  }catch(e){return json(res,502,{error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':String(e.message||'تعذر الاتصال بالمزود'),providerId,providerName:prov.name||providerId});}
}

function readNotifications(){ return readJSON('notifications.json',[]); }
function writeNotifications(v){ writeJSON('notifications.json',Array.isArray(v)?v:[]); }
function readNotificationSeen(){ return readJSON('notification_seen.json',{}); }
function writeNotificationSeen(v){ writeJSON('notification_seen.json',v&&typeof v==='object'?v:{}); }
function notifId(){ return 'N'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'); }
function sanitizeNotification(n){ return {id:String(n.id||''),title:String(n.title||''),message:String(n.message||''),url:String(n.url||''),required:!!n.required,active:n.active!==false,createdAt:n.createdAt||new Date().toISOString(),updatedAt:n.updatedAt||n.createdAt||new Date().toISOString(),...(n.orderId?{orderId:String(n.orderId)}:{}),...(n.type?{type:String(n.type)}:{}),...(n.status?{status:String(n.status)}:{}),read:!!n.read}; }
function userNotifId(username,type,orderId,status=''){return 'UN'+sha256([username,type,orderId,status].map(x=>String(x||'')).join('|')).slice(0,24)}
function createUserNotification(username, data={}){
  const user=String(username||'').trim();if(!user)return null;
  const type=String(data.type||'info'),orderId=String(data.orderId||''),status=String(data.status||'');
  const id=String(data.id||userNotifId(user,type,orderId,status));
  const n={id,user,title:String(data.title||'إشعار جديد').slice(0,160),message:String(data.message||'').slice(0,1500),orderId,type,status,createdAt:data.createdAt||nowISO(),url:String(data.url||''),read:false,active:true,...(data.meta&&typeof data.meta==='object'?{meta:data.meta}:{})};
  const all=readJSON('user_notifications.json',{});const rows=Array.isArray(all[user])?all[user]:[];
  if(!rows.some(x=>String(x.id)===id)){rows.unshift(n);all[user]=rows.slice(0,300);writeJSON('user_notifications.json',all);}
  const remote={...n};delete remote.user;
  firebaseWriteJson('userNotifications/'+firebaseSafeKey(user)+'/'+id,remote,4500).catch(()=>{});
  return n;
}
async function listUserNotifications(username){
  const user=String(username||'').trim(),all=readJSON('user_notifications.json',{}),local=Array.isArray(all[user])?all[user]:[];let remote=[];
  try{const v=await firebaseGetJson('userNotifications/'+firebaseSafeKey(user),4500);if(v&&typeof v==='object')remote=(Array.isArray(v)?v:Object.values(v)).filter(x=>x&&typeof x==='object').map(x=>({...x,user}));}catch(_){}
  const merged=new Map();for(const n of [...remote,...local]){if(n?.id)merged.set(String(n.id),{...merged.get(String(n.id)),...n,user});}
  const seen={...(readNotificationSeen()[user]||{})};try{const rs=await firebaseGetJson('userNotificationSeen/'+firebaseSafeKey(user),3000);if(rs&&typeof rs==='object')Object.assign(seen,rs)}catch(_){}
  const own=[...merged.values()].map(n=>({...sanitizeNotification(n),read:!!(n.read||seen[n.id]),user}));
  const broadcasts=readNotifications().filter(n=>n.active!==false).map(n=>({...sanitizeNotification(n),read:!!seen[n.id],type:'broadcast'}));
  return [...own,...broadcasts].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)).slice(0,500);
}

function ownedProviderOrder(username,providerId,providerOrderId){
  const rows=readJSON('orders.json',[]); return Array.isArray(rows) && rows.some(x=>String(x.user||'')===String(username||'') && String(x.providerId||'')===String(providerId||'') && String(x.providerOrderId||'')===String(providerOrderId||''));
}


function nowISO(){ return new Date().toISOString(); }
function sha256(v){ return crypto.createHash('sha256').update(String(v||'')).digest('hex'); }
// Provider secrets use a dedicated key when configured. Legacy decrypt fallback preserves
// provider credentials saved by older releases while the operator rotates to SADA_ENCRYPTION_KEY.
const LEGACY_PROVIDER_ENCRYPTION_SECRET='sadairaq-session-secret-change-me';
function persistentEncryptionSecret(){
  // A random key is safe as a fallback only when DATA is on durable storage; never claim a
  // release-local key will survive redeployment or encrypt remotely persisted secrets with it.
  if(!DATA_IS_EXTERNAL)return '';
  const file=path.join(DATA,'.sada-encryption-key');
  try{
    fs.mkdirSync(DATA,{recursive:true});
    const existing=String(fs.readFileSync(file,'utf8')||'').trim();
    if(existing.length>=32)return existing;
  }catch(_){}
  try{
    const value=crypto.randomBytes(48).toString('base64url');
    try{fs.writeFileSync(file,value,{encoding:'utf8',flag:'wx',mode:0o600});return value;}
    catch(e){if(e&&e.code==='EEXIST'){const existing=String(fs.readFileSync(file,'utf8')||'').trim();if(existing.length>=32)return existing;}throw e;}
  }catch(e){console.warn('Persistent encryption key unavailable:',String(e.message||e).slice(0,100));return '';}
}
function preferredEncryptionSecret(){
  const dedicated=String(process.env.SADA_ENCRYPTION_KEY||'').trim();
  if(dedicated.length>=32)return dedicated;
  const sessionSecret=String(process.env.SESSION_SECRET||'').trim();
  if(sessionSecret.length>=32 && sessionSecret!=='sadairaq-session-secret-change-me')return sessionSecret;
  // A deliberately configured strong admin password is stable across deploys too. Never
  // use the built-in legacy default as an encryption key.
  const adminSecret=String(process.env.ADMIN_PASSWORD||'').trim();
  if(adminSecret.length>=32 && adminSecret!=='SrIraq!9vQ#4mL7@xK2')return adminSecret;
  return persistentEncryptionSecret();
}
function telegramEncryptionReady(){return !!preferredEncryptionSecret();}
function apiCipherKey(secret){
  const chosen=arguments.length?String(secret||''):String(preferredEncryptionSecret()||process.env.SESSION_SECRET||process.env.ADMIN_PASSWORD||LEGACY_PROVIDER_ENCRYPTION_SECRET);
  return crypto.createHash('sha256').update(chosen).digest();
}
function encryptSecret(plain){
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',apiCipherKey(),iv);
  const enc=Buffer.concat([c.update(String(plain||''),'utf8'),c.final()]);
  const tag=c.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString('base64url');
}
function decryptSecret(blob){
  const b=Buffer.from(String(blob||''),'base64url'); if(b.length<28)return '';
  const iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28);
  const candidates=[apiCipherKey()];
  for(const secret of [process.env.SESSION_SECRET,process.env.ADMIN_PASSWORD,LEGACY_PROVIDER_ENCRYPTION_SECRET,persistentEncryptionSecret()].filter(Boolean)){const key=apiCipherKey(String(secret));if(!candidates.some(existing=>existing.equals(key)))candidates.push(key);}
  for(const key of candidates){try{const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(enc),d.final()]).toString('utf8')}catch(_){}}
  return '';
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
async function firebaseWriteJson(pathname,value,timeoutMs=8000){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{ const u=FIREBASE_DATABASE_URL+'/'+String(pathname).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')+'.json'; const r=await fetch(u,{method:'PUT',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(value),signal:controller.signal}); if(!r.ok) throw new Error('Firebase HTTP '+r.status); return await r.json().catch(()=>value); }
  finally{ clearTimeout(timer); }
}
async function firebaseDeleteJson(pathname,timeoutMs=8000){ return firebaseWriteJson(pathname,null,timeoutMs); }

// Order audit: the Firebase `orders` node is the customer-facing source of truth;
// the server ledger is merged in for orders created through the backend API.
const DEFAULT_ORDER_AUDIT_SETTINGS={delayHours:3,notifyAdmin:true,updatedAt:null};
let ORDER_AUDIT_SNAPSHOT_CACHE={at:0,rows:[],firebaseAvailable:false,firebaseError:'',loaded:false};
let ORDER_AUDIT_MONITOR_RUNNING=false;
function cleanOrderAuditSettings(value={}){
  const delay=Number(value.delayHours??3);
  // Legacy false values had been the old default; enable them once unless the admin explicitly saved the toggle in this schema.
  const notifyAdmin=value.notifyAdminExplicit===true?value.notifyAdmin===true:true;
  return {...DEFAULT_ORDER_AUDIT_SETTINGS,...value,delayHours:Number.isFinite(delay)?Math.max(1,Math.min(72,Math.round(delay))):3,notifyAdmin,notifyAdminExplicit:value.notifyAdminExplicit===true};
}
async function getOrderAuditSettings(){
  const local=readJSON('settings.json',{}).orderAudit||{};
  try{const remote=await firebaseGetJson('config/orderAuditSettings',4500);if(remote&&typeof remote==='object'&&!Array.isArray(remote))return cleanOrderAuditSettings({...local,...remote});}catch(_){}
  return cleanOrderAuditSettings(local);
}
async function saveOrderAuditSettings(value){
  const cfg=cleanOrderAuditSettings(value);cfg.updatedAt=nowISO();
  const local=readJSON('settings.json',{});local.orderAudit=cfg;writeJSON('settings.json',local);
  let firebaseSaved=false,error='';
  try{await firebaseWriteJson('config/orderAuditSettings',cfg,8000);firebaseSaved=true;}catch(e){error=String(e.message||e).slice(0,180)}
  return {settings:cfg,firebaseSaved,localSaved:true,persistent:firebaseSaved||DATA_IS_EXTERNAL,error};
}
function auditTimestamp(value){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value==='number'||/^\d{9,16}$/.test(String(value).trim())){const n=Number(value);if(!Number.isFinite(n))return null;const ms=n<100000000000? n*1000:n;return Number.isFinite(ms)&&ms>0&&ms<8640000000000000?ms:null;}
  const parsed=Date.parse(String(value));return Number.isFinite(parsed)&&parsed>0?parsed:null;
}
function auditOrderTime(order={}){
  for(const key of ['createdAt','created_at','created','timestamp','time','date','orderDate','createdOn']){const ms=auditTimestamp(order[key]);if(ms)return ms;}
  return null;
}
function auditStatus(value){
  const raw=String(value??'').trim();if(!raw)return 'unknown';
  const basic=normalizeProviderStatus(raw);if(basic!=='unknown')return basic;
  const x=raw.toLowerCase().replace(/[\s_-]+/g,' ');
  if(['معلق','قيد الانتظار','بانتظار','انتظار','قيد المعالجة'].includes(x))return 'pending';
  if(['قيد التنفيذ','جاري التنفيذ','قيد التقدم','جاري','تحت التنفيذ','قيد العمل'].includes(x))return 'processing';
  if(['مكتمل','مكتملة','منجز','منجزة','تم التنفيذ','مكتمل جزئياً لا'].includes(x))return 'completed';
  if(['جزئي','مكتمل جزئيا','مكتمل جزئياً','جزئي مكتمل'].includes(x))return 'partial';
  if(['ملغي','ملغى','ملغاة','تم الإلغاء','تم الالغاء'].includes(x))return 'cancelled';
  if(['فشل','فاشل','فاشلة','فشل نهائي','مرفوض'].includes(x))return 'failed';
  if(['مسترد','مسترجع','تم الاسترداد'].includes(x))return 'refunded';
  return 'unknown';
}
function auditTerminalStatus(status){return ['completed','cancelled','failed','refunded','partial'].includes(status);}
function auditPlatform(order={}){
  const source={app:order.serviceApp||order.app||order.platform||'',serviceApp:order.serviceApp||order.app||'',platform:order.platform||'',name:order.serviceName||order.service||order.name||'',serviceName:order.serviceName||order.service||'',category:order.category||'',groups:Array.isArray(order.groups)?order.groups:[]};
  const p=canonicalServicePlatform(source).serviceApp;
  return p==='other'?(String(source.app||source.platform||'أخرى')):p;
}
function auditNormalizeRecord(order={},source='firebase',sourceKey=''){
  const o=order&&typeof order==='object'?order:{};
  const id=String(o.siteOrderId||o.id||o.orderId||o.order_id||o.publicOrderNo||'').trim();
  const providerOrderId=String(o.providerOrderId||o.smmpartyOrderId||o.provider_order_id||o.providerOrderID||o.smmOrderId||'').trim();
  const user=String(o.user||o.username||o.userName||o.customer||'').trim();
  const createdMs=auditOrderTime(o);
  const rawStatus=String(o.status||o.providerStatus||o.smmStatus||'').trim();
  return {
    id,siteOrderId:id,publicOrderNo:String(o.publicOrderNo||id||''),user,
    userName:String(o.userName||o.fullName||o.name||o.customerName||user||'').trim(),
    email:String(o.email||o.userEmail||o.customerEmail||'').trim(),
    serviceName:String(o.serviceName||o.serviceTitle||o.service||o.name||'خدمة').trim(),
    serviceId:String(o.serviceId||o.service_id||o.serviceKey||'').trim(),
    platform:auditPlatform(o),serviceApp:String(o.serviceApp||o.app||o.platform||'').trim(),
    link:String(o.link||o.url||o.target||o.targetUrl||''),quantity:Number(o.quantity??o.qty??0)||0,
    status:auditStatus(rawStatus),rawStatus:rawStatus||'غير مسجلة',createdAt:o.createdAt||o.created_at||o.timestamp||o.date||null,createdMs,
    providerName:String(o.providerName||o.provider||o.smmProviderName||'').trim(),providerId:String(o.providerId||o.provider_id||o.smmProviderId||'').trim(),providerOrderId,amountIQD:Number(o.totalIQD??o.total??o.amountIQD??NaN),
    lastCheckedAt:o.lastCheckedAt||o.lastChecked||o.providerCheckedAt||null,
    updatedAt:o.updatedAt||o.updated_at||o.lastUpdatedAt||null,
    completedAt:o.completedAt||o.completed_at||o.finishedAt||null,
    cancelledAt:o.cancelledAt||o.cancelled_at||o.cancelAt||null,
    cancelReason:String(o.cancelReason||o.cancellationReason||o.failureReason||o.reason||''),
    remains:o.remains??null,startCount:o.startCount??o.start_count??null,refundState:String(o.refundState||''),refundAmountIQD:Number(o.refundAmountIQD||0),
    source, firebaseKey:source==='firebase'?String(sourceKey||''):'',
    legacyHistory:!!o.legacyHistory, readOnly:!!o.readOnly,
    siteLocalId:source==='server'?String(id||''):'',
    amountUsd:Number(o.chargeUsd??o.totalUsd??o.priceUsd??NaN),
    sourceTimestamp:createdMs||0
  };
}
function auditIdentity(row){
  const id=String(row.id||row.publicOrderNo||'').trim(),u=String(row.user||'').trim();
  if(id)return 'id:'+id+'|u:'+u;
  if(row.providerOrderId)return 'provider:'+String(row.providerId||'')+'|'+row.providerOrderId+'|u:'+u;
  return String(row.source||'')+':'+String(row.firebaseKey||row.createdMs||'')+'|u:'+u;
}
async function loadOrderAuditSnapshot(force=false){
  const now=Date.now();if(!force&&ORDER_AUDIT_SNAPSHOT_CACHE.loaded&&now-ORDER_AUDIT_SNAPSHOT_CACHE.at<8000)return ORDER_AUDIT_SNAPSHOT_CACHE;
  const remote=await Promise.allSettled([firebaseGetJson('orders',14000)]);
  const fbOk=remote[0].status==='fulfilled';const fbRoot=fbOk?remote[0].value:null;
  const fbError=fbOk?'':String(remote[0].reason?.message||'تعذر قراءة Firebase').slice(0,180);
  const rawFirebase=[];
  if(fbOk&&fbRoot&&typeof fbRoot==='object'){
    const entries=Array.isArray(fbRoot)?fbRoot.map((v,i)=>[String(i),v]):Object.entries(fbRoot);
    for(const [key,o] of entries){if(!o||typeof o!=='object'||Array.isArray(o)||o.event)continue;const row=auditNormalizeRecord(o,'firebase',key);if(row.id||row.providerOrderId||row.createdMs)rawFirebase.push(row);}
  }
  const local=readJSON('orders.json',[]);const rawLocal=[];
  if(Array.isArray(local))for(const o of local){if(!o||typeof o!=='object'||o.event)continue;const row=auditNormalizeRecord(o,'server',String(o.id||''));if(row.id||row.providerOrderId||row.createdMs)rawLocal.push(row);}
  const merged=new Map();
  // Firebase order records are preferred for current status. Add local-ledger-only fields only if missing.
  for(const row of [...rawFirebase,...rawLocal]){
    const key=auditIdentity(row);const prior=merged.get(key);
    if(!prior){merged.set(key,{...row,_auditSources:[row.source],_firebaseKey:row.firebaseKey||'',_serverOrderId:row.siteLocalId||''});continue;}
    const incomingIsFirebase=row.source==='firebase';const winner=incomingIsFirebase?{...prior,...row}:{...row,...prior};
    for(const [field,value] of Object.entries(row))if((winner[field]===undefined||winner[field]===null||winner[field]===''||winner[field]==='unknown')&&value!==undefined&&value!==null&&value!=='')winner[field]=value;
    winner._auditSources=[...new Set([...(prior._auditSources||[]),row.source])];
    winner._firebaseKey=prior._firebaseKey||row.firebaseKey||'';winner._serverOrderId=prior._serverOrderId||row.siteLocalId||'';
    merged.set(key,winner);
  }
  const providers=providerStore().providers||{};
  const rows=[...merged.values()].map(row=>({...row,providerName:row.providerName||(providers[row.providerId]?.name||''),status:auditStatus(row.status||row.rawStatus)}));
  ORDER_AUDIT_SNAPSHOT_CACHE={at:now,rows,firebaseAvailable:fbOk,firebaseError:fbError,loaded:true};
  return ORDER_AUDIT_SNAPSHOT_CACHE;
}
function auditPublicRecord(row,now=Date.now(),delayHours=3){
  const createdMs=Number(row.createdMs||auditOrderTime(row)||0)||null;const ageMs=createdMs?Math.max(0,now-createdMs):null;const status=auditStatus(row.status||row.rawStatus);
  return {id:String(row.id||''),siteOrderId:String(row.siteOrderId||row.id||''),publicOrderNo:String(row.publicOrderNo||row.id||''),user:String(row.user||''),userName:String(row.userName||row.user||'—'),email:String(row.email||''),serviceName:String(row.serviceName||'خدمة'),serviceId:String(row.serviceId||''),platform:String(row.platform||auditPlatform(row)),serviceApp:String(row.serviceApp||''),link:String(row.link||''),quantity:Number(row.quantity||0),status,rawStatus:String(row.rawStatus||status),createdAt:row.createdAt||null,createdMs,ageMs,overdue:!row.legacyHistory&&!!(ageMs!==null&&ageMs>delayHours*3600000&&!auditTerminalStatus(status)),providerName:String(row.providerName||'—'),providerId:String(row.providerId||''),providerOrderId:String(row.providerOrderId||''),lastCheckedAt:row.lastCheckedAt||null,updatedAt:row.updatedAt||null,completedAt:row.completedAt||null,cancelledAt:row.cancelledAt||null,cancelReason:String(row.cancelReason||''),remains:row.remains??null,startCount:row.startCount??null,amountUsd:Number.isFinite(row.amountUsd)?row.amountUsd:null,source:String(row.source||''),sourceKey:String(row._firebaseKey||row.firebaseKey||''),legacyHistory:!!row.legacyHistory,readOnly:!!row.legacyHistory||!!row.readOnly,sources:Array.isArray(row._auditSources)?row._auditSources:[row.source].filter(Boolean)};
}
function auditPageFilter(rows,params,settings){
  const now=Date.now(),delayMs=settings.delayHours*3600000;
  const view=String(params.view||'overdue');const q=String(params.q||'').trim().toLowerCase();const numberType=String(params.numberType||'site');
  const provider=String(params.provider||'');const platform=String(params.platform||'');const service=String(params.service||'');const status=String(params.status||'');const delay=String(params.delay||'');const range=String(params.range||'7d');const sort=String(params.sort||'newest');
  const rangeMs=range==='today'?86400000:range==='7d'?7*86400000:range==='30d'?30*86400000:Infinity;const cutoff=rangeMs===Infinity?0:now-rangeMs;
  const records=rows.map(r=>auditPublicRecord(r,now,settings.delayHours));
  const inSelectedRange=r=>rangeMs===Infinity?true:(r.createdMs!==null&&r.createdMs>=cutoff);
  const overdue=records.filter(r=>!r.legacyHistory&&r.overdue), completed=records.filter(r=>r.status==='completed'&&inSelectedRange(r)),cancelled=records.filter(r=>r.status==='cancelled'&&inSelectedRange(r));
  const openWithAge=records.filter(r=>!r.legacyHistory&&r.ageMs!==null&&!auditTerminalStatus(r.status));const stats={overdue:overdue.length,over6:openWithAge.filter(r=>r.ageMs>=6*3600000).length,over12:openWithAge.filter(r=>r.ageMs>=12*3600000).length,completed:completed.length,cancelled:cancelled.length};
  let list=records.filter(r=>{
    if(view==='lookup'&&!q)return false;
    if(view==='overdue'&&!r.overdue)return false;
    if(view==='completed'&&r.status!=='completed')return false;
    if(view==='cancelled'&&r.status!=='cancelled')return false;
    if(view==='lookup'){
      if(numberType==='provider'&&String(r.providerOrderId||'').toLowerCase()!==q)return false;
      if(numberType!=='provider'&&String(r.siteOrderId||r.id||'').toLowerCase()!==q)return false;
    } else if(q){const hay=[r.siteOrderId,r.id,r.user,r.userName,r.email,r.serviceName,r.serviceId,r.link,r.providerName,r.providerOrderId,r.platform].join(' ').toLowerCase();if(!hay.includes(q))return false;}
    // A number lookup is authoritative; stale filters from a previous view must not hide an exact match.
    if(view!=='lookup'&&provider&&r.providerId!==provider&&r.providerName!==provider)return false;
    if(view!=='lookup'&&platform&&r.platform.toLowerCase()!==platform.toLowerCase()&&r.serviceApp.toLowerCase()!==platform.toLowerCase())return false;
    if(view!=='lookup'&&service&&r.serviceName!==service&&r.serviceId!==service)return false;
    if(view!=='lookup'&&status&&status!=='all'&&r.status!==status)return false;
    if(view!=='lookup'&&delay){if(!r.overdue)return false;const h=(r.ageMs||0)/3600000;if(delay==='3-6'&&(h<settings.delayHours||h>=6))return false;if(delay==='6-12'&&(h<6||h>=12))return false;if(delay==='12+'&&h<12)return false;}
    if(['completed','cancelled'].includes(view)&&!inSelectedRange(r))return false;
    return true;
  });
  list.sort((a,b)=>sort==='oldest'?Number(a.createdMs||0)-Number(b.createdMs||0):sort==='delay-high'?Number(b.ageMs||0)-Number(a.ageMs||0):Number(b.createdMs||0)-Number(a.createdMs||0));
  const pageSize=Math.min(50,Math.max(5,Number(params.limit)||20));const total=list.length;const totalPages=Math.max(1,Math.ceil(total/pageSize));const page=Math.min(totalPages,Math.max(1,Number(params.page)||1));const start=(page-1)*pageSize;
  const providers=[...new Map(records.filter(x=>x.providerId||x.providerName).map(x=>[x.providerId||x.providerName,{id:x.providerId||x.providerName,name:x.providerName||x.providerId}])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  const platforms=[...new Set(records.map(x=>x.platform).filter(x=>x&&x!=='أخرى'))].sort();
  const services=[...new Set(records.map(x=>x.serviceName).filter(x=>x&&x!=='خدمة'))].sort((a,b)=>a.localeCompare(b)).map(name=>({id:name,name}));
  return {view,page,pageSize,total,totalPages,items:list.slice(start,start+pageSize),stats,settings,providers,platforms,services,source:{firebaseAvailable:ORDER_AUDIT_SNAPSHOT_CACHE.firebaseAvailable,partial:!ORDER_AUDIT_SNAPSHOT_CACHE.firebaseAvailable,firebaseError:ORDER_AUDIT_SNAPSHOT_CACHE.firebaseError},range};
}
async function orderAuditEnrichUsers(items){
  const local=readJSON('users.json',{users:{}}).users||{};
  return await Promise.all(items.map(async item=>{
    if(!item.user)return item;
    let user=local[item.user]||{};
    // A local username/name may exist while the email is only stored in Firebase; fetch when either is missing.
    if((!user.email&&!user.mail)||(!user.fullName&&!user.name)){try{const remote=await firebaseUserByUsername(item.user);if(remote&&typeof remote==='object')user={...remote,...user,email:user.email||user.mail||remote.email||remote.mail||'',fullName:user.fullName||remote.fullName||'',name:user.name||remote.name||''}}catch(_){}}
    return {...item,userName:item.userName&&item.userName!==item.user?item.userName:String(user.fullName||user.name||item.userName||item.user),email:String(item.email||user.email||user.mail||'')};
  }));
}
async function getOrderAuditState(){
  const local=readJSON('order_audit_state.json',{alerts:{}});
  try{const remote=await firebaseGetJson('config/orderAuditState',4500);if(remote&&typeof remote==='object'&&!Array.isArray(remote))return {...local,...remote,alerts:{...(local.alerts||{}),...(remote.alerts||{})}};}catch(_){}
  return local;
}
async function saveOrderAuditState(state){
  writeJSON('order_audit_state.json',state);try{await firebaseWriteJson('config/orderAuditState',state,6000);return true}catch(_){return DATA_IS_EXTERNAL;}
}
async function runOrderAuditMonitor(){
  if(ORDER_AUDIT_MONITOR_RUNNING)return;ORDER_AUDIT_MONITOR_RUNNING=true;
  try{
    const cfg=await getOrderAuditSettings();if(!cfg.notifyAdmin)return;
    const tg=telegramConfig();if(!tg.enabled||!tg.token||!tg.overdueChat)return;
    const snap=await loadOrderAuditSnapshot(true);if(!snap.firebaseAvailable)return;
    const now=Date.now(),state=await getOrderAuditState(),alerts={...(state.alerts||{})};let changed=false;
    // Escalation levels are fixed at 3/6/12 hours; the dashboard's configurable filter remains separate.
    const rows=snap.rows.map(r=>auditPublicRecord(r,now,cfg.delayHours)).filter(r=>!r.legacyHistory&&Number(r.ageMs||0)>=3*3600000&&!auditTerminalStatus(r.status)).sort((a,b)=>b.ageMs-a.ageMs).slice(0,150);
    const levels=[{h:3,label:'🟠 إنذار أول — تأخير 3 ساعات',kind:'warning'},{h:6,label:'🔴 إنذار مرتفع — تأخير 6 ساعات',kind:'danger'},{h:12,label:'🚨 خطر حرج — تأخير 12 ساعة',kind:'critical'}];
    const work=[];
    for(const o of rows){const key=String(o.siteOrderId||o.id||o.providerOrderId||'');if(!key)continue;const old=alerts[key];const known={...(old&&typeof old==='object'?old:{}),levels:{...(old?.levels||{})}};if(old?.sentAt&&!known.levels['3'])known.levels['3']={sentAt:old.sentAt,status:old.status||''};for(const level of levels){if(Number(o.ageMs||0)>=level.h*3600000&&!known.levels[String(level.h)])work.push({o,key,level});}}
    for(const task of work.slice(0,12)){
      const {o,key,level}=task;
      // Re-read the latest entry per task so alerts for 3, 6 and 12 hours accumulate together.
      const old=alerts[key];const item={...(old&&typeof old==='object'?old:{}),levels:{...(old?.levels||{})}};if(old?.sentAt&&!item.levels['3'])item.levels['3']={sentAt:old.sentAt,status:old.status||''};if(item.levels[String(level.h)])continue;
      const hours=(Number(o.ageMs||0)/3600000).toFixed(1);
      const text=`${level.label} — صدى العراق
🆔 رقم الطلب: #${o.siteOrderId||o.id}
👤 المستخدم: ${o.userName||o.user||'—'}
📦 الخدمة: ${o.serviceName||'—'}
🌐 المنصة: ${o.platform||'—'}
🔗 الرابط: ${o.link||'—'}
🔢 الكمية: ${Number(o.quantity||0).toLocaleString('en-US')}
🏷️ المزوّد: ${o.providerName||'—'}
🔢 رقم المزود: ${o.providerOrderId||'غير متوفر'}
📊 الحالة: ${o.rawStatus||o.status}
⏱️ مدة الانتظار: ${hours} ساعة
يرجى فحص الطلب واتخاذ الإجراء المناسب.`;
      const sent=await notifyTelegramRecipients(text,{channel:'overdue',kind:'order_audit_'+level.kind,orderId:key});
      if(sent.ok){item.levels[String(level.h)]={sentAt:nowISO(),status:o.status};item.status=o.status;item.updatedAt=nowISO();alerts[key]=item;changed=true;await saveOrderAuditState({alerts:{...alerts},updatedAt:nowISO()});}
    }
    const entries=Object.entries(alerts).sort((a,b)=>Date.parse(b[1]?.updatedAt||b[1]?.sentAt||0)-Date.parse(a[1]?.updatedAt||a[1]?.sentAt||0)).slice(0,3000);
    if(changed)await saveOrderAuditState({alerts:Object.fromEntries(entries),updatedAt:nowISO()});
  }catch(e){console.warn('order audit monitor error:',String(e.message||e).slice(0,180));}finally{ORDER_AUDIT_MONITOR_RUNNING=false;}
}

async function firebasePatchJson(pathname,value,timeoutMs=12000){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const u=FIREBASE_DATABASE_URL+'/'+String(pathname).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')+'.json';const r=await fetch(u,{method:'PATCH',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(value),signal:controller.signal});if(!r.ok)throw new Error('Firebase HTTP '+r.status);return await r.json().catch(()=>value)}finally{clearTimeout(timer)}
}
// Firebase compare-and-swap: prevents concurrent refund/balance updates from overwriting each other.
async function firebaseTransaction(pathname,mutator,timeoutMs=9000,maxRetries=6){
  const url=FIREBASE_DATABASE_URL+'/'+String(pathname).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')+'.json';
  for(let attempt=0;attempt<maxRetries;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    let current,etag;
    try{
      const get=await fetch(url,{headers:{'Accept':'application/json','X-Firebase-ETag':'true'},signal:controller.signal});
      if(!get.ok)throw new Error('Firebase transaction GET HTTP '+get.status);
      current=await get.json();etag=get.headers.get('etag')||get.headers.get('ETag');
      if(!etag)throw new Error('Firebase لم يرجع ETag؛ أوقفنا تعديل الرصيد لمنع التكرار');
    }finally{clearTimeout(timer)}
    const decision=await mutator(current);
    if(!decision||decision.write===false)return {ok:true,changed:false,value:current,result:decision?.result||{}};
    const controller2=new AbortController(),timer2=setTimeout(()=>controller2.abort(),timeoutMs);
    try{
      const put=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','Accept':'application/json','If-Match':etag},body:JSON.stringify(decision.value),signal:controller2.signal});
      if(put.status===412)continue;
      if(!put.ok)throw new Error('Firebase transaction PUT HTTP '+put.status);
      const value=await put.json().catch(()=>decision.value);
      return {ok:true,changed:true,value,result:decision.result||{}};
    }finally{clearTimeout(timer2)}
  }
  throw new Error('تعذر تثبيت التعديل بسبب تغيّر الرصيد بالتزامن؛ أعد المحاولة');
}
function refundIdentity(order={}){return sha256(String(order.user||order.username||'')+'|'+String(order.id||order.siteOrderId||order.orderId||'')+'|'+String(order.providerId||'')+'|'+String(order.providerOrderId||'' )).slice(0,40)}
async function resolveFinancialOrder(order={}){
  const id=String(order.id||order.siteOrderId||order.orderId||'');const username=String(order.user||order.username||'');const pid=String(order.providerId||'');const po=String(order.providerOrderId||order.smmpartyOrderId||'');
  const rows=readJSON('orders.json',[]);
  const local=Array.isArray(rows)?rows.find(x=>x&&!x.event&&((id&&String(x.id||x.localId||'')===id&&(!username||String(x.user||'')===username))||(po&&String(x.providerOrderId||x.smmpartyOrderId||'')===po&&(!pid||String(x.providerId||'')===pid)&&(!username||String(x.user||'')===username)))):null;
  if(local)return {...order,...local};
  const fbKey=String(order._firebaseKey||order.firebaseKey||'');
  if(fbKey){try{const remote=await firebaseGetJson('orders/'+fbKey,5000);if(remote&&typeof remote==='object')return {...order,...remote,_firebaseKey:fbKey};}catch(_){}}
  if(po){try{const root=await firebaseGetJson('orders',7000);if(root&&typeof root==='object'){for(const [key,v] of Object.entries(root)){if(!v||typeof v!=='object')continue;if(String(v.providerOrderId||v.smmpartyOrderId||v.provider_order_id||'')===po&&(!pid||String(v.providerId||v.provider_id||'')===pid)&&(!username||String(v.user||v.username||'')===username))return {...order,...v,_firebaseKey:key};}}}catch(_){}}
  return {...order};
}
function refundChargeIQD(order={}){
  for(const k of ['totalIQD','chargeIqd','amountIQD','total','amountIqd']){const n=Number(order[k]);if(Number.isFinite(n)&&n>0)return Math.round(n*10000)/10000;}
  for(const k of ['chargeUsd','totalUsd','amountUsd','priceUsd']){const n=Number(order[k]);if(Number.isFinite(n)&&n>0)return Math.round(n*FIXED_RATE*10000)/10000;}
  return 0;
}
async function applyVerifiedOrderRefund(inputOrder={},providerData={},normalizedStatus=''){
  const order=await resolveFinancialOrder(inputOrder);
  const status=normalizeProviderStatus(normalizedStatus||providerData.status||providerData.smmStatus||order.status||'');
  if(!['cancelled','partial'].includes(status))return {ok:true,credited:false,state:'not-eligible',reason:'status-not-refundable'};
  const user=String(order.user||order.username||'').trim();if(!user)return {ok:false,credited:false,state:'pending',reason:'missing-user'};
  if(providerData.refund_confirmed===false||providerData.refunded===false||/^(pending|processing|failed|rejected)$/i.test(String(providerData.refund_status||providerData.refundStatus||'')))return {ok:true,credited:false,state:'pending',reason:'provider-refund-not-confirmed'};
  const charged=refundChargeIQD(order);if(!(charged>0))return {ok:true,credited:false,state:'pending',reason:'missing-charge-amount'};
  let target=charged;
  if(status==='partial'){
    const quantity=Number(order.quantity||order.qty||0);
    const remainsVal=providerData.remains??providerData.remaining??order.remains;
    const remains=Number(remainsVal);
    if(!Number.isFinite(quantity)||quantity<=0||remainsVal===undefined||remainsVal===null||String(remainsVal).trim()===''||!Number.isFinite(remains)||remains<0||remains>quantity)return {ok:true,credited:false,state:'pending',reason:'partial-status-without-reliable-remains'};
    if(remains===0){
      const rows=readJSON('orders.json',[]);let changed=false;
      if(Array.isArray(rows)){for(let i=0;i<rows.length;i++){const x=rows[i];if(!x||x.event)continue;const sameId=String(order.id||order.siteOrderId||'')&&String(x.id||x.localId||'')===String(order.id||order.siteOrderId||'')&&String(x.user||'')===user;const sameProvider=String(order.providerOrderId||order.smmpartyOrderId||'')&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(order.providerOrderId||order.smmpartyOrderId||'')&&String(x.user||'')===user;if(sameId||sameProvider){rows[i]={...x,refundState:'no_refund_due',refundLastUpdatedAt:nowISO()};changed=true;}}}
      if(changed)writeJSON('orders.json',rows);
      const fbKey=String(order._firebaseKey||order.firebaseKey||'');if(fbKey){try{await firebasePatchJson('orders/'+fbKey,{refundState:'no_refund_due',refundLastUpdatedAt:nowISO()},5000)}catch(_){}}
      return {ok:true,credited:false,state:'no-refund-due',reason:'provider-reports-zero-undelivered-quantity'};
    }
    target=Math.round(charged*Math.max(0,Math.min(1,remains/quantity))*10000)/10000;
  }
  const key=refundIdentity(order);const userPath='users/'+firebaseSafeKey(user);let transaction;
  try{
    transaction=await firebaseTransaction(userPath,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
      const refunds=current.sadaRefunds&&typeof current.sadaRefunds==='object'?{...current.sadaRefunds}:{};
      const old=refunds[key]&&typeof refunds[key]==='object'?refunds[key]:{};
      const previous=Math.max(0,Number(old.totalIQD||old.refundedIQD||0)||0);
      const cumulative=Math.min(charged,Math.max(previous,target));const delta=Math.round((cumulative-previous)*10000)/10000;
      if(delta<=0)return {write:false,result:{credited:false,state:'already-credited',totalRefundIQD:previous,balanceIQD:Number(current.balance||0)}};
      const before=Number(current.balance||0);const after=Math.round((before+delta)*10000)/10000;const at=nowISO();
      const event={id:sha256(key+'|'+cumulative).slice(0,32),orderId:String(order.id||order.siteOrderId||order.orderId||''),providerOrderId:String(order.providerOrderId||order.smmpartyOrderId||''),providerId:String(order.providerId||''),serviceName:String(order.serviceName||order.name||order.service||'خدمة'),serviceId:String(order.serviceId||''),status,quantity:Number(order.quantity||order.qty||0),remains:providerData.remains??order.remains??null,amountIQD:delta,totalRefundIQD:cumulative,amountUSD:Number((delta/FIXED_RATE).toFixed(6)),reason:status==='cancelled'?'استرداد بعد تأكيد إلغاء الطلب من المزود':'استرداد الجزء غير المنفذ بعد تأكيد الحالة الجزئية من المزود',createdAt:at};
      const events=Array.isArray(old.events)?old.events.slice(-50):[];events.push(event);
      refunds[key]={key,orderId:event.orderId,providerOrderId:event.providerOrderId,providerId:event.providerId,serviceName:event.serviceName,status,totalIQD:cumulative,amountUSD:Number((cumulative/FIXED_RATE).toFixed(6)),events,updatedAt:at};
      current.balance=after;current.sadaRefunds=refunds;current.updatedAt=at;
      return {write:true,value:current,result:{credited:true,deltaIQD:delta,totalRefundIQD:cumulative,balanceIQD:after,event}};
    });
  }catch(e){return {ok:false,credited:false,state:'pending',reason:'firebase-balance-update-failed',error:String(e.message||e).slice(0,180)}}
  if(transaction.result?.error)return {ok:false,credited:false,state:'pending',reason:transaction.result.error};
  if(transaction.result?.credited){
    const ev=transaction.result.event;const refunds=readJSON('refunds.json',[]);if(Array.isArray(refunds)&&!refunds.some(x=>x.id===ev.id)){refunds.push({...ev,user});writeJSON('refunds.json',refunds.slice(-10000));}
    appendJsonLedger('balance_ledger.json',{user,type:'refund',amountUSD:ev.amountUSD,amountIQD:ev.amountIQD,after:transaction.result.balanceIQD,reason:ev.reason,admin:'system-provider-status',reference:ev.orderId,providerOrderId:ev.providerOrderId,createdAt:ev.createdAt,refundEventId:ev.id});
    const local=readJSON('orders.json',[]);let changed=false;if(Array.isArray(local)){for(let i=0;i<local.length;i++){const x=local[i];if(!x||x.event)continue;const sameId=ev.orderId&&String(x.id||x.localId||'')===ev.orderId&&String(x.user||'')===user;const sameProvider=ev.providerOrderId&&String(x.providerOrderId||x.smmpartyOrderId||'')===ev.providerOrderId&&String(x.user||'')===user;if(sameId||sameProvider){local[i]={...x,refundState:'credited',refundAmountIQD:transaction.result.totalRefundIQD,refundLastUpdatedAt:ev.createdAt};changed=true;}}}if(changed)writeJSON('orders.json',local);
  }
  const result=transaction.result||{};const settledState=result.error?'pending':(result.credited||result.state==='already-credited'?'credited':'pending');
  if(settledState==='credited'){
    const stamp=nowISO();const localRows=readJSON('orders.json',[]);let touched=false;if(Array.isArray(localRows)){for(let i=0;i<localRows.length;i++){const x=localRows[i];if(!x||x.event)continue;const sameId=String(order.id||order.siteOrderId||'')&&String(x.id||x.localId||'')===String(order.id||order.siteOrderId||'')&&(!user||String(x.user||'')===user);const samePo=String(order.providerOrderId||order.smmpartyOrderId||'')&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(order.providerOrderId||order.smmpartyOrderId||'')&&(!user||String(x.user||'')===user);if(sameId||samePo){localRows[i]={...x,refundState:'credited',refundAmountIQD:Number(result.totalRefundIQD||target),refundLastUpdatedAt:stamp};touched=true;}}}if(touched)writeJSON('orders.json',localRows);
    const fbKey=String(order._firebaseKey||order.firebaseKey||'');if(fbKey){try{await firebasePatchJson('orders/'+fbKey,{refundState:'credited',refundAmountIQD:Number(result.totalRefundIQD||target),refundLastUpdatedAt:stamp},5000)}catch(_) {}}
  }
  return {ok:true,credited:!!result.credited,state:result.state|| (result.credited?'credited':settledState),amountIQD:Number(result.deltaIQD||0),totalRefundIQD:Number(result.totalRefundIQD||target),balanceIQD:Number(result.balanceIQD??transaction.value?.balance??0),currency:'IQD',reason:result.reason||''};
}
async function syncVerifiedOrderStatus(order,providerData,normalizedStatus){
  const normalized=normalizeProviderStatus(normalizedStatus||providerData?.status||'');const update={providerStatus:String(providerData?.status||providerData?.data?.status||''),lastCheckedAt:nowISO(),updatedAt:nowISO()};
  if(normalized!=='unknown')update.status=normalized;if(providerData?.remains!==undefined)update.remains=providerData.remains;if(providerData?.start_count!==undefined||providerData?.startCount!==undefined)update.startCount=providerData.start_count??providerData.startCount;
  const full=await resolveFinancialOrder(order);const rows=readJSON('orders.json',[]);let localChanged=false;for(let i=0;i<rows.length;i++){const x=rows[i];if(!x||x.event)continue;const match=(full.id&&String(x.id||x.localId||'')===String(full.id)&&String(x.user||'')===String(full.user||''))||(full.providerOrderId&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(full.providerOrderId)&&String(x.user||'')===String(full.user||''));if(match){rows[i]={...x,...update};localChanged=true;}}
  if(localChanged)writeJSON('orders.json',rows);
  const fbKey=String(full._firebaseKey||full.firebaseKey||'');if(fbKey){try{await firebasePatchJson('orders/'+fbKey,update,7000)}catch(_) {}}
  let refund=null;if(['cancelled','partial'].includes(normalized))refund=await applyVerifiedOrderRefund({...full,...update},providerData,normalized);
  const old=normalizeProviderStatus(full.status||'');if(normalized!=='unknown'&&old!==normalized)notifyOrderStatusChange({...full,...update},old,normalized).catch(()=>{});
  return {order:{...full,...update},refund};
}
async function runRefundReconciliationMonitor(){
  if(runRefundReconciliationMonitor.running)return;runRefundReconciliationMonitor.running=true;
  try{
    const snapshot=await loadOrderAuditSnapshot(true);if(!snapshot.rows?.length)return;const now=Date.now();let examined=0;
    const candidates=snapshot.rows.filter(r=>r.providerId&&r.providerOrderId&&(['pending','processing'].includes(r.status)||(['cancelled','partial'].includes(r.status)&&!['credited','no_refund_due'].includes(String(r.refundState||''))))&&(!r.lastCheckedAt||now-(auditTimestamp(r.lastCheckedAt)||0)>180000)).sort((a,b)=>Number(a.createdMs||0)-Number(b.createdMs||0)).slice(0,12);
    for(const row of candidates){if(examined++>=12)break;try{const full=await resolveFinancialOrder(row);await ensureProviderRuntime(row.providerId);const prov=getProviderById(row.providerId,{allowSingleFallback:false}).prov;if(!prov?.url||!prov?.key)continue;const d=await providerRequest(prov,{action:'status',order:String(row.providerOrderId)},15000);const normalized=normalizeProviderStatus(d?.status??d?.data?.status??d?.result?.status??'');if(normalized==='unknown')continue;await syncVerifiedOrderStatus(full,d,normalized);}catch(e){console.warn('refund/order status monitor:',String(e.message||e).slice(0,120));}}
  }catch(e){console.warn('refund reconciliation monitor:',String(e.message||e).slice(0,160));}finally{runRefundReconciliationMonitor.running=false;}
}

const DEFAULT_GLOBAL_PRICING={markupPct:50,autoSync:true,intervalHours:1,lastAttemptAt:null,lastSuccessAt:null,lastUpdatedAt:null,lastResult:null,lastError:''};
function cleanGlobalPricing(v={}){
  const pct=Number(v.markupPct??v.markup??DEFAULT_GLOBAL_PRICING.markupPct);
  const interval=Number(v.intervalHours??DEFAULT_GLOBAL_PRICING.intervalHours);
  return {...DEFAULT_GLOBAL_PRICING,...v,markupPct:Number.isFinite(pct)?Math.max(0,Math.min(1000,pct)):50,autoSync:v.autoSync!==false,intervalHours:[1,3,6,12,24].includes(interval)?interval:1};
}
function localGlobalPricing(){const settings=readJSON('settings.json',{});return cleanGlobalPricing(settings.pricing||{});}
async function getGlobalPricing(){
  const local=localGlobalPricing();
  try{const remote=await firebaseGetJson('config/pricing',4500);if(remote&&typeof remote==='object'&&!Array.isArray(remote)){const r=cleanGlobalPricing(remote);const lt=Date.parse(local.lastUpdatedAt||'')||0,rt=Date.parse(r.lastUpdatedAt||'')||0;return rt>=lt?r:local;}}catch(_){}
  return local;
}
async function saveGlobalPricing(v){
  const p=cleanGlobalPricing(v);p.lastUpdatedAt=nowISO();p.lastError='';
  const settings=readJSON('settings.json',{});settings.pricing=p;writeJSON('settings.json',settings);
  let persistedRemotely=false,remoteError='';
  try{await firebaseWriteJson('config/pricing',p,9000);persistedRemotely=true}catch(e){remoteError=String(e.message||e).slice(0,180)}
  return {pricing:p,persistedRemotely,remoteError};
}
function validRateField(s,keys){
  for(const k of keys){const v=s?.[k];if(v===undefined||v===null||String(v).trim()==='')continue;const n=Number(String(v).replace(/,/g,''));if(Number.isFinite(n)&&n>=0)return n;}return null;
}
function providerServiceKey(s){for(const k of ['providerServiceId','smmpartyId','sourceServiceId','provider_service_id','serviceId','service_id']){const v=s?.[k];if(v!==undefined&&v!==null&&String(v).trim()!=='')return String(v).trim()}return ''}
function providerServiceRate(s){return validRateField(s,['rate','rate_usd','rateUsd','usd_rate','usdRate','rate_per_1000','ratePer1000','price_per_1000','pricePer1000'])}
function catalogRate(s){return validRateField(s,['providerRateUsd','smmRateUsd','baseProviderRateUsd','smmRate','provider_rate_usd'])}
function pricedPatch(s,base,pct){const sell=Number((base*(1+pct/100)).toFixed(8));return {sellingUsd:sell,price:Number((sell*FIXED_RATE).toFixed(6)),basePrice:Number((base*FIXED_RATE).toFixed(6)),providerRateUsd:base,smmRateUsd:base,smmRate:base,markupPct:pct,priceSyncedAt:nowISO()}}
// Firebase REST multi-path PATCH: write nested field paths, never replace the entire service object.
function appendServicePricePatch(out,key,values){for(const [field,value] of Object.entries(values))out[String(key)+'/'+field]=value;}
async function applyCachedGlobalMarkup(pct){
  const root=await firebaseGetJson('services',18000);if(!root||typeof root!=='object'||Array.isArray(root))return {updated:0,skipped:0};
  const patch={};let updated=0,skipped=0;const localServices=readJSON('api_services.json',[]);let localUpdated=0;
  for(const [key,s] of Object.entries(root)){
    if(!s||typeof s!=='object')continue;const pid=String(s.providerId||'').trim(),sid=providerServiceKey(s);if(!pid||!sid){skipped++;continue}const base=catalogRate(s);if(base===null){skipped++;continue}
    const priced=pricedPatch(s,base,pct);appendServicePricePatch(patch,key,priced);updated++;
    for(const a of localServices){if(pid&&String(a.providerId||'')!==pid)continue;if(sid&&String(a.providerServiceId||a.id||'')!==sid)continue;if(!sid&&!pid)continue;Object.assign(a,priced,{rateUsd:priced.sellingUsd,rate:priced.sellingUsd});localUpdated++}
  }
  if(updated)await firebasePatchJson('services',patch,20000);
  if(localUpdated)writeJSON('api_services.json',localServices);
  return {updated,skipped,localUpdated};
}
let GLOBAL_PRICE_SYNC_RUNNING=false;
async function runProviderPriceSync(options={}){
  if(GLOBAL_PRICE_SYNC_RUNNING)return {ok:false,busy:true,updated:0,errors:['مزامنة أخرى قيد التنفيذ']};
  GLOBAL_PRICE_SYNC_RUNNING=true;
  let cfg=await getGlobalPricing();cfg.lastAttemptAt=nowISO();const settings=readJSON('settings.json',{});settings.pricing=cfg;writeJSON('settings.json',settings);
  const result={ok:true,updated:0,skipped:0,providers:0,providerErrors:[],localUpdated:0};
  try{
    const root=await firebaseGetJson('services',22000);if(!root||typeof root!=='object'||Array.isArray(root))throw new Error('تعذر قراءة كتالوج الخدمات من قاعدة البيانات');
    const rows=Object.entries(root).filter(([k,v])=>v&&typeof v==='object');
    const providerIds=[...new Set(rows.map(([,v])=>String(v.providerId||'').trim()).filter(Boolean))];
    if(!providerIds.length){result.ok=false;result.providerErrors.push('لا توجد خدمات مرتبطة بمزود وسعر تكلفة محفوظ');}
    const pct=cleanGlobalPricing(cfg).markupPct;
    const allPatches={};const localServices=readJSON('api_services.json',[]);let localUpdated=0;
    for(const pid of providerIds.slice(0,20)){
      try{
        await ensureProviderRuntime(pid);const found=getProviderById(pid,{allowSingleFallback:false});if(!found.prov?.url||!found.prov?.key)throw new Error('بيانات المزود غير متوفرة');
        const raw=normalizeProviderServices(await providerRequest(found.prov,{action:'services'},22000));
        if(!raw.length)throw new Error('المزود لم يرجع قائمة خدمات');
        const byId=new Map();for(const r of raw){const id=String(r?.service??r?.service_id??r?.serviceId??r?.id??r?.serviceID??'').trim();if(id)byId.set(id,r)}
        let pUpdated=0;
        for(const [key,svc] of rows){if(String(svc.providerId||'')!==pid)continue;const sid=providerServiceKey(svc);if(!sid){result.skipped++;continue}const latest=byId.get(sid);if(!latest){result.skipped++;continue}const base=providerServiceRate(latest);if(base===null){result.skipped++;continue}const oldBase=catalogRate(svc);if(base===0&&oldBase!==null&&oldBase>0){result.skipped++;result.providerErrors.push(pid+' الخدمة '+sid+': تجاهلنا سعراً صفرياً غير متوقع حتى لا تتحول خدمة مدفوعة إلى مجانية');continue}const priced=pricedPatch(svc,base,pct);appendServicePricePatch(allPatches,key,priced);pUpdated++;result.updated++;
          for(const a of localServices){if(String(a.providerId||'')===pid&&String(a.providerServiceId||a.id||'')===sid){Object.assign(a,priced,{rateUsd:priced.sellingUsd,rate:priced.sellingUsd});localUpdated++}}
        }
        result.providers++;if(!pUpdated)result.providerErrors.push(pid+': لم تتم مطابقة معرّفات الخدمات');
      }catch(e){result.ok=false;result.providerErrors.push(pid+': '+String(e.message||e).slice(0,160))}
    }
    if(Object.keys(allPatches).length)await firebasePatchJson('services',allPatches,24000);
    if(localUpdated)writeJSON('api_services.json',localServices);result.localUpdated=localUpdated;
    cfg=localGlobalPricing();cfg.lastAttemptAt=nowISO();cfg.lastResult={updated:result.updated,skipped:result.skipped,providers:result.providers,localUpdated:result.localUpdated};cfg.lastError=result.providerErrors.join(' | ').slice(0,700);if(result.updated>0){cfg.lastSuccessAt=nowISO();}else if(!result.providerErrors.length){cfg.lastError='لم يتم العثور على خدمات مطابقة للتحديث'};
    const st=readJSON('settings.json',{});st.pricing=cfg;writeJSON('settings.json',st);try{await firebaseWriteJson('config/pricing',cfg,7000)}catch(_){}
    result.pricing=cfg;return result;
  }catch(e){result.ok=false;result.providerErrors.push(String(e.message||e).slice(0,180));const st=readJSON('settings.json',{});const p=cleanGlobalPricing(st.pricing||{});p.lastAttemptAt=nowISO();p.lastError=result.providerErrors.join(' | ').slice(0,700);st.pricing=p;writeJSON('settings.json',st);try{await firebaseWriteJson('config/pricing',p,5000)}catch(_){}return result;
  }finally{GLOBAL_PRICE_SYNC_RUNNING=false}
}
function startGlobalPriceSyncScheduler(){
  const runIfDue=async()=>{try{const p=await getGlobalPricing();if(!p.autoSync)return;const last=Date.parse(p.lastAttemptAt||p.lastSuccessAt||'')||0;const gap=Math.max(1,p.intervalHours)*3600000;if(Date.now()-last<gap)return;await runProviderPriceSync({automatic:true})}catch(e){console.error('Sada pricing scheduler:',String(e.message||e))}};
  const t=setInterval(runIfDue,10*60*1000);t.unref();const first=setTimeout(runIfDue,120000);first.unref();
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
let TELEGRAM_CHANNELS_REMOTE={};
function readTelegramStoredSecret(settings){
  const tg=settings?.telegram&&typeof settings.telegram==='object'?settings.telegram:{};
  if(tg.tokenEncrypted){if(!telegramEncryptionReady()&&!String(process.env.TELEGRAM_BOT_TOKEN||'').trim()){console.warn('Stored Telegram token is paused because a local encryption key could not be read or created.');return '';}const plain=decryptSecret(tg.tokenEncrypted);if(plain)return plain;}
  // Migrate legacy plaintext only when a stable key can protect it at rest.
  if(tg.token){if(!telegramEncryptionReady()){console.warn('Legacy Telegram token migration paused because an encryption key could not be read or created.');return '';}try{tg.tokenEncrypted=encryptSecret(String(tg.token));delete tg.token;settings.telegram=tg;writeJSON('settings.json',settings);return decryptSecret(tg.tokenEncrypted)||'';}catch(e){console.warn('Telegram token migration failed:',String(e.message||e).slice(0,100));}}
  return '';
}
function telegramConfig(){
  const settings=readJSON('settings.json',{});const cfg=settings.telegram||{};
  const envToken=String(process.env.TELEGRAM_BOT_TOKEN||'').trim();
  const storedToken=readTelegramStoredSecret(settings);
  const legacyChat=String(process.env.TELEGRAM_CHAT_ID||cfg.chat||'@jbhbhg58').trim();
  const activationEnv=String(process.env.TELEGRAM_ACTIVATION_CHAT_ID||'').trim();
  const overdueEnv=String(process.env.TELEGRAM_OVERDUE_CHAT_ID||'').trim();
  const activationChat=String(activationEnv||cfg.activationChat||TELEGRAM_CHANNELS_REMOTE.activationChat||legacyChat).trim();
  const overdueChat=String(overdueEnv||cfg.overdueChat||TELEGRAM_CHANNELS_REMOTE.overdueChat||'').trim();
  const envToggle=String(process.env.TELEGRAM_NOTIFICATIONS_ENABLED||'').trim();
  const enabled=envToggle ? envToggle.toLowerCase()!=='false' : (TELEGRAM_CHANNELS_REMOTE.enabled!==undefined?TELEGRAM_CHANNELS_REMOTE.enabled!==false:cfg.enabled!==false);
  const extra=(String(process.env.TELEGRAM_EXTRA_CHAT_IDS||'').trim()||'').split(',').map(x=>x.trim()).filter(Boolean);
  return {enabled,token:String(envToken||storedToken||'').trim(),chat:activationChat,activationChat,overdueChat,activationEnvLocked:!!activationEnv,overdueEnvLocked:!!overdueEnv,extraChats:[...new Set(extra)].filter(x=>x!==activationChat&&x!==overdueChat)};
}
async function hydrateTelegramChannelsFromFirebase(){
  let any=false;
  try{const remote=await firebaseGetJson('config/telegramChannels',3500);if(remote&&typeof remote==='object'&&!Array.isArray(remote)){TELEGRAM_CHANNELS_REMOTE={activationChat:String(remote.activationChat||''),overdueChat:String(remote.overdueChat||''),enabled:remote.enabled!==undefined?remote.enabled:undefined,updatedAt:remote.updatedAt||null};const settings=readJSON('settings.json',{});settings.telegram=settings.telegram||{};if(!process.env.TELEGRAM_ACTIVATION_CHAT_ID&&TELEGRAM_CHANNELS_REMOTE.activationChat&&!settings.telegram.activationChat)settings.telegram.activationChat=TELEGRAM_CHANNELS_REMOTE.activationChat;if(!process.env.TELEGRAM_OVERDUE_CHAT_ID&&TELEGRAM_CHANNELS_REMOTE.overdueChat&&!settings.telegram.overdueChat)settings.telegram.overdueChat=TELEGRAM_CHANNELS_REMOTE.overdueChat;if(process.env.TELEGRAM_NOTIFICATIONS_ENABLED===undefined&&TELEGRAM_CHANNELS_REMOTE.enabled!==undefined)settings.telegram.enabled=TELEGRAM_CHANNELS_REMOTE.enabled;writeJSON('settings.json',settings);any=true}}catch(e){console.warn('Telegram channel hydration skipped:',String(e.message||e).slice(0,120))}
  try{if(!process.env.TELEGRAM_BOT_TOKEN){const secret=await firebaseGetJson('config/telegramSecret',3500);if(secret&&typeof secret.tokenEncrypted==='string'&&secret.tokenEncrypted){const settings=readJSON('settings.json',{});settings.telegram=settings.telegram||{};if(!settings.telegram.tokenEncrypted){settings.telegram.tokenEncrypted=secret.tokenEncrypted;delete settings.telegram.token;writeJSON('settings.json',settings);}any=true;}}}catch(e){console.warn('Telegram encrypted secret hydration skipped:',String(e.message||e).slice(0,120))}
  return any;
}
function telegramLog(entry){
  const arr=readJSON('telegram_notifications.json',[]);
  arr.push({...entry,createdAt:entry.createdAt||nowISO()});
  writeJSON('telegram_notifications.json',arr.slice(-300));
}
async function telegramRequest(method,payload,timeoutMs=8000){
  const cfg=telegramConfig();
  if(!cfg.enabled) return {ok:false,skipped:true,error:'إشعارات القناة غير مفعلة'};
  if(!cfg.token||(method!=='getMe'&&!String(payload?.chat_id||cfg.chat||'').trim())) return {ok:false,error:'Bot Token أو Chat ID غير محفوظ'};
  const apiBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(`${apiBase}/bot${encodeURIComponent(cfg.token)}/${method}`,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch(_){d={description:text};}
    return {ok:!!(r.ok&&d.ok===true),status:r.status,description:String(d.description||''),messageId:d.result?.message_id||null,raw:r.ok?undefined:redactSecretObject(d)};
  }catch(e){return {ok:false,error:e?.name==='AbortError'?'انتهت مهلة Telegram':String(e?.message||e)};}
  finally{clearTimeout(timer);}
}
async function telegramTestConnection(){const r=await telegramRequest('getMe',{});telegramLog({kind:'connection_test',ok:r.ok,status:r.status,description:r.description||r.error||'',messageId:r.messageId||null});return r;}
async function sendTelegramDetailed(text,meta={}){
  const cfg=telegramConfig();
  const caption=String(text||'').slice(0,1024);
  let r;
  const targetChat=String(meta.chatId||cfg.chat||'').trim();
  if(!targetChat)return {ok:false,error:'معرّف قناة Telegram غير مضبوط'};
  const imagePath=path.join(ROOT,'telegram-notification.png');
  if(cfg.enabled!==false && cfg.token && targetChat && fs.existsSync(imagePath)){
    const apiBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
    let photoError='';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const fd=new FormData();
      fd.append('chat_id',targetChat);
      fd.append('photo',new Blob([fs.readFileSync(imagePath)],{type:'image/png'}),'telegram-notification.png');
      fd.append('caption',caption);
      const rr=await fetch(`${apiBase}/bot${encodeURIComponent(cfg.token)}/sendPhoto`,{method:'POST',body:fd,signal:controller.signal});
      const tx=await rr.text();let dd={};try{dd=tx?JSON.parse(tx):{}}catch(_){dd={description:tx};}
      r={ok:!!(rr.ok&&dd.ok===true),status:rr.status,description:String(dd.description||''),messageId:dd.result?.message_id||null,raw:rr.ok?undefined:redactSecretObject(dd)};
      if(!r.ok)photoError=r.description||'لم يؤكد Telegram إرسال الصورة.';
    }catch(e){photoError=e?.name==='AbortError'?'انتهت مهلة إرسال الصورة إلى Telegram':String(e?.message||e);r={ok:false,error:photoError};}
    finally{clearTimeout(timer)}
    // Network failure and rejected photo uploads both fall back to a real text-message call.
    if(!r.ok){
      const fallback=await telegramRequest('sendMessage',{chat_id:targetChat,text:caption,disable_web_page_preview:true});
      if(fallback.ok)r={...fallback,description:'تم إرسال النص بعد تعذر إرسال الصورة'+(photoError?' — '+photoError:'')};
      else r={...fallback,ok:false,error:fallback.error||fallback.description||photoError||'فشل إرسال الرسالة النصية أيضاً',description:fallback.description||photoError||''};
    }
  }else{
    r=await telegramRequest('sendMessage',{chat_id:targetChat,text:caption,disable_web_page_preview:true});
  }
  telegramLog({kind:meta.kind||'message',ok:r.ok,status:r.status,description:r.description||r.error||'',messageId:r.messageId||null,orderId:meta.orderId||null,media:r.ok&&String(r.description||'').includes('تم إرسال النص')?'text-fallback':'photo-or-text'});
  return r;
}
async function notifyTelegramRecipients(text,meta={}){
  const cfg=telegramConfig();const channel=String(meta.channel||'activation');
  const primaryChat=channel==='overdue'?cfg.overdueChat:(cfg.activationChat||cfg.chat);
  if(!cfg.enabled||!cfg.token||!primaryChat)return {ok:false,error:channel==='overdue'?'قناة الطلبات المتأخرة غير مضبوطة':'إعدادات قناة التفعيلات غير مكتملة'};
  const targets=channel==='overdue'?[primaryChat]:[...new Set([primaryChat,...(cfg.extraChats||[])])];const results=[];
  for(const chatId of targets){const r=await sendTelegramDetailed(text,{...meta,chatId});results.push({chatId,ok:!!r.ok,error:r.error||r.description||''});}
  const primary=results.find(x=>x.chatId===primaryChat);const ok=!!primary?.ok;return {ok,results,description:ok?'تم إرسال الإشعار إلى القناة المحددة':results.map(x=>`${x.chatId}: ${x.error}`).join(' | ')};
}
async function sendTelegram(text){return (await notifyTelegramRecipients(text,{kind:'message'})).ok;}

function telegramOrderIdentity(o={}){const id=String(o.id||o.siteOrderId||o.orderId||o.publicOrderNo||'').trim();const user=String(o.user||o.username||o.userName||'').trim();if(id)return 'id:'+id+'|u:'+user;const po=String(o.providerOrderId||o.provider_order_id||o.smmpartyOrderId||'').trim();if(po)return 'provider:'+String(o.providerId||o.provider_id||'')+'|'+po+'|u:'+user;return String(o.source||'')+':'+String(o._firebaseKey||o.firebaseKey||o.createdMs||'')+'|u:'+user;}
function telegramOrderMessage(o={}){return `🆕 طلب جديد — صدى العراق\n🆔 رقم الطلب الداخلي: #${o.id||o.siteOrderId||o.orderId||'غير متوفر'}\n👤 المستخدم: ${o.userName||o.user||o.username||'—'}\n📦 الخدمة: ${o.serviceName||o.name||'خدمة'}\n🌐 المنصة: ${o.serviceApp||o.platform||o.app||'—'}\n🔗 الرابط: ${o.link||o.url||'—'}\n🔢 الكمية: ${Number(o.quantity||o.qty||0).toLocaleString('en-US')}\n💰 السعر: $${Number(o.chargeUsd??o.unitSellingUsd??o.priceUsd??0).toFixed(4)}\n🏷️ المزوّد: ${o.providerName||o.provider||o.providerId||'—'}\n🔢 رقم طلب المزوّد: ${o.providerOrderId||o.smmpartyOrderId||o.provider_order_id||'غير متوفر'}\n📊 الحالة: ${o.status||'pending'}\n🕐 الإنشاء: ${o.createdAt||nowISO()}`;}
async function readTelegramOrderState(){
  const local=readJSON('telegram_order_state.json',{initialized:false,seen:{}});let remote={};
  try{const d=await firebaseGetJson('config/telegramOrderState',4000);if(d&&typeof d==='object'&&!Array.isArray(d))remote=d}catch(_){}
  return {...remote,...local,initialized:!!(remote.initialized||local.initialized),seen:{...(remote.seen||{}),...(local.seen||{})}};
}
async function persistTelegramOrderState(state){
  const safe={initialized:!!state.initialized,seen:state.seen&&typeof state.seen==='object'?state.seen:{},updatedAt:nowISO()};
  const compact=Object.fromEntries(Object.entries(safe.seen).sort((a,b)=>Date.parse(b[1]?.sentAt||b[1]?.baselineAt||0)-Date.parse(a[1]?.sentAt||a[1]?.baselineAt||0)).slice(0,5000));safe.seen=compact;writeJSON('telegram_order_state.json',safe);try{await firebaseWriteJson('config/telegramOrderState',safe,5000);return true}catch(_){return DATA_IS_EXTERNAL;}
}
async function notifyTelegramNewOrder(o,meta={}){
  const key=telegramOrderIdentity(o);if(!key)return {ok:false,error:'رقم الطلب غير متوفر'};
  const result=await notifyTelegramRecipients(telegramOrderMessage(o),{kind:'new_order',orderId:String(o.id||o.siteOrderId||''),...meta});
  if(result.ok){const st=await readTelegramOrderState();st.seen=st.seen||{};st.seen[key]={sentAt:nowISO(),source:meta.source||'backend'};await persistTelegramOrderState(st);}return result;
}
async function runTelegramNewOrdersMonitor(){
  if(TELEGRAM_ORDER_MONITOR_RUNNING)return;TELEGRAM_ORDER_MONITOR_RUNNING=true;
  try{
    const tg=telegramConfig();if(!tg.enabled||!tg.token||!tg.chat)return;
    const snap=await loadOrderAuditSnapshot(true);if(!snap.firebaseAvailable&&(!snap.rows||!snap.rows.length))return;
    const st=await readTelegramOrderState(),seen={...(st.seen||{})};
    const now=Date.now();
    if(!st.initialized){
      // Prevent an old-order flood on the first deploy, but don't silently skip orders created just now.
      const recent=[];
      for(const row of (snap.rows||[])){const key=auditIdentity(row);if(!key)continue;if(row.legacyHistory){seen[key]=seen[key]||{baselineAt:nowISO(),source:'legacy-history'};continue;}const age=Number(row.createdMs||0)>0?now-Number(row.createdMs):Infinity;if(age<=10*60*1000&&!seen[key])recent.push(row);else seen[key]=seen[key]||{baselineAt:nowISO()};}
      await persistTelegramOrderState({initialized:true,seen});
      for(const row of recent.slice(0,25)){const key=auditIdentity(row);const r=await notifyTelegramNewOrder({...row,id:row.siteOrderId||row.id||'',_firebaseKey:row._firebaseKey||row.firebaseKey||'',source:row.source||''},{source:'monitor-first-scan'});if(r.ok)seen[key]={sentAt:nowISO(),source:'monitor-first-scan'};}
      if(recent.length)await persistTelegramOrderState({initialized:true,seen});
      return;
    }
    const fresh=(snap.rows||[]).filter(row=>{const key=auditIdentity(row);return !row.legacyHistory&&key&&!seen[key]}).sort((a,b)=>Number(a.createdMs||0)-Number(b.createdMs||0)).slice(0,25);
    for(const row of fresh){const key=auditIdentity(row);const siteId=String(row.siteOrderId||row.id||'');createUserNotification(row.user||row.username,{type:'order_created',orderId:siteId,status:String(row.status||'pending'),title:'تم استلام طلبك #'+siteId,message:'تم استلام طلب '+siteId+' لخدمة '+String(row.serviceName||'خدمة')+'، وسيتم تحديث الحالة هنا.',meta:{serviceName:String(row.serviceName||'خدمة'),quantity:Number(row.quantity||0),providerName:String(row.providerName||''),providerOrderId:String(row.providerOrderId||'')}});const r=await notifyTelegramNewOrder({...row,id:siteId,_firebaseKey:row._firebaseKey||row.firebaseKey||'',source:row.source||''},{source:'monitor'});if(r.ok)seen[key]={sentAt:nowISO(),source:'monitor'};}
    if(fresh.length&&Object.keys(seen).length)await persistTelegramOrderState({initialized:true,seen});
  }catch(e){console.warn('Telegram new-order monitor:',String(e.message||e).slice(0,180))}finally{TELEGRAM_ORDER_MONITOR_RUNNING=false;}
}
let TELEGRAM_ORDER_MONITOR_RUNNING=false;

async function notifyOrderStatusChange(order, oldStatus, newStatus){
  if(!order || String(oldStatus||'')===String(newStatus||'')) return false;
  const labels={processing:'قيد التنفيذ',completed:'مكتمل',partial:'مكتمل جزئياً',cancelled:'ملغي',failed:'فشل',refunded:'تم الاسترداد',pending:'قيد الانتظار'};
  const orderId=String(order.id||order.siteOrderId||order.localId||'');
  createUserNotification(order.user||order.username,{type:'order_status',orderId,status:newStatus,title:'تحديث حالة طلبك #'+orderId,message:'الخدمة: '+String(order.serviceName||'خدمة')+' · الكمية: '+Number(order.quantity||0).toLocaleString('ar-IQ')+' · الحالة الجديدة: '+(labels[newStatus]||newStatus),meta:{serviceName:String(order.serviceName||'خدمة'),quantity:Number(order.quantity||0),providerName:String(order.providerName||''),providerOrderId:String(order.providerOrderId||'')}});
  const msg=`تحديث حالة طلب
🆔 رقم الطلب: #${orderId}
👤 المستخدم: ${order.user||'—'}
📦 الخدمة: ${order.serviceName||'—'}
🔢 الكمية: ${Number(order.quantity||0).toLocaleString('en-US')}
💰 السعر: $${Number(order.chargeUsd||Number(order.total||0)/FIXED_RATE).toFixed(2)}
📊 الحالة: ${labels[newStatus]||newStatus}
🕐 الوقت: ${new Date().toLocaleString('en-GB',{hour12:false})}`;
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
        if(p===pid && (!providerServiceId || providerServiceId===sid)) return {id:providerServiceId||sid,fbId:fkey,name:String(fb.name||'خدمة'),category:String(fb.category||((fb.groups||[])[0]||'عام')),app:String(fb.app||fb.serviceApp||(Array.isArray(fb.apps)?fb.apps[0]:'')||(Array.isArray(fb.platforms)?fb.platforms[0]:'Other')),apps:Array.isArray(fb.apps)?fb.apps:[],platforms:Array.isArray(fb.platforms)?fb.platforms:[],groups:Array.isArray(fb.groups)?fb.groups:[],categories:Array.isArray(fb.categories)?fb.categories:[],description:String(fb.desc||''),providerCategory:String(fb.providerCategory||''),sellingUsd:Number(fb.sellingUsd??0),rateUsd:Number(fb.sellingUsd??fb.smmRateUsd??fb.rateUsd??(Number(fb.price||0)/FIXED_RATE)),min:Number(fb.min||100),max:Number(fb.max||10000),providerId:p,providerServiceId:providerServiceId||sid,smmRateUsd:Number(fb.smmRateUsd||fb.rate||0),refill:!!fb.refill,cancel:!!fb.cancel};
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

function canonicalServicePlatform(s={}){
  const raw=[s.app,s.serviceApp,s.platform,...(Array.isArray(s.apps)?s.apps:[]),...(Array.isArray(s.platforms)?s.platforms:[]),s.name,s.serviceName,s.description,s.providerCategory,...(Array.isArray(s.groups)?s.groups:[]),...(Array.isArray(s.categories)?s.categories:[]),s.category].filter(Boolean).join(' ').toLowerCase();
  const defs=[['instagram',['instagram','انستغرام','انستجرام','انستا']],['tiktok',['tiktok','tik tok','تيك توك','تيكتوك']],['facebook',['facebook','فيسبوك','فيس بوك']],['youtube',['youtube','يوتيوب']],['telegram',['telegram','تلجرام','تيليجرام','تليجرام']],['twitter',['twitter','تويتر','x.com']],['snapchat',['snapchat','سناب']],['whatsapp',['whatsapp','واتساب']],['linkedin',['linkedin','لينكد']]];
  for(const [key,terms] of defs)if(terms.some(term=>raw.includes(term)))return {serviceApp:key,image:'/platform-icons/'+key+'.svg',platformIcon:'/platform-icons/'+key+'.svg'};
  return {serviceApp:'other',image:'/platform-icons/other.svg',platformIcon:'/platform-icons/other.svg'};
}
function calcApiChargeUsd(s,qty,user){
  const pct=Math.max(0,Math.min(100,Number(user?.discountPct)||0));
  const total=Math.max(0,Number(qty)/1000*Number(s.sellingUsd||s.rateUsd||s.rate||0)*(1-pct/100));
  return {pct,total:Number(total.toFixed(6))};
}
function baghdadDateKey(value){
  const d=value instanceof Date?value:new Date(value||0);if(!Number.isFinite(d.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const m={};for(const p of parts)m[p.type]=p.value;return `${m.year}-${m.month}-${m.day}`;
}
function baghdadWeekStartKey(date=new Date()){
  const key=baghdadDateKey(date);if(!key)return '';const [y,m,d]=key.split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));const days=(dt.getUTCDay()+6)%7;dt.setUTCDate(dt.getUTCDate()-days);return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}
function statsSnapshot(range='all',ordersOverride=null){
  const allOrders=Array.isArray(ordersOverride)?ordersOverride:readJSON('orders.json',[]);const reset=readJSON('stats_state.json',{resetAt:null}).resetAt;const now=new Date();const todayKey=baghdadDateKey(now),weekStart=baghdadWeekStartKey(now),monthStart=todayKey.slice(0,7)+'-01',resetKey=reset?baghdadDateKey(reset):'';
  const kept=(Array.isArray(allOrders)?allOrders:[]).filter(o=>o&&!o.event&&(!reset||new Date(o.createdAt||0)>new Date(reset)));
  const list=kept.filter(o=>{const key=baghdadDateKey(o.createdAt);if(!key)return false;if(range==='today')return key===todayKey;if(range==='7d')return key>=weekStart&&key<=todayKey;if(range==='month')return key>=monthStart&&key<=todayKey;return true;});
  const metrics=rows=>{let sales=0,cost=0;for(const o of rows){const sale=Number(o.chargeUsd!==undefined?o.chargeUsd:(Number(o.total||0)/FIXED_RATE));const providerCost=Number(o.providerCostUsd!==undefined?o.providerCostUsd:(Number(o.providerRateUsd||o.smmRateUsd||0)*Number(o.quantity||0)/1000));sales+=Number.isFinite(sale)?sale:0;cost+=Number.isFinite(providerCost)?providerCost:0;}return {orders:rows.length,salesUsd:Number(sales.toFixed(6)),providerCostUsd:Number(cost.toFixed(6)),profitUsd:Number((sales-cost).toFixed(6)),profitMarginPct:sales>0?Number(((sales-cost)/sales*100).toFixed(2)):0};};
  const counts={total:0,today:0,completed:0,processing:0,pending:0,cancelled:0,failed:0,refunded:0,partial:0};const services={},users={},profits={};
  for(const o of list){counts.total++;const st=normalizeProviderStatus(o.status||'pending');if(st in counts)counts[st]++;if(baghdadDateKey(o.createdAt)===todayKey)counts.today++;const sale=Number(o.chargeUsd!==undefined?o.chargeUsd:(Number(o.total||0)/FIXED_RATE));const providerCost=Number(o.providerCostUsd!==undefined?o.providerCostUsd:(Number(o.providerRateUsd||o.smmRateUsd||0)*Number(o.quantity||0)/1000));const sn=String(o.serviceName||o.serviceId||'خدمة');services[sn]=(services[sn]||0)+1;profits[sn]=(profits[sn]||0)+(Number.isFinite(sale)?sale:0)-(Number.isFinite(providerCost)?providerCost:0);const un=String(o.user||o.username||'');users[un]=(users[un]||0)+1;}
  const vals=list.map(o=>Number(o.chargeUsd!==undefined?o.chargeUsd:Number(o.total||0)/FIXED_RATE)).filter(Number.isFinite);const serviceMost=Object.entries(services).sort((a,b)=>b[1]-a[1])[0]||null,userMost=Object.entries(users).sort((a,b)=>b[1]-a[1])[0]||null,profitMost=Object.entries(profits).sort((a,b)=>b[1]-a[1])[0]||null;
  const todayRows=kept.filter(o=>baghdadDateKey(o.createdAt)===todayKey),weekRows=kept.filter(o=>{const k=baghdadDateKey(o.createdAt);return k>=weekStart&&k<=todayKey;});const rangeMetrics=metrics(list),todayMetrics=metrics(todayRows),weekMetrics=metrics(weekRows);
  return {counts,...rangeMetrics,salesUsd:rangeMetrics.salesUsd,providerCostUsd:rangeMetrics.providerCostUsd,profitUsd:rangeMetrics.profitUsd,profitMarginPct:rangeMetrics.profitMarginPct,ordersToday:todayMetrics.orders,ordersWeek:weekMetrics.orders,salesTodayUsd:todayMetrics.salesUsd,salesWeekUsd:weekMetrics.salesUsd,costTodayUsd:todayMetrics.providerCostUsd,costWeekUsd:weekMetrics.providerCostUsd,profitTodayUsd:todayMetrics.profitUsd,profitWeekUsd:weekMetrics.profitUsd,highestOrderUsd:vals.length?Math.max(...vals):0,lowestOrderUsd:vals.length?Math.min(...vals):0,mostOrderedService:serviceMost?.[0]||null,mostOrderingUser:userMost?.[0]||null,highestProfitService:profitMost?{name:profitMost[0],profitUsd:Number(Number(profitMost[1]).toFixed(6))}:null,resetAt:reset||null,source:'local-or-merged',todayDate:todayKey,weekStartDate:weekStart};
}

function stableOrderCountIdentity(o,key=''){
  if(!o||typeof o!=='object'||Array.isArray(o)||o.event)return '';
  const user=String(o.user||o.username||o.userName||'').trim();
  if(o.legacyHistory&&o.legacyImportKey!==undefined&&o.legacyImportKey!==null&&String(o.legacyImportKey).trim())return 'legacy:'+String(o.legacyImportKey).trim();
  const id=String(o.id||o.siteOrderId||o.orderId||o.order_id||o.publicOrderNo||'').trim();
  if(id)return 'order:'+user+':'+id;
  const provider=String(o.providerOrderId||o.provider_order_id||o.smmpartyOrderId||'').trim();
  if(provider)return 'provider:'+user+':'+String(o.providerId||o.provider_id||'')+':'+provider;
  const stamp=String(o.createdAt||o.created_date||o.createdMs||'');
  if(user&&(stamp||o.serviceId||o.serviceName))return 'fallback:'+user+':'+stamp+':'+String(o.serviceId||o.serviceName||'')+':'+String(o.quantity||'');
  return key?'key:'+String(key):'';
}
function uniqueActualOrders(remoteOrders,localOrders=[]){
  const map=new Map();
  for(const [i,o] of collectionEntries(localOrders)){const id=stableOrderCountIdentity(o,'local-'+i);if(id)map.set(id,o);}
  for(const [k,o] of collectionEntries(remoteOrders)){const id=stableOrderCountIdentity(o,k);if(id)map.set(id,{...(map.get(id)||{}),...o});}
  return [...map.values()];
}

const MATH_CAPTCHA_CHALLENGES=new Map();
function issueMathCaptcha(req){
  const now=Date.now();for(const [k,v] of MATH_CAPTCHA_CHALLENGES)if(v.expiresAt<now)MATH_CAPTCHA_CHALLENGES.delete(k);while(MATH_CAPTCHA_CHALLENGES.size>5000)MATH_CAPTCHA_CHALLENGES.delete(MATH_CAPTCHA_CHALLENGES.keys().next().value);
  const a=crypto.randomInt(1,8),b=crypto.randomInt(1,8),captchaId=crypto.randomBytes(18).toString('hex');MATH_CAPTCHA_CHALLENGES.set(captchaId,{answer:String(a+b),ip:clientIp(req),expiresAt:now+5*60*1000});return {captchaId,question:`${a} + ${b} = ؟`};
}
function consumeMathCaptcha(req,b){
  const id=String(b?.captchaId||''),answer=String(b?.captchaAnswer??'').trim(),challenge=MATH_CAPTCHA_CHALLENGES.get(id);if(id)MATH_CAPTCHA_CHALLENGES.delete(id);
  if(!challenge||challenge.expiresAt<Date.now())return 'انتهى سؤال التحقق؛ حدّث السؤال وحاول مجدداً.';if(challenge.ip!==clientIp(req))return 'تغير اتصالك أثناء التحقق؛ حدّث السؤال وحاول مجدداً.';if(!/^\d{1,2}$/.test(answer)||!safeEqual(answer,challenge.answer))return 'ناتج الجمع غير صحيح؛ حاول مرة أخرى.';return '';
}
let googleOAuthClientCached=null,googleOAuthClientAudience='';
function requestHasSameOrigin(req){
  const origin=String(req.headers.origin||'').trim();const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();
  if(!origin||!host)return false;try{const u=new URL(origin);return ['https:','http:'].includes(u.protocol)&&u.host.toLowerCase()===host;}catch(_){return false;}
}
function getGoogleOAuthClient(){const clientId=String(process.env.GOOGLE_CLIENT_ID||'').trim();if(!clientId)return null;if(!googleOAuthClientCached||googleOAuthClientAudience!==clientId){const {OAuth2Client}=require('google-auth-library');googleOAuthClientCached=new OAuth2Client(clientId);googleOAuthClientAudience=clientId;}return {client:googleOAuthClientCached,clientId};}
function cleanGoogleUser(user={}){const out={...user};delete out.password;delete out.passwordHash;delete out.googleSub;return out;}
async function googleAuthLogin(credential){
  const config=getGoogleOAuthClient();if(!config)throw Object.assign(new Error('تسجيل Google غير مفعّل بعد؛ أضف GOOGLE_CLIENT_ID من Google Cloud إلى متغيرات Railway.'),{statusCode:503});
  const ticket=await config.client.verifyIdToken({idToken:String(credential||''),audience:config.clientId});const payload=ticket.getPayload()||{};
  if(!payload.sub||!payload.email||payload.email_verified!==true)throw Object.assign(new Error('تعذر تأكيد هوية Google أو البريد الإلكتروني غير موثق.'),{statusCode:401});
  const sub=String(payload.sub),email=String(payload.email).trim().toLowerCase(),mapKey=sha256(sub);let accounts=readJSON('google_accounts.json',{}),usersStore=readJSON('users.json',{users:{}}),users=usersStore.users||{},username=String(accounts[mapKey]?.username||'');
  if(!username){try{const remoteMap=await firebaseGetJson('config/googleAccounts/'+mapKey,3500);if(remoteMap?.username)username=String(remoteMap.username)}catch(_){}}
  let user=username?users[username]:null;if(!user&&username){try{const remoteUser=await firebaseGetJson('users/'+firebaseSafeKey(username),3500);if(remoteUser&&typeof remoteUser==='object'){user=remoteUser;users[username]=user;}}catch(_){}}
  if(!user){const found=Object.entries(users).find(([n,u])=>u&&u.role!=='admin'&&(String(u.googleSub||'')===sub||(String(u.email||'').toLowerCase()===email&&u.emailVerified===true)));if(found){username=found[0];user=found[1];}}
  let created=false;if(!user){const local=email.split('@')[0].replace(/[^a-zA-Z0-9_]/g,'_').replace(/^_+|_+$/g,'').slice(0,16)||'googleuser';let base=local;let suffix=sub.slice(-5).replace(/[^a-zA-Z0-9]/g,'')||crypto.randomBytes(3).toString('hex');username=base;if(username===ADMIN_USER||users[username])username=(base.slice(0,10)+'_'+suffix).slice(0,20);let n=2;while(users[username]||username===ADMIN_USER){username=(base.slice(0,15)+'_'+suffix+n).slice(0,24);n++;if(n>100)throw new Error('تعذر إنشاء اسم مستخدم فريد');}
    user={name:String(payload.name||local).slice(0,100),email,emailVerified:true,googleSub:sub,authProvider:'google',picture:String(payload.picture||''),passwordHash:'',balance:0,level:'مبتدئ',telegram:'',phone:'',joined:nowISO(),totalSpent:0,totalOrders:0,role:'user'};created=true;
  }else{if(user.role==='admin'&&!user.googleSub)throw Object.assign(new Error('هذا الحساب الإداري لا يمكن ربطه تلقائياً بتسجيل Google.'),{statusCode:403});user={...user,email, emailVerified:true,googleSub:sub,authProvider:'google',name:String(user.name||payload.name||username).slice(0,100),picture:String(payload.picture||user.picture||''),updatedAt:nowISO()};}
  usersStore.users=users;users[username]=user;usersStore.users[username]=user;accounts[mapKey]={username,email,provider:'google',updatedAt:nowISO()};
  writeJSON('users.json',usersStore);writeJSON('google_accounts.json',accounts);let firebaseSaved=false,firebaseError='';
  try{const profile={username,name:user.name,email,emailVerified:true,authProvider:'google',picture:user.picture||'',balance:Number(user.balance||0),level:user.level||'مبتدئ',telegram:String(user.telegram||''),phone:String(user.phone||''),joined:user.joined||nowISO(),totalSpent:Number(user.totalSpent||0),totalOrders:Number(user.totalOrders||0),role:'user'};await firebaseWriteJson('users/'+firebaseSafeKey(username),profile,7000);await firebaseWriteJson('config/googleAccounts/'+mapKey,{username,email,updatedAt:nowISO()},7000);firebaseSaved=true;}catch(e){firebaseError=String(e.message||e);}
  if(created&&!firebaseSaved&&!DATA_IS_EXTERNAL){delete usersStore.users[username];delete accounts[mapKey];writeJSON('users.json',usersStore);writeJSON('google_accounts.json',accounts);throw Object.assign(new Error('تعذر حفظ الحساب في قاعدة بيانات دائمة؛ تحقق من اتصال Firebase أو اربط Railway Volume ثم أعد المحاولة.'),{statusCode:503});}
  const sessionToken='';return {username,user,sessionToken,firebaseSaved,firebaseError};
}


// -------------------- Private legacy-database import (v1.5.76) --------------------
// The ZIP is uploaded by an authenticated administrator. Personal data is staged only
// under DATA (never in the public project folder or Git source), then orders are merged
// with stable keys into the live Firebase orders node. Existing live orders are not replaced.
const LEGACY_STAGE_FILE = 'legacy_import_staging.json';
const LEGACY_USERS_PRIVATE_FILE = 'legacy_import_users_private.json';
const LEGACY_IMPORT_STATE_FILE = 'legacy_import_state.json';
const LEGACY_IMPORT_CONFIRM = 'IMPORT_LEGACY_DATABASE_1_5_76';
const LEGACY_IMPORT_MAX_ZIP_BYTES = 18 * 1024 * 1024;
const ZIP_CRC32_TABLE = (()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
function zipCrc32(buffer){let c=0xFFFFFFFF;for(let i=0;i<buffer.length;i++)c=ZIP_CRC32_TABLE[(c^buffer[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
async function readRawRequestBuffer(req,limit=LEGACY_IMPORT_MAX_ZIP_BYTES){const parts=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>limit)throw Object.assign(new Error('حجم ملف ZIP أكبر من الحد المسموح (18 ميجابايت).'),{statusCode:413});parts.push(chunk);}return Buffer.concat(parts,total);}
function readZipArchive(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<22)throw new Error('ملف ZIP غير صالح أو فارغ.');
  const sigEOCD=Buffer.from([0x50,0x4b,0x05,0x06]);let eocd=-1;const min=Math.max(0,buffer.length-65557);
  for(let i=buffer.length-22;i>=min;i--){if(buffer[i]===0x50&&buffer[i+1]===0x4b&&buffer[i+2]===0x05&&buffer[i+3]===0x06){eocd=i;break;}}
  if(eocd<0)throw new Error('لم يتم العثور على فهرس ZIP صالح.');
  const disk=buffer.readUInt16LE(eocd+4),cdDisk=buffer.readUInt16LE(eocd+6),entriesOnDisk=buffer.readUInt16LE(eocd+8),totalEntries=buffer.readUInt16LE(eocd+10),cdSize=buffer.readUInt32LE(eocd+12),cdOffset=buffer.readUInt32LE(eocd+16);
  if(disk!==0||cdDisk!==0||entriesOnDisk!==totalEntries||totalEntries>2000||cdOffset+cdSize>eocd)throw new Error('صيغة ZIP متعددة الأقراص أو ZIP64 غير مدعومة. أعد إنشاء ملف ZIP القياسي.');
  const entries={};let pos=cdOffset,totalUncompressed=0;
  for(let n=0;n<totalEntries;n++){
    if(pos+46>buffer.length||buffer.readUInt32LE(pos)!==0x02014b50)throw new Error('فهرس ZIP تالف.');
    const flags=buffer.readUInt16LE(pos+8),method=buffer.readUInt16LE(pos+10),expectedCrc=buffer.readUInt32LE(pos+16),compressedSize=buffer.readUInt32LE(pos+20),uncompressedSize=buffer.readUInt32LE(pos+24),nameLen=buffer.readUInt16LE(pos+28),extraLen=buffer.readUInt16LE(pos+30),commentLen=buffer.readUInt16LE(pos+32),localOffset=buffer.readUInt32LE(pos+42);
    const name=buffer.subarray(pos+46,pos+46+nameLen).toString('utf8');pos+=46+nameLen+extraLen+commentLen;
    if(!name||name.startsWith('/')||name.split(/[\\/]/).includes('..'))throw new Error('ملف ZIP يحتوي على مسار غير آمن.');
    if(name.endsWith('/'))continue;
    if(flags&1)throw new Error('ملفات ZIP المشفرة بكلمة مرور غير مدعومة.');
    if(uncompressedSize>12*1024*1024)throw new Error('أحد ملفات ZIP أكبر من الحد المسموح.');
    totalUncompressed+=uncompressedSize;if(totalUncompressed>30*1024*1024)throw new Error('إجمالي الملفات بعد فك الضغط أكبر من الحد المسموح.');
    if(localOffset+30>buffer.length||buffer.readUInt32LE(localOffset)!==0x04034b50)throw new Error('رأس ملف داخلي في ZIP تالف.');
    const localNameLen=buffer.readUInt16LE(localOffset+26),localExtraLen=buffer.readUInt16LE(localOffset+28),dataStart=localOffset+30+localNameLen+localExtraLen,dataEnd=dataStart+compressedSize;
    if(dataEnd>buffer.length)throw new Error('بيانات أحد ملفات ZIP غير مكتملة.');
    const compressed=buffer.subarray(dataStart,dataEnd);let output;
    if(method===0)output=Buffer.from(compressed);else if(method===8)output=zlib.inflateRawSync(compressed,{maxOutputLength:12*1024*1024});else throw new Error('طريقة ضغط ZIP غير مدعومة: '+method);
    if(output.length!==uncompressedSize||zipCrc32(output)!==expectedCrc)throw new Error('فشل التحقق من سلامة الملف داخل ZIP: '+name);
    entries[name.replace(/\\/g,'/')]=output;
  }
  return entries;
}
function parseLegacyJsonEntry(entries,name){const key=Object.keys(entries).find(k=>k===name||k.endsWith('/'+name));if(!key)throw new Error('ملف ZIP لا يحتوي على '+name);try{return JSON.parse(entries[key].toString('utf8'));}catch(_){throw new Error('ملف '+name+' ليس JSON صالحاً.');}}
function assertUniqueIds(rows,label){if(!Array.isArray(rows))throw new Error('قائمة '+label+' ليست مصفوفة.');const ids=new Set();for(const row of rows){const id=String(row?.id??'').trim();if(!id)throw new Error('يوجد سجل بلا معرّف في '+label+'.');if(ids.has(id))throw new Error('يوجد معرّف مكرر في '+label+'.');ids.add(id);}return ids;}
function normalizeLegacyBalance(value){const n=Number(value);return Number.isFinite(n)?n:0;}
function legacyUserPrivateRow(u){return {id:String(u?.id||''),email:normalizeEmail(u?.email||''),full_name:String(u?.full_name||'').slice(0,160),arabic_name:String(u?.arabic_name||'').slice(0,160),user_code:String(u?.user_code||''),balance:normalizeLegacyBalance(u?.balance),created_date:String(u?.created_date||''),updated_date:String(u?.updated_date||'')};}
function legacyOrderPrivateRow(o){return {id:String(o?.id||''),order_number:String(o?.order_number||''),user_id:String(o?.user_id||''),user_name:String(o?.user_name||''),service_id:String(o?.service_id||''),service_name:String(o?.service_name||'خدمة'),platform_name:String(o?.platform_name||''),provider_id:String(o?.provider_id||''),provider_name:String(o?.provider_name||''),provider_order_id:String(o?.provider_order_id||''),quantity:Number(o?.quantity||0)||0,link:String(o?.link||''),total_price:Number(o?.total_price||0)||0,cost:Number(o?.cost||0)||0,status:String(o?.status||'new'),provider_status:String(o?.provider_status||''),is_free:!!o?.is_free,start_count:o?.start_count??null,remains:o?.remains??null,created_date:String(o?.created_date||''),updated_date:String(o?.updated_date||'')};}
function legacyStableFirebaseKey(id){return 'legacy_'+sha256(String(id||'')).slice(0,32);}
function legacyAliasUser(id){return 'legacy_'+sha256(String(id||'unknown')).slice(0,12);}
function legacyStatus(value){const v=String(value||'').trim().toLowerCase().replace(/[\\s-]+/g,'_');const map={new:'pending',pending:'pending',waiting:'pending',processing:'processing',in_progress:'processing',completed:'completed',complete:'completed',partial:'partial',canceled:'cancelled',cancelled:'cancelled',refunded:'refunded',error:'failed',failed:'failed'};return map[v]||'pending';}
function collectionEntries(value){if(Array.isArray(value))return value.map((v,i)=>[String(i),v]);if(value&&typeof value==='object')return Object.entries(value);return [];}
function normalizeCurrentUsers(root){const users=[];const emailMap=new Map(),nameMap=new Map();for(const [key,raw] of collectionEntries(root)){if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;const username=String(raw.username||decodeFirebaseSafeKey(key)||key).trim();if(!username)continue;const item={key,username,user:raw,email:normalizeEmail(raw.email||raw.mail||raw.emailAddress||'')};users.push(item);if(item.email){const arr=emailMap.get(item.email)||[];arr.push(item);emailMap.set(item.email,arr);}const n=username.toLowerCase();const arr=nameMap.get(n)||[];arr.push(item);nameMap.set(n,arr);}return {users,emailMap,nameMap};}
function mapLegacyUsersToCurrent(legacyUsers,currentDirectory){const byLegacyId=new Map(),matchedIds=new Set();for(const old of legacyUsers){let match=null;const email=normalizeEmail(old.email||'');const emailRows=email?currentDirectory.emailMap.get(email)||[]:[];if(emailRows.length===1)match=emailRows[0];else if(emailRows.length>1)match=null;if(!match&&old.user_code){const candidates=currentDirectory.nameMap.get(String(old.user_code).trim().toLowerCase())||[];if(candidates.length===1)match=candidates[0];}if(match){byLegacyId.set(String(old.id),match);matchedIds.add(String(old.id));}else byLegacyId.set(String(old.id),null);}return {byLegacyId,matchedIds};}
function legacyPublicOrderNumber(old,duplicateOrderNumbers,liveNumbers,allocatedNumbers){const n=String(old.order_number||'').trim();if(n&&duplicateOrderNumbers.get(n)===1&&!liveNumbers.has(n)&&!allocatedNumbers.has(n)){allocatedNumbers.add(n);return n;}let candidate='H'+sha256(String(old.id)).slice(0,10).toUpperCase();while(liveNumbers.has(candidate)||allocatedNumbers.has(candidate))candidate='H'+sha256(candidate+String(old.id)).slice(0,10).toUpperCase();allocatedNumbers.add(candidate);return candidate;}
function legacyOrderMatchesLive(old,matchedUsername,liveOrders){if(!matchedUsername)return false;const oldProvider=String(old.provider_id||''),oldProviderOrder=String(old.provider_order_id||'');for(const [,r] of liveOrders){if(!r||typeof r!=='object'||r.legacyHistory)continue;if(String(r.user||r.username||'')!==matchedUsername)continue;const rp=String(r.providerId||r.provider_id||''),rpo=String(r.providerOrderId||r.provider_order_id||r.smmpartyOrderId||'');if(oldProviderOrder&&rpo===oldProviderOrder&&(!oldProvider||!rp||oldProvider===rp))return true;const rid=String(r.publicOrderNo||r.id||r.order_id||'');if(old.order_number&&rid===String(old.order_number)&&String(r.serviceName||r.service||'')===String(old.service_name||'')&&String(r.link||'')===String(old.link||'')&&Number(r.quantity||0)===Number(old.quantity||0))return true;}return false;}
function buildLegacyOrderRecord(old,legacyUser,matched,currentDirectory,publicOrderNo){
  const username=matched?.username||legacyAliasUser(old.user_id);const currentName=matched?.user?.name||matched?.user?.fullName||matched?.user?.full_name||'';const priceUsd=Math.max(0,Number(old.total_price||0)||0);const costUsd=Math.max(0,Number(old.cost||0)||0);const qty=Math.max(0,Number(old.quantity||0)||0);
  return {id:String(publicOrderNo),publicOrderNo:String(publicOrderNo),user:username,userName:String(currentName||legacyUser?.arabic_name||legacyUser?.full_name||old.user_name||username),serviceId:String(old.service_id||''),serviceName:String(old.service_name||'خدمة'),serviceApp:String(old.platform_name||''),platform:String(old.platform_name||''),link:String(old.link||''),quantity:qty,total:Number((priceUsd*FIXED_RATE).toFixed(4)),totalIQD:Number((priceUsd*FIXED_RATE).toFixed(4)),chargeUsd:Number(priceUsd.toFixed(6)),providerCostUsd:Number(costUsd.toFixed(6)),unitSellingUsd:qty?Number((priceUsd*1000/qty).toFixed(6)):0,discountPct:0,status:legacyStatus(old.status),rawLegacyStatus:String(old.status||''),providerStatus:String(old.provider_status||''),providerId:'',providerOrderId:'',providerName:'',legacyProviderId:String(old.provider_id||''),legacyProviderOrderId:String(old.provider_order_id||''),legacyProviderName:String(old.provider_name||''),free:!!old.is_free,remains:old.remains??null,startCount:old.start_count??null,createdAt:String(old.created_date||''),updatedAt:String(old.updated_date||old.created_date||''),legacyHistory:true,readOnly:true,legacyImportKey:String(old.id),legacyOrderId:String(old.id),legacyOrderNumber:String(old.order_number||''),legacyUserId:String(old.user_id||''),legacyEmailHash:legacyUser?.email?sha256(normalizeEmail(legacyUser.email)):'' ,legacySource:'Base44 export'};
}
async function readLegacyStage(){const stage=readJSON(LEGACY_STAGE_FILE,null);if(!stage||stage.version!==1||!Array.isArray(stage.users)||!Array.isArray(stage.orders))return null;return stage;}
async function getLegacyRemoteSnapshot(){let remoteUsers,remoteOrders;try{[remoteUsers,remoteOrders]=await Promise.all([firebaseGetJson('users',12000),firebaseGetJson('orders',15000)]);}catch(e){throw Object.assign(new Error('تعذر الوصول إلى قاعدة Firebase الحية؛ لم يتم تغيير أي بيانات. '+String(e.message||e).slice(0,140)),{statusCode:503});}return {remoteUsers:remoteUsers||{},remoteOrders:remoteOrders||{}};}
function createLegacyPlan(stage,remoteUsers,remoteOrders){
  const directory=normalizeCurrentUsers(remoteUsers),mapped=mapLegacyUsersToCurrent(stage.users,directory),remoteOrderRows=collectionEntries(remoteOrders).filter(([,o])=>o&&typeof o==='object'&&!o.event),legacyById=new Map();
  for(const [k,o] of remoteOrderRows)if(o.legacyHistory&&o.legacyImportKey)legacyById.set(String(o.legacyImportKey),{key:k,order:o});
  const liveRows=remoteOrderRows.filter(([,o])=>!o.legacyHistory);const liveNumbers=new Set();for(const [,o] of liveRows){for(const n of [o.publicOrderNo,o.id,o.order_id])if(n!==undefined&&n!==null&&String(n).trim())liveNumbers.add(String(n).trim());}
  const numberCounts=new Map();for(const o of stage.orders){const n=String(o.order_number||'').trim();if(n)numberCounts.set(n,(numberCounts.get(n)||0)+1);}
  const allocated=new Set(),upserts={},balanceCandidates=[],oldUserById=new Map(stage.users.map(u=>[String(u.id),u])),legacyOrderCountsByUsername={};let alreadyImported=0,liveDuplicates=0,unmatchedOrderUsers=0;
  for(const old of stage.orders){const oldId=String(old.id),oldUser=oldUserById.get(String(old.user_id));const matched=mapped.byLegacyId.get(String(old.user_id))||null;const existing=legacyById.get(oldId);if(existing)alreadyImported++;
    if(!existing&&legacyOrderMatchesLive(old,matched?.username,liveRows)){liveDuplicates++;continue;}
    const pub=legacyPublicOrderNumber(old,numberCounts,liveNumbers,allocated);const row=buildLegacyOrderRecord(old,oldUser,matched,directory,pub);
    if(!matched)unmatchedOrderUsers++;
    if(matched)legacyOrderCountsByUsername[matched.username]=(legacyOrderCountsByUsername[matched.username]||0)+1;
    if(existing){upserts[existing.key]={...existing.order,...row,legacyImportKey:oldId,legacyHistory:true,readOnly:true,legacyCountedForUser:!!matched,legacyImportedAt:existing.order.legacyImportedAt||nowISO()};}
    else upserts[legacyStableFirebaseKey(oldId)]={...row,legacyCountedForUser:!!matched,legacyImportedAt:nowISO()};
  }
  const localLedger=readJSON('balance_ledger.json',[]),localPayments=readJSON('payments.json',[]);const existingOrderCounts=new Map();for(const [,o] of liveRows){const u=String(o.user||o.username||'');if(u)existingOrderCounts.set(u,(existingOrderCounts.get(u)||0)+1);}
  let matchedPositiveBalances=0,unmatchedPositiveBalances=0,balancesAlreadyRestored=0,balanceSkippedExisting=0,negativeBalancesSkipped=0;const balanceRestorePlan=[];
  for(const old of stage.users){const oldBalance=Number(old.balance||0);if(oldBalance<0){negativeBalancesSkipped++;continue;}if(oldBalance<=0)continue;const matched=mapped.byLegacyId.get(String(old.id));if(!matched){unmatchedPositiveBalances++;continue;}if(matched.user.legacyBalanceRestoredFromBase44===true){balancesAlreadyRestored++;continue;}
    const bal=Number(matched.user.balance);const hasBalance=matched.user.balance!==undefined&&matched.user.balance!==null&&matched.user.balance!=='';const activeOrders=Number(existingOrderCounts.get(matched.username)||0)>0;const activeTotals=Number(matched.user.totalOrders||0)>0||Number(matched.user.totalSpent||0)>0;const ledgerActivity=localLedger.some(x=>String(x?.user||'')===matched.username)||localPayments.some(x=>String(x?.user||x?.username||'')===matched.username);const active=activeOrders||activeTotals||ledgerActivity;
    if((hasBalance&&Math.abs(bal)>0.000001)||active){balanceSkippedExisting++;continue;}
    balanceRestorePlan.push({old,matched,balanceUsd:oldBalance,balanceIQD:Number((oldBalance*FIXED_RATE).toFixed(4))});matchedPositiveBalances++;
  }
  return {directory,mapped,remoteOrderRows,liveRows,upserts,alreadyImported,liveDuplicates,unmatchedOrderUsers,legacyOrderCountsByUsername,matchedUsers:mapped.matchedIds.size,unmatchedUsers:stage.users.length-mapped.matchedIds.size,balanceRestorePlan,matchedPositiveBalances,unmatchedPositiveBalances,balancesAlreadyRestored,balanceSkippedExisting,negativeBalancesSkipped,legacyUserById:oldUserById,counts:{users:stage.users.length,orders:stage.orders.length,transactions:Number(stage.transactionCount||0)}};
}
function legacyOrderResponseRecord(order,key){return {...order,source:order.legacyHistory?'legacy':'live',readOnly:!!order.legacyHistory,legacyFirebaseKey:order.legacyHistory?String(key||''):undefined};}

async function routeAPI(req,res,urlObj){
  const p=normalizedPath(urlObj.pathname);

  if(p==='/api/public/site-order-count'&&req.method==='GET'){
    let remoteOrders;try{remoteOrders=await firebaseGetJson('orders',9000);}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة عدّاد الطلبات الحقيقي من قاعدة الموقع. لم نعرض رقماً تخمينياً.',complete:false});}
    const rows=uniqueActualOrders(remoteOrders,readJSON('orders.json',[]));
    return json(res,200,{ok:true,count:rows.length,source:'firebase+server-ledger',complete:true,updatedAt:nowISO()});
  }

  if(p==='/api/admin/users-directory'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    let remoteUsers={},remoteOrders={},ordersAvailable=true,warning='';
    try{remoteUsers=await firebaseGetJson('users',12000);remoteUsers=remoteUsers||{};}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة حسابات Firebase: '+String(e.message||e).slice(0,160)});}
    try{remoteOrders=await firebaseGetJson('orders',15000);remoteOrders=remoteOrders||{};}catch(e){ordersAvailable=false;warning='تم تحميل المستخدمين، لكن تعذرت قراءة الطلبات الحقيقية: '+String(e.message||e).slice(0,120);}
    const directory=normalizeCurrentUsers(remoteUsers);
    const orders=ordersAvailable?uniqueActualOrders(remoteOrders,readJSON('orders.json',[])):[];
    const countsByUser=new Map(),countsByLegacyId=new Map();
    for(const o of orders){
      const username=String(o.user||o.username||o.userName||'').trim();if(username)countsByUser.set(username,(countsByUser.get(username)||0)+1);
      const legacyId=String(o.legacyUserId||'').trim();if(legacyId)countsByLegacyId.set(legacyId,(countsByLegacyId.get(legacyId)||0)+1);
    }
    const storedOld=readJSON(LEGACY_USERS_PRIVATE_FILE,[]);
    const stage=await readLegacyStage();
    const legacyUsers=Array.isArray(storedOld)&&storedOld.length?storedOld:(Array.isArray(stage?.users)?stage.users:[]);
    const stageOrders=Array.isArray(stage?.orders)?stage.orders:[];
    const legacyStageCounts=new Map();for(const o of stageOrders){const id=String(o.user_id||'');if(id)legacyStageCounts.set(id,(legacyStageCounts.get(id)||0)+1);}
    const mapped=mapLegacyUsersToCurrent(legacyUsers,directory);
    const result=directory.users.map(row=>{
      const count=ordersAvailable?(countsByUser.get(row.username)||0):Number(row.user.totalOrders||0);
      return {username:row.username,name:String(row.user.name||row.user.fullName||row.user.full_name||row.username),email:row.email||'',balance:Number(row.user.balance||0),totalOrders:count,storedTotalOrders:Number(row.user.totalOrders||0),level:String(row.user.level||'مبتدئ'),phone:String(row.user.phone||''),telegram:String(row.user.telegram||''),joined:String(row.user.joined||row.user.createdAt||''),role:String(row.user.role||'user'),readOnlyLegacy:false,hasCurrentAccount:true,legacyUserIds:[]};
    });
    const currentByKey=new Map(result.map((u,i)=>[directory.users[i].key,u]));
    let matchedLegacyUsers=0,legacyOnlyUsers=0;
    for(const old of legacyUsers){
      const current=mapped.byLegacyId.get(String(old.id));
      if(current){matchedLegacyUsers++;const row=currentByKey.get(current.key);if(row){row.legacyUserIds.push(String(old.id));if(ordersAvailable){const base=Math.max(countsByLegacyId.get(String(old.id))||0,0);if(base>0)row.totalOrders=Math.max(row.totalOrders,base);}}continue;}
      legacyOnlyUsers++;
      const id=String(old.id||'');
      const count=ordersAvailable?(countsByLegacyId.get(id)||0):(legacyStageCounts.get(id)||0);
      result.push({username:legacyAliasUser(id),name:String(old.arabic_name||old.full_name||old.fullName||('مستخدم قديم '+id.slice(0,8))),email:String(old.email||''),balance:Number((Number(old.balance||0)*FIXED_RATE).toFixed(4)),totalOrders:count,storedTotalOrders:count,level:'سجل قديم',phone:'',telegram:'',joined:String(old.created_date||''),role:'legacy',readOnlyLegacy:true,hasCurrentAccount:false,legacyUserId:id,legacyPending:!storedOld.length});
    }
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();
    const filtered=result.filter(u=>!q||[u.username,u.name,u.email,u.legacyUserId].some(v=>String(v||'').toLowerCase().includes(q)));
    filtered.sort((a,b)=>Number(b.totalOrders||0)-Number(a.totalOrders||0)||String(b.joined||'').localeCompare(String(a.joined||''))||String(a.name||'').localeCompare(String(b.name||''),'ar'));
    return json(res,200,{ok:true,users:filtered,total:result.length,currentUsers:directory.users.length,legacyUsers:legacyUsers.length,matchedLegacyUsers,legacyOnlyUsers,ordersAvailable,source:ordersAvailable?'firebase+server-ledger':'firebase-users-only',warning});
  }

  // Administrator-only legacy database workflow. Uploaded archive is validated and stored
  // in the private DATA directory; database content is never served as static files.
  if(p==='/api/admin/legacy-import/upload'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const ct=String(req.headers['content-type']||'').toLowerCase();if(!ct.includes('application/zip')&&!ct.includes('application/octet-stream'))return json(res,415,{ok:false,error:'ارفع ملف ZIP بصيغة application/zip.'});
    const bytes=await readRawRequestBuffer(req);const entries=readZipArchive(bytes);const dbKey=Object.keys(entries).find(k=>k==='sadairaq.db'||k.endsWith('/sadairaq.db'));if(!dbKey||entries[dbKey].subarray(0,16).toString('binary')!=='SQLite format 3\u0000')return json(res,422,{ok:false,error:'ملف SQLite غير موجود أو تالف داخل ZIP.'});
    const users=parseLegacyJsonEntry(entries,'sadairaq-users.json'),orders=parseLegacyJsonEntry(entries,'sadairaq-orders.json'),transactions=parseLegacyJsonEntry(entries,'sadairaq-transactions.json');
    const userIds=assertUniqueIds(users,'المستخدمين'),orderIds=assertUniqueIds(orders,'الطلبات'),transactionIds=assertUniqueIds(transactions,'المعاملات');const linkedOrders=orders.filter(o=>userIds.has(String(o?.user_id||''))).length;
    if(!users.length||!orders.length||linkedOrders!==orders.length)return json(res,422,{ok:false,error:'فشل التحقق من العلاقات بين المستخدمين والطلبات؛ لم يتم حفظ أي بيانات.',counts:{users:users.length,orders:orders.length,linkedOrders}});
    const privateUsers=users.map(legacyUserPrivateRow);const privateOrders=orders.map(legacyOrderPrivateRow);
    const stage={version:1,uploadedAt:nowISO(),sourceFile:'SadaIraq_Database_Export.zip',sourceZipBytes:bytes.length,users:privateUsers,orders:privateOrders,transactionCount:transactions.length,counts:{users:users.length,orders:orders.length,transactions:transactions.length}};
    writeJSON(LEGACY_STAGE_FILE,stage);
    return json(res,200,{ok:true,uploaded:true,zipBytes:bytes.length,counts:stage.counts,linkedOrders,checks:{sqliteHeader:true,zipCrcsValid:true,userIdsUnique:userIds.size===users.length,orderIdsUnique:orderIds.size===orders.length,transactionIdsUnique:transactionIds.size===transactions.length,allOrdersLinkedToUsers:linkedOrders===orders.length},message:'تم فحص الملف وتخزين بيانات الترحيل بشكل خاص. لم يتم تعديل قاعدة Firebase بعد.'});
  }
  if(p==='/api/admin/legacy-import/preview'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const stage=await readLegacyStage();if(!stage)return json(res,404,{ok:false,error:'لم يتم رفع ملف قاعدة البيانات بعد. اختر ملف ZIP أولاً.'});
    try{const remote=await getLegacyRemoteSnapshot();const plan=createLegacyPlan(stage,remote.remoteUsers,remote.remoteOrders);return json(res,200,{ok:true,ready:true,counts:plan.counts,matchedUsers:plan.matchedUsers,unmatchedUsers:plan.unmatchedUsers,ordersToAdd:Object.keys(plan.upserts).length-plan.alreadyImported,ordersAlreadyImported:plan.alreadyImported,duplicatesAlreadyInLiveDatabase:plan.liveDuplicates,unmatchedOrderUsers:plan.unmatchedOrderUsers,balancesToRestore:plan.balanceRestorePlan.length,unmatchedPositiveBalances:plan.unmatchedPositiveBalances,balanceSkippedExisting:plan.balanceSkippedExisting,negativeBalancesSkipped:plan.negativeBalancesSkipped,balancesAlreadyRestored:plan.balancesAlreadyRestored,exchangeRate:FIXED_RATE,warning:'سيتم ربط الطلبات بالبريد المطابق فقط. الحسابات القديمة التي لا تملك حساباً مطابقاً تبقى ظاهرة للإدارة باسم سجل قديم ولا يمكنها تسجيل الدخول بكلمة مرور Base44 القديمة.'});}catch(e){return json(res,503,{ok:false,error:String(e.message||e)});}
  }
  if(p==='/api/admin/legacy-import/apply'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);if(String(b.confirm||'')!==LEGACY_IMPORT_CONFIRM)return json(res,422,{ok:false,error:'اكتب تأكيد الدمج الصحيح من لوحة الإدارة.'});const stage=await readLegacyStage();if(!stage)return json(res,404,{ok:false,error:'ملف الترحيل غير موجود. ارفع ملف ZIP مرة أخرى.'});
    let remote;try{remote=await getLegacyRemoteSnapshot();}catch(e){return json(res,503,{ok:false,error:String(e.message||e)});}const plan=createLegacyPlan(stage,remote.remoteUsers,remote.remoteOrders);
    let ordersWritten=0;try{if(Object.keys(plan.upserts).length){await firebasePatchJson('orders',plan.upserts,30000);ordersWritten=Math.max(0,Object.keys(plan.upserts).length-plan.alreadyImported);}}catch(e){return json(res,503,{ok:false,error:'تعذر حفظ الطلبات القديمة في Firebase. لم نحذف ملف الترحيل؛ أعد المحاولة بعد التأكد من الاتصال. '+String(e.message||e).slice(0,160),partial:false});}
    // Keep a private, minimal index of legacy users for the admin's user-count report and
    // future remapping of users who register later. No password, phone, Telegram ID or tokens.
    writeJSON(LEGACY_USERS_PRIVATE_FILE,stage.users.map(legacyUserPrivateRow));
    let balancesRestored=0,balanceWriteErrors=0,orderCountersUpdated=0,orderCounterWriteErrors=0;const balanceErrorNames=[];
    // Synchronize the legacy portion of each matched account's order counter exactly once.
    // The per-user marker makes retries safe if an earlier HTTP request timed out after Firebase saved.
    const counterUpdates=[];
    for(const [username,targetCountRaw] of Object.entries(plan.legacyOrderCountsByUsername||{})){
      const matched=plan.directory.users.find(x=>x.username===username);if(!matched)continue;
      const targetCount=Math.max(Number(matched.user.legacyBase44OrdersCount||0),Number(targetCountRaw||0));
      const previouslyCounted=Math.max(0,Number(matched.user.legacyBase44OrdersCount||0));
      const delta=Math.max(0,targetCount-previouslyCounted);
      const totalBefore=Math.max(0,Number(matched.user.totalOrders||0)||0);
      if(delta===0&&Number(matched.user.legacyBase44OrdersCount||0)===targetCount)continue;
      counterUpdates.push({matched,targetCount,newTotalOrders:totalBefore+delta});
    }
    for(let i=0;i<counterUpdates.length;i+=12){const chunk=counterUpdates.slice(i,i+12);const settled=await Promise.allSettled(chunk.map(async item=>{const patch={totalOrders:item.newTotalOrders,legacyBase44OrdersCount:item.targetCount,legacyOrdersCounterUpdatedAt:nowISO(),updatedAt:nowISO()};await firebasePatchJson('users/'+item.matched.key,patch,9000);return true;}));for(let j=0;j<settled.length;j++){if(settled[j].status==='fulfilled')orderCountersUpdated++;else orderCounterWriteErrors++;}}
    for(let i=0;i<plan.balanceRestorePlan.length;i+=8){const chunk=plan.balanceRestorePlan.slice(i,i+8);const settled=await Promise.allSettled(chunk.map(async item=>{const patch={balance:item.balanceIQD,legacyBase44UserId:String(item.old.id),legacyBalanceOriginalUSD:item.balanceUsd,legacyBalanceRestoredFromBase44:true,legacyBalanceRestoredAt:nowISO(),updatedAt:nowISO()};await firebasePatchJson('users/'+item.matched.key,patch,9000);return true;}));for(let j=0;j<settled.length;j++){if(settled[j].status==='fulfilled')balancesRestored++;else{balanceWriteErrors++;if(balanceErrorNames.length<3)balanceErrorNames.push(String(settled[j].reason?.message||'فشل حفظ رصيد').slice(0,100));}}}
    const finalReport={completedAt:nowISO(),sourceFile:stage.sourceFile,counts:plan.counts,matchedUsers:plan.matchedUsers,unmatchedUsers:plan.unmatchedUsers,ordersWritten,ordersAlreadyImported:plan.alreadyImported,duplicatesAlreadyInLiveDatabase:plan.liveDuplicates,unmatchedOrderUsers:plan.unmatchedOrderUsers,orderCountersUpdated,orderCounterWriteErrors,balancesRestored,balanceWriteErrors,unmatchedPositiveBalances:plan.unmatchedPositiveBalances,balanceSkippedExisting:plan.balanceSkippedExisting,negativeBalancesSkipped:plan.negativeBalancesSkipped,balancesAlreadyRestored:plan.balancesAlreadyRestored,exchangeRate:FIXED_RATE};
    writeJSON(LEGACY_IMPORT_STATE_FILE,finalReport);
    if(balanceWriteErrors===0){try{fs.unlinkSync(path.join(DATA,LEGACY_STAGE_FILE));}catch(_){} }
    return json(res,200,{ok:true,report:finalReport,warning:(balanceWriteErrors||orderCounterWriteErrors)?'تم حفظ الطلبات القديمة، لكن تعذر تحديث بعض الأرصدة أو عدادات الطلبات. ملف الترحيل محفوظ؛ أعد الفحص والدمج بعد التأكد من الاتصال.':(plan.unmatchedUsers?'بعض حسابات القاعدة القديمة لا تطابق بريداً في المشروع الجديد؛ طلباتها محفوظة باسم سجل قديم، ولن يستطيع صاحبها رؤيتها بحسابه حتى يوجد حساب مطابق بالبريد ثم تعيد رفع ZIP وتضغط دمج مرة أخرى.':'تم ربط الطلبات بالحسابات المطابقة، ومزامنة عدد الطلبات التاريخية لكل حساب. كل طلب جديد سيزيد الإجمالي تلقائياً بمقدار واحد.')});
  }
  if(p==='/api/admin/legacy-import/status'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const stage=await readLegacyStage(),report=readJSON(LEGACY_IMPORT_STATE_FILE,null);return json(res,200,{ok:true,uploaded:!!stage,stagedCounts:stage?.counts||null,lastImport:report||null});
  }
  if(p==='/api/admin/user-order-stats'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});let remoteUsers={},remoteOrders={};let firebaseAvailable=true;try{[remoteUsers,remoteOrders]=await Promise.all([firebaseGetJson('users',12000),firebaseGetJson('orders',15000)]);remoteUsers=remoteUsers||{};remoteOrders=remoteOrders||{};}catch(e){firebaseAvailable=false;return json(res,503,{ok:false,error:'تعذر قراءة المستخدمين والطلبات من Firebase: '+String(e.message||e).slice(0,140)});}
    const directory=normalizeCurrentUsers(remoteUsers),currentByUsername=new Map(directory.users.map(u=>[u.username,u]));const oldUsers=readJSON(LEGACY_USERS_PRIVATE_FILE,[]);const oldById=new Map((Array.isArray(oldUsers)?oldUsers:[]).map(u=>[String(u.id),u]));const localOrders=readJSON('orders.json',[]);const dedup=new Map();
    const addOrder=(o,source,key='')=>{if(!o||typeof o!=='object'||o.event)return;const user=String(o.user||o.username||'').trim();if(!user)return;const identity=String(o.legacyHistory?'legacy:'+o.legacyImportKey:(o.id||o.siteOrderId||o.orderId||o.order_id||o.providerOrderId||o.smmpartyOrderId||key||o.createdAt||''));if(!identity)return;dedup.set(user+'|'+identity,{o,user,source});};
    for(const [i,o] of (Array.isArray(localOrders)?localOrders:[]).entries())addOrder(o,'local',String(i));for(const [k,o] of collectionEntries(remoteOrders))addOrder(o,o.legacyHistory?'legacy':'firebase',k);
    const groups=new Map();for(const {o,user,source} of dedup.values()){
      const curr=currentByUsername.get(user);const legacyId=String(o.legacyUserId||'');const old=oldById.get(legacyId);const groupKey=curr?'current:'+user:(legacyId?'legacy:'+legacyId:'current:'+user);let g=groups.get(groupKey);if(!g){g={username:curr?user:(legacyId?legacyAliasUser(legacyId):user),name:String(curr?.user?.name||curr?.user?.fullName||old?.arabic_name||old?.full_name||o.userName||o.name||user),orderCount:0,legacyOrderCount:0,newOrderCount:0,balanceUsd:curr?Number(curr.user.balance||0)/FIXED_RATE:Number(old?.balance||0),balanceSource:curr?'current-account':'legacy-snapshot',legacyUserId:legacyId||null,hasCurrentAccount:!!curr};groups.set(groupKey,g);}
      g.orderCount++;if(o.legacyHistory)g.legacyOrderCount++;else g.newOrderCount++;if(curr){g.name=String(curr.user.name||curr.user.fullName||g.name);g.balanceUsd=Number(curr.user.balance||0)/FIXED_RATE;g.balanceSource='current-account';}
    }
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();const limit=Math.min(100,Math.max(5,Number(urlObj.searchParams.get('limit')||50)));const rows=[...groups.values()].filter(x=>x.orderCount>0&&(!q||[x.name,x.username,x.legacyUserId].some(v=>String(v||'').toLowerCase().includes(q)))).sort((a,b)=>b.orderCount-a.orderCount||a.name.localeCompare(b.name,'ar')).slice(0,limit);return json(res,200,{ok:true,users:rows,total:groups.size,orders:dedup.size,firebaseAvailable});
  }

  // -------------------- Public API key management --------------------
  if(p==='/api/user/api-key' && req.method==='GET'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const keys=readJSON('api_keys.json',{}); const rec=Object.values(keys).find(x=>x&&x.username===u&&!x.revokedAt);
    return json(res,200,{ok:true,exists:!!rec,masked:rec?.masked||null});
  }
  if(p==='/api/user/api-key' && req.method==='POST'){
    if(!String(process.env.SADA_ENCRYPTION_KEY||'').trim())return json(res,503,{ok:false,error:'يلزم ضبط SADA_ENCRYPTION_KEY لحفظ مفتاح API مشفراً قبل إنشائه.'});
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
    const {pct,total}=calcApiChargeUsd(s,quantity,au.user); const iqd=Number((total*FIXED_RATE).toFixed(4)); await ensureProviderRuntime(s.providerId); const {prov}=getProviderById(s.providerId); if(!prov)return json(res,502,{error:'Provider unavailable'});
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
    if(result?.ok){ createUserNotification(au.username,{type:'order_created',orderId:String(result.order.id),status:'pending',title:'تم استلام طلبك #'+String(result.order.id),message:'تم استلام طلبك لخدمة '+String(result.order.serviceName||'خدمة')+' والكمية '+quantity+'.',meta:{serviceName:String(result.order.serviceName||'خدمة'),quantity,providerName:String(result.order.providerName||'')}}); sendTelegram(`🆕 طلب جديد\n🆔 رقم الطلب: #${result.order.id}\n👤 المستخدم: ${au.username}\n📦 الخدمة: ${result.order.serviceName}\n🔗 الرابط: ${link}\n🔢 الكمية: ${quantity.toLocaleString('en-US')}\n💰 السعر: $${total.toFixed(2)}\n📊 الحالة: Pending\n🕐 الوقت: ${new Date().toLocaleString('en-GB',{hour12:false})}`).catch(()=>{}); return json(res,200,apiOrderPublic(result.order)); }
    return json(res,500,{error:'تعذر إنشاء الطلب'});
  }

  // -------------------- Admin order audit / diagnostics --------------------
  if(p==='/api/admin/order-audit/settings' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const settings=await getOrderAuditSettings();
    return json(res,200,{ok:true,settings,defaultDelayHours:3,monitorIntervalMinutes:1,storageMode:DATA_IS_EXTERNAL?'persistent-directory':'release-local'});
  }
  if(p==='/api/admin/order-audit/settings' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const previous=await getOrderAuditSettings();
    const delayHours=Number(b.delayHours??previous.delayHours);
    if(!Number.isInteger(delayHours)||delayHours<1||delayHours>72)return json(res,422,{ok:false,error:'مدة التأخير يجب أن تكون بين ساعة و72 ساعة'});
    const saved=await saveOrderAuditSettings({...previous,delayHours,notifyAdmin:b.notifyAdmin===undefined?previous.notifyAdmin:b.notifyAdmin===true,notifyAdminExplicit:b.notifyAdmin!==undefined?true:previous.notifyAdminExplicit===true});
    return json(res,200,{ok:true,...saved,warning:saved.persistent?'':'تم حفظ الإعداد محلياً فقط؛ اربط تخزيناً دائماً أو تحقق من صلاحيات Firebase حتى يبقى بعد إعادة النشر.'});
  }
  if(p==='/api/admin/order-audit' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const snapshot=await loadOrderAuditSnapshot(String(urlObj.searchParams.get('refresh')||'')==='1');
    if(!snapshot.firebaseAvailable&&!snapshot.rows.length)return json(res,502,{ok:false,error:'تعذر قراءة قاعدة الطلبات من Firebase، ولم يتوفر سجل خادم بديل. لم يتم عرض نتائج فارغة على أنها مؤكدة.',details:snapshot.firebaseError||'Firebase unavailable'});
    const settings=await getOrderAuditSettings();
    const result=auditPageFilter(snapshot.rows,{view:urlObj.searchParams.get('view'),q:urlObj.searchParams.get('q'),numberType:urlObj.searchParams.get('numberType'),provider:urlObj.searchParams.get('provider'),platform:urlObj.searchParams.get('platform'),service:urlObj.searchParams.get('service'),status:urlObj.searchParams.get('status'),delay:urlObj.searchParams.get('delay'),range:urlObj.searchParams.get('range'),sort:urlObj.searchParams.get('sort'),page:urlObj.searchParams.get('page'),limit:urlObj.searchParams.get('limit')},settings);
    result.items=await orderAuditEnrichUsers(result.items);
    result.source={...result.source,orderCount:snapshot.rows.length,readAt:new Date(snapshot.at).toISOString(),warning:!snapshot.firebaseAvailable?'عرض جزئي من سجل الخادم؛ تعذر تأكيد بيانات Firebase.':''};
    return json(res,200,{ok:true,...result});
  }
  if(p==='/api/admin/order-audit/check' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const number=String(b.number||b.orderId||'').trim();const numberType=String(b.numberType||'site');
    if(!number)return json(res,422,{ok:false,error:'أدخل رقم الطلب أولاً'});
    const snapshot=await loadOrderAuditSnapshot(true);
    if(!snapshot.firebaseAvailable&&!snapshot.rows.length)return json(res,502,{ok:false,error:'تعذر قراءة سجل الطلبات الأساسي: '+(snapshot.firebaseError||'Firebase unavailable')});
    let candidates=snapshot.rows;
    if(String(b.sourceKey||'').trim())candidates=candidates.filter(r=>String(r._firebaseKey||r.firebaseKey||'')===String(b.sourceKey).trim());
    else if(numberType==='provider')candidates=candidates.filter(r=>String(r.providerOrderId||'')===number);
    else candidates=candidates.filter(r=>String(r.siteOrderId||r.id||'')===number||String(r.publicOrderNo||'')===number);
    candidates.sort((a,b)=>Number(b.createdMs||0)-Number(a.createdMs||0));
    const raw=candidates[0];if(!raw)return json(res,404,{ok:false,error:numberType==='provider'?'لم يُعثر على رقم طلب المزوّد في سجلات الموقع. لا يمكن فحص رقم غير مرتبط بطلب محفوظ.':'رقم الطلب غير موجود في قاعدة بيانات الموقع.'});
    const cfg=await getOrderAuditSettings();let order=await orderAuditEnrichUsers([auditPublicRecord(raw,Date.now(),cfg.delayHours)]).then(x=>x[0]);
    if(!raw.providerId||!raw.providerOrderId){return json(res,200,{ok:true,externalVerified:false,saved:false,order,warning:'تم العثور على الطلب وحالته المخزنة، لكن لا توجد بيانات ربط مكتملة بالمزوّد؛ لم يتم إجراء فحص خارجي.'});}
    try{
      await ensureProviderRuntime(raw.providerId);const resolved=getProviderById(raw.providerId,{allowSingleFallback:false});const prov=resolved.prov;
      if(!prov?.url||!prov?.key)return json(res,200,{ok:true,externalVerified:false,saved:false,order,warning:'تم عرض آخر حالة مخزنة، لكن تعذر العثور على إعدادات المزود المحفوظة لهذا الطلب؛ لم يتم تغيير حالته.'});
      const d=await providerRequest(prov,{action:'status',order:String(raw.providerOrderId)});
      const providerRawStatus=String(d?.status??d?.data?.status??d?.result?.status??'').trim();const normalized=auditStatus(providerRawStatus);const checkedAt=nowISO();let saved=true;let saveError='';
      const update={providerStatus:providerRawStatus,lastCheckedAt:checkedAt,updatedAt:checkedAt};
      if(normalized!=='unknown')update.status=normalized;
      if(d?.remains!==undefined)update.remains=d.remains;
      if(d?.start_count!==undefined||d?.startCount!==undefined)update.startCount=d.start_count??d.startCount;
      if(raw._firebaseKey||raw.firebaseKey){try{await firebasePatchJson('orders/'+String(raw._firebaseKey||raw.firebaseKey),update,10000)}catch(e){saved=false;saveError=String(e.message||e).slice(0,160)}}
      const localRows=readJSON('orders.json',[]);let localChanged=false;
      if(Array.isArray(localRows)){
        for(let i=0;i<localRows.length;i++){
          const x=localRows[i];if(!x||x.event)continue;
          const same=(raw.id&&String(x.id||x.publicOrderNo||'')===String(raw.id))&&(!raw.user||String(x.user||'')===String(raw.user));
          const sameProvider=String(x.providerId||'')===String(raw.providerId)&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(raw.providerOrderId);
          if(same||sameProvider){localRows[i]={...x,...update};localChanged=true;}
        }
      }
      if(localChanged){try{writeJSON('orders.json',localRows)}catch(e){saved=false;saveError=saveError||String(e.message||e).slice(0,160)}}
      const oldStatus=auditStatus(raw.status||raw.rawStatus);const newStatus=normalized==='unknown'?oldStatus:normalized;
      if(saved&&['cancelled','partial'].includes(newStatus)){const full=await resolveFinancialOrder({...raw,...(raw._firebaseKey?{_firebaseKey:raw._firebaseKey}:{}),user:raw.user,providerId:raw.providerId,providerOrderId:raw.providerOrderId});update.refundResult=await applyVerifiedOrderRefund({...full,...update,status:newStatus},d,newStatus);}
      if(saved&&oldStatus!==newStatus&&newStatus!=='unknown')notifyOrderStatusChange({...raw,...update,user:raw.user},oldStatus,newStatus).catch(()=>{});
      const mergedOrder={...order,status:newStatus,rawStatus:providerRawStatus||order.rawStatus,lastCheckedAt:checkedAt,remains:update.remains??order.remains,startCount:update.startCount??order.startCount};
      return json(res,200,{ok:true,externalVerified:true,saved,order:mergedOrder,providerStatus:providerRawStatus,providerNormalizedStatus:normalized,refund:update.refundResult||null,checkedAt,warning:normalized==='unknown'?'اتصل النظام بالمزوّد، لكن رد الحالة غير معروف؛ حافظنا على الحالة المخزنة ولم نعتبر الطلب مكتملاً.':(!saved?'تم فحص المزود لكن تعذر حفظ الحالة الجديدة في قاعدة الموقع: '+saveError:'')});
    }catch(e){
      appendJsonLedger('provider_failures.json',{stage:'admin_order_audit_status',siteOrderId:raw.id,providerId:raw.providerId,providerOrderId:raw.providerOrderId,error:String(e.message||e).slice(0,180),createdAt:nowISO()});
      return json(res,200,{ok:true,externalVerified:false,saved:false,order,warning:'تعذر التحقق من المزود الآن. الحالة المعروضة هي آخر حالة محفوظة ولم نغيّرها. السبب: '+String(e.message||'فشل الاتصال').slice(0,180)});
    }
  }

  // -------------------- Admin API / audit / stats --------------------
  if(p==='/api/admin/pricing' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const pricing=await getGlobalPricing();return json(res,200,{ok:true,pricing});
  }
  if(p==='/api/admin/pricing' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const pct=Number(b.markupPct);if(!Number.isFinite(pct)||pct<0||pct>1000)return json(res,422,{ok:false,error:'نسبة الربح يجب أن تكون بين 0 و1000%'});
    const hours=Number(b.intervalHours??6);if(![1,3,6,12,24].includes(hours))return json(res,422,{ok:false,error:'اختر فترة تحديث من 1 أو 3 أو 6 أو 12 أو 24 ساعة'});
    const previous=await getGlobalPricing();const saved=await saveGlobalPricing({...previous,markupPct:pct,autoSync:b.autoSync!==false,intervalHours:hours,lastAttemptAt:previous.lastAttemptAt,lastSuccessAt:previous.lastSuccessAt});
    let cached={updated:0,skipped:0,localUpdated:0},cachedError='';try{cached=await applyCachedGlobalMarkup(pct)}catch(e){cachedError=String(e.message||e).slice(0,180)}
    let live={ok:false,updated:0,providerErrors:[]};if(b.syncNow===true){live=await runProviderPriceSync({manual:true})}
    return json(res,200,{ok:true,pricing:await getGlobalPricing(),persistedRemotely:saved.persistedRemotely,remoteError:saved.remoteError,cached,cachedError,live});
  }
  if(p==='/api/admin/pricing/sync' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const result=await runProviderPriceSync({manual:true});return json(res,200,result);
  }
  if(p==='/api/admin/service-sync' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const list=Array.isArray(b.services)?b.services:[];if(list.length>25000)return json(res,413,{ok:false,error:'عدد الخدمات كبير جداً'});
    const safe=list.map(s=>{const providerServiceId=String(s?.smmpartyId||s?.providerServiceId||s?.serviceId||'').trim();const fbId=String(s?.fbKey||s?.id||'').trim();return {id:providerServiceId,fbId,name:String(s?.name||'خدمة'),category:String(s?.category||((Array.isArray(s?.groups)&&s.groups[0])||'عام')),sellingUsd:Number(s?.sellingUsd||0),rateUsd:Number(s?.sellingUsd||s?.smmRateUsd||s?.rateUsd||0),min:Number(s?.min||100),max:Number(s?.max||10000),refill:!!s?.refill,cancel:!!s?.cancel,providerId:String(s?.providerId||''),providerServiceId,smmRateUsd:Number(s?.smmRateUsd||s?.rate||0),updatedAt:nowISO()};}).filter(x=>x.id&&x.providerId);
    writeJSON('api_services.json',safe);return json(res,200,{ok:true,count:safe.length,syncedAt:nowISO()});
  }
  if(p==='/api/admin/sync-users' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const list=Array.isArray(b.users)?b.users:[];const store=readJSON('users.json',{users:{}});let n=0;for(const x of list.slice(0,10000)){const u=String(x?.username||'').trim();const bal=Number(x?.balance);if(!u||!Number.isFinite(bal)||bal<0)continue;store.users[u]={...(store.users[u]||{name:u,role:'user'}),balance:Number(bal.toFixed(4)),totalSpent:Number(x?.totalSpent||store.users[u]?.totalSpent||0),totalOrders:Number(x?.totalOrders||store.users[u]?.totalOrders||0),discountPct:Number(x?.discountPct??store.users[u]?.discountPct??0)};n++;}writeJSON('users.json',store);return json(res,200,{ok:true,count:n});
  }
  if(p==='/api/admin/stats' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const range=String(urlObj.searchParams.get('range')||'all');if(!['today','7d','month','all'].includes(range))return json(res,422,{ok:false,error:'نطاق غير صالح'});
    const local=readJSON('orders.json',[]),map=new Map();const keyOf=(o,k='')=>String(o?.id||o?.siteOrderId||o?.orderId||o?.order_id||o?.providerOrderId||(String(o?.user||o?.username||'')+'|'+String(o?.createdAt||'')+'|'+String(o?.serviceId||'')+'|'+String(o?.quantity||''))||k);
    for(const o of Array.isArray(local)?local:[])if(o&&!o.event)map.set(keyOf(o),o);let firebaseAvailable=false,firebaseError='';
    try{const remote=await firebaseGetJson('orders',6000);firebaseAvailable=true;if(remote&&typeof remote==='object'){const entries=Array.isArray(remote)?remote.map((o,i)=>[String(i),o]):Object.entries(remote);for(const [k,o] of entries){if(!o||typeof o!=='object'||o.event)continue;const key=keyOf(o,k);map.set(key,{...(map.get(key)||{}),...o,...(map.get(key)?.providerCostUsd!==undefined&&o.providerCostUsd===undefined?{providerCostUsd:map.get(key).providerCostUsd}:{})});}}}catch(e){firebaseError=String(e.message||e).slice(0,160);}
    const stats=statsSnapshot(range,[...map.values()]);stats.source=firebaseAvailable?'firebase+local':'local-only';stats.firebaseAvailable=firebaseAvailable;return json(res,200,{ok:true,range,stats,warning:firebaseAvailable?'':('تعذر قراءة طلبات Firebase؛ الأرقام محسوبة من سجل الخادم المتاح فقط. '+firebaseError)});
  }
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
  if(p==='/api/admin/user-finance' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const username=String(urlObj.searchParams.get('username')||'').trim();if(!username)return json(res,422,{ok:false,error:'اسم المستخدم مطلوب'});const u=readJSON('users.json',{users:{}}).users?.[username];if(!u)return json(res,404,{ok:false,error:'المستخدم غير موجود'});
    const orderMap=new Map();const add=o=>{if(!o||o.event||String(o.user||o.username||'')!==username)return;const id=String(o.legacyHistory?'legacy:'+o.legacyImportKey:(o.id||o.siteOrderId||o.orderId||o.order_id||o.providerOrderId||o.createdAt||''));if(id)orderMap.set(id,{...(orderMap.get(id)||{}),...o});};for(const o of readJSON('orders.json',[]))add(o);try{const rem=await firebaseGetJson('orders',9000);for(const [,o] of collectionEntries(rem))add(o);}catch(_){}
    const orders=[...orderMap.values()];const ledger=readJSON('balance_ledger.json',[]).filter(x=>String(x.user||'')===username);const deposits=ledger.filter(x=>['charge','deposit'].includes(String(x.type||''))).reduce((a,x)=>a+Number(x.amountUSD||Number(x.amountIQD||0)/FIXED_RATE||0),0);const spent=orders.reduce((a,o)=>a+Number(o.chargeUsd??Number(o.total||0)/FIXED_RATE),0);return json(res,200,{ok:true,user:{username,name:String(u.name||username),balanceUsd:Number((Number(u.balance||0)/FIXED_RATE).toFixed(6)),totalDepositsUsd:Number(deposits.toFixed(6)),totalSpentUsd:Number(spent.toFixed(6)),totalOrders:orders.length,legacyOrders:orders.filter(o=>o.legacyHistory).length,discountPct:Number(u.discountPct||0)}});
  }
  if(p==='/api/admin/telegram' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const cfg=telegramConfig();const storedCfg=readJSON('settings.json',{}).telegram||{};return json(res,200,{ok:true,telegram:{enabled:cfg.enabled,tokenSet:!!cfg.token,encryptionReady:telegramEncryptionReady(),durableStorage:DATA_IS_EXTERNAL,tokenFromEnvironment:!!String(process.env.TELEGRAM_BOT_TOKEN||'').trim(),tokenStoredEncrypted:!!storedCfg.tokenEncrypted,chat:cfg.chat||'',activationChat:cfg.activationChat||'',overdueChat:cfg.overdueChat||'',activationEnvLocked:cfg.activationEnvLocked,overdueEnvLocked:cfg.overdueEnvLocked,extraChatsCount:(cfg.extraChats||[]).length}});}
  if(p==='/api/admin/telegram' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const cfg=readJSON('settings.json',{});const tg=cfg.telegram||{};
    if(b.enabled!==undefined)tg.enabled=!!b.enabled;
    const newToken=String(b.token||'').trim();if(newToken&&!telegramEncryptionReady())return json(res,503,{ok:false,error:'لم يُحفظ التوكن لحمايته. افتح Railway > مشروعك > Variables وأضف SESSION_SECRET بقيمة عشوائية ثابتة لا تقل عن 32 حرفاً (يفضل 64)، ثم أعد النشر. أو اربط Volume دائمًا واجعل SADA_DATA_DIR=/data. لا تضع التوكن داخل الكود ولا ترسله في المحادثة.'});if(newToken){tg.tokenEncrypted=encryptSecret(newToken);delete tg.token;}
    if(b.chat!==undefined)tg.chat=String(b.chat).trim();if(b.activationChat!==undefined&&!telegramConfig().activationEnvLocked){tg.activationChat=String(b.activationChat||'').trim();tg.chat=tg.activationChat||tg.chat||'';}if(b.overdueChat!==undefined&&!telegramConfig().overdueEnvLocked)tg.overdueChat=String(b.overdueChat||'').trim();
    // Migrate any legacy cleartext token before saving, never expose it in the response.
    if(tg.token&&!tg.tokenEncrypted){tg.tokenEncrypted=encryptSecret(tg.token);delete tg.token;}cfg.telegram=tg;writeJSON('settings.json',cfg);
    let firebaseChannelsSaved=false,firebaseSecretSaved=false;try{const channelData={activationChat:tg.activationChat||tg.chat||'',overdueChat:tg.overdueChat||'',enabled:tg.enabled!==false,updatedAt:nowISO()};await firebaseWriteJson('config/telegramChannels',channelData,6000);TELEGRAM_CHANNELS_REMOTE=channelData;firebaseChannelsSaved=true;}catch(e){console.warn('Telegram channel persistence Firebase failed:',String(e.message||e).slice(0,100));}
    if(tg.tokenEncrypted){try{await firebaseWriteJson('config/telegramSecret',{tokenEncrypted:tg.tokenEncrypted,updatedAt:nowISO()},6000);firebaseSecretSaved=true;}catch(e){console.warn('Encrypted Telegram secret Firebase persistence failed:',String(e.message||e).slice(0,100));}}
    const durable=DATA_IS_EXTERNAL||firebaseChannelsSaved&&(!tg.tokenEncrypted||firebaseSecretSaved);
    if(!durable)return json(res,503,{ok:false,error:'تمت محاولة حفظ الإعدادات محلياً فقط، لكن لم يتأكد الحفظ الدائم. افتح Railway Variables وأضف SESSION_SECRET ثابتاً قوياً، أو اربط Volume دائماً على /data مع SADA_DATA_DIR=/data. وتأكد من صلاحية الكتابة في Firebase ثم أعد الحفظ؛ لم نعتبر الإعدادات محفوظة.',persistent:false});
    return json(res,200,{ok:true,persistent:true,storageMode:firebaseChannelsSaved?'firebase+local':'external-volume',warning:tg.tokenEncrypted&&!firebaseSecretSaved?'تم حفظ الإعدادات على مساحة التخزين الدائمة، لكن نسخة Firebase المشفرة لم تتحدث.':undefined,telegram:{enabled:tg.enabled!==false,tokenSet:!!(process.env.TELEGRAM_BOT_TOKEN||tg.tokenEncrypted),chat:tg.activationChat||tg.chat||'',activationChat:tg.activationChat||tg.chat||'',overdueChat:tg.overdueChat||''}});
  }
  if(p==='/api/admin/telegram/test' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const r=await sendTelegramDetailed(String(b.text||'✅ اختبار إشعارات صدى العراق'),{kind:'manual_test'});return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'تم إرسال اختبار Telegram':(r.description||r.error||'فشل إرسال اختبار Telegram'),status:r.status||null,messageId:r.messageId||null});}
  if(p==='/api/admin/telegram/test-connection' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const r=await telegramTestConnection();return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'اتصال Telegram ناجح':(r.description||r.error||'فشل الاتصال بـ Telegram'),status:r.status||null});}
  if(p==='/api/admin/telegram/test-order' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const sample='🧪 اختبار إشعار طلب\n🆔 رقم طلب صدى العراق: #TEST-001\n👤 المستخدم: اختبار\n📦 الخدمة: خدمة تجريبية\n🔗 الرابط: https://example.com\n🔢 الكمية: 1,000\n💰 السعر: $0.50\n📊 الحالة: Pending\n🕐 الوقت: '+new Date().toLocaleString('en-GB',{hour12:false});const r=await sendTelegramDetailed(sample,{kind:'test_order',orderId:'TEST-001'});return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'تم إرسال إشعار طلب تجريبي':(r.description||r.error||'فشل إرسال إشعار الطلب'),status:r.status||null,messageId:r.messageId||null});}
  if(p==='/api/admin/telegram/test-channel' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const channel=b.channel==='overdue'?'overdue':'activation';const r=await notifyTelegramRecipients(String(b.text||('🧪 اختبار قناة '+(channel==='overdue'?'الطلبات المتأخرة':'التفعيلات')+' — صدى العراق')),{channel,kind:'manual_channel_test'});return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'تم إرسال الاختبار إلى القناة المحددة':(r.description||r.error||'تعذر الإرسال'),results:r.results||[]});}
  if(p==='/api/admin/telegram/logs' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});return json(res,200,{ok:true,logs:readJSON('telegram_notifications.json',[]).slice(-50).reverse()});}

  if(p==='/api/welcome-settings' && req.method==='GET'){
    const settings=readJSON('settings.json',{});let remote=null;try{remote=await firebaseGetJson('config/welcomePopup',3500)}catch(_){}
    const localWelcome=settings.welcomePopup&&typeof settings.welcomePopup==='object'?settings.welcomePopup:{};const remoteWelcome=remote&&typeof remote==='object'?remote:{};const v=(Date.parse(remoteWelcome.updatedAt||'')||0)>=(Date.parse(localWelcome.updatedAt||'')||0)?{...localWelcome,...remoteWelcome}:{...remoteWelcome,...localWelcome};
    const safeUrl=value=>{try{const u=new URL(String(value||''));return u.protocol==='https:'?u.toString():''}catch(_){return ''}};
    const cfg={welcome:{enabled:v.enabled!==false,showEveryEntry:v.showEveryEntry!==false,splashEnabled:v.splashEnabled!==false,title:String(v.title||'مرحباً بكم في صدى العراق!').slice(0,100),subtitle:String(v.subtitle||'مرحباً بك، يسعدنا حضورك. نحن إلى جانبك في كل وقت.').slice(0,240),tutorialTitle:String(v.tutorialTitle||'شرح التطبيق').slice(0,60),tutorialSubtitle:String(v.tutorialSubtitle||'شاهد شرح الاستخدام بالتفصيل').slice(0,100),tutorialUrl:safeUrl(v.tutorialUrl||settings.tutorialUrl||settings.youtubeUrl||''),whatsappTitle:String(v.whatsappTitle||'دعم الواتساب').slice(0,60),whatsappSubtitle:String(v.whatsappSubtitle||'تحدث معنا على واتساب').slice(0,100),whatsappUrl:safeUrl(v.whatsappUrl||settings.waUrl||settings.waNum||'https://wa.me/9647762267959')||normalizeWhatsAppUrl(settings.waUrl||settings.waNum||''),telegramTitle:String(v.telegramTitle||'قناة التليجرام').slice(0,60),telegramSubtitle:String(v.telegramSubtitle||'تابع آخر الأخبار والتحديثات').slice(0,100),telegramUrl:(()=>{const u=safeUrl(v.telegramUrl||settings.telegramChannelUrl||'https://t.me/jbhbhg58')||'https://t.me/jbhbhg58';return /^https:\/\/t\.me\/hddjh55\/?$/i.test(u)?'https://t.me/jbhbhg58':u})()}};
    return json(res,200,{ok:true,...cfg});
  }
  if(p==='/api/admin/welcome-settings' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const settings=readJSON('settings.json',{});let remote=null;try{remote=await firebaseGetJson('config/welcomePopup',5000)}catch(_){}
    const localWelcome=settings.welcomePopup&&typeof settings.welcomePopup==='object'?settings.welcomePopup:{};const remoteWelcome=remote&&typeof remote==='object'?remote:{};const welcome=(Date.parse(remoteWelcome.updatedAt||'')||0)>=(Date.parse(localWelcome.updatedAt||'')||0)?{...localWelcome,...remoteWelcome}:{...remoteWelcome,...localWelcome};const tg=telegramConfig();
    return json(res,200,{ok:true,welcome:{enabled:welcome.enabled!==false,showEveryEntry:welcome.showEveryEntry!==false,splashEnabled:welcome.splashEnabled!==false,title:welcome.title||'مرحباً بكم في صدى العراق!',subtitle:welcome.subtitle||'مرحباً بك، يسعدنا حضورك. نحن إلى جانبك في كل وقت.',tutorialTitle:welcome.tutorialTitle||'شرح التطبيق',tutorialSubtitle:welcome.tutorialSubtitle||'شاهد شرح الاستخدام بالتفصيل',tutorialUrl:welcome.tutorialUrl||settings.tutorialUrl||settings.youtubeUrl||'',whatsappTitle:welcome.whatsappTitle||'دعم الواتساب',whatsappSubtitle:welcome.whatsappSubtitle||'تحدث معنا على واتساب',whatsappUrl:welcome.whatsappUrl||settings.waUrl||'https://wa.me/9647762267959',telegramTitle:welcome.telegramTitle||'قناة التليجرام',telegramSubtitle:welcome.telegramSubtitle||'تابع آخر الأخبار والتحديثات',telegramUrl:(()=>{const u=String(welcome.telegramUrl||'https://t.me/jbhbhg58');return /^https:\/\/t\.me\/hddjh55\/?$/i.test(u)?'https://t.me/jbhbhg58':u})()},channels:{activationChat:tg.activationChat||'',overdueChat:tg.overdueChat||'',activationEnvLocked:tg.activationEnvLocked,overdueEnvLocked:tg.overdueEnvLocked},telegram:{enabled:tg.enabled,tokenSet:!!tg.token}});
  }
  if(p==='/api/admin/welcome-settings' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const w=b.welcome&&typeof b.welcome==='object'?b.welcome:{};const channels=b.channels&&typeof b.channels==='object'?b.channels:{};
    const safeText=(x,max,def='')=>String(x??def).trim().slice(0,max);
    const safeUrl=(x)=>{try{const u=new URL(String(x||'').trim());return u.protocol==='https:'?u.toString():''}catch(_){return ''}};
    const old=readJSON('settings.json',{});const welcome={enabled:w.enabled!==false,showEveryEntry:w.showEveryEntry!==false,splashEnabled:w.splashEnabled!==false,title:safeText(w.title,100,'مرحباً بكم في صدى العراق!'),subtitle:safeText(w.subtitle,240,'مرحباً بك، يسعدنا حضورك. نحن إلى جانبك في كل وقت.'),tutorialTitle:safeText(w.tutorialTitle,60,'شرح التطبيق'),tutorialSubtitle:safeText(w.tutorialSubtitle,100,'شاهد شرح الاستخدام بالتفصيل'),tutorialUrl:safeUrl(w.tutorialUrl),whatsappTitle:safeText(w.whatsappTitle,60,'دعم الواتساب'),whatsappSubtitle:safeText(w.whatsappSubtitle,100,'تحدث معنا على واتساب'),whatsappUrl:safeUrl(w.whatsappUrl),telegramTitle:safeText(w.telegramTitle,60,'قناة التليجرام'),telegramSubtitle:safeText(w.telegramSubtitle,100,'تابع آخر الأخبار والتحديثات'),telegramUrl:safeUrl(w.telegramUrl)||'https://t.me/jbhbhg58',updatedAt:nowISO()};
    const tg={...(old.telegram||{})};if(b.telegramEnabled!==undefined)tg.enabled=b.telegramEnabled===true;const validateChat=(x)=>{const v=String(x||'').trim();return !v||/^@?[A-Za-z0-9_]{5,64}$/.test(v)||/^-?\d{5,25}$/.test(v)};
    if(channels.activationChat!==undefined&&!telegramConfig().activationEnvLocked){if(!validateChat(channels.activationChat))return json(res,422,{ok:false,error:'اسم قناة التفعيلات غير صالح'});tg.activationChat=String(channels.activationChat||'').trim();tg.chat=tg.activationChat||tg.chat||'';}
    if(channels.overdueChat!==undefined&&!telegramConfig().overdueEnvLocked){if(!validateChat(channels.overdueChat))return json(res,422,{ok:false,error:'اسم قناة الطلبات المتأخرة غير صالح'});tg.overdueChat=String(channels.overdueChat||'').trim();}
    old.welcomePopup=welcome;old.telegram=tg;writeJSON('settings.json',old);
    let firebaseWelcome=false,firebaseChannels=false,errors=[];
    try{await firebaseWriteJson('config/welcomePopup',welcome,7000);firebaseWelcome=true}catch(e){errors.push('welcome: '+String(e.message||e).slice(0,120))}
    try{const channelData={activationChat:tg.activationChat||'',overdueChat:tg.overdueChat||'',enabled:tg.enabled!==false,updatedAt:nowISO()};await firebaseWriteJson('config/telegramChannels',channelData,7000);TELEGRAM_CHANNELS_REMOTE=channelData;firebaseChannels=true}catch(e){errors.push('channels: '+String(e.message||e).slice(0,120))}
    const durable=(firebaseWelcome&&firebaseChannels)||DATA_IS_EXTERNAL;
    if(!durable)return json(res,503,{ok:false,error:'لم يكتمل الحفظ الدائم. الخادم حفظ نسخة محلية مؤقتة فقط، لكن Firebase رفض حفظ الإعدادات ولا يوجد Railway Volume مؤكد. أصلح صلاحيات كتابة Firebase أو اربط Volume دائماً ثم أعد الحفظ.',welcome,channels:{activationChat:tg.activationChat||telegramConfig().activationChat||'',overdueChat:tg.overdueChat||telegramConfig().overdueChat||''},persisted:false,firebaseWelcome,firebaseChannels,errors});
    return json(res,200,{ok:true,welcome,channels:{activationChat:tg.activationChat||telegramConfig().activationChat||'',overdueChat:tg.overdueChat||telegramConfig().overdueChat||''},persisted:true,firebaseWelcome,firebaseChannels,warning:!firebaseWelcome||!firebaseChannels?'تم الحفظ في مساحة دائمة لكن إحدى نسخ Firebase لم تتحدث. راجع التفاصيل قبل مغادرة الصفحة.':'',errors});
  }
  if(p==='/api/user/refunds' && req.method==='GET'){
    const username=userFromSession(req);if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول لعرض عمليات الاسترداد'});
    try{
      const user=await firebaseUserByUsername(username);if(!user)return json(res,200,{ok:true,user:username,balanceIQD:0,balanceUSD:0,refunds:[],warning:'لم يتم العثور على سجل رصيد المستخدم في Firebase.'});
      const map=user.sadaRefunds&&typeof user.sadaRefunds==='object'?user.sadaRefunds:{};const rows=[];for(const entry of Object.values(map)){if(!entry||typeof entry!=='object')continue;for(const ev of (Array.isArray(entry.events)?entry.events:[]))rows.push({...ev,user:username});}
      const global=readJSON('refunds.json',[]);for(const r of global.filter(x=>String(x.user||'')===username)){if(!rows.some(y=>y.id&&y.id===r.id))rows.push(r)}
      rows.sort((a,b)=>(Date.parse(b.createdAt||'')||0)-(Date.parse(a.createdAt||'')||0));const total=rows.reduce((sum,r)=>sum+Math.max(0,Number(r.amountIQD||0)),0);const balanceIQD=Number(user.balance||0);
      return json(res,200,{ok:true,user:username,balanceIQD,balanceUSD:Number((balanceIQD/FIXED_RATE).toFixed(6)),totalRefundIQD:total,totalRefundUSD:Number((total/FIXED_RATE).toFixed(6)),refunds:rows.slice(0,500)});
    }catch(e){return json(res,502,{ok:false,error:'تعذر قراءة سجل الاسترداد من قاعدة البيانات: '+String(e.message||e).slice(0,150)});}
  }
  if(p==='/api/admin/order-audit/balances' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();const page=Math.max(1,parseInt(urlObj.searchParams.get('page')||'1',10)||1);const limit=Math.max(10,Math.min(100,parseInt(urlObj.searchParams.get('limit')||'50',10)||50));
    let remote={};let remoteOk=false;try{const x=await firebaseGetJson('users',12000);remote=x&&typeof x==='object'&&!Array.isArray(x)?x:{};remoteOk=true}catch(e){if(!DATA_IS_EXTERNAL)return json(res,502,{ok:false,error:'تعذر قراءة أرصدة Firebase بأمان؛ لم نعرض أرقاماً محلية على أنها الأرصدة الحقيقية.',details:String(e.message||e).slice(0,140)})}
    const local=readJSON('users.json',{users:{}}).users||{};const all=new Map();for(const [k,v] of Object.entries(local)){if(v&&typeof v==='object')all.set(k,{...v,username:String(v.username||k)})}for(const [k,v] of Object.entries(remote)){if(v&&typeof v==='object'){const username=String(v.username||k);all.set(username,{...(all.get(username)||{}),...v,username})}}
    const rows=[...all.values()].map(u=>({username:String(u.username||u.u||''),name:String(u.fullName||u.name||u.username||''),email:String(u.email||u.mail||''),balanceIQD:Number(u.balance||0),balanceUSD:Number((Number(u.balance||0)/FIXED_RATE).toFixed(6)),role:String(u.role||'user'),updatedAt:u.updatedAt||u.joined||null})).filter(u=>u.username&&(!q||[u.username,u.name,u.email].join(' ').toLowerCase().includes(q))).sort((a,b)=>b.balanceIQD-a.balanceIQD);
    const stats={totalUsers:all.size,withBalance:rows.filter(x=>x.balanceIQD>0).length,totalBalanceIQD:[...all.values()].reduce((sum,u)=>sum+Number(u.balance||0),0),totalBalanceUSD:0};stats.totalBalanceUSD=Number((stats.totalBalanceIQD/FIXED_RATE).toFixed(6));
    return json(res,200,{ok:true,stats,items:rows.slice((page-1)*limit,page*limit),page,limit,total:rows.length,totalPages:Math.max(1,Math.ceil(rows.length/limit)),source:remoteOk?'firebase':'local-only',warning:remoteOk?'': 'تنبيه: مصدر Firebase غير متاح؛ بيانات العرض محلية وقد لا تعكس الرصيد الحي.'});
  }
  if(p==='/api/admin/order-audit/balances/adjust' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const username=String(b.username||'').trim();const type=String(b.type||'');const reason=String(b.reason||'').trim();const amount=Number(b.amountUsd);
    if(!username||!['charge','deduct','clear'].includes(type)||reason.length<4)return json(res,422,{ok:false,error:'حدد المستخدم ونوع العملية وسبباً واضحاً من 4 أحرف على الأقل'});
    if(type!=='clear'&&(!Number.isFinite(amount)||amount<=0||amount>1000000))return json(res,422,{ok:false,error:'أدخل مبلغاً بالدولار أكبر من صفر'});
    let tx;try{tx=await firebaseTransaction('users/'+firebaseSafeKey(username),current=>{if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};const before=Number(current.balance||0);const amountIQD=type==='clear'?before:Math.round(amount*FIXED_RATE*10000)/10000;if(type==='deduct'&&amountIQD>before)return {write:false,result:{error:'insufficient-balance',balanceIQD:before}};const delta=type==='charge'?amountIQD:type==='deduct'?-amountIQD:-before;const after=Math.max(0,Math.round((before+delta)*10000)/10000);const ledger=Array.isArray(current.adminBalanceLedger)?current.adminBalanceLedger.slice(-199):[];const event={id:crypto.randomUUID(),username,type,amountIQD:Math.abs(delta),amountUSD:Number((Math.abs(delta)/FIXED_RATE).toFixed(6)),beforeIQD:before,afterIQD:after,reason,admin:String(session(req)?.username||ADMIN_USER),createdAt:nowISO()};ledger.push(event);current.balance=after;current.adminBalanceLedger=ledger;current.updatedAt=nowISO();return {write:true,value:current,result:{event,balanceIQD:after}}},10000,8)}catch(e){return json(res,502,{ok:false,error:'تعذر تعديل الرصيد في Firebase: '+String(e.message||e).slice(0,150)})}
    if(tx.result?.error){const status=tx.result.error==='user-not-found'?404:tx.result.error==='insufficient-balance'?409:422;return json(res,status,{ok:false,error:tx.result.error==='user-not-found'?'المستخدم غير موجود في قاعدة Firebase':tx.result.error==='insufficient-balance'?'رصيد المستخدم أقل من مبلغ الخصم':'تعذر تنفيذ العملية'})}
    const ev=tx.result.event;appendJsonLedger('balance_ledger.json',{...ev,admin:String(session(req)?.username||ADMIN_USER)});let local=readJSON('users.json',{users:{}});if(local.users?.[username]){local.users[username].balance=tx.result.balanceIQD;writeJSON('users.json',local)}
    return json(res,200,{ok:true,event:ev,balanceIQD:tx.result.balanceIQD,balanceUSD:Number((tx.result.balanceIQD/FIXED_RATE).toFixed(6))});
  }
  if(p==='/api/config'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); return json(res,200,{appName:APP_NAME,version:APP_VERSION,buildId:BUILD_ID,currency:'USD',exchangeRate:FIXED_RATE,fixedRecharge:'5000 IQD = 4 USD',rateTable:[1000,2000,3000,4000,5000,6000,7000,8000,9000,10000].map(i=>({iqd:i,usd:i/FIXED_RATE})),supportWhatsappUrl:waUrl,supportWhatsappNumber:normalizeWhatsAppNumber(waUrl),telegramChannelUrl:'https://t.me/jbhbhg58'}); }
  if(p==='/api/auth/google-config'&&req.method==='GET'){return json(res,200,{ok:true,enabled:!!String(process.env.GOOGLE_CLIENT_ID||'').trim(),clientId:String(process.env.GOOGLE_CLIENT_ID||'').trim()});}
  if(p==='/api/auth/captcha'&&req.method==='GET'){const wait=rateLimit(req,'captcha');if(wait)return json(res,429,{ok:false,error:'طلبات تحقق كثيرة؛ أعد المحاولة بعد قليل.'},{'Retry-After':String(wait)});return json(res,200,{ok:true,...issueMathCaptcha(req)});}
  if(p==='/api/auth/google'&&req.method==='POST'){
    if(!requestHasSameOrigin(req))return json(res,403,{ok:false,error:'رفض تسجيل الدخول بسبب اختلاف مصدر الطلب؛ أعد فتح الموقع الرسمي.'});
    const wait=rateLimit(req,'auth');if(wait)return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req);const cap=consumeMathCaptcha(req,b);if(cap)return json(res,422,{ok:false,error:cap,captchaFailed:true});
    if(!String(b.credential||''))return json(res,422,{ok:false,error:'رمز Google مفقود.'});
    try{const out=await googleAuthLogin(String(b.credential));const role='user';const sessionToken=setSession(res,{role,username:out.username});const safe=cleanGoogleUser(out.user);return json(res,200,{ok:true,role,username:out.username,user:safe,sessionToken,authProvider:'google',firebaseSaved:out.firebaseSaved});}
    catch(e){const code=Number(e.statusCode)||(/invalid|token|audience|expired|signature/i.test(String(e.message||''))?401:502);return json(res,code,{ok:false,error:code===502?'تعذر الاتصال بخدمة التحقق من Google؛ حاول مرة أخرى.':String(e.message||'فشل التحقق من Google')});}
  }
  if(p==='/api/auth' && req.method==='POST'){
    const wait=rateLimit(req,'auth'); if(wait) return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req);const captchaError=consumeMathCaptcha(req,b);if(captchaError)return json(res,422,{ok:false,error:captchaError,captchaFailed:true});
    const u=String(b.username||'').trim(),pw=String(b.password||'');
    if(String(b.action||'')==='register'){
      const name=String(b.name||'').trim().replace(/\s+/g,' ');
      if(!/^[a-zA-Z0-9]{5,32}$/.test(u)) return json(res,422,{ok:false,error:'اسم المستخدم يجب أن يكون 5 أحرف أو أرقام إنجليزية على الأقل، من دون مسافات.'});
      if(name.length<3||name.length>80||!/\p{Script=Arabic}/u.test(name))return json(res,422,{ok:false,error:'اكتب اسمك الكامل باللغة العربية.'});
      if(pw.length<8) return json(res,422,{ok:false,error:'كلمة المرور يجب أن تكون 8 أحرف على الأقل'});
      const email=normalizeEmail(b.email);if(!validEmail(email))return json(res,422,{ok:false,error:'أدخل بريدك الإلكتروني الصحيح.'});
      if(u.toLowerCase()===ADMIN_USER.toLowerCase()) return json(res,409,{ok:false,error:'اسم المستخدم محجوز'});
      const store=readJSON('users.json',{users:{}});if(Object.keys(store.users||{}).some(k=>k.toLowerCase()===u.toLowerCase()))return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً'});
      let remoteCheck;try{remoteCheck=await findRemoteUserByUsername(u);}catch(e){return json(res,503,{ok:false,error:'تعذر التحقق من الحسابات القديمة في قاعدة البيانات. لم ننشئ حساباً مكرراً؛ أعد المحاولة بعد قليل.'});}
      if(remoteCheck)return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً في قاعدة الحسابات الحالية'});
      let emailAccount;try{emailAccount=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر التحقق من البريد في قاعدة البيانات؛ لم ننشئ حساباً جديداً.'});}
      if(emailAccount)return json(res,409,{ok:false,error:'هذا البريد مرتبط بحساب موجود بالفعل. سجّل الدخول باستخدامه أو باسم المستخدم.'});
      const now=nowISO();
      const user={username:u,name,email,emailVerified:false,passwordHash:hashPassword(pw),balance:0,level:'مبتدئ',telegram:'',phone:'',joined:now,totalSpent:0,totalOrders:0,role:'user'};
      store.users[u]=user;writeJSON('users.json',store);
      let firebaseSaved=false;
      try{await firebaseWriteJson('users/'+firebaseSafeKey(u),user,5000);firebaseSaved=true;}
      catch(e){console.warn('New account Firebase mirror unavailable:',String(e.message||e).slice(0,120));}
      if(!firebaseSaved&&!DATA_IS_EXTERNAL){delete store.users[u];writeJSON('users.json',store);return json(res,503,{ok:false,error:'تعذر التأكد من حفظ الحساب بشكل دائم. لم نكمل التسجيل حتى لا يضيع الحساب؛ أعد المحاولة بعد استقرار قاعدة البيانات.'});}
      const sessionToken=setSession(res,{role:'user',username:u});const clean={...user};delete clean.password;delete clean.passwordHash;
      return json(res,200,{ok:true,role:'user',username:u,user:clean,sessionToken,emailVerified:false,message:'تم إنشاء حسابك بنجاح. يمكنك الدخول باسم المستخدم أو البريد الإلكتروني.'});
    }
    if(u.toLowerCase()===ADMIN_USER.toLowerCase()&&adminPasswordValid(pw)){const sessionToken=setSession(res,{role:'admin',username:ADMIN_USER});return json(res,200,{ok:true,role:'admin',username:ADMIN_USER,sessionToken});}
    const store=readJSON('users.json',{users:{}});let actualUsername=u;let user=store.users?.[u]||null;
    if(!user){const found=Object.entries(store.users||{}).find(([key,val])=>key.toLowerCase()===u.toLowerCase()||String(val?.username||'').toLowerCase()===u.toLowerCase());if(found){actualUsername=found[0];user=found[1];}}
    let remoteRecord=null,remoteLookupFailed=false;
    if(!user){try{remoteRecord=await findRemoteUserByUsername(u);if(remoteRecord){actualUsername=remoteRecord.username||u;user=remoteRecord.user;}}catch(e){remoteLookupFailed=true;console.warn('Legacy Firebase login lookup failed:',String(e.message||e).slice(0,120));}}
    if(!user&&validEmail(u)){
      try{const foundByEmail=await findAccountByEmail(u);if(foundByEmail&&foundByEmail.source!=='admin'){actualUsername=String(foundByEmail.username||foundByEmail.user?.username||u);user=foundByEmail.user;remoteRecord={username:actualUsername,user,firebasePath:foundByEmail.firebasePath||('users/'+firebaseSafeKey(actualUsername))};}}
      catch(e){remoteLookupFailed=true;console.warn('Email login lookup failed:',String(e.message||e).slice(0,120));}
    }
    if(user&&verifyPassword(pw,user.passwordHash||user.password||user.passHash||user.pass||'')){
      // Mirror a remote-only legacy account locally without replacing its financial/order fields.
      if(!store.users[actualUsername]||!String(user.passwordHash||'').startsWith('scrypt$')){const upgraded={...(store.users[actualUsername]||user),...user,username:actualUsername};if(!String(user.passwordHash||'').startsWith('scrypt$'))upgraded.passwordHash=hashPassword(pw);delete upgraded.password;delete upgraded.pass;delete upgraded.passHash;store.users[actualUsername]=upgraded;writeJSON('users.json',store);
        if(remoteRecord&&remoteRecord.firebasePath&&!String(user.passwordHash||'').startsWith('scrypt$')){try{await firebasePatchJson(remoteRecord.firebasePath,{passwordHash:upgraded.passwordHash,password:null,pass:null,passHash:null,passwordUpdatedAt:nowISO()},5000);}catch(e){console.warn('Legacy password hash remote migration skipped:',String(e.message||e).slice(0,100));}}
      }
      const localUser=readJSON('users.json',{users:{}}).users?.[actualUsername]||user;
      const sessionToken=setSession(res,{role:localUser.role==='admin'?'admin':'user',username:actualUsername});const clean={...localUser};delete clean.password;delete clean.passwordHash;delete clean.pass;delete clean.passHash;
      return json(res,200,{ok:true,role:localUser.role==='admin'?'admin':'user',username:actualUsername,user:clean,sessionToken,legacyAccountRecovered:!Boolean(store.users?.[u])});
    }
    if(remoteLookupFailed)return json(res,503,{ok:false,error:'تعذر الاتصال بقاعدة الحسابات للتحقق من حسابك القديم. حسابك لم يُحذف؛ حاول مرة أخرى بعد قليل.'});
    if(user&&!String(user.passwordHash||user.password||user.passHash||user.pass||''))return json(res,409,{ok:false,error:'تم العثور على سجل حسابك القديم، لكن سجل كلمة المرور غير متوفر لهذا الحساب. لا تنشئ حساباً مكرراً؛ استخدم استعادة كلمة المرور إذا كان البريد موثقاً أو تواصل مع الدعم.'});
    return json(res,401,{ok:false,error:'بيانات الدخول غير صحيحة'});
  }
  if(p==='/api/auth/forgot-password' && req.method==='POST'){
    const wait=rateLimit(req,'email');if(wait)return json(res,429,{ok:false,error:'طلبات الاستعادة كثيرة؛ أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req),email=normalizeEmail(b.email);if(!validEmail(email))return json(res,422,{ok:false,error:'أدخل عنوان بريد إلكتروني صحيحاً.'});
    let account=null;try{account=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر فحص قاعدة الحسابات الآن. لم نغيّر أي حساب؛ أعد المحاولة بعد قليل.'});}
    // Same public response for existing and unknown emails to reduce account enumeration.
    if(!account)return json(res,200,{ok:true,message:'إذا كان البريد مرتبطاً بحساب، فستصلك رسالة استعادة.'});
    if(account.source==='admin'&&(process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD_HASH))return json(res,503,{ok:false,error:'كلمة مرور الإدارة مضبوطة من متغيرات الاستضافة؛ حدّث ADMIN_PASSWORD أو ADMIN_PASSWORD_HASH من Railway.'});
    try{await beginEmailChallenge(email,'reset',account.username,'استعادة كلمة المرور');return json(res,200,{ok:true,message:'إذا كان البريد مرتبطاً بحساب، فستصلك رسالة استعادة.'});}
    catch(e){return json(res,Number(e.statusCode)||502,{ok:false,error:String(e.message||'تعذر إرسال رسالة الاستعادة').slice(0,260)});}
  }
  if(p==='/api/auth/reset-password' && req.method==='POST'){
    const wait=rateLimit(req,'email');if(wait)return json(res,429,{ok:false,error:'محاولات كثيرة؛ أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req),email=normalizeEmail(b.email),code=String(b.code||''),newPassword=String(b.newPassword||'');if(!validEmail(email)||!/^[0-9]{6}$/.test(code))return json(res,422,{ok:false,error:'أدخل البريد ورمز التحقق المكوّن من 6 أرقام.'});if(newPassword.length<8)return json(res,422,{ok:false,error:'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.'});
    const challengeStore=readJSON('email_challenges.json',{}),challenge=challengeStore[emailChallengeKey(email,'reset')];if(!challenge||!challenge.username)return json(res,422,{ok:false,error:'أرسل رمز استعادة جديداً أولاً.'});
    if(challenge.username===ADMIN_USER){if(process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD_HASH)return json(res,409,{ok:false,error:'كلمة مرور الإدارة تُدار من Railway Variables؛ لم يتغير شيء.'});const verified=consumeEmailChallenge(email,'reset',code,challenge.username);if(!verified.ok)return json(res,422,{ok:false,error:verified.error});const cfg=readJSON('settings.json',{});cfg.adminPasswordHash=hashPassword(newPassword);cfg.adminPasswordUpdatedAt=nowISO();writeJSON('settings.json',cfg);return json(res,200,{ok:true,message:'تم تغيير كلمة مرور الإدارة. سجّل الدخول بكلمة المرور الجديدة.'});}
    const usersStore=readJSON('users.json',{users:{}});let localKey=Object.keys(usersStore.users||{}).find(k=>k===challenge.username)||Object.keys(usersStore.users||{}).find(k=>k.toLowerCase()===String(challenge.username).toLowerCase());let user=localKey?usersStore.users[localKey]:null;let resetFirebasePath=localKey?'users/'+firebaseSafeKey(localKey):'';let remoteRecord=null;
    if(!user){try{remoteRecord=await findRemoteUserByUsername(challenge.username);if(remoteRecord){localKey=remoteRecord.username||challenge.username;resetFirebasePath=remoteRecord.firebasePath||('users/'+firebaseSafeKey(localKey));user={...remoteRecord.user,username:localKey};usersStore.users[localKey]=user;}}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل سجل الحساب القديم من قاعدة البيانات؛ لم تتغير كلمة المرور. أعد إرسال رمز جديد لاحقاً.'});}}
    if(!user||normalizeEmail(user.email||user.mail||user.emailAddress)!==email)return json(res,409,{ok:false,error:'تعذر مطابقة البريد مع حسابك؛ لم تتغير كلمة المرور.'});
    const verified=consumeEmailChallenge(email,'reset',code,challenge.username);if(!verified.ok)return json(res,422,{ok:false,error:verified.error});
    if(!remoteRecord){try{remoteRecord=await findRemoteUserByUsername(localKey);}catch(e){return json(res,503,{ok:false,error:'تعذر التأكد من قاعدة الحسابات؛ لم تتغير كلمة المرور. أرسل رمزاً جديداً بعد عودة الاتصال.'});}}
    if(!remoteRecord&&!DATA_IS_EXTERNAL)return json(res,503,{ok:false,error:'لا يوجد تخزين دائم مؤكد لتغيير كلمة المرور بأمان. اربط Railway Volume أو أصلح Firebase ثم أرسل رمزاً جديداً.'});
    const newHash=hashPassword(newPassword),updatedAt=nowISO();
    if(remoteRecord){try{await firebasePatchJson(remoteRecord.firebasePath||resetFirebasePath||('users/'+firebaseSafeKey(localKey)),{passwordHash:newHash,password:null,pass:null,passHash:null,passwordUpdatedAt:updatedAt},7000);}catch(e){return json(res,502,{ok:false,error:'تعذر حفظ كلمة المرور الجديدة في قاعدة الحسابات؛ لم نغيّر النسخة المحلية حتى لا تتعارض الحسابات. أرسل رمزاً جديداً وأعد المحاولة.'});}}
    user.passwordHash=newHash;delete user.password;delete user.pass;delete user.passHash;user.passwordUpdatedAt=updatedAt;usersStore.users[localKey]=user;writeJSON('users.json',usersStore);
    return json(res,200,{ok:true,message:'تم تغيير كلمة المرور بنجاح.',remoteSynced:!!remoteRecord,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'check-persistence'});
  }
  if(p==='/api/account/email/request' && req.method==='POST'){
    if(!requestHasSameOrigin(req))return json(res,403,{ok:false,error:'رفض الطلب بسبب اختلاف مصدر الصفحة؛ أعد فتح الموقع الرسمي.'});const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'سجّل الدخول أولاً.'});const wait=rateLimit(req,'email');if(wait)return json(res,429,{ok:false,error:'طلبات البريد كثيرة؛ أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req),email=normalizeEmail(b.email);if(!validEmail(email))return json(res,422,{ok:false,error:'أدخل البريد الجديد بصورة صحيحة.'});let account;try{account=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر فحص البريد في قاعدة البيانات.'});}if(account&&account.username.toLowerCase()!==String(s.username).toLowerCase())return json(res,409,{ok:false,error:'البريد مستخدم في حساب آخر.'});
    try{await beginEmailChallenge(email,'change-email',s.username,'تأكيد البريد الجديد');return json(res,200,{ok:true,message:'تم إرسال رمز حقيقي إلى البريد الجديد.'});}catch(e){return json(res,Number(e.statusCode)||502,{ok:false,error:String(e.message||'تعذر إرسال رمز البريد').slice(0,260)});}
  }
  if(p==='/api/account/email/confirm' && req.method==='POST'){
    if(!requestHasSameOrigin(req))return json(res,403,{ok:false,error:'رفض الطلب بسبب اختلاف مصدر الصفحة؛ أعد فتح الموقع الرسمي.'});const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'سجّل الدخول أولاً.'});const b=await bodyJSON(req),email=normalizeEmail(b.email),code=String(b.code||'');if(!validEmail(email))return json(res,422,{ok:false,error:'البريد الجديد غير صالح.'});const check=consumeEmailChallenge(email,'change-email',code,s.username);if(!check.ok)return json(res,422,{ok:false,error:check.error});
    let collision=null;try{collision=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر التأكد من أن البريد غير مستخدم لأن قاعدة البيانات غير متاحة؛ لم يتغير البريد.'});}if(collision&&String(collision.username).toLowerCase()!==String(s.username).toLowerCase())return json(res,409,{ok:false,error:'البريد أصبح مرتبطاً بحساب آخر.'});
    const store=readJSON('users.json',{users:{}});let key=Object.keys(store.users||{}).find(k=>k===s.username)||Object.keys(store.users||{}).find(k=>k.toLowerCase()===String(s.username).toLowerCase());let user=key?store.users[key]:null;let remoteRecord=null;
    if(!user){try{remoteRecord=await findRemoteUserByUsername(s.username);if(remoteRecord){key=remoteRecord.username||s.username;user={...remoteRecord.user,username:key};}}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل الحساب القديم من قاعدة البيانات؛ لم يتغير البريد.'});}}
    else {try{remoteRecord=await findRemoteUserByUsername(key);}catch(e){return json(res,503,{ok:false,error:'تعذر التأكد من مزامنة الحساب مع قاعدة البيانات؛ لم يتغير البريد.'});}}
    if(!user)return json(res,404,{ok:false,error:'الحساب غير موجود في مخزن الحسابات الحالي؛ لم يتغير البريد.'});
    const updatedAt=nowISO();if(remoteRecord){try{await firebasePatchJson(remoteRecord.firebasePath||('users/'+firebaseSafeKey(key)),{email,emailVerified:true,emailVerifiedAt:updatedAt,updatedAt},7000);}catch(e){return json(res,502,{ok:false,error:'تعذر حفظ البريد الجديد في قاعدة الحسابات؛ لم نغيّر نسخة الحساب المحلية. أرسل رمزاً جديداً وأعد المحاولة.'});}}else if(!DATA_IS_EXTERNAL)return json(res,503,{ok:false,error:'لا يوجد تخزين دائم مؤكد لتغيير البريد بأمان. اربط Railway Volume أو أصلح Firebase ثم أرسل رمزاً جديداً.'});
    user.email=email;user.emailVerified=true;user.emailVerifiedAt=updatedAt;user.updatedAt=updatedAt;store.users[key]=user;writeJSON('users.json',store);
    return json(res,200,{ok:true,email,emailVerified:true,remoteSynced:!!remoteRecord,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'check-persistence'});
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
    const b=await bodyJSON(req); const prov=await resolveProviderDiagnosticsInput(b);
    if(!/^https?:\/\//i.test(prov.url)||!prov.key)return json(res,422,{ok:false,error:'رابط API أو مفتاح API غير صالح. إذا كان المزود محفوظاً، أعد تحميل قائمة المزودين ثم أعد الاختبار.'});
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
  if(p==='/api/admin/support-notify' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{ok:false,error:'طلبات الإشعارات كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req);const username=String(b.username||'').trim().slice(0,150);const message=String(b.message||'').trim().slice(0,1200);const chatMessageId=String(b.chatMessageId||'').trim().slice(0,180);
    if(!username||!message||!chatMessageId)return json(res,422,{ok:false,error:'اسم المستخدم والرسالة ومعرف الرسالة مطلوبة'});
    const id='SUP'+sha256(username+'|'+chatMessageId).slice(0,24);
    const notification=createUserNotification(username,{id,type:'support_reply',title:'رد جديد من الدعم الفني',message:message.slice(0,380),meta:{chatMessageId}});
    return json(res,200,{ok:true,notificationId:notification?.id||id});
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
    const s=session(req); if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const all=await listUserNotifications(s.username);const includeRead=urlObj.searchParams.get('all')==='1';const items=includeRead?all:all.filter(n=>!n.read);return json(res,200,{ok:true,notifications:items,unreadCount:all.filter(n=>!n.read).length,checkedAt:nowISO()});
  }
  if(p==='/api/notifications/seen' && req.method==='POST'){
    const s=session(req); if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const b=await bodyJSON(req); const id=String(b.id||''); if(!id)return json(res,422,{ok:false,error:'معرف الإشعار مطلوب'}); const seen=readNotificationSeen(); seen[s.username]=seen[s.username]||{}; seen[s.username][id]=nowISO(); writeNotificationSeen(seen);firebaseWriteJson('userNotificationSeen/'+firebaseSafeKey(s.username)+'/'+id,nowISO(),4000).catch(()=>{});const all=readJSON('user_notifications.json',{});const rows=Array.isArray(all[s.username])?all[s.username]:[];let found=false;for(let i=0;i<rows.length;i++)if(String(rows[i].id)===id){rows[i]={...rows[i],read:true,readAt:nowISO()};found=true;}if(found){all[s.username]=rows;writeJSON('user_notifications.json',all);firebasePatchJson('userNotifications/'+firebaseSafeKey(s.username)+'/'+id,{read:true,readAt:nowISO()},4000).catch(()=>{});} return json(res,200,{ok:true});
  }
  if(p==='/api/user/summary' && req.method==='GET'){
    const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const uname=String(s.username||'');
    const localOrders=readJSON('orders.json',[]).filter(x=>x&&!x.event&&String(x.user||x.username||'')===uname);
    const orderMap=new Map();
    const addSummaryOrder=(o,sourceKey='')=>{const id=String(o.id||o.siteOrderId||o.localId||o.orderId||o.order_id||o.providerOrderId||o.smmpartyOrderId||sourceKey||o.createdAt||'');if(!id)return;const key=uname+'|'+id;const prior=orderMap.get(key)||{};const usdRaw=o.chargeUsd??o.totalUsd??o.priceUsd??o.amountUsd;const usd=Number(usdRaw);const iqRaw=o.totalIQD??o.total??o.amountIQD??o.chargeIqd;const iq=Number(iqRaw);const amountUsd=Number.isFinite(usd)&&usd>=0?usd:prior.amountUsd;const totalIQD=Number.isFinite(iq)&&iq>0?iq:(Number.isFinite(amountUsd)&&amountUsd>=0?Number((amountUsd*FIXED_RATE).toFixed(4)):prior.totalIQD||0);orderMap.set(key,{...prior,id,user:uname,totalIQD,amountUsd});};
    for(const o of localOrders)addSummaryOrder(o);
    try{const fbOrders=await firebaseGetJson('orders',4500);if(fbOrders&&typeof fbOrders==='object'){const entries=Array.isArray(fbOrders)?fbOrders.map((v,i)=>[String(i),v]):Object.entries(fbOrders);for(const [key,o] of entries){if(!o||typeof o!=='object'||o.event||String(o.user||o.username||o.userName||'')!==uname)continue;addSummaryOrder(o,key);}}}catch(e){console.warn('user summary remote orders unavailable:',String(e.message||e).slice(0,100))}
    const orders=[...orderMap.values()];const spentIQD=orders.reduce((a,o)=>a+Math.max(0,Number(o.totalIQD||((Number(o.amountUsd)||0)*FIXED_RATE))||0),0);
    const refs=readJSON('refunds.json',[]).filter(x=>String(x.user||'')===uname);let refundedIQD=refs.reduce((a,r)=>a+Math.max(0,Number(r.amountIQD||0)),0);let remoteUser=null;try{remoteUser=await firebaseGetJson('users/'+firebaseSafeKey(uname),3500)}catch(_){}if(remoteUser?.sadaRefunds&&typeof remoteUser.sadaRefunds==='object'){const remoteRefunded=Object.values(remoteUser.sadaRefunds).reduce((a,r)=>a+Math.max(0,Number(r?.totalIQD||0)),0);refundedIQD=Math.max(refundedIQD,remoteRefunded)}
    const er=readJSON('earn_requests.json',[]).filter(x=>String(x.user||'')===uname&&x.status==='approved');const rewardsUSD=Math.max(Number(remoteUser?.sadaEarnTotalUSD||0),er.reduce((a,r)=>a+Math.max(0,Number(r.rewardUSD||0)),0));const localBalance=readJSON('users.json',{users:{}}).users?.[uname]?.balance;const balanceIQD=Number(remoteUser?.balance??localBalance??s.balance??0);
    return json(res,200,{ok:true,orders:orders.length,spentIQD:Number(spentIQD.toFixed(4)),refundedIQD:Number(refundedIQD.toFixed(4)),rewardsUSD:Number(rewardsUSD.toFixed(6)),balanceIQD,currency:'IQD',checkedAt:nowISO()});
  }
  if(p==='/api/earn/requests' && req.method==='GET'){
    const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});const rows=readJSON('earn_requests.json',[]).filter(x=>String(x.user||'')===String(s.username));let remote=[];try{const v=await firebaseGetJson('earnRequestsByUser/'+firebaseSafeKey(s.username),4000);if(v&&typeof v==='object')remote=(Array.isArray(v)?v:Object.values(v)).filter(x=>x&&typeof x==='object')}catch(_){}const m=new Map();for(const r of [...remote,...rows])if(r.id)m.set(String(r.id),{...m.get(String(r.id)),...r});return json(res,200,{ok:true,requests:[...m.values()].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)).slice(0,100),maxRewardUSD:50});
  }
  if(p==='/api/earn/requests' && req.method==='POST'){
    const wait=rateLimit(req,'auth');if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، حاول لاحقاً'},{'Retry-After':String(wait)});const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});const b=await bodyJSON(req);const platform=String(b.platform||'').toLowerCase();const link=String(b.videoUrl||b.link||'').trim();const followers=Number(b.followers),views=Number(b.views),notes=String(b.notes||'').trim().slice(0,500);let u;try{u=new URL(link)}catch(_){return json(res,422,{ok:false,error:'رابط الفيديو غير صالح'})}const domains={tiktok:['tiktok.com'],youtube:['youtube.com','youtu.be'],instagram:['instagram.com'],facebook:['facebook.com','fb.watch']};if(u.protocol!=='https:'||!(domains[platform]||[]).some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))return json(res,422,{ok:false,error:'اختر المنصة الصحيحة وأدخل رابط فيديو HTTPS مطابقاً لها'});if(!Number.isInteger(followers)||followers<100)return json(res,422,{ok:false,error:'يجب أن يكون لديك 100 مشترك/متابع على الأقل'});if(!Number.isInteger(views)||views<100||views>10000)return json(res,422,{ok:false,error:'عدد المشاهدات المقبول من 100 إلى 10,000'});const rewardUSD=views<500?1.5:views<2000?2:5;const localRows=readJSON('earn_requests.json',[]);if(localRows.some(x=>String(x.user||'')===String(s.username)&&x.status==='pending_review'&&String(x.videoUrl||'')===link))return json(res,409,{ok:false,error:'هذا الفيديو لديه طلب مراجعة قيد الانتظار'});let total=localRows.filter(x=>String(x.user||'')===String(s.username)&&['pending_review','approved'].includes(x.status)).reduce((a,x)=>a+Number(x.rewardUSD||0),0);try{const rem=await firebaseGetJson('earnRequestsByUser/'+firebaseSafeKey(s.username),3000);if(rem&&typeof rem==='object')total=Math.max(total,Object.values(rem).filter(x=>x&&['pending_review','approved'].includes(x.status)).reduce((a,x)=>a+Number(x.rewardUSD||0),0))}catch(_){}if(total+rewardUSD>50)return json(res,422,{ok:false,error:'تجاوزت حد المكافآت المتاحة 50 دولاراً لهذا الحساب'});const id='ER'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(3).toString('hex').toUpperCase();const row={id,user:String(s.username),videoUrl:u.toString(),platform,followers,views,notes,rewardUSD,status:'pending_review',createdAt:nowISO(),updatedAt:nowISO()};localRows.unshift(row);writeJSON('earn_requests.json',localRows.slice(0,10000));let remoteSaved=false,remoteError='';try{await firebaseWriteJson('earnRequests/'+id,row,5000);const urow={...row};delete urow.user;await firebaseWriteJson('earnRequestsByUser/'+firebaseSafeKey(s.username)+'/'+id,urow,5000);remoteSaved=true}catch(e){remoteError=String(e.message||e).slice(0,120)}if(!remoteSaved&&!DATA_IS_EXTERNAL){const arr=readJSON('earn_requests.json',[]).filter(x=>x.id!==id);writeJSON('earn_requests.json',arr);return json(res,503,{ok:false,error:'تعذر حفظ طلب المكافأة في قاعدة بيانات دائمة. أعد المحاولة بعد فحص Firebase أو مساحة التخزين.'})}createUserNotification(s.username,{type:'earn_request',status:'pending_review',title:'تم استلام طلب رصيد مجاني',message:'تم تسجيل طلب مكافأتك بقيمة '+rewardUSD.toFixed(2)+' دولار وهو بانتظار مراجعة الإدارة.'});return json(res,201,{ok:true,request:row,persistedRemotely:remoteSaved,warning:remoteSaved?'':'تم حفظ الطلب في التخزين المحلي الدائم لكن تعذر مزامنته مع Firebase.'});
  }
  if(p==='/api/admin/earn-requests' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const page=Math.max(1,Number(urlObj.searchParams.get('page')||1)),limit=Math.min(100,Math.max(10,Number(urlObj.searchParams.get('limit')||30))),q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();let rows=readJSON('earn_requests.json',[]);try{const v=await firebaseGetJson('earnRequests',5000);if(v&&typeof v==='object'){const m=new Map(rows.map(x=>[String(x.id),x]));for(const x of Object.values(v))if(x&&typeof x==='object'&&x.id)m.set(String(x.id),{...m.get(String(x.id)),...x});rows=[...m.values()]}}catch(_){}rows=rows.filter(x=>!q||[x.id,x.user,x.videoUrl,x.platform,x.status].some(v=>String(v||'').toLowerCase().includes(q))).sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));return json(res,200,{ok:true,total:rows.length,page,limit,requests:rows.slice((page-1)*limit,page*limit)});
  }
  if(p==='/api/admin/earn-requests/decision' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req),id=String(b.id||''),action=String(b.action||''),reason=String(b.reason||'').trim().slice(0,400);if(!id||!['approve','reject'].includes(action))return json(res,422,{ok:false,error:'بيانات القرار غير مكتملة'});let rows=readJSON('earn_requests.json',[]),row=rows.find(x=>String(x.id)===id);if(!row){try{row=await firebaseGetJson('earnRequests/'+id,4000)}catch(_){}}if(!row||!row.user)return json(res,404,{ok:false,error:'طلب المكافأة غير موجود'});if(row.status==='approved')return json(res,200,{ok:true,alreadyProcessed:true,request:row});if(row.status==='rejected')return json(res,409,{ok:false,error:'تم رفض هذا الطلب سابقاً'});if(action==='reject'){row={...row,status:'rejected',reviewedAt:nowISO(),reviewedBy:session(req)?.username||'admin',reviewReason:reason};}else{const reward=Math.max(0,Number(row.rewardUSD||0));if(reward<=0||reward>50)return json(res,422,{ok:false,error:'قيمة المكافأة غير صالحة'});let tx;try{tx=await firebaseTransaction('users/'+firebaseSafeKey(row.user),current=>{if(!current||typeof current!=='object')return {write:false,result:{error:'user-record-not-found'}};const credits=current.sadaEarnCredits&&typeof current.sadaEarnCredits==='object'?{...current.sadaEarnCredits}:{};if(credits[id])return {write:false,result:{already:true,balanceIQD:Number(current.balance||0)}};const lifetime=Number(current.sadaEarnTotalUSD||0);if(lifetime+reward>50.000001)return {write:false,result:{error:'تجاوز حد المكافآت 50 دولاراً'}};const before=Number(current.balance||0),amountIQD=Number((reward*FIXED_RATE).toFixed(4)),after=Number((before+amountIQD).toFixed(4)),at=nowISO();credits[id]={requestId:id,rewardUSD:reward,amountIQD,createdAt:at};current.sadaEarnCredits=credits;current.sadaEarnTotalUSD=Number((lifetime+reward).toFixed(6));current.balance=after;current.updatedAt=at;return {write:true,value:current,result:{credited:true,balanceBeforeIQD:before,balanceIQD:after,amountIQD,rewardUSD:reward}}},10000);if(tx.result?.error)return json(res,409,{ok:false,error:tx.result.error});}catch(e){return json(res,503,{ok:false,error:'تعذر تحديث رصيد المستخدم في قاعدة البيانات: '+String(e.message||e).slice(0,140)})}row={...row,status:'approved',reviewedAt:nowISO(),reviewedBy:session(req)?.username||'admin',reviewReason:reason};if(tx.result?.credited){appendJsonLedger('balance_ledger.json',{user:row.user,type:'earn_reward',amountUSD:reward,amountIQD:tx.result.amountIQD,after:tx.result.balanceIQD,reason:'مكافأة رصيد مجاني بعد مراجعة الإدارة',admin:session(req)?.username||'admin',reference:id,createdAt:nowISO()});}else if(!tx.result?.already)return json(res,503,{ok:false,error:'لم يتم تأكيد عملية رصيد المكافأة.'});}
    const idx=rows.findIndex(x=>String(x.id)===id);if(idx>=0)rows[idx]=row;else rows.unshift(row);writeJSON('earn_requests.json',rows.slice(0,10000));try{await firebaseWriteJson('earnRequests/'+id,row,5000);const ur={...row};delete ur.user;await firebaseWriteJson('earnRequestsByUser/'+firebaseSafeKey(row.user)+'/'+id,ur,5000)}catch(e){if(!DATA_IS_EXTERNAL)return json(res,503,{ok:false,error:'تم تحديث السجل المحلي لكن تعذر تثبيته في Firebase؛ تحقق من قاعدة البيانات.'})}createUserNotification(row.user,{type:'earn_decision',status:row.status,title:row.status==='approved'?'تمت الموافقة على مكافأتك':'تمت مراجعة طلب المكافأة',message:row.status==='approved'?'تم اعتماد مكافأتك وإضافة '+Number(row.rewardUSD||0).toFixed(2)+' دولار إلى رصيدك.':'تم رفض طلب المكافأة. '+reason});return json(res,200,{ok:true,request:row});
  }

  if(p==='/api/provider/balance' && req.method==='GET'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات الرصيد كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح — جلسة الإدارة غير صالحة'});
    const requested=String(urlObj.searchParams.get('provider')||''); await ensureProviderRuntime(requested);
    const {prov,pid}=getProviderById(requested,{allowSingleFallback:true}); if(!prov?.url||!prov?.key)return json(res,404,{ok:false,error:'المزود غير موجود أو بيانات URL/Key غير مكتملة'});
    try{const d=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(d); if(balance===null)return json(res,502,{ok:false,error:'المزود لم يرجع قيمة رصيد صالحة'}); return json(res,200,{ok:true,providerId:pid,providerName:prov.name||pid,balance,currency:normalizeProviderCurrency(d),checkedAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/provider/test' && req.method==='POST'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات اختبار المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const prov=await resolveProviderDiagnosticsInput(b);
    if(!/^https?:\/\//i.test(prov.url)||!prov.key) return json(res,422,{ok:false,error:'رابط API أو مفتاح API غير صالح. إذا كان المزود محفوظاً، أعد تحميل قائمة المزودين ثم أعد الاختبار.'});
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
    const orderSession=session(req);
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const isAdminSession=orderSession?.role==='admin';
    const b=await bodyJSON(req); const providerId=String(b.providerId||'').trim(); const serviceId=String(b.serviceId||'').trim(); const firebaseServiceKey=String(b.firebaseServiceKey||'').trim(); const link=String(b.link||'').trim(); const quantity=Number(b.quantity); const localId=String(b.localId||'').trim();
    if(!providerId||!serviceId||!link||!Number.isInteger(quantity)||quantity<=0)return json(res,422,{ok:false,error:'بيانات الطلب غير مكتملة',stage:'validate'});
    if(!/^https?:\/\//i.test(link))return json(res,422,{ok:false,error:'الرابط غير صالح',stage:'validate'});
    const existing=readJSON('orders.json',[]).find(x=>String(x.user||'')===username&&String(x.localId||'')===localId&&localId&&String(x.providerOrderId||''));
    if(existing){const existingSiteId=String(existing.id||existing.localId||localId||'');const providerTrackingToken=issueProviderOrderTrackingToken({username,providerId:String(existing.providerId||providerId),providerOrderId:String(existing.providerOrderId),siteOrderId:existingSiteId});return json(res,200,{ok:true,idempotent:true,siteOrderId:existingSiteId,providerId:String(existing.providerId||providerId),providerName:String(existing.providerName||''),providerOrderId:String(existing.providerOrderId),providerTrackingToken,providerRaw:existing.providerRaw||null,createdAt:existing.createdAt||new Date().toISOString()});}
    const svc=await authoritativeWebsiteService(providerId,serviceId,firebaseServiceKey);
    if(!svc)return json(res,409,{ok:false,error:'لم أستطع التحقق من الخدمة وربطها بالمزود. أعد تحميل الخدمات من لوحة الإدارة. ',stage:'service_lookup'});
    const mn=Math.max(1,Number(svc.min||100)),mx=Math.max(mn,Number(svc.max||10000)); if(quantity<mn||quantity>mx)return json(res,422,{ok:false,error:'الكمية خارج حدود الخدمة',stage:'validate'});
    const serviceRate=Number(svc.sellingUsd??svc.rateUsd??0); const localUser=readJSON('users.json',{users:{}}).users?.[username]||{}; const userDiscount=Math.max(0,Math.min(100,Number(localUser.discountPct??orderSession?.discountPct??0)||0)); const chargeUsd=Number((Math.max(0,quantity/1000*serviceRate*(1-userDiscount/100))).toFixed(6)); const chargeIqd=Number((chargeUsd*FIXED_RATE).toFixed(4));
    await ensureProviderRuntime(providerId); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالخدمة غير موجود',stage:'provider_lookup'});
    const result=await withApiUserLock(username,async()=>{
      // The server, not the browser, is authoritative for provider-order wallet reservations.
      const reservationId=sha256(String(localId||'')+'|'+username).slice(0,40);
      let reserved=false,before=0,after=0;
      async function markReservation(state){
        if(isAdminSession||chargeIqd<=0)return;
        try{await firebaseTransaction('users/'+firebaseSafeKey(username),current=>{
          if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
          const map=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};
          if(!map[reservationId])return {write:false,result:{missing:true}};
          if(state==='complete'){delete map[reservationId];current.sadaOrderReservations=map;current.updatedAt=nowISO();return {write:true,value:current,result:{completed:true}};}
          if(state==='release'){
            const amount=Math.max(0,Number(map[reservationId].amountIQD||chargeIqd));
            current.balance=Number((Number(current.balance||0)+amount).toFixed(4));delete map[reservationId];
            current.sadaOrderReservations=map;current.updatedAt=nowISO();
            return {write:true,value:current,result:{released:true,amountIQD:amount,balanceIQD:current.balance}};
          }
          map[reservationId]={...map[reservationId],state,updatedAt:nowISO()};current.sadaOrderReservations=map;current.updatedAt=nowISO();
          return {write:true,value:current,result:{marked:true}};
        },10000,8)}catch(e){console.warn('order reservation reconciliation:',String(e.message||e).slice(0,140))}
      }
      if(chargeIqd>0 && !isAdminSession){
        if(!localId||localId.length>100)return {walletUnavailable:true,error:'رقم تتبع الطلب مطلوب لإجراء حجز آمن'};
        let tx;try{tx=await firebaseTransaction('users/'+firebaseSafeKey(username),current=>{
          if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
          const map=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};
          if(map[reservationId])return {write:false,result:{duplicateReservation:true,state:String(map[reservationId].state||'reserved')}};
          const bal=Number(current.balance||0);if(!Number.isFinite(bal)||bal<chargeIqd)return {write:false,result:{insufficient:true,balanceIQD:Math.max(0,Number.isFinite(bal)?bal:0)}};
          before=bal;after=Number((bal-chargeIqd).toFixed(4));current.balance=after;
          map[reservationId]={localId,amountIQD:chargeIqd,state:'reserved',createdAt:nowISO(),providerId,serviceId};current.sadaOrderReservations=map;current.updatedAt=nowISO();
          return {write:true,value:current,result:{reserved:true,beforeIQD:before,afterIQD:after}};
        },10000,8)}catch(e){return {walletUnavailable:true,error:'تعذر حجز الرصيد بأمان في قاعدة البيانات: '+String(e.message||e).slice(0,100)}}
        if(tx.result?.error)return {walletUnavailable:true,error:'لم يتم العثور على سجل رصيد موثوق للمستخدم في Firebase'};
        if(tx.result?.insufficient)return {insufficient:true,balanceUsd:Number((Number(tx.result.balanceIQD||0)/FIXED_RATE).toFixed(6))};
        if(tx.result?.duplicateReservation)return {duplicateReservation:true,state:tx.result.state};
        reserved=!!tx.result?.reserved;before=Number(tx.result?.beforeIQD||0);after=Number(tx.result?.afterIQD||0);
        if(!reserved)return {walletUnavailable:true,error:'تعذر تأكيد حجز الرصيد؛ لم يتم إرسال الطلب إلى المزود'};
        appendJsonLedger('balance_ledger.json',{user:username,type:'order_reservation',amountUSD:Number((chargeIqd/FIXED_RATE).toFixed(6)),amountIQD:chargeIqd,beforeIQD:before,afterIQD:after,reason:'حجز رصيد قبل إرسال الطلب إلى المزود',admin:'system',reference:localId,createdAt:nowISO()});
      }
      try{
        const d=await providerRequest(prov,{action:'add',service:String(svc.providerServiceId||serviceId),link,quantity});
        const providerOrderId=normalizeProviderOrderId(d);
        if(!providerOrderId){await markReservation('uncertain');appendJsonLedger('provider_failures.json',{stage:'provider_response',uncertain:true,user:username,providerId,serviceId,localId,link,quantity,error:'المزود لم يرجع رقم طلب واضح',providerResponse:safeProviderResponse(d),createdAt:nowISO()});return {error:'المزود لم يرجع رقم طلب واضح بعد عملية الإرسال؛ تم تعليق الحجز لحين المراجعة لتجنب تكرار الطلب',uncertain:true};}
        const createdAt=nowISO(); const siteOrderId=String(localId||('EXT_'+Date.now()));
        const providerTrackingToken=issueProviderOrderTrackingToken({username,providerId,providerOrderId,siteOrderId});
        const platformFields=canonicalServicePlatform(svc);const ord={id:siteOrderId,localId:siteOrderId,user:username,providerId,providerName:prov.name||providerId,providerOrderId,serviceId,serviceName:String(svc.name||'خدمة'),serviceApp:platformFields.serviceApp,image:platformFields.image,platformIcon:platformFields.platformIcon,link,quantity,unitSellingUsd:serviceRate,discountPct:userDiscount,chargeUsd,total:chargeIqd,status:'pending',billingMode:isAdminSession?'admin-test':'user',providerRaw:safeProviderResponse(d),createdAt}; appendJsonLedger('orders.json',ord);
        await markReservation('complete');
        return {ok:true,order:ord,providerTrackingToken};
      }catch(e){
        const rejected=!!e.providerRejected; const authFail=providerAuthErrorText(e.message);
        if(reserved&&rejected){
          try{const refundTx=await firebaseTransaction('users/'+firebaseSafeKey(username),current=>{if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};const map=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};const rec=map[reservationId];if(!rec)return {write:false,result:{alreadyReleased:true}};const amount=Math.max(0,Number(rec.amountIQD||chargeIqd)),bal=Number(current.balance||0);current.balance=Number((bal+amount).toFixed(4));delete map[reservationId];current.sadaOrderReservations=map;current.updatedAt=nowISO();return {write:true,value:current,result:{released:true,beforeIQD:bal,afterIQD:current.balance,amountIQD:amount}}},10000,8);if(refundTx.result?.released)appendJsonLedger('balance_ledger.json',{user:username,type:'refund',amountUSD:Number((Number(refundTx.result.amountIQD||chargeIqd)/FIXED_RATE).toFixed(6)),amountIQD:Number(refundTx.result.amountIQD||chargeIqd),beforeIQD:refundTx.result.beforeIQD,afterIQD:refundTx.result.afterIQD,reason:'استرداد حجز بعد رفض المزود للطلب بشكل مؤكد',admin:'system-provider-rejection',reference:localId,createdAt:nowISO()});}catch(refundError){console.error('Failed to release rejected provider reservation:',String(refundError.message||refundError).slice(0,160))}
        }else if(reserved){await markReservation('uncertain')}
        appendJsonLedger('provider_failures.json',{stage:'website_provider_add',uncertain:!rejected,authFailure:authFail,user:username,providerId,serviceId,localId,link,quantity,error:String(e.message||e),createdAt:nowISO()}); return {error:authFail?'مفتاح API للمزود مرفوض أو منتهي':String(e.message||e),uncertain:!rejected,authFailure:authFail};
      }
    });
    if(result?.insufficient)return json(res,402,{ok:false,error:'رصيد المستخدم غير كافٍ',balanceUsd:result.balanceUsd});
    if(result?.walletUnavailable)return json(res,503,{ok:false,error:result.error||'تعذر حجز الرصيد بأمان؛ لم يتم إرسال الطلب'});
    if(result?.duplicateReservation)return json(res,409,{ok:false,error:'يوجد حجز سابق لهذا الطلب قيد التحقق؛ لم نرسل طلباً مكرراً.',uncertain:true,state:result.state});
    if(result?.error)return json(res,502,{ok:false,error:result.error,uncertain:!!result.uncertain,authFailure:!!result.authFailure});
    if(result?.ok){const siteId=String(result.order.id||localId||'');createUserNotification(username,{type:'order_created',orderId:siteId,status:'pending',title:'تم استلام طلبك #'+siteId,message:'تم استلام طلب '+siteId+' لخدمة '+String(result.order.serviceName||'خدمة')+'، وسيتم تحديث حالته هنا.',meta:{serviceName:String(result.order.serviceName||'خدمة'),quantity:Number(result.order.quantity||0),providerName:String(result.order.providerName||''),providerOrderId:String(result.order.providerOrderId||'')}});notifyTelegramNewOrder(result.order,{source:'backend'}).catch(()=>{});return json(res,200,{ok:true,siteOrderId:siteId,providerId,providerName:prov.name||providerId,providerOrderId:String(result.order.providerOrderId),providerTrackingToken:String(result.providerTrackingToken||''),providerRaw:result.order.providerRaw,providerBalanceBefore:null,chargeUsd,totalIQD:chargeIqd,discountPct:userDiscount,createdAt:result.order.createdAt});}
    return json(res,500,{ok:false,error:'تعذر إنشاء الطلب'});
  }

  if(p==='/api/order/status' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req); const providerIdInput=String(b.providerId||'').trim(); const providerOrderIdInput=String(b.providerOrderId||'').trim(); const siteOrderId=String(b.siteOrderId||b.orderId||'').trim();
    if(!providerIdInput||!providerOrderIdInput)return json(res,422,{ok:false,error:'بيانات التحقق ناقصة'});
    const rows=readJSON('orders.json',[]);
    const ownedBySite=siteOrderId?rows.find(x=>String(x.user||'')===username&&String(x.providerId||'')===providerIdInput&&[String(x.id||''),String(x.localId||'')].includes(siteOrderId)&&String(x.providerOrderId||'')):null;
    const ownedByProvider=rows.find(x=>String(x.user||'')===username&&String(x.providerId||'')===providerIdInput&&String(x.providerOrderId||'')===providerOrderIdInput);
    const ticket=verifyProviderOrderTrackingToken(b.providerTrackingToken,{username,providerId:providerIdInput,providerOrderId:providerOrderIdInput,siteOrderId});
    const ledgerOrder=ownedBySite||ownedByProvider;
    if(!ticket&&!ledgerOrder)return json(res,403,{ok:false,error:'تعذر إثبات ملكية الطلب من سجل الخادم. حدّث الصفحة أو أرسل رقم طلب الموقع للدعم إذا كان الطلب قديماً.'});
    const providerId=String(ticket?.providerId||ledgerOrder?.providerId||providerIdInput);
    const providerOrderId=String(ticket?.providerOrderId||ledgerOrder?.providerOrderId||providerOrderIdInput);
    const effectiveSiteOrderId=String(ticket?.siteOrderId||ledgerOrder?.id||ledgerOrder?.localId||siteOrderId||'');
    await ensureProviderRuntime(providerId); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالطلب غير موجود'});
    try{
      const d=await providerRequest(prov,{action:'status',order:providerOrderId});
      const normalized=normalizeProviderStatus(d.status||''); const checkedAt=nowISO();
      const idx=rows.findIndex(x=>String(x.user||'')===username&&String(x.providerId||'')===providerId&&String(x.providerOrderId||'')===providerOrderId);
      let resolvedSiteOrderId=effectiveSiteOrderId;
      if(idx>=0){const ord=rows[idx];const oldStatus=normalizeProviderStatus(ord.status||'pending');resolvedSiteOrderId=String(ord.id||effectiveSiteOrderId);ord.providerStatus=String(d.status||'');if(normalized!=='unknown')ord.status=normalized;ord.remains=d.remains;ord.startCount=d.start_count??d.startCount;ord.providerCharge=d.charge;ord.providerCurrency=d.currency||'USD';ord.lastCheckedAt=checkedAt;ord.providerRaw=safeProviderResponse(d);rows[idx]=ord;writeJSON('orders.json',rows);if(['cancelled','partial'].includes(normalized))await applyVerifiedOrderRefund(ord,d,normalized);if(oldStatus!==normalizeProviderStatus(ord.status||oldStatus))notifyOrderStatusChange(ord,oldStatus,normalizeProviderStatus(ord.status||oldStatus)).catch(()=>{});}
      return json(res,200,{ok:true,siteOrderId:resolvedSiteOrderId,providerId,providerOrderId,status:String(d.status||''),normalizedStatus:normalized,remains:d.remains,startCount:d.start_count??d.startCount,charge:d.charge,currency:d.currency||'USD',raw:d,checkedAt});
    }catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/cancel' && req.method==='POST'){
    const wait=rateLimit(req,'order');if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req);if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req);const providerId=String(b.providerId||'').trim();const providerOrderId=String(b.providerOrderId||'').trim();if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات الإلغاء ناقصة'});
    if(!ownedProviderOrder(username,providerId,providerOrderId))return json(res,403,{ok:false,error:'هذا الطلب لا يتبع حسابك'});
    await ensureProviderRuntime(providerId);const {prov}=getProviderById(providerId);if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{
      const cancelResp=await providerRequest(prov,{action:'cancel',orders:providerOrderId});
      if(!providerActionSucceeded('cancel',cancelResp,providerOrderId))return json(res,502,{ok:false,error:'المزود لم يؤكد طلب الإلغاء؛ لم يتغير الرصيد.',providerRaw:safeProviderResponse(cancelResp)});
      const rows=readJSON('orders.json',[]);const idx=rows.findIndex(x=>!x.event&&String(x.user||'')===username&&String(x.providerId||'')===providerId&&String(x.providerOrderId||'')===providerOrderId);if(idx<0)return json(res,403,{ok:false,error:'لا يوجد سجل طلب موثوق لهذا المستخدم في خادم الموقع؛ لم نغير الحالة أو الرصيد.'});
      const ord=rows[idx];let statusResp=null,norm='unknown';try{statusResp=await providerRequest(prov,{action:'status',order:providerOrderId});norm=normalizeProviderStatus(statusResp?.status??statusResp?.data?.status??'');}catch(_){}
      if(!['cancelled','partial'].includes(norm)){
        const event={event:'cancel-request',user:username,providerId,providerOrderId,status:'cancel_requested',providerRaw:safeProviderResponse(cancelResp),createdAt:nowISO()};appendJsonLedger('orders.json',event);
        return json(res,202,{ok:true,pending:true,providerOrderId,status:ord.status||'pending',message:'المزود قبل طلب الإلغاء لكن لم يؤكد الحالة النهائية بعد؛ لم يُضف أي رصيد إلى المحفظة.',providerStatus:statusResp?.status||''});
      }
      const old=normalizeProviderStatus(ord.status||'pending');ord.providerStatus=String(statusResp.status||'');ord.status=norm;ord.providerRaw=safeProviderResponse(statusResp);ord.remains=statusResp.remains??ord.remains;ord.lastCheckedAt=nowISO();ord.cancelledAt=norm==='cancelled'?nowISO():ord.cancelledAt;rows[idx]=ord;writeJSON('orders.json',rows);
      const refund=await applyVerifiedOrderRefund(ord,statusResp,norm);notifyOrderStatusChange(ord,old,norm).catch(()=>{});
      return json(res,200,{ok:true,providerOrderId,status:norm,providerStatus:ord.providerStatus,refund,updatedAt:ord.lastCheckedAt,message:refund?.credited?'تم تأكيد الحالة وإرجاع المبلغ المستحق إلى المحفظة.':refund?.state==='pending'?'تم تحديث الحالة، لكن تعذر تأكيد مبلغ الاسترداد أو حفظه؛ لم يُضاف الرصيد.':'تم تأكيد الحالة، ولا يوجد مبلغ إضافي مستحق للاسترداد.'});
    }catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':String(e.message||e)});}
  }
  if(p==='/api/logout'){
    const id=sid(req); if(id) sessions.delete(id); res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); return json(res,200,{ok:true});
  }

  if(p==='/api/admin/orders' && req.method==='GET'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();
    const st=String(urlObj.searchParams.get('status')||'').trim().toLowerCase();
    const merged=new Map();const keyOf=o=>String(o?.legacyHistory?'legacy:'+o.legacyImportKey:(o?.id||o?.siteOrderId||o?.orderId||o?.order_id||o?.providerOrderId||o?.smmpartyOrderId||o?.createdAt||''))+'|'+String(o?.user||o?.username||'');
    for(const o of readJSON('orders.json',[])){if(!o||o.event)continue;merged.set(keyOf(o),{...o,source:'server',readOnly:false});}
    let firebaseAvailable=true,firebaseWarning='';try{const remote=await firebaseGetJson('orders',12000);for(const [k,o] of collectionEntries(remote)){if(!o||typeof o!=='object'||o.event)continue;const id=keyOf(o),prior=merged.get(id)||{};merged.set(id,{...prior,...o,source:o.legacyHistory?'legacy':'firebase',readOnly:!!o.legacyHistory});}}catch(e){firebaseAvailable=false;firebaseWarning=String(e.message||e).slice(0,140);}
    const rows=[...merged.values()].filter(o=>{const hay=[o.id,o.publicOrderNo,o.user,o.userName,o.link,o.serviceName,o.providerOrderId,o.legacyOrderId,o.legacyOrderNumber].map(v=>String(v||'').toLowerCase()).join(' ');const norm=normalizeProviderStatus(o.status||'pending');return (!q||hay.includes(q))&&(!st||st==='all'||norm===st);}).sort((a,b)=>(Date.parse(b.createdAt||0)||0)-(Date.parse(a.createdAt||0)||0)).slice(0,500);
    return json(res,200,{ok:true,orders:rows,firebaseAvailable,warning:firebaseWarning||undefined,readOnlyLegacyCount:rows.filter(x=>x.legacyHistory).length});
  }
  if(p==='/api/admin/order-status' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const siteId=String(b.orderId||'').trim();
    if(!siteId) return json(res,422,{ok:false,error:'رقم طلب الموقع مطلوب'});
    const rows=readJSON('orders.json',[]); const idx=rows.findIndex(o=>String(o.id||'')===siteId);
    if(idx<0) return json(res,404,{ok:false,error:'طلب الموقع غير موجود'});
    const order=rows[idx]; if(!order.providerId||!order.providerOrderId) return json(res,409,{ok:false,error:'هذا الطلب لا يملك طلباً مرتبطاً بالمزود'});
    await ensureProviderRuntime(order.providerId); const {prov}=getProviderById(order.providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{
      const d=await providerRequest(prov,{action:'status',order:String(order.providerOrderId)});
      const oldStatus=normalizeProviderStatus(order.status||'pending'); const newStatus=normalizeProviderStatus(d.status||order.status||'pending');
      order.providerStatus=String(d.status||''); order.status=newStatus==='unknown'?(order.status||'pending'):newStatus;
      order.remains=d.remains; order.startCount=d.start_count??d.startCount; order.lastCheckedAt=nowISO(); order.providerRaw=safeProviderResponse(d);
      rows[idx]=order; writeJSON('orders.json',rows); if(['cancelled','partial'].includes(order.status))await applyVerifiedOrderRefund(order,d,order.status); notifyOrderStatusChange(order,oldStatus,order.status).catch(()=>{});
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
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح — جلسة الإدارة غير صالحة'});
    const id=String(urlObj.searchParams.get('provider')||'');
    await ensureProviderRuntime(id);
    const {pid,prov}=getProviderById(id,{allowSingleFallback:true});
    if(!prov?.key) return json(res,404,{ok:false,error:'المزود غير موجود أو مفتاحه غير محفوظ'});
    return json(res,200,{ok:true,providerId:pid,key:String(prov.key)});
  }
  if(p.startsWith('/api/providers/') && req.method==='DELETE'){
    if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
    const pid=decodeURIComponent(p.slice('/api/providers/'.length)).trim();
    if(!pid) return json(res,400,{error:'معرف المزود مفقود'});
    const store=providerStore();
    const existed=!!store.providers[pid];
    const out={...(store.providers||{})};
    delete out[pid];
    const deletedIds=new Set(store.deletedProviderIds||[]);
    deletedIds.add(pid); // permanent tombstone: an update/restart must not resurrect this provider
    let active=String(store.activeProvider||'');
    if(active===pid) active=Object.keys(out)[0]||'';
    writeJSON('providers.runtime.json',{activeProvider:active,providers:out,deletedProviderIds:[...deletedIds],updatedAt:new Date().toISOString()});
    // Persist deletion independently of the code release and remove any Firebase copy.
    let firebaseSynced=true;
    try{
      await firebaseDeleteJson('config/smmProviders/'+firebaseSafeKey(pid));
      await firebaseDeleteJson('config/smmProviderSecrets/'+firebaseSafeKey(pid));
      await firebaseWriteJson('config/smmDeletedProviders/'+firebaseSafeKey(pid),true);
      const activeRemote=String(active||''); if(activeRemote) await firebaseWriteJson('config/smmActive',activeRemote);
    }catch(e){ firebaseSynced=false; console.warn('provider delete Firebase sync failed:',e?.message||e); }
    return json(res,200,{ok:true,deleted:pid,alreadyDeleted:!existed,activeProvider:active,count:Object.keys(out).length,firebaseSynced});
  }
  if(p==='/api/providers'){
    if(req.method!=='GET'&&req.method!=='POST') return json(res,405,{error:'Method not allowed'});
    if(!isAdmin(req)) return json(res,403,{error:'غير مصرح — جلسة الإدارة غير صالحة'});
    let store=providerStore();
    if(req.method==='GET'){
      // Hydrate remote metadata/secrets on each explicit list request, without clearing local data if Firebase is offline.
      await hydrateProviderRuntimeFromFirebase().catch(()=>{});
      store=providerStore();
      const safe={};
      for(const [id,v] of Object.entries(store.providers||{})) if(v?.url) safe[id]={id,name:v.name||id,url:v.url||'',hasKey:!!v.key};
      return json(res,200,{activeProvider:store.activeProvider||'',providers:safe,storageMode:DATA_IS_EXTERNAL?'external-directory':'release-local'});
    }
    const b=await bodyJSON(req); const list=Array.isArray(b.providers)?b.providers:[];
    await ensureProviderRuntime(''); store=providerStore();
    const incoming={};
    for(const item of list){
      if(!item||typeof item!=='object') continue;
      const rawId=String(item.id||item.providerId||'').trim(); const id=normalizeProviderId(rawId);
      if(!id) continue;
      let oldId=providerIdInStore(store,rawId)||providerIdInStore(store,id);
      let prev=oldId?store.providers[oldId]:{};
      const name=String(item.name||prev?.name||id).trim();
      let apiUrl=String(item.url||item.apiUrl||prev?.url||'').trim();
      // A list loaded from the admin UI intentionally contains hasKey, not the secret.
      // If a legacy/provider ID was renamed, preserve its saved secret only when exactly
      // one existing provider has the same normalized API URL.
      if(!oldId && apiUrl){
        let normalizedIncoming='';
        try{normalizedIncoming=normalizeProviderApiUrl(apiUrl).replace(/\/$/,'').toLowerCase();}catch(_){}
        if(normalizedIncoming){
          const matches=Object.entries(store.providers||{}).filter(([,v])=>{
            if(!v?.key||!v?.url)return false;
            try{return normalizeProviderApiUrl(v.url).replace(/\/$/,'').toLowerCase()===normalizedIncoming;}catch(_){return false;}
          });
          if(matches.length===1){oldId=matches[0][0];prev=matches[0][1]||{};}
        }
      }
      let key=usableProviderKey(item.key)||usableProviderKey(item.apiKey)||usableProviderKey(prev?.key)||usableProviderKey(store.envProvider?.id===id?store.envProvider.key:'');
      try{apiUrl=normalizeProviderApiUrl(apiUrl)}catch(_){ }
      const blockedDeleted=[...(store.deletedProviderIds||[])].some(x=>normalizeProviderId(x)===id);
      // A tombstoned provider may return only after an explicit Add/Save operation.
      const explicitRestore=b.restoreDeleted===true;
      if(blockedDeleted&&!explicitRestore) continue;
      if(name && /^https?:\/\//i.test(apiUrl) && key){
        incoming[id]={...(prev||{}),...item,id,name,url:apiUrl,key,source:'admin'};
      }
    }
    const confirmedReplace=b.mode==='replace'&&b.confirmReplace===true;
    const out=confirmedReplace?incoming:{...(store.providers||{}),...incoming};
    const unsavedRequested=list.filter(item=>{
      if(!item||typeof item!=='object')return false;
      const rawId=String(item.id||item.providerId||'').trim();const nid=normalizeProviderId(rawId);if(!nid)return false;
      const storedId=providerIdInStore({providers:out},rawId)||providerIdInStore({providers:out},nid);const prov=storedId?out[storedId]:out[nid];
      // If a provider is present in the admin form but neither its saved copy nor the request carries a usable key/URL,
      // don't silently return success: the next release would correctly have nothing to restore.
      return !(String(prov?.url||item.url||item.apiUrl||'').trim() && (usableProviderKey(prov?.key)||usableProviderKey(item.key)||usableProviderKey(item.apiKey)));
    });
    if(unsavedRequested.length){return json(res,409,{ok:false,error:'تعذر تثبيت بيانات بعض المزودين لأن مفتاح API أو الرابط غير محفوظ. أعد فتح المزود، أدخل المفتاح الصحيح، واحفظه حتى يتأكد التخزين الدائم.',unsaved:unsavedRequested.map(x=>String(x.name||x.id||x.providerId||'مزود'))});}
    const deletedIds=new Set(store.deletedProviderIds||[]);
    for(const id of Object.keys(incoming)) for(const oldId of [...deletedIds]) if(normalizeProviderId(oldId)===normalizeProviderId(id)) deletedIds.delete(oldId);
    let activeCandidate=String(b.activeProvider!==undefined?b.activeProvider:(store.activeProvider||''));
    let active=providerIdInStore({providers:out},activeCandidate);
    if(!active) active=Object.keys(out).find(id=>out[id]?.url&&out[id]?.key)||'';
    writeJSON('providers.runtime.json',{activeProvider:active,providers:out,deletedProviderIds:[...deletedIds],updatedAt:nowISO()});
    let firebaseSynced=true;
    try{
      for(const [id,v] of Object.entries(incoming)){
        const k=firebaseSafeKey(id);
        await firebaseDeleteJson('config/smmDeletedProviders/'+k);
        await firebaseWriteJson('config/smmProviders/'+k,{id,name:v.name,url:v.url,hasKey:true});
        await firebaseWriteJson('config/smmProviderSecrets/'+k,{id,key:v.key,name:v.name,url:v.url});
      }
      await firebaseWriteJson('config/smmActive',active);
    }catch(e){firebaseSynced=false;console.warn('provider save Firebase sync failed:',e?.message||e);}
    const persistent=firebaseSynced||DATA_IS_EXTERNAL;
    // Let the browser attempt its authenticated Firebase write if direct server-side Firebase
    // access is unavailable; the UI must not show success unless that second durable path works.
    return json(res,200,{ok:true,count:Object.keys(out).length,activeProvider:active,firebaseSynced,persistent,storageMode:firebaseSynced?'firebase':(DATA_IS_EXTERNAL?'external-directory':'release-local'),needsClientPersistence:!persistent,warning:persistent?'':'الحفظ على الخادم مؤقت حتى يتأكد حفظ Firebase من الواجهة أو يُربط Railway Volume.',received:list.length,saved:Object.keys(incoming).length});
  }
  if(p==='/api/smm') return apiSmm(req,res,urlObj);
  if(p==='/api/asiacell' && req.method==='POST') return apiAsiacell(req,res);
  if(p==='/api/health') {
    let uiVersion='', uiBuildId='', versionFile='', buildFile='';
    try { const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8'); uiVersion=String(html.match(/<meta\s+name=["']sada-version["']\s+content=["']([^"']+)["']/i)?.[1]||''); uiBuildId=String(html.match(/<meta\s+name=["']sada-build-id["']\s+content=["']([^"']+)["']/i)?.[1]||''); } catch(_) {}
    try { versionFile=fs.readFileSync(path.join(ROOT,'version.txt'),'utf8').trim(); } catch(_) {}
    try { buildFile=fs.readFileSync(path.join(ROOT,'BUILD_ID.txt'),'utf8').trim(); } catch(_) {}
    const deploymentConsistent=uiVersion===APP_VERSION && uiBuildId===BUILD_ID && versionFile===APP_VERSION && buildFile===BUILD_ID;
    const health={ok:true,app:APP_NAME,version:APP_VERSION,buildId:BUILD_ID,uiVersion,uiBuildId,versionFile,buildFile,deploymentConsistent,dataStorageMode:DATA_IS_EXTERNAL?'external-directory':'release-local',providerCount:Object.keys(providerStore().providers||{}).length,time:new Date().toISOString(),node:process.version};
    // Keep operational configuration details private; only an authenticated admin can inspect them.
    if(isAdmin(req))health.securityConfig={sessionSecretConfigured:!!String(process.env.SESSION_SECRET||'').trim(),dedicatedEncryptionKeyConfigured:!!String(process.env.SADA_ENCRYPTION_KEY||'').trim(),stableEncryptionAvailable:telegramEncryptionReady(),firebaseConfigured:!!String(process.env.FIREBASE_DATABASE_URL||'').trim(),emailServiceConfigured:!!(String(process.env.RESEND_API_KEY||'').trim()&&String(process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM||'').trim()),telegramTokenFromEnvironment:!!String(process.env.TELEGRAM_BOT_TOKEN||'').trim(),adminPasswordFromEnvironment:!!(String(process.env.ADMIN_PASSWORD||'').trim()||String(process.env.ADMIN_PASSWORD_HASH||'').trim())};
    return json(res,200,health);
  }
  return json(res,404,{error:'API endpoint not found'});
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
function serveStatic(req,res,urlObj){
  let p=decodeURIComponent(urlObj.pathname); if(p==='/'||p==='') p='/index.html';
  const baseName=path.posix.basename(p).toLowerCase();
  const blockedFiles=new Set(['server.js','package.json','config.json','authproviders.json','login.json','noauth.json','cookies.txt']);
  if(blockedFiles.has(baseName) || /^\/data(?:\/|$)/i.test(p) || /(?:^|\/)\.(?:env|git|npmrc)/i.test(p)) return json(res,403,{error:'Forbidden'});
  const file=path.resolve(ROOT,'.'+p);
  const relative=path.relative(ROOT,file);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) return json(res,403,{error:'Forbidden'});
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()) return json(res,404,{error:'Not found'});
    const ext=path.extname(file).toLowerCase();
    res.statusCode=200; res.setHeader('Content-Type',MIME[ext]||'application/octet-stream');
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
    if(ext==='.html') res.setHeader('Pragma','no-cache');
    fs.createReadStream(file).pipe(res);
  });
}

async function hydrateProviderRuntimeFromFirebase(){
  // Provider metadata and credentials were split into two Firebase paths by newer UI builds.
  // Merge both paths; never discard the local runtime store when Firebase is temporarily offline.
  const settled=await Promise.allSettled([
    firebaseGetJson('config/smmProviders',7000),
    firebaseGetJson('config/smmProviderSecrets',7000),
    firebaseGetJson('config/smmDeletedProviders',7000),
    firebaseGetJson('config/smmActive',7000)
  ]);
  const take=i=>settled[i]?.status==='fulfilled'?settled[i].value:null;
  const remote=take(0), secrets=take(1), deleted=take(2), remoteActive=take(3);
  const old=readJSON('providers.runtime.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
  const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
  const deletedSet=new Set([
    ...(Array.isArray(old?.deletedProviderIds)?old.deletedProviderIds:[]).map(String),
    ...(Array.isArray(legacy?.deletedProviderIds)?legacy.deletedProviderIds:[]).map(String),
    ...((deleted&&typeof deleted==='object')?Object.entries(deleted).filter(([,v])=>v===true).map(([k])=>String(k)):[])
  ]);
  const providers={...(old?.providers&&typeof old.providers==='object'?old.providers:{})};
  if(legacy?.providers&&typeof legacy.providers==='object') for(const [id,v] of Object.entries(legacy.providers)) providers[id]=providers[id]?{...v,...providers[id]}:v;
  const ids=new Set([
    ...Object.keys(remote&&typeof remote==='object'&&!Array.isArray(remote)?remote:{}),
    ...Object.keys(secrets&&typeof secrets==='object'&&!Array.isArray(secrets)?secrets:{})
  ]);
  for(const firebaseKey of ids){
    const meta=(remote&&typeof remote[firebaseKey]==='object'&&remote[firebaseKey])||{};
    const secret=(secrets&&typeof secrets[firebaseKey]==='object'&&secrets[firebaseKey])||{};
    const id=String(secret.id||meta.id||firebaseKey).trim();
    const normId=normalizeProviderId(id);
    const blocked=[...deletedSet].some(x=>String(x)===id || normalizeProviderId(x)===normId);
    if(!id||blocked)continue;
    const prevKey=providerIdInStore({providers},id);
    const prev=prevKey?providers[prevKey]:{};
    const urlRaw=String(secret.url||meta.url||prev.url||'').trim();
    const key=usableProviderKey(secret.key)||usableProviderKey(meta.key)||usableProviderKey(prev.key);
    if(!urlRaw||!key)continue;
    let url=urlRaw; try{url=normalizeProviderApiUrl(urlRaw)}catch(_){}
    providers[id]={...prev,...meta,...secret,id,name:String(meta.name||secret.name||prev.name||id),url,key};
    if(prevKey && prevKey!==id) delete providers[prevKey];
  }
  for(const id of deletedSet){ for(const existing of Object.keys(providers)){if(String(existing)===String(id)||normalizeProviderId(existing)===normalizeProviderId(id))delete providers[existing];} }
  const env=envProvider(); if(env&&!deletedSet.has(String(env.id)))providers[env.id]={...(providers[env.id]||{}),...env};
  const activeFromRemote=typeof remoteActive==='string'?remoteActive:String(remoteActive?.id||remoteActive?.activeProvider||'');
  const active=providers[activeFromRemote]?activeFromRemote:(providers[old?.activeProvider]?String(old.activeProvider):(Object.keys(providers)[0]||''));
  writeJSON('providers.runtime.json',{activeProvider:active,providers,deletedProviderIds:[...deletedSet],updatedAt:nowISO()});
  return true;
}
async function ensureProviderRuntime(id=''){
  let store=providerStore();
  const wanted=String(id||store.activeProvider||'');
  const found=getProviderById(wanted).prov;
  if(found?.url&&found?.key)return store;
  await hydrateProviderRuntimeFromFirebase();
  store=providerStore();
  return store;
}

ensureData();
ensureTelegramDefaults();
startGlobalPriceSyncScheduler();
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
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`${APP_NAME} v${APP_VERSION} build ${BUILD_ID} running on port ${PORT}`);
  if(!process.env.ADMIN_PASSWORD) console.warn('SECURITY WARNING: the legacy default admin password is enabled; set ADMIN_PASSWORD in production.');
  if(!process.env.SESSION_SECRET) console.warn('SECURITY WARNING: configure a long random SESSION_SECRET for stable, multi-instance signed sessions.');
  if(!process.env.SADA_ENCRYPTION_KEY && !telegramEncryptionReady()) console.warn('SECURITY WARNING: could not create a stable encryption key; set a strong fixed SESSION_SECRET or attach persistent Railway storage.');
  // Bind HTTP before any remote Firebase hydration so saved sessions respond immediately.
  Promise.allSettled([hydrateProviderRuntimeFromFirebase(),hydrateTelegramChannelsFromFirebase()]).then(()=>{
    setTimeout(()=>{runOrderAuditMonitor().catch(()=>{});runTelegramNewOrdersMonitor().catch(()=>{});runRefundReconciliationMonitor().catch(()=>{});},15000).unref();
    setInterval(()=>{runOrderAuditMonitor().catch(()=>{});runTelegramNewOrdersMonitor().catch(()=>{});runRefundReconciliationMonitor().catch(()=>{});},120*1000).unref();
  });
});
