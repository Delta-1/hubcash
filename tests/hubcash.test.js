import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createApp} from '../server/app.js';
import {createVault} from '../server/crypto.js';
import {memoryStore,postgresStore} from '../server/store.js';
import {HubCash} from '../sdk/hubcash.js';

const env={HUBCASH_MASTER_KEY:'x'.repeat(40),HUBCASH_PUBLIC_URL:'https://hubcash.test',HUBCASH_ADMIN_LINKY_IDS:'linky-user-1'};
const MP_SECRET='segredo-do-webhook-mp';

// Mercado Pago falso: guarda o que foi criado e responde consultas.
function fakeMp(){
  const calls=[],payments=new Map(),preapprovals=new Map();
  return {calls,payments,preapprovals,
    async whoami(t){if(!t.startsWith('APP_USR-'))throw new Error('401');return {id:123,nickname:'UWY'};},
    async updatePreference(t,id,b){calls.push(['update-preference',id,b]);return {id};},
    async createPreference(t,b){calls.push(['preference',b]);return {id:'pref_1',init_point:'https://mp.test/checkout/pref_1',sandbox_init_point:'https://sandbox.mp.test/pref_1'};},
    async createPreapproval(t,b){calls.push(['preapproval',b]);const p={id:'pre_1',status:'pending',external_reference:b.external_reference,init_point:'https://mp.test/sub/pre_1'};preapprovals.set(p.id,p);return p;},
    async updatePreapproval(t,id,b){calls.push(['update',id,b]);const p=preapprovals.get(id);p.status=b.status;return p;},
    async getPreapproval(t,id){return preapprovals.get(id);},
    async getPayment(t,id){return payments.get(String(id));},
    async getAuthorizedPayment(){return {};},
  };
}

// LINKY falso: devolve uma URL de autorização e, no callback, a identidade escolhida no teste.
function fakeLinky(){
  const linky={next:{sub:'linky-user-1',email:'dono@uwy.com',name:'Dono UWY'},
    async start(){return {url:'https://linky.test/authorize?state=abc',pending:{verifier:'v',state:'abc',nonce:'n'}};},
    async finish(url,pending){if(pending.state!=='abc'||!String(url).includes('code='))throw new Error('state');return linky.next;}};
  return linky;
}

