const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {URL} = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const APP_NAME = 'صدى العراق';
const ADMIN_USER = process.env.ADMIN_EMAIL || 'hsydgyg5@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SrIraq!9vQ#4mL7@xK2';
const FIXED_RECEIVER = '07763308188';
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
      return json(res,200,{ok:true,message:'تم إرسال رمز تأكيد التحويل.',usd:amount/FIXED_RATE,receiver:FIXED_RECEIVER,transferPid:s.pid_transfer});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  if(action==='confirm_transfer'){
    if(s.step!=='transfer_sms') return json(res,409,{error:'لا توجد عملية تحويل بانتظار التأكيد'});
    const code=String(inBody.passcode||'').trim(); if(!/^\d{4,8}$/.test(code)) return json(res,422,{error:'رمز التأكيد غير صحيح'});
    try{
      const d=await acPost('https://odpapp.asiacell.com/api/v1/credit-transfer/do-transfer?lang=ar',s.headers,{PID:s.pid_transfer,passcode:code});
      if(!d.success) throw new Error(d.message || 'فشل التحويل');
      s.step='completed';
      const amount=Number(s.amount); return json(res,200,{ok:true,message:'تم التحويل بنجاح',usd:amount/FIXED_RATE,amountIQD:amount,receiver:FIXED_RECEIVER,phone:s.phone||'',transferPid:s.pid_transfer});
    }catch(e){ return json(res,502,{error:e.message}); }
  }
  return json(res,422,{error:'عملية غير معروفة'});
}

async function apiSmm(req,res,urlObj){
  const store=readJSON('providers.json',{activeProvider:'',providers:{}});
  const providerId=String(urlObj.searchParams.get('provider')||store.activeProvider||'');
  let prov=(store.providers||{})[providerId];
  if(!prov && isAdmin(req)){
    const u=String(urlObj.searchParams.get('_url')||''); const k=String(urlObj.searchParams.get('_key')||'');
    if(/^https?:\/\//i.test(u) && k) prov={name:'اختبار',url:u,key:k};
  }
  if(!prov) return json(res,404,{error:'لا يوجد مزود محفوظ أو جلسة الإدارة منتهية'});
  const action=String(urlObj.searchParams.get('action')||'balance');
  if(!['balance','services','add','status'].includes(action)) return json(res,422,{error:'عملية غير مدعومة'});
  const payload=new URLSearchParams(); payload.set('key',prov.key); payload.set('action',action);
  for(const k of ['service','link','quantity','order']){ if(urlObj.searchParams.has(k)) payload.set(k,String(urlObj.searchParams.get(k))); }
  try{
    const r=await fetch(prov.url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:payload.toString(),redirect:'follow'});
    const text=await r.text(); let d; try{d=text?JSON.parse(text):{};}catch(_){d={};}
    if(!r.ok) return json(res,502,{error:`مزود SMM أعاد HTTP ${r.status}`});
    if(d?.error) return json(res,502,{error:String(d.error)});
    return json(res,200,d);
  }catch(e){ return json(res,502,{error:e.name==='AbortError'?'انتهت مهلة الاتصال':e.message}); }
}

async function routeAPI(req,res,urlObj){
  const p=normalizedPath(urlObj.pathname);
  if(p==='/api/config') return json(res,200,{appName:APP_NAME,currency:'USD',exchangeRate:FIXED_RATE,fixedRecharge:'5000 IQD = 4 USD',asiacellReceiver:FIXED_RECEIVER});
  if(p==='/api/auth' && req.method==='POST'){
    const b=await bodyJSON(req); const u=String(b.username||'').trim(); const pw=String(b.password||'');
    if(String(b.action||'')==='register'){
      if(!/^[a-zA-Z0-9_]+$/.test(u)) return json(res,422,{ok:false,error:'اسم المستخدم يجب أن يكون بالإنجليزية والأرقام فقط'});
      if(pw.length<4) return json(res,422,{ok:false,error:'كلمة المرور يجب أن تكون 4 أحرف على الأقل'});
      if(u===ADMIN_USER) return json(res,409,{ok:false,error:'اسم المستخدم محجوز'});
      const store=readJSON('users.json',{users:{}}); if(store.users[u]) return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً'});
      const user={name:u,password:pw,balance:0,level:'مبتدئ',telegram:String(b.telegram||''),phone:String(b.phone||''),joined:new Date().toISOString(),totalSpent:0,totalOrders:0};
      store.users[u]=user; writeJSON('users.json',store); setSession(res,{role:'user',username:u});
      return json(res,200,{ok:true,role:'user',username:u,user:{...user,password:undefined}});
    }
    if(u===ADMIN_USER && pw===ADMIN_PASSWORD){ setSession(res,{role:'admin',username:ADMIN_USER}); return json(res,200,{ok:true,role:'admin',username:ADMIN_USER}); }
    const store=readJSON('users.json',{users:{}}); const user=store.users?.[u];
    if(user && user.password===pw){ setSession(res,{role:'user',username:u}); return json(res,200,{ok:true,role:'user',username:u,user:{...user,password:undefined}}); }
    return json(res,401,{ok:false,error:'بيانات الدخول غير صحيحة'});
  }
  if(p==='/api/logout'){
    const id=sid(req); if(id) sessions.delete(id); res.setHeader('Set-Cookie','sadairaq_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return json(res,200,{ok:true});
  }
  if(p==='/api/providers'){
    const store=readJSON('providers.json',{activeProvider:'',providers:{}});
    if(req.method==='GET'){
      const safe={}; for(const [id,v] of Object.entries(store.providers||{})) safe[id]={id,name:v.name||id,url:v.url||''};
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
  if(p==='/api/health') return json(res,200,{ok:true,app:APP_NAME,time:new Date().toISOString(),node:process.version});
  return json(res,404,{error:'API endpoint not found'});
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
function serveStatic(req,res,urlObj){
  let p=decodeURIComponent(urlObj.pathname); if(p==='/'||p==='') p='/index.html';
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
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname.startsWith('/api/')) return routeAPI(req,res,u);
    return serveStatic(req,res,u);
  }catch(e){ return json(res,500,{error:'Server error',message:e.message}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`${APP_NAME} running on port ${PORT}`));
