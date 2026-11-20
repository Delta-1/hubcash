// Rotas HTTP do HubCash.
//   /auth/*      entrar e sair (Entrar com LINKY)
//   /api/*       painel de cada empresa (sessão por cookie, dados separados por espaço)
//   /v1/*        API pública para os apps (chave hc_...)
//   /webhooks/*  notificações do Mercado Pago
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomId,sha256} from './crypto.js';
import {createBilling,publicCharge,fail} from './billing.js';

const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const mask=v=>v?'••••'+String(v).slice(-4):null;
const SESSION_COOKIE='hc_session',PENDING_COOKIE='hc_login',SESSION_TTL=12*3600e3;

function limiter(max,windowMs){const hits=new Map();return (req,res,next)=>{const k=req.ip,now=Date.now(),h=(hits.get(k)||[]).filter(t=>now-t<windowMs);h.push(now);hits.set(k,h);if(h.length>max)return res.status(429).json({error:'Muitas tentativas. Espere alguns minutos.'});next();};}
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(c=>c.trim()).filter(Boolean).map(c=>{const i=c.indexOf('=');return [c.slice(0,i),decodeURIComponent(c.slice(i+1))];}));

export function createApp({store,mp,vault,env,linky,fetchImpl,log=console}){
  const app=express(),publicUrl=String(env.HUBCASH_PUBLIC_URL||'').replace(/\/$/,''),secure=publicUrl.startsWith('https://');
  const billing=createBilling({store,mp,vault,publicUrl,fetchImpl,log});
  const devLogin=env.HUBCASH_DEV_LOGIN==='true'&&env.NODE_ENV!=='production';
  // Conta administradora: os IDs LINKY do dono (os mesmos de LINKY_ADMIN_USER_IDS no LINKY).
  const adminIds=new Set(String(env.HUBCASH_ADMIN_LINKY_IDS||'').split(/[,;\s]+/).filter(Boolean));
  const isAdmin=user=>!!user&&adminIds.has(user.linkySub);
  const PLANS=['trial','starter','pro','enterprise'];
  const setCookie=(res,name,value,maxAgeMs)=>res.append('Set-Cookie',`${name}=${value?encodeURIComponent(value):''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs/1000)}${secure?'; Secure':''}`);
  app.disable('x-powered-by');app.set('trust proxy',1);
  app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');next();});
  // Endereço oficial: quem abre o painel por outro endereço (ex.: o da Railway) vai para HUBCASH_PUBLIC_URL.
  // API, webhooks e health continuam respondendo em qualquer endereço.
  const canonicalHost=publicUrl&&env.NODE_ENV==='production'?new URL(publicUrl).host:null;
  app.use((req,res,next)=>{if(!canonicalHost||req.method!=='GET'||req.get('host')===canonicalHost||/^\/(v1|api|webhooks|health)(\/|$)/.test(req.path))return next();res.redirect(301,publicUrl+req.originalUrl);});
  app.use(express.json({limit:'256kb'}));

  app.get('/health',route(async(req,res)=>res.json({ok:await store.health(),store:store.kind})));

  // ---------- Entrar com LINKY ----------
  // Primeiro acesso: cria o usuário (pelo sub do LINKY, nunca pelo e-mail) e o espaço da empresa.
  async function signIn(res,identity){
    let user=await store.findOne('user',{linkySub:identity.sub});
    if(!user)user={id:randomId('usr',10),linkySub:identity.sub};
    user={...user,email:identity.email,name:identity.name,lastLoginAt:new Date().toISOString()};
    if(!user.workspaceId){const ws=await store.put('workspace',{id:randomId('ws',10),name:identity.name?`Empresa de ${identity.name.split(' ')[0]}`:'Minha empresa',ownerId:user.id,plan:'trial'});user.workspaceId=ws.id;}
    user=await store.put('user',user);
    const token=randomId('s',32);
    await store.put('session',{id:sha256(token),userId:user.id,workspaceId:user.workspaceId,expiresAt:Date.now()+SESSION_TTL});
    setCookie(res,SESSION_COOKIE,token,SESSION_TTL);
    return user;
  }

  app.get('/auth/config',(req,res)=>res.json({provider:'LINKY',devLogin}));
  app.get('/auth/login',limiter(30,15*60e3),route(async(req,res)=>{
    if(!linky)throw fail(503,'Entrar com LINKY ainda não está configurado (LINKY_CLIENT_ID e LINKY_CLIENT_SECRET).');
    const {url,pending}=await linky.start({prompt:req.query.signup?'login':undefined}),id=randomId('l',24);
    await store.put('oidc_pending',{id:sha256(id),...pending,expiresAt:Date.now()+600e3});
    setCookie(res,PENDING_COOKIE,id,600e3);res.redirect(303,url);
  }));
  app.get('/auth/callback',route(async(req,res)=>{
    const id=cookies(req)[PENDING_COOKIE],key=id&&sha256(id),pending=key&&await store.get('oidc_pending',key);
    setCookie(res,PENDING_COOKIE,'',0);
    if(!pending||pending.expiresAt<Date.now())return res.redirect(303,'/?erro=expirado');
    // Consome o pedido antes da troca, mesmo que ela falhe.
    await store.put('oidc_pending',{id:key,expiresAt:0});
    if(req.query.error)return res.redirect(303,'/?erro='+(req.query.error==='access_denied'?'recusado':'linky'));
    let identity;try{identity=await linky.finish(publicUrl+req.originalUrl,pending);}catch(e){log.warn?.('[hubcash] login LINKY falhou',e.code||e.message);return res.redirect(303,'/?erro=linky');}
    await signIn(res,identity);res.redirect(303,'/');
  }));
  if(devLogin)app.post('/auth/dev-login',route(async(req,res)=>{const email=String(req.body?.email||'dev@uwy.local').toLowerCase();res.json({user:await signIn(res,{sub:'dev:'+email,email,name:req.body?.name||'Dev'})});}));
  app.post('/auth/logout',route(async(req,res)=>{const t=cookies(req)[SESSION_COOKIE];if(t)await store.put('session',{id:sha256(t),expiresAt:0});setCookie(res,SESSION_COOKIE,'',0);res.json({ok:true});}));

  // ---------- Webhooks do Mercado Pago ----------
  app.post('/webhooks/mercadopago/:accountId',route(async(req,res)=>{
    const {run}=await billing.receiveWebhook(req.params.accountId,{headers:req.headers,query:req.query,body:req.body});
    res.status(200).json({received:true});setImmediate(run);
  }));

  // ---------- API pública (apps) ----------
  const appAuth=route(async(req,res,next)=>{
    const key=String(req.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(!/^hc_(live|test)_[\w-]{20,}$/.test(key))throw fail(401,'Use Authorization: Bearer hc_live_... (chave do app no HubCash).');
    const a=await store.findOne('app',{keyHash:sha256(key)});if(!a||a.disabled)throw fail(401,'Chave de API inválida ou desativada.');
    const ws=a.workspaceId&&await store.get('workspace',a.workspaceId);if(ws?.suspended)throw fail(403,'A conta HubCash desta empresa está suspensa.');
    req.hubApp=a;next();
  });
  const v1=express.Router();v1.use(appAuth);
  v1.post('/checkouts',route(async(req,res)=>res.status(201).json(publicCharge(await billing.createCheckout(req.hubApp,req.body,req.get('idempotency-key'))))));
  v1.post('/subscriptions',route(async(req,res)=>res.status(201).json(publicCharge(await billing.createSubscription(req.hubApp,req.body,req.get('idempotency-key'))))));
  v1.post('/subscriptions/:id/cancel',route(async(req,res)=>res.json(publicCharge(await billing.cancelSubscription(req.hubApp,req.params.id)))));
  v1.get('/charges/:id',route(async(req,res)=>{const c=await store.get('charge',req.params.id);if(!c||c.appId!==req.hubApp.id)throw fail(404,'Cobrança não encontrada.');res.json(publicCharge(c));}));
  v1.get('/charges',route(async(req,res)=>{const where={appId:req.hubApp.id};if(req.query.externalReference)where.externalReference=String(req.query.externalReference);if(req.query.status)where.status=String(req.query.status);res.json({data:(await store.list('charge',{where,limit:100})).map(publicCharge)});}));
  app.use('/v1',v1);

  // ---------- Painel da empresa ----------
  const api=express.Router();
  api.use(route(async(req,res,next)=>{
    // Mutação exige o cabeçalho x-hubcash (bloqueia envio de formulário de outro site).
    if(req.method!=='GET'&&req.get('x-hubcash')!=='1')throw fail(403,'Requisição recusada.');
    const t=cookies(req)[SESSION_COOKIE],s=t&&await store.get('session',sha256(t));
    if(!s||s.expiresAt<Date.now())throw fail(401,'Entre com LINKY novamente.');
    const [user,ws]=await Promise.all([store.get('user',s.userId),store.get('workspace',s.workspaceId)]);
    if(!user||!ws)throw fail(401,'Entre com LINKY novamente.');
    req.user=user;req.ws=ws;req.admin=isAdmin(user);
    if(ws.suspended&&!req.admin&&!req.path.startsWith('/me'))throw fail(403,'A conta HubCash desta empresa está suspensa. Fale com a UWY.');
    next();
  }));
  const own=async(kind,id,ws)=>{const r=await store.get(kind,String(id||''));return r&&r.workspaceId===ws.id?r:null;};
  const publicAccount=a=>({id:a.id,name:a.name,mode:a.mode,accessToken:mask(a.accessTokenLast4),webhookSecretSet:!!a.webhookSecretEnc,webhookUrl:`${publicUrl}/webhooks/mercadopago/${a.id}`,mpUser:a.mpUser||null,createdAt:a.createdAt});
  const publicApp=a=>({id:a.id,name:a.name,accountId:a.accountId,keyPrefix:a.keyPrefix,webhookUrl:a.webhookUrl||null,disabled:!!a.disabled,createdAt:a.createdAt});

  api.get('/me',(req,res)=>res.json({user:{id:req.user.id,name:req.user.name,email:req.user.email,role:req.admin?'admin':'member'},workspace:{id:req.ws.id,name:req.ws.name,plan:req.ws.plan,suspended:!!req.ws.suspended}}));

  // ---------- Administração UWY (todas as empresas) ----------
  const adminOnly=(req,res,next)=>req.admin?next():next(fail(403,'Somente a administração UWY.'));
  api.get('/admin/workspaces',adminOnly,route(async(req,res)=>{
    const [workspaces,users,apps,charges]=await Promise.all(['workspace','user','app','charge'].map(k=>store.list(k,{limit:5000})));
    const month=new Date().toISOString().slice(0,7);
    res.json({data:workspaces.map(w=>{const mine=charges.filter(c=>c.workspaceId===w.id),owner=users.find(u=>u.id===w.ownerId);return {id:w.id,name:w.name,plan:w.plan,suspended:!!w.suspended,createdAt:w.createdAt,owner:owner?{name:owner.name,email:owner.email,lastLoginAt:owner.lastLoginAt}:null,members:users.filter(u=>u.workspaceId===w.id).length,apps:apps.filter(a=>a.workspaceId===w.id).length,charges:mine.length,paidThisMonth:mine.flatMap(c=>(c.payments||[]).filter(p=>p.status==='paid'&&String(p.at).startsWith(month))).reduce((t,p)=>t+Number(p.amount||0),0)};}),plans:PLANS});
  }));
  api.patch('/admin/workspaces/:id',adminOnly,route(async(req,res)=>{
    const w=await store.get('workspace',req.params.id);if(!w)throw fail(404,'Empresa não encontrada.');const next={...w};
    if(req.body?.plan!==undefined){if(!PLANS.includes(req.body.plan))throw fail(400,'Plano inválido.');next.plan=req.body.plan;}
    if(req.body?.suspended!==undefined){if(w.id===req.ws.id&&req.body.suspended)throw fail(400,'Você não pode suspender a sua própria empresa.');next.suspended=!!req.body.suspended;}
    const saved=await store.put('workspace',next);res.json({id:saved.id,plan:saved.plan,suspended:!!saved.suspended});
  }));
  api.patch('/workspace',route(async(req,res)=>{const name=String(req.body?.name||'').trim();if(!name||name.length>80)throw fail(400,'Nome da empresa inválido.');if(req.ws.ownerId!==req.user.id)throw fail(403,'Só o dono pode renomear.');const ws=await store.put('workspace',{...req.ws,name});res.json({id:ws.id,name:ws.name,plan:ws.plan});}));

  api.get('/overview',route(async(req,res)=>{
    const where={workspaceId:req.ws.id},charges=await store.list('charge',{where,limit:1000}),month=new Date().toISOString().slice(0,7);
    const paidThisMonth=charges.flatMap(c=>(c.payments||[]).filter(p=>p.status==='paid'&&String(p.at).startsWith(month))).reduce((s,p)=>s+Number(p.amount||0),0);
    const activeSubs=charges.filter(c=>c.kind==='subscription'&&c.status==='active');
    res.json({paidThisMonth,mrr:activeSubs.reduce((s,c)=>s+c.amount/(c.intervalMonths||1),0),activeSubscriptions:activeSubs.length,pending:charges.filter(c=>c.status==='pending').length,accounts:(await store.list('account',{where})).length,apps:(await store.list('app',{where})).length,recent:charges.slice(0,8).map(publicCharge)});
  }));

  api.get('/accounts',route(async(req,res)=>res.json({data:(await store.list('account',{where:{workspaceId:req.ws.id}})).map(publicAccount)})));
  api.post('/accounts',route(async(req,res)=>{
    const name=String(req.body?.name||'').trim(),accessToken=String(req.body?.accessToken||'').trim(),webhookSecret=String(req.body?.webhookSecret||'').trim();
    if(!name)throw fail(400,'Dê um nome para a conta.');if(!/^(APP_USR|TEST)-[\w-]{20,}$/.test(accessToken))throw fail(400,'Access token do Mercado Pago inválido (começa com APP_USR- ou TEST-).');
    const me=await mp.whoami(accessToken).catch(()=>{throw fail(400,'O Mercado Pago não aceitou esse access token.');});
    const acc=await store.put('account',{id:randomId('acc',8),workspaceId:req.ws.id,name,mode:req.body?.mode==='live'?'live':'test',accessTokenEnc:vault.seal(accessToken),accessTokenLast4:accessToken.slice(-4),webhookSecretEnc:vault.seal(webhookSecret),mpUser:{id:me.id,nickname:me.nickname||null}});
    res.status(201).json(publicAccount(acc));
  }));
  api.patch('/accounts/:id',route(async(req,res)=>{
    const a=await own('account',req.params.id,req.ws);if(!a)throw fail(404,'Conta não encontrada.');const next={...a};
    if(req.body?.name)next.name=String(req.body.name).trim();
    if(req.body?.webhookSecret)next.webhookSecretEnc=vault.seal(String(req.body.webhookSecret).trim());
    if(req.body?.accessToken){const t=String(req.body.accessToken).trim();await mp.whoami(t).catch(()=>{throw fail(400,'O Mercado Pago não aceitou esse access token.');});next.accessTokenEnc=vault.seal(t);next.accessTokenLast4=t.slice(-4);}
    res.json(publicAccount(await store.put('account',next)));
  }));

  const newKey=mode=>'hc_'+(mode==='live'?'live':'test')+'_'+randomId('k',24).slice(2);
  api.get('/apps',route(async(req,res)=>res.json({data:(await store.list('app',{where:{workspaceId:req.ws.id}})).filter(a=>!a.internal).map(publicApp)})));
  api.post('/apps',route(async(req,res)=>{
    const name=String(req.body?.name||'').trim(),account=await own('account',req.body?.accountId,req.ws);
    if(!name)throw fail(400,'Dê um nome para o app.');if(!account)throw fail(400,'Escolha a conta do Mercado Pago que vai receber.');
    const webhookUrl=req.body?.webhookUrl?String(req.body.webhookUrl).trim():null;if(webhookUrl&&!/^https?:\/\//.test(webhookUrl))throw fail(400,'Webhook do app precisa ser uma URL http(s).');
    const apiKey=newKey(account.mode),webhookSecret='whsec_'+randomId('s',24).slice(2);
    const a=await store.put('app',{id:randomId('app',8),workspaceId:req.ws.id,name,accountId:account.id,webhookUrl,keyHash:sha256(apiKey),keyPrefix:apiKey.slice(0,12),webhookSecretEnc:vault.seal(webhookSecret)});
    res.status(201).json({...publicApp(a),apiKey,webhookSecret,note:'Guarde a chave e o segredo agora: eles não aparecem de novo.'});
  }));
  api.patch('/apps/:id',route(async(req,res)=>{
    const a=await own('app',req.params.id,req.ws);if(!a)throw fail(404,'App não encontrado.');const next={...a};
    if('webhookUrl' in (req.body||{}))next.webhookUrl=req.body.webhookUrl||null;if('disabled' in (req.body||{}))next.disabled=!!req.body.disabled;if(req.body?.name)next.name=String(req.body.name).trim();
    res.json(publicApp(await store.put('app',next)));
  }));
  api.post('/apps/:id/rotate-key',route(async(req,res)=>{
    const a=await own('app',req.params.id,req.ws);if(!a)throw fail(404,'App não encontrado.');const account=await store.get('account',a.accountId),apiKey=newKey(account?.mode);
    await store.put('app',{...a,keyHash:sha256(apiKey),keyPrefix:apiKey.slice(0,12)});res.json({apiKey,note:'A chave antiga parou de funcionar.'});
  }));

  api.get('/charges',route(async(req,res)=>{const where={workspaceId:req.ws.id};for(const k of ['appId','status','kind'])if(req.query[k])where[k]=String(req.query[k]);res.json({data:(await store.list('charge',{where,limit:300})).map(publicCharge)});}));
  api.post('/charges',route(async(req,res)=>{
    const a=await own('app',req.body?.appId,req.ws);if(!a)throw fail(400,'Escolha o app da cobrança.');
    const c=req.body?.kind==='subscription'?await billing.createSubscription(a,req.body):await billing.createCheckout(a,req.body);res.status(201).json(publicCharge(c));
  }));
  api.get('/charges/:id',route(async(req,res)=>{const c=await own('charge',req.params.id,req.ws);if(!c)throw fail(404,'Cobrança não encontrada.');res.json(publicCharge(c));}));
  // Maquininha: cobrança avulsa na hora, sem precisar de app. Usa um app interno do espaço.
  api.post('/quick-charge',route(async(req,res)=>{
    const accounts=await store.list('account',{where:{workspaceId:req.ws.id}});
    const account=req.body?.accountId?accounts.find(a=>a.id===req.body.accountId):accounts.find(a=>a.mode==='live')||accounts[0];
    if(!account)throw fail(400,'Conecte uma conta do Mercado Pago antes de cobrar.');
    let app=(await store.list('app',{where:{workspaceId:req.ws.id,internal:true}})).find(a=>a.accountId===account.id);
    if(!app)app=await store.put('app',{id:randomId('app',8),workspaceId:req.ws.id,name:'Maquininha · '+account.name,internal:true,accountId:account.id,webhookUrl:null,keyHash:sha256(randomId('k',32)),keyPrefix:'interno',webhookSecretEnc:null});
    const c=await billing.createCheckout(app,{amount:req.body?.amount,description:String(req.body?.description||'').trim()||'Cobrança '+req.ws.name,customer:{email:req.body?.customer?.email||undefined,name:req.body?.customer?.name||undefined},maxInstallments:req.body?.maxInstallments||12,source:'maquininha'},req.get('idempotency-key'));
    res.status(201).json(publicCharge(c));
  }));
  api.post('/charges/:id/cancel',route(async(req,res)=>{const c=await own('charge',req.params.id,req.ws);if(!c)throw fail(404,'Cobrança não encontrada.');res.json(publicCharge(await billing.cancelSubscription(await store.get('app',c.appId),c.id)));}));
  app.use('/api',api);

  // ---------- Painel web (build do Vite) ----------
  const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','web','dist');
  if(fs.existsSync(dist)){app.use(express.static(dist,{index:false,maxAge:'1h'}));app.get(/^\/(?!v1|api|auth|webhooks|health).*/,(req,res)=>res.sendFile(path.join(dist,'index.html')));}

  app.use((req,res)=>res.status(404).json({error:'Rota não encontrada.'}));
  app.use((err,req,res,next)=>{const status=err.status||500;if(status>=500)log.error?.('[hubcash]',err.message,err.mp||'');res.status(status).json({error:status>=500&&!err.mp?'Erro interno.':err.message,...(err.mp?{mercadoPago:err.mp.body}:{})});});
  return app;
}