async function setup(){
  const mp=fakeMp(),store=process.env.TEST_DATABASE_URL?await postgresStore(process.env.TEST_DATABASE_URL,'hc_test_'+crypto.randomBytes(4).toString('hex')):memoryStore(),delivered=[],linky=fakeLinky();
  const fetchImpl=async(url,opts)=>{delivered.push({url,opts});return {ok:true,status:200};};
  const app=createApp({store,mp,vault:createVault(env.HUBCASH_MASTER_KEY),env,linky,fetchImpl,log:{warn(){},error(){}}});
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(method,path,body,headers={})=>{const res=await fetch(base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(method!=='GET'?{'x-hubcash':'1'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:res.status,headers:res.headers,body:await res.json().catch(()=>null)};};
  // Faz o fluxo Entrar com LINKY e devolve o cabeçalho de cookie da sessão.
  const login=async identity=>{
    if(identity)linky.next=identity;
    const start=await call('GET','/auth/login');
    const pending=start.headers.getSetCookie().find(c=>c.startsWith('hc_login=')).split(';')[0];
    const cb=await call('GET','/auth/callback?code=xyz&state=abc',null,{cookie:pending});
    assert.equal(cb.status,303);assert.equal(cb.headers.get('location'),'/');
    return {cookie:cb.headers.getSetCookie().find(c=>c.startsWith('hc_session=')).split(';')[0]};
  };
  const adm=await login();
  const {body:account}=await call('POST','/api/accounts',{name:'UWY',mode:'test',accessToken:'APP_USR-'+'1'.repeat(30),webhookSecret:MP_SECRET},adm);
  const {body:created}=await call('POST','/api/apps',{name:'OLUNE',accountId:account.id,webhookUrl:'https://olune.test/hooks/hubcash'},adm);
  return {mp,store,app,delivered,server,base,call,login,adm,account,created,close:()=>server.close()};
}

const mpSignature=(dataId,requestId,ts=String(Date.now()))=>`ts=${ts},v1=${crypto.createHmac('sha256',MP_SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex')}`;
const wait=()=>new Promise(r=>setTimeout(r,50));

test('painel exige login LINKY e nunca devolve o access token',async()=>{
  const t=await setup();try{
    assert.equal((await t.call('GET','/api/accounts')).status,401);
    assert.equal((await t.call('GET','/auth/callback?code=x&state=abc')).headers.get('location'),'/?erro=expirado');
    const me=await t.call('GET','/api/me',null,t.adm);
    assert.equal(me.body.user.email,'dono@uwy.com');assert.equal(me.body.workspace.name,'Empresa de Dono');
    const {body}=await t.call('GET','/api/accounts',null,t.adm);
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
    const ov=await t.call('GET','/api/overview',null,t.adm);
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

test('cada empresa só vê os próprios dados',async()=>{
  const t=await setup();try{
    const other=await t.login({sub:'linky-user-2',email:'outra@empresa.com',name:'Ana Souza'});
    assert.equal((await t.call('GET','/api/me',null,other)).body.workspace.name,'Empresa de Ana');
    assert.deepEqual((await t.call('GET','/api/apps',null,other)).body.data,[]);
    assert.deepEqual((await t.call('GET','/api/accounts',null,other)).body.data,[]);
    assert.equal((await t.call('POST','/api/apps',{name:'X',accountId:t.account.id},other)).status,400);
    assert.equal((await t.call('POST','/api/charges',{appId:t.created.id,amount:10,description:'x',customer:{email:'a@b.co'}},other)).status,400);
    // O mesmo usuário LINKY volta para o mesmo espaço.
    const again=await t.login({sub:'linky-user-1',email:'dono@uwy.com',name:'Dono UWY'});
    assert.equal((await t.call('GET','/api/apps',null,again)).body.data.length,1);
    // Sem o cabeçalho x-hubcash, a mutação é recusada.
    assert.equal((await t.call('POST','/api/apps',{name:'Y',accountId:t.account.id},{...t.adm,'x-hubcash':'0'})).status,403);
    // Sair invalida a sessão.
    await t.call('POST','/auth/logout',{},again);
    assert.equal((await t.call('GET','/api/me',null,again)).status,401);
  }finally{t.close();}
});

test('conta administradora do LINKY vê todas as empresas e pode suspender',async()=>{
  const t=await setup();try{
    const other=await t.login({sub:'linky-user-2',email:'outra@empresa.com',name:'Ana Souza'});
    assert.equal((await t.call('GET','/api/me',null,other)).body.user.role,'member');
    assert.equal((await t.call('GET','/api/admin/workspaces',null,other)).status,403);
    const owner=await t.login({sub:'linky-user-1',email:'dono@uwy.com',name:'Dono UWY'});
    assert.equal((await t.call('GET','/api/me',null,owner)).body.user.role,'admin');
    const list=(await t.call('GET','/api/admin/workspaces',null,owner)).body.data;
    assert.equal(list.length,2);
    const ana=list.find(w=>w.owner?.email==='outra@empresa.com');
    assert.equal((await t.call('PATCH','/api/admin/workspaces/'+ana.id,{plan:'pro',suspended:true},owner)).body.suspended,true);
    assert.equal((await t.call('GET','/api/apps',null,other)).status,403);
    assert.equal((await t.call('GET','/api/me',null,other)).body.workspace.suspended,true);
    const mine=list.find(w=>w.owner?.email==='dono@uwy.com');
    assert.equal((await t.call('PATCH','/api/admin/workspaces/'+mine.id,{suspended:true},owner)).status,400);
  }finally{t.close();}
});

test('maquininha cobra na hora sem app e sem e-mail do cliente',async()=>{
  const t=await setup();try{
    const out=await t.call('POST','/api/quick-charge',{amount:37.5,description:'Corte de cabelo'},t.adm);
    assert.equal(out.status,201);assert.equal(out.body.status,'pending');assert.equal(out.body.source,'maquininha');assert.equal(out.body.amount,37.5);
    const pref=t.mp.calls.at(-1)[1];
    assert.equal(pref.items[0].unit_price,37.5);assert.equal(pref.payer,undefined);
    assert.equal((await t.call('GET','/api/charges/'+out.body.id,null,t.adm)).body.id,out.body.id);
    assert.equal((await t.call('GET','/api/apps',null,t.adm)).body.data.length,1,'app interno não aparece na lista');
    const other=await t.login({sub:'linky-user-9',email:'x@y.com',name:'Zé'});
    assert.equal((await t.call('POST','/api/quick-charge',{amount:10},other)).status,400);
    assert.equal((await t.call('GET','/api/charges/'+out.body.id,null,other)).status,404);
  }finally{t.close();}
});

test('em produção, o painel aberto por outro endereço vai para o endereço oficial',async()=>{
  const app=createApp({store:memoryStore(),mp:fakeMp(),vault:createVault(env.HUBCASH_MASTER_KEY),env:{...env,NODE_ENV:'production'},linky:fakeLinky(),log:{warn(){},error(){}}});
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});const base='http://127.0.0.1:'+server.address().port;
  try{
    const res=await fetch(base+'/auth/login?x=1',{redirect:'manual'});
    assert.equal(res.status,301);assert.equal(res.headers.get('location'),'https://hubcash.test/auth/login?x=1');
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/api/me',{redirect:'manual'})).status,401);
  }finally{server.close();}
});

test('cobrança fixa recebe várias vezes e pode ser desativada',async()=>{
  const t=await setup();try{
    const c=(await t.call('POST','/api/quick-charge',{amount:25,description:'QR do balcão',mode:'fixed'},t.adm)).body;
    assert.equal(c.mode,'fixed');assert.equal(c.status,'active');assert.equal(c.expiresAt,null);
    assert.equal(t.mp.calls.at(-1)[1].expires,undefined);
    for(const [id,rid] of [['501','f1'],['502','f2']]){
      t.mp.payments.set(id,{id:Number(id),status:'approved',external_reference:c.id,transaction_amount:25,date_approved:new Date().toISOString()});
      await t.call('POST','/webhooks/mercadopago/'+t.account.id+'?data.id='+id+'&type=payment',{type:'payment',data:{id}},{'x-signature':mpSignature(id,rid),'x-request-id':rid});
    }
    await wait();
    const after=(await t.call('GET','/api/charges/'+c.id,null,t.adm)).body;
    assert.equal(after.status,'active');assert.equal(after.paidCount,2);assert.equal(after.paidTotal,50);
    assert.equal((await t.call('GET','/api/overview',null,t.adm)).body.paidThisMonth,50);
    const off=(await t.call('POST','/api/charges/'+c.id+'/deactivate',{},t.adm)).body;
    assert.equal(off.status,'inactive');assert.equal(t.mp.calls.at(-1)[0],'update-preference');assert.equal(t.mp.calls.at(-1)[2].expires,true);
    assert.equal((await t.call('POST','/api/quick-charge',{amount:5,mode:'fixed',expiresInMinutes:30},t.adm)).status,400);
  }finally{t.close();}
});

test('cobrança temporária expira no prazo escolhido',async()=>{
  const t=await setup();try{
    const c=(await t.call('POST','/api/quick-charge',{amount:80,expiresInMinutes:30},t.adm)).body;
    const pref=t.mp.calls.at(-1)[1];
    assert.equal(pref.expires,true);assert.ok(pref.expiration_date_to.endsWith('+00:00'));assert.equal(pref.date_of_expiration,pref.expiration_date_to);
    const mins=(Date.parse(c.expiresAt)-Date.now())/60e3;assert.ok(mins>29&&mins<31);assert.equal(c.status,'pending');
    const stored=await t.store.get('charge',c.id);await t.store.put('charge',{...stored,expiresAt:new Date(Date.now()-1000).toISOString()});
    assert.equal((await t.call('GET','/api/charges/'+c.id,null,t.adm)).body.status,'expired');
    assert.equal((await t.call('POST','/api/quick-charge',{amount:5,expiresInMinutes:1},t.adm)).status,400);
  }finally{t.close();}
});

test('cobrador: cliente, recorrência mensal limitada, geração automática e atraso',async()=>{
  const t=await setup();try{
    const bad=await t.call('POST','/api/collector/customers',{name:'Ana',phone:'123'},t.adm);assert.equal(bad.status,400);
    const cus=(await t.call('POST','/api/collector/customers',{name:'Padaria Sol',phone:'(68) 99999-0000',email:'Padaria@Sol.com',document:'11.222.333/0001-81'},t.adm)).body;
    assert.equal(cus.phone,'5568999990000');assert.equal(cus.email,'padaria@sol.com');assert.equal(cus.situation,'ok');
    const today=new Date(Date.now()-3*3600e3).toISOString().slice(0,10);
    // 3 mensalidades de R$ 150 a partir de hoje, vencendo hoje: a primeira sai na hora.
    const rec=(await t.call('POST','/api/collector/recurrings',{customerId:cus.id,description:'Mensalidade',amount:'150,00',frequency:'monthly',dayOfMonth:28,startDate:today,limit:'count',occurrences:3,leadDays:31},t.adm)).body;
    assert.equal(rec.status,'active');assert.equal(rec.generated,1);
    let detail=(await t.call('GET','/api/collector/customers/'+cus.id,null,t.adm)).body;
    assert.equal(detail.charges.length,1);assert.equal(detail.charges[0].amount,150);assert.ok(detail.charges[0].dueDate);
    assert.equal(t.mp.calls.at(-1)[1].external_reference,detail.charges[0].id);
    // varredura: com 31 dias de antecedência, gera a próxima; não duplica na segunda passada
    // gerar manualmente até acabar
    await t.call('POST','/api/collector/recurrings/'+rec.id+'/generate',{},t.adm);
    await t.call('POST','/api/collector/recurrings/'+rec.id+'/generate',{},t.adm);
    detail=(await t.call('GET','/api/collector/customers/'+cus.id,null,t.adm)).body;
    assert.equal(detail.charges.length,3);assert.equal(detail.recurrings[0].status,'finished');
    assert.equal((await t.call('POST','/api/collector/recurrings/'+rec.id+'/generate',{},t.adm)).status,400);
    // vencida e não paga vira atrasada
    const first=detail.charges.at(-1),stored=await t.store.get('charge',first.id);
    await t.store.put('charge',{...stored,dueDate:'2020-01-10'});
    detail=(await t.call('GET','/api/collector/customers/'+cus.id,null,t.adm)).body;
    assert.equal(detail.situation,'overdue');assert.equal(detail.charges.find(c=>c.id===first.id).status,'overdue');
    const sum=(await t.call('GET','/api/collector/summary',null,t.adm)).body;
    assert.equal(sum.customers,1);assert.equal(sum.overdueCount,1);
    // outra empresa não vê
    const other=await t.login({sub:'linky-user-7',email:'o@o.com',name:'Outro'});
    assert.equal((await t.call('GET','/api/collector/customers/'+cus.id,null,other)).status,404);
  }finally{t.close();}
});

test('cobrador: varredura gera só o que entra na antecedência e não duplica',async()=>{
  const t=await setup();try{
    const cus=(await t.call('POST','/api/collector/customers',{name:'Cliente X'},t.adm)).body;
    const today=new Date(Date.now()-3*3600e3).toISOString().slice(0,10);
    const rec=(await t.call('POST','/api/collector/recurrings',{customerId:cus.id,description:'Plano',amount:50,frequency:'weekly',startDate:today,leadDays:0},t.adm)).body;
    assert.equal(rec.generated,1);
    const before=t.mp.calls.length;
    assert.equal(await t.app.collector.sweep(),0);assert.equal(await t.app.collector.sweep(),0);
    assert.equal(t.mp.calls.length,before);
    const r=await t.store.get('recurring',rec.id);await t.store.put('recurring',{...r,nextDueDate:today});
    assert.equal(await t.app.collector.sweep(),1);assert.equal(await t.app.collector.sweep(),0);
    await t.call('PATCH','/api/collector/recurrings/'+rec.id,{action:'pause'},t.adm);
    const r2=await t.store.get('recurring',rec.id);await t.store.put('recurring',{...r2,nextDueDate:today});
    assert.equal(await t.app.collector.sweep(),0);
  }finally{t.close();}
});
