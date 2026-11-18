// Rotas HTTP do HubCash.
//   /v1/*        API pública para os apps da UWY (chave hc_...)
//   /admin/*     painel do dono (senha HUBCASH_ADMIN_PASSWORD)
//   /webhooks/*  notificações do Mercado Pago
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomId,sha256,safeEqual,signSession,verifySession} from './crypto.js';
import {createBilling,publicCharge,fail} from './billing.js';

const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const mask=v=>v?'••••'+String(v).slice(-4):null;

function limiter(max,windowMs){const hits=new Map();return (req,res,next)=>{const k=req.ip,now=Date.now(),h=(hits.get(k)||[]).filter(t=>now-t<windowMs);h.push(now);hits.set(k,h);if(h.length>max)return res.status(429).json({error:'Muitas tentativas. Espere alguns minutos.'});next();};}

export function createApp({store,mp,vault,env,fetchImpl,log=console}){
  const app=express(),billing=createBilling({store,mp,vault,publicUrl:env.HUBCASH_PUBLIC_URL,fetchImpl,log});
  const sessionSecret=sha256('session:'+env.HUBCASH_MASTER_KEY);
  app.disable('x-powered-by');app.set('trust proxy',1);
  app.use(express.json({limit:'256kb'}));

  app.get('/health',route(async(req,res)=>res.json({ok:await store.health(),store:store.kind})));

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
    req.hubApp=a;next();
  });
  const v1=express.Router();v1.use(appAuth);
  v1.post('/checkouts',route(async(req,res)=>res.status(201).json(publicCharge(await billing.createCheckout(req.hubApp,req.body,req.get('idempotency-key'))))));
  v1.post('/subscriptions',route(async(req,res)=>res.status(201).json(publicCharge(await billing.createSubscription(req.hubApp,req.body,req.get('idempotency-key'))))));
  v1.post('/subscriptions/:id/cancel',route(async(req,res)=>res.json(publicCharge(await billing.cancelSubscription(req.hubApp,req.params.id)))));
  v1.get('/charges/:id',route(async(req,res)=>{const c=await store.get('charge',req.params.id);if(!c||c.appId!==req.hubApp.id)throw fail(404,'Cobrança não encontrada.');res.json(publicCharge(c));}));
  v1.get('/charges',route(async(req,res)=>{const where={appId:req.hubApp.id};if(req.query.externalReference)where.externalReference=String(req.query.externalReference);if(req.query.status)where.status=String(req.query.status);res.json({data:(await store.list('charge',{where,limit:100})).map(publicCharge)});}));
  app.use('/v1',v1);

  // ---------- Painel (admin) ----------
  const admin=express.Router();
  admin.post('/login',limiter(10,15*60e3),route(async(req,res)=>{
    if(!env.HUBCASH_ADMIN_PASSWORD||!safeEqual(sha256(req.body?.password||''),sha256(env.HUBCASH_ADMIN_PASSWORD)))throw fail(401,'Senha incorreta.');
    res.json({token:signSession(sessionSecret)});
  }));
  admin.use((req,res,next)=>verifySession(sessionSecret,String(req.get('authorization')||'').replace(/^Bearer\s+/i,''))?next():res.status(401).json({error:'Entre no painel novamente.'}));

  const publicAccount=a=>({id:a.id,name:a.name,mode:a.mode,accessToken:mask(a.accessTokenLast4),webhookSecretSet:!!a.webhookSecretEnc,webhookUrl:`${String(env.HUBCASH_PUBLIC_URL||'').replace(/\/$/,'')}/webhooks/mercadopago/${a.id}`,mpUser:a.mpUser||null,createdAt:a.createdAt});
  const publicApp=a=>({id:a.id,name:a.name,accountId:a.accountId,keyPrefix:a.keyPrefix,webhookUrl:a.webhookUrl||null,disabled:!!a.disabled,createdAt:a.createdAt});

  admin.get('/overview',route(async(req,res)=>{
    const charges=await store.list('charge',{limit:1000}),month=new Date().toISOString().slice(0,7);
    const paidThisMonth=charges.flatMap(c=>(c.payments||[]).filter(p=>p.status==='paid'&&String(p.at).startsWith(month))).reduce((s,p)=>s+Number(p.amount||0),0);
    const activeSubs=charges.filter(c=>c.kind==='subscription'&&c.status==='active');
    res.json({paidThisMonth,mrr:activeSubs.reduce((s,c)=>s+c.amount/(c.intervalMonths||1),0),activeSubscriptions:activeSubs.length,pending:charges.filter(c=>c.status==='pending').length,accounts:(await store.list('account')).length,apps:(await store.list('app')).length,recent:charges.slice(0,8).map(publicCharge)});
  }));

  admin.get('/accounts',route(async(req,res)=>res.json({data:(await store.list('account')).map(publicAccount)})));
  admin.post('/accounts',route(async(req,res)=>{
    const name=String(req.body?.name||'').trim(),accessToken=String(req.body?.accessToken||'').trim(),webhookSecret=String(req.body?.webhookSecret||'').trim();
    if(!name)throw fail(400,'Dê um nome para a conta.');if(!/^(APP_USR|TEST)-[\w-]{20,}$/.test(accessToken))throw fail(400,'Access token do Mercado Pago inválido (começa com APP_USR- ou TEST-).');
    const me=await mp.whoami(accessToken).catch(()=>{throw fail(400,'O Mercado Pago não aceitou esse access token.');});
    const acc=await store.put('account',{id:randomId('acc',8),name,mode:req.body?.mode==='live'?'live':'test',accessTokenEnc:vault.seal(accessToken),accessTokenLast4:accessToken.slice(-4),webhookSecretEnc:vault.seal(webhookSecret),mpUser:{id:me.id,nickname:me.nickname||null}});
    res.status(201).json(publicAccount(acc));
  }));
  admin.patch('/accounts/:id',route(async(req,res)=>{
    const a=await store.get('account',req.params.id);if(!a)throw fail(404,'Conta não encontrada.');const next={...a};
    if(req.body?.name)next.name=String(req.body.name).trim();
    if(req.body?.webhookSecret)next.webhookSecretEnc=vault.seal(String(req.body.webhookSecret).trim());
    if(req.body?.accessToken){const t=String(req.body.accessToken).trim();await mp.whoami(t).catch(()=>{throw fail(400,'O Mercado Pago não aceitou esse access token.');});next.accessTokenEnc=vault.seal(t);next.accessTokenLast4=t.slice(-4);}
    res.json(publicAccount(await store.put('account',next)));
  }));

  const newKey=mode=>'hc_'+(mode==='live'?'live':'test')+'_'+randomId('k',24).slice(2);
  admin.get('/apps',route(async(req,res)=>res.json({data:(await store.list('app')).map(publicApp)})));
  admin.post('/apps',route(async(req,res)=>{
    const name=String(req.body?.name||'').trim(),account=await store.get('account',String(req.body?.accountId||''));
    if(!name)throw fail(400,'Dê um nome para o app.');if(!account)throw fail(400,'Escolha a conta do Mercado Pago que vai receber.');
    const webhookUrl=req.body?.webhookUrl?String(req.body.webhookUrl).trim():null;if(webhookUrl&&!/^https?:\/\//.test(webhookUrl))throw fail(400,'Webhook do app precisa ser uma URL http(s).');
    const apiKey=newKey(account.mode),webhookSecret='whsec_'+randomId('s',24).slice(2);
    const a=await store.put('app',{id:randomId('app',8),name,accountId:account.id,webhookUrl,keyHash:sha256(apiKey),keyPrefix:apiKey.slice(0,12),webhookSecretEnc:vault.seal(webhookSecret)});
    res.status(201).json({...publicApp(a),apiKey,webhookSecret,note:'Guarde a chave e o segredo agora: eles não aparecem de novo.'});
  }));
  admin.patch('/apps/:id',route(async(req,res)=>{
    const a=await store.get('app',req.params.id);if(!a)throw fail(404,'App não encontrado.');const next={...a};
    if('webhookUrl' in (req.body||{}))next.webhookUrl=req.body.webhookUrl||null;if('disabled' in (req.body||{}))next.disabled=!!req.body.disabled;if(req.body?.name)next.name=String(req.body.name).trim();
    res.json(publicApp(await store.put('app',next)));
  }));
  admin.post('/apps/:id/rotate-key',route(async(req,res)=>{
    const a=await store.get('app',req.params.id);if(!a)throw fail(404,'App não encontrado.');const account=await store.get('account',a.accountId),apiKey=newKey(account?.mode);
    await store.put('app',{...a,keyHash:sha256(apiKey),keyPrefix:apiKey.slice(0,12)});res.json({apiKey,note:'A chave antiga parou de funcionar.'});
  }));

  admin.get('/charges',route(async(req,res)=>{const where={};for(const k of ['appId','status','kind'])if(req.query[k])where[k]=String(req.query[k]);res.json({data:(await store.list('charge',{where,limit:300})).map(publicCharge)});}));
  // Cobrança criada à mão pelo painel (gera um link para mandar ao cliente).
  admin.post('/charges',route(async(req,res)=>{
    const a=await store.get('app',String(req.body?.appId||''));if(!a)throw fail(400,'Escolha o app da cobrança.');
    const c=req.body?.kind==='subscription'?await billing.createSubscription(a,req.body):await billing.createCheckout(a,req.body);res.status(201).json(publicCharge(c));
  }));
  admin.post('/charges/:id/cancel',route(async(req,res)=>{const c=await store.get('charge',req.params.id);if(!c)throw fail(404,'Cobrança não encontrada.');res.json(publicCharge(await billing.cancelSubscription(await store.get('app',c.appId),c.id)));}));
  app.use('/admin',admin);

  // ---------- Painel web (build do Vite) ----------
  const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','web','dist');
  if(fs.existsSync(dist)){app.use(express.static(dist,{index:false,maxAge:'1h'}));app.get(/^\/(?!v1|admin|webhooks|health).*/,(req,res)=>res.sendFile(path.join(dist,'index.html')));}

  app.use((req,res)=>res.status(404).json({error:'Rota não encontrada.'}));
  app.use((err,req,res,next)=>{const status=err.status||500;if(status>=500)log.error?.('[hubcash]',err.message,err.mp||'');res.status(status).json({error:status>=500&&!err.mp?'Erro interno.':err.message,...(err.mp?{mercadoPago:err.mp.body}:{})});});
  return app;
}
