import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createApp} from '../server/app.js';
import {createVault} from '../server/crypto.js';
import {memoryStore} from '../server/store.js';
import {HubCash} from '../sdk/hubcash.js';

const env={HUBCASH_MASTER_KEY:'x'.repeat(40),HUBCASH_ADMIN_PASSWORD:'senha-forte',HUBCASH_PUBLIC_URL:'https://hubcash.test'};
const MP_SECRET='segredo-do-webhook-mp';

// Mercado Pago falso: guarda o que foi criado e responde consultas.
function fakeMp(){
  const calls=[],payments=new Map(),preapprovals=new Map();
  return {calls,payments,preapprovals,
    async whoami(t){if(!t.startsWith('APP_USR-'))throw new Error('401');return {id:123,nickname:'UWY'};},
    async createPreference(t,b){calls.push(['preference',b]);return {id:'pref_1',init_point:'https://mp.test/checkout/pref_1',sandbox_init_point:'https://sandbox.mp.test/pref_1'};},
    async createPreapproval(t,b){calls.push(['preapproval',b]);const p={id:'pre_1',status:'pending',external_reference:b.external_reference,init_point:'https://mp.test/sub/pre_1'};preapprovals.set(p.id,p);return p;},
    async updatePreapproval(t,id,b){calls.push(['update',id,b]);const p=preapprovals.get(id);p.status=b.status;return p;},
    async getPreapproval(t,id){return preapprovals.get(id);},
    async getPayment(t,id){return payments.get(String(id));},
    async getAuthorizedPayment(){return {};},
  };
}

async function setup(){
  const mp=fakeMp(),store=memoryStore(),delivered=[];
  const fetchImpl=async(url,opts)=>{delivered.push({url,opts});return {ok:true,status:200};};
  const app=createApp({store,mp,vault:createVault(env.HUBCASH_MASTER_KEY),env,fetchImpl,log:{warn(){},error(){}}});
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(method,path,body,headers={})=>{const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json()};};
  const {body:{token}}=await call('POST','/admin/login',{password:env.HUBCASH_ADMIN_PASSWORD});
  const adm={authorization:'Bearer '+token};
  const {body:account}=await call('POST','/admin/accounts',{name:'UWY',mode:'test',accessToken:'APP_USR-'+'1'.repeat(30),webhookSecret:MP_SECRET},adm);
  const {body:created}=await call('POST','/admin/apps',{name:'OLUNE',accountId:account.id,webhookUrl:'https://olune.test/hooks/hubcash'},adm);
  return {mp,store,delivered,server,base,call,adm,account,created,close:()=>server.close()};
}

const mpSignature=(dataId,requestId,ts=String(Date.now()))=>`ts=${ts},v1=${crypto.createHmac('sha256',MP_SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex')}`;
const wait=()=>new Promise(r=>setTimeout(r,50));

test('painel exige senha e nunca devolve o access token',async()=>{
  const t=await setup();try{
    assert.equal((await t.call('POST','/admin/login',{password:'errada'})).status,401);
    assert.equal((await t.call('GET','/admin/accounts')).status,401);
    const {body}=await t.call('GET','/admin/accounts',null,t.adm);
    assert.equal(body.data[0].accessToken,'••••1111');
    assert.ok(!JSON.stringify(body).includes('APP_USR-'));
    assert.equal(body.data[0].webhookUrl,`https://hubcash.test/webhooks/mercadopago/${t.account.id}`);
    assert.match(t.created.apiKey,/^hc_test_/);
  }finally{t.close();}
});

