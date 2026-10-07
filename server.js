const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {URL} = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const APP_NAME = 'صدى العراق';
const APP_VERSION = '1.3.2';
const ADMIN_USER = process.env.ADMIN_EMAIL || 'hsydgyg5@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SrIraq!9vQ#4mL7@xK2';
const FIXED_RECEIVER = process.env.ASIACELL_RECEIVER || '07763308188';
const FIXED_RATE = 1250; // 1 USD = 1,250 IQD
const sessions = new Map();

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
function session(req){ const id=sid(req); return id ? sessions.get(id) : null; }
function setSession(res, value){
  const id=crypto.randomBytes(24).toString('hex');
  sessions.set(id,{...value,createdAt:Date.now()});
  const secure = (false ? 'Secure; ' : '');
  res.setHeader('Set-Cookie',`sadairaq_sid=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=86400`);
}
async function bodyJSON(req){
  let raw='';
  for await (const chunk of req) raw += chunk;
  if(!raw) return {};
  try{return JSON.parse(raw)}catch(_){return {};}
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
  const candidates=[d?.balance,d?.data?.balance,d?.result?.balance,d?.response?.balance,d?.account?.balance];
  for(const v of candidates){
    if(v!==undefined && v!==null && String(v).trim()!==''){
      const n=Number(String(v).replace(/[^0-9+\-.eE]/g,''));
      if(Number.isFinite(n)) return n;
    }
  }
  return null;
}
function normalizeProviderCurrency(d){
  return String(d?.currency||d?.data?.currency||d?.result?.currency||d?.account?.currency||'USD').toUpperCase();
}
function providerActionSucceeded(action,d){
  if(action==='cancel') return d?.cancel===1 || d?.cancel==='1' || d?.success===true || String(d?.status||'').toLowerCase()==='cancelled';
  return true;
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
async function providerRequest(prov,params,timeoutMs=30000){
  if(!prov?.url||!prov?.key) throw new Error('بيانات المزود غير مكتملة');
  const payload=new URLSearchParams(); payload.set('key',String(prov.key)); Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&String(v)!=='')payload.set(k,String(v));});
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{ const r=await fetch(prov.url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:payload.toString(),redirect:'follow',signal:controller.signal}); const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch(_){d={raw:text};} if(!r.ok) throw new Error(`مزود SMM أعاد HTTP ${r.status}`); if(d?.error) throw new Error(String(d.error)); return d; } finally{clearTimeout(timer);} }
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
  if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
  const store=readJSON('providers.json',{activeProvider:'',providers:{}});
  const providerId=String(urlObj.searchParams.get('provider')||store.activeProvider||'');
  let prov=(store.providers||{})[providerId];
  if(!prov && isAdmin(req)){ const u=String(urlObj.searchParams.get('_url')||''); const k=String(urlObj.searchParams.get('_key')||''); if(/^https?:\/\//i.test(u)&&k)prov={name:'اختبار',url:u,key:k}; }
  if(!prov)return json(res,404,{error:'لا يوجد مزود محفوظ أو جلسة الإدارة منتهية'});
  const action=String(urlObj.searchParams.get('action')||'balance');
  if(!['balance','services','add','status','cancel'].includes(action))return json(res,422,{error:'عملية غير مدعومة'});
  if(!isAdmin(req))return json(res,403,{error:'غير مصرح'});
  const payload={action}; for(const k of ['service','link','quantity','order']){if(urlObj.searchParams.has(k))payload[k]=urlObj.searchParams.get(k);}
  try{return json(res,200,await providerRequest(prov,payload));}
  catch(e){return json(res,502,{error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
}

async function routeAPI(req,res,urlObj){
  const p=normalizedPath(urlObj.pathname);
  if(p==='/api/config'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); return json(res,200,{appName:APP_NAME,version:APP_VERSION,currency:'USD',exchangeRate:FIXED_RATE,fixedRecharge:'5000 IQD = 4 USD',rateTable:[1000,2000,3000,4000,5000,6000,7000,8000,9000,10000].map(i=>({iqd:i,usd:i/FIXED_RATE})),supportWhatsappUrl:waUrl,supportWhatsappNumber:normalizeWhatsAppNumber(waUrl)}); }
  if(p==='/api/auth' && req.method==='POST'){
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
  if(p==='/api/provider/balance' && req.method==='GET'){ if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const {prov,pid}=getProviderById(urlObj.searchParams.get('provider')); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'}); try{const d=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(d); if(balance===null)return json(res,502,{ok:false,error:'المزود لم يرجع قيمة رصيد صالحة',raw:d}); return json(res,200,{ok:true,providerId:pid,providerName:prov.name||pid,balance,currency:normalizeProviderCurrency(d),raw:d,checkedAt:new Date().toISOString()});}catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});} }
  if(p==='/api/order/create' && req.method==='POST'){
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req); const providerId=String(b.providerId||''); const serviceId=String(b.serviceId||''); const link=String(b.link||'').trim(); const quantity=Number(b.quantity);
    if(!providerId||!serviceId||!link||!Number.isInteger(quantity)||quantity<=0)return json(res,422,{ok:false,error:'بيانات الطلب غير مكتملة'});
    const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالخدمة غير موجود'});
    try{const d=await providerRequest(prov,{action:'add',service:serviceId,link,quantity}); if(!d||d.order===undefined||d.order===null||String(d.order)==='')return json(res,502,{ok:false,error:'المزود لم يرجع رقم طلب حقيقي',providerResponse:d}); const providerOrderId=String(d.order); appendJsonLedger('orders.json',{localId:String(b.localId||''),user:username,providerId,providerOrderId,serviceId,link,quantity,status:'pending',createdAt:new Date().toISOString()}); return json(res,200,{ok:true,providerId,providerName:prov.name||providerId,providerOrderId,providerRaw:d,createdAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/status' && req.method==='POST'){
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'}); const b=await bodyJSON(req); const providerId=String(b.providerId||''); const providerOrderId=String(b.providerOrderId||''); if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات التحقق ناقصة'}); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{const d=await providerRequest(prov,{action:'status',order:providerOrderId}); const status=String(d.status||''); return json(res,200,{ok:true,providerOrderId,status,normalizedStatus:normalizeProviderStatus(status),remains:d.remains,startCount:d.start_count??d.startCount,charge:d.charge,currency:d.currency||'USD',raw:d,checkedAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/cancel' && req.method==='POST'){
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'}); const b=await bodyJSON(req); const providerId=String(b.providerId||''); const providerOrderId=String(b.providerOrderId||''); if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات الإلغاء ناقصة'}); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{const d=await providerRequest(prov,{action:'cancel',order:providerOrderId}); if(!providerActionSucceeded('cancel',d)) return json(res,502,{ok:false,error:'المزود لم يؤكد إلغاء الطلب',providerRaw:d}); appendJsonLedger('orders.json',{event:'cancel',user:username,providerId,providerOrderId,status:'cancelled',createdAt:new Date().toISOString(),providerRaw:d}); return json(res,200,{ok:true,providerOrderId,status:'cancelled',providerRaw:d,updatedAt:new Date().toISOString()});}
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
  if(p==='/api/providers'){
    const store=readJSON('providers.json',{activeProvider:'',providers:{}});
    if(req.method==='GET'){
      if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
      const safe={}; for(const [id,v] of Object.entries(store.providers||{})) safe[id]={id,name:v.name||id,url:v.url||'',key:v.key||''};
      return json(res,200,{activeProvider:store.activeProvider||'',providers:safe});
    }
    if(req.method==='POST'){
      if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
      const b=await bodyJSON(req); const list=Array.isArray(b.providers)?b.providers:[]; const out={};
      for(const item of list){
        if(!item||typeof item!=='object') continue;
        const id=String(item.id||'').replace(/[^a-zA-Z0-9_-]/g,''); const name=String(item.name||'').trim(); const apiUrl=String(item.url||'').trim(); const key=String(item.key||'').trim();
        if(id&&name&&/^https?:\/\//i.test(apiUrl)&&key) out[id]={name,url:apiUrl,key};
      }
      writeJSON('providers.json',{activeProvider:String(b.activeProvider||''),providers:out,updatedAt:new Date().toISOString()});
      return json(res,200,{ok:true,count:Object.keys(out).length});
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
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname.startsWith('/api/')) return routeAPI(req,res,u);
    return serveStatic(req,res,u);
  }catch(e){ return json(res,500,{error:'Server error',message:e.message}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`${APP_NAME} running on port ${PORT}`));