test('app cria checkout com o SDK e recebe aviso quando é pago',async()=>{
  const t=await setup();try{
    const hc=new HubCash({apiKey:t.created.apiKey,baseUrl:t.base});
    const c=await hc.checkouts.create({amount:2160,description:'OLUNE Anual',customer:{email:'RH@Empresa.com'},externalReference:'company_42'});
    assert.equal(c.status,'pending');assert.equal(c.checkoutUrl,'https://sandbox.mp.test/pref_1');assert.equal(c.customer.email,'rh@empresa.com');
    const pref=t.mp.calls[0][1];
    assert.equal(pref.items[0].unit_price,2160);assert.equal(pref.external_reference,c.id);assert.equal(pref.notification_url,`https://hubcash.test/webhooks/mercadopago/${t.account.id}`);

    t.mp.payments.set('999',{id:999,status:'approved',external_reference:c.id,transaction_amount:2160,date_approved:'2026-11-18T12:00:00Z'});
    const bad=await t.call('POST','/webhooks/mercadopago/'+t.account.id+'?data.id=999&type=payment',{type:'payment',data:{id:'999'}},{'x-signature':'ts=1,v1=abc','x-request-id':'r1'});
    assert.equal(bad.status,401);
    const ok=await t.call('POST','/webhooks/mercadopago/'+t.account.id+'?data.id=999&type=payment',{type:'payment',action:'payment.updated',data:{id:'999'}},{'x-signature':mpSignature('999','r2'),'x-request-id':'r2'});
    assert.equal(ok.status,200);await wait();

    const paid=await hc.charges.get(c.id);
    assert.equal(paid.status,'paid');assert.equal(paid.payments[0].amount,2160);
    const hook=t.delivered.find(d=>d.url==='https://olune.test/hooks/hubcash');
    assert.ok(hook,'o app foi avisado');
    const event=HubCash.verifyWebhook(hook.opts.body,hook.opts.headers['x-hubcash-signature'],t.created.webhookSecret);
    assert.equal(event.type,'charge.paid');assert.equal(event.data.externalReference,'company_42');
    assert.equal(HubCash.verifyWebhook(hook.opts.body,hook.opts.headers['x-hubcash-signature'],'segredo-errado'),null);
  }finally{t.close();}
});

test('assinatura mensal: cria, ativa pelo webhook e cancela',async()=>{
  const t=await setup();try{
    const hc=new HubCash({apiKey:t.created.apiKey,baseUrl:t.base});
    const s=await hc.subscriptions.create({amount:50,description:'Plano Mensal',intervalMonths:1,customer:{email:'cliente@empresa.com'},returnUrl:'https://olune.test/obrigado'});
    assert.equal(s.object,'subscription');assert.equal(s.checkoutUrl,'https://mp.test/sub/pre_1');
    const pre=t.mp.calls[0][1];
    assert.deepEqual(pre.auto_recurring,{frequency:1,frequency_type:'months',transaction_amount:50,currency_id:'BRL'});
    t.mp.preapprovals.get('pre_1').status='authorized';
    await t.call('POST','/webhooks/mercadopago/'+t.account.id+'?data.id=pre_1&type=subscription_preapproval',{type:'subscription_preapproval',data:{id:'pre_1'}},{'x-signature':mpSignature('pre_1','r3'),'x-request-id':'r3'});
    await wait();
    assert.equal((await hc.charges.get(s.id)).status,'active');
    const ov=await t.call('GET','/admin/overview',null,t.adm);
    assert.equal(ov.body.activeSubscriptions,1);assert.equal(ov.body.mrr,50);
    const canceled=await hc.subscriptions.cancel(s.id);
    assert.equal(canceled.status,'canceled');assert.deepEqual(t.mp.calls.at(-1),['update','pre_1',{status:'cancelled'}]);
  }finally{t.close();}
});

test('validações, chave inválida e idempotência',async()=>{
  const t=await setup();try{
    const key={authorization:'Bearer '+t.created.apiKey};
    assert.equal((await t.call('POST','/v1/checkouts',{amount:10,description:'x',customer:{email:'a@b.co'}},{authorization:'Bearer hc_test_'+'z'.repeat(30)})).status,401);
    assert.equal((await t.call('POST','/v1/checkouts',{amount:-5,description:'x',customer:{email:'a@b.co'}},key)).status,400);
    assert.equal((await t.call('POST','/v1/subscriptions',{amount:50,description:'x',intervalMonths:5,customer:{email:'a@b.co'}},key)).status,400);
    const a=await t.call('POST','/v1/checkouts',{amount:10,description:'x',customer:{email:'a@b.co'}},{...key,'idempotency-key':'pedido-1'});
    const b=await t.call('POST','/v1/checkouts',{amount:10,description:'x',customer:{email:'a@b.co'}},{...key,'idempotency-key':'pedido-1'});
    assert.equal(a.body.id,b.body.id);assert.equal(t.mp.calls.length,1);
  }finally{t.close();}
});
