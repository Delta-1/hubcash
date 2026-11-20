// Núcleo do HubCash: cria cobranças no Mercado Pago, recebe webhooks e avisa os apps.
import {randomId,sha256,signEvent} from './crypto.js';
import {verifyMpSignature} from './mercadopago.js';

export const fail=(status,message)=>Object.assign(new Error(message),{status});

// Status unificado do HubCash.
const PAYMENT_STATUS={approved:'paid',authorized:'pending',pending:'pending',in_process:'pending',in_mediation:'pending',rejected:'failed',cancelled:'failed',refunded:'refunded',charged_back:'refunded'};
const PREAPPROVAL_STATUS={pending:'pending',authorized:'active',paused:'paused',cancelled:'canceled'};
const INTERVALS=[1,2,3,6,12];

const money=v=>{const n=Math.round(Number(v)*100)/100;if(!Number.isFinite(n)||n<=0||n>1e7)throw fail(400,'amount deve ser um valor em reais maior que zero (ex.: 200 ou 49.90).');return n;};
const text=(v,name,max=200,required=true)=>{const s=String(v??'').trim();if(required&&!s)throw fail(400,name+' é obrigatório.');if(s.length>max)throw fail(400,name+' passou de '+max+' caracteres.');return s;};
const email=v=>{const s=text(v,'customer.email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))throw fail(400,'customer.email inválido.');return s;};
const url=(v,name)=>{if(!v)return null;try{const u=new URL(v);if(!['https:','http:'].includes(u.protocol))throw 0;return u.toString();}catch{throw fail(400,name+' precisa ser uma URL http(s).');}};

export function publicCharge(c){
  return {id:c.id,object:c.kind,source:c.source||'api',status:c.status,amount:c.amount,currency:c.currency,description:c.description,intervalMonths:c.intervalMonths||null,customer:c.customer,externalReference:c.externalReference||null,checkoutUrl:c.checkoutUrl||null,paidAt:c.paidAt||null,lastPaymentAt:c.lastPaymentAt||null,payments:(c.payments||[]).map(p=>({id:p.id,status:p.status,amount:p.amount,at:p.at})),appId:c.appId,createdAt:c.createdAt,updatedAt:c.updatedAt};
}

export function createBilling({store,mp,vault,publicUrl,fetchImpl=globalThis.fetch,log=console}){
  const base=String(publicUrl||'').replace(/\/$/,'');
  const accountToken=async(accountId,workspaceId)=>{const a=await store.get('account',accountId);if(!a||(workspaceId&&a.workspaceId!==workspaceId))throw fail(400,'App sem conta do Mercado Pago válida.');return {account:a,token:vault.open(a.accessTokenEnc)};};

  // Idempotência: a mesma Idempotency-Key do mesmo app devolve a mesma cobrança.
  async function idempotent(app,key,create){
    if(!key)return create();
    const id='idem_'+sha256(app.id+':'+key).slice(0,40),hit=await store.get('idempotency',id);
    if(hit)return store.get('charge',hit.chargeId);
    const charge=await create();await store.put('idempotency',{id,chargeId:charge.id});return charge;
  }

  async function createCheckout(app,body,idemKey){
    const amount=money(body.amount),description=text(body.description,'description',120),customer={email:body.customer?.email?email(body.customer.email):null,name:text(body.customer?.name,'customer.name',120,false)||null};
    const externalReference=text(body.externalReference,'externalReference',120,false)||null,returnUrl=url(body.returnUrl,'returnUrl');
    const maxInstallments=Math.min(12,Math.max(1,Math.floor(Number(body.maxInstallments)||12)));
    return idempotent(app,idemKey,async()=>{
      const {account,token}=await accountToken(app.accountId,app.workspaceId),id=randomId('chg');
      const pref=await mp.createPreference(token,{
        items:[{id,title:description,quantity:1,unit_price:amount,currency_id:'BRL'}],
        ...(customer.email||customer.name?{payer:{...(customer.email?{email:customer.email}:{}),...(customer.name?{name:customer.name}:{})}}:{}),
        external_reference:id,
        notification_url:`${base}/webhooks/mercadopago/${account.id}`,
        payment_methods:{installments:maxInstallments},
        ...(returnUrl?{back_urls:{success:returnUrl,pending:returnUrl,failure:returnUrl},auto_return:'approved'}:{}),
        metadata:{hubcash_charge_id:id,hubcash_app_id:app.id},
      },id);
      return store.put('charge',{id,kind:'checkout',source:body.source||'api',workspaceId:app.workspaceId,appId:app.id,accountId:account.id,status:'pending',amount,currency:'BRL',description,customer,externalReference,returnUrl,mpId:pref.id,checkoutUrl:account.mode==='test'?(pref.sandbox_init_point||pref.init_point):pref.init_point,payments:[]});
    });
  }

  async function createSubscription(app,body,idemKey){
    const amount=money(body.amount),description=text(body.description,'description',120),customer={email:email(body.customer?.email),name:text(body.customer?.name,'customer.name',120,false)||null};
    const intervalMonths=Number(body.intervalMonths||1);if(!INTERVALS.includes(intervalMonths))throw fail(400,'intervalMonths deve ser 1, 2, 3, 6 ou 12.');
    const externalReference=text(body.externalReference,'externalReference',120,false)||null,returnUrl=url(body.returnUrl,'returnUrl')||base+'/obrigado';
    return idempotent(app,idemKey,async()=>{
      const {account,token}=await accountToken(app.accountId,app.workspaceId),id=randomId('sub');
      const pre=await mp.createPreapproval(token,{
        reason:description,external_reference:id,payer_email:customer.email,back_url:returnUrl,status:'pending',
        auto_recurring:{frequency:intervalMonths,frequency_type:'months',transaction_amount:amount,currency_id:'BRL'},
      },id);
      return store.put('charge',{id,kind:'subscription',workspaceId:app.workspaceId,appId:app.id,accountId:account.id,status:'pending',amount,currency:'BRL',description,intervalMonths,customer,externalReference,returnUrl,mpId:pre.id,checkoutUrl:pre.init_point,payments:[]});
    });
  }

  async function cancelSubscription(app,id){
    const c=await store.get('charge',id);if(!c||c.appId!==app.id||c.kind!=='subscription')throw fail(404,'Assinatura não encontrada.');
    if(c.status==='canceled')return c;
    const {token}=await accountToken(c.accountId);await mp.updatePreapproval(token,c.mpId,{status:'cancelled'});
    const out=await store.put('charge',{...c,status:'canceled',canceledAt:new Date().toISOString()});notifyApp(out,'subscription.canceled');return out;
  }

  // Avisa o app (webhook de saída), assinado com o segredo do app. Tenta 3 vezes.
  async function notifyApp(charge,type){
    const app=await store.get('app',charge.appId);if(!app?.webhookUrl)return;
    const event={id:randomId('evt'),type,createdAt:new Date().toISOString(),data:publicCharge(charge)},body=JSON.stringify(event),secret=vault.open(app.webhookSecretEnc);
    for(let attempt=1;attempt<=3;attempt++){
      try{const res=await fetchImpl(app.webhookUrl,{method:'POST',headers:{'content-type':'application/json','x-hubcash-signature':signEvent(secret,body),'x-hubcash-event':type},body,signal:AbortSignal.timeout(8000)});
        await store.put('charge',{...(await store.get('charge',charge.id)),lastDelivery:{eventId:event.id,type,status:res.status,ok:res.ok,at:new Date().toISOString()}});if(res.ok)return;}
      catch(e){log.warn?.('[hubcash] aviso ao app falhou',app.id,e.message);}
      await new Promise(r=>setTimeout(r,attempt*1000));
    }
  }

  const typeFor=(c,prev)=>c.kind==='subscription'?(c.status==='active'&&prev!=='active'?'subscription.activated':c.status==='canceled'?'subscription.canceled':'subscription.updated'):c.status==='paid'?'charge.paid':c.status==='failed'?'charge.failed':c.status==='refunded'?'charge.refunded':'charge.updated';

  async function applyPayment(token,paymentId){
    const p=await mp.getPayment(token,paymentId);
    let c=p.external_reference?await store.get('charge',p.external_reference):null;
    if(!c&&p.metadata?.preapproval_id)c=await store.findOne('charge',{mpId:p.metadata.preapproval_id});
    if(!c)return null;
    const status=PAYMENT_STATUS[p.status]||'pending',payment={id:String(p.id),status,amount:p.transaction_amount,at:p.date_approved||p.date_created};
    const payments=[...(c.payments||[]).filter(x=>x.id!==payment.id),payment],prev=c.status;
    const next=c.kind==='subscription'?{...c,payments,lastPaymentAt:status==='paid'?payment.at:c.lastPaymentAt}:{...c,payments,status,paidAt:status==='paid'?payment.at:c.paidAt};
    const saved=await store.put('charge',next);
    notifyApp(saved,c.kind==='subscription'?(status==='paid'?'subscription.payment_succeeded':status==='failed'?'subscription.payment_failed':'subscription.updated'):typeFor(saved,prev));
    return saved;
  }

  async function applyPreapproval(token,preId){
    const pre=await mp.getPreapproval(token,preId);
    const c=(pre.external_reference&&await store.get('charge',pre.external_reference))||await store.findOne('charge',{mpId:pre.id});if(!c)return null;
    const prev=c.status,saved=await store.put('charge',{...c,status:PREAPPROVAL_STATUS[pre.status]||c.status,nextPaymentAt:pre.next_payment_date||c.nextPaymentAt||null});
    if(saved.status!==prev)notifyApp(saved,typeFor(saved,prev));return saved;
  }

  // Webhook do Mercado Pago. Valida a assinatura, deduplica e processa depois de responder 200.
  async function receiveWebhook(accountId,{headers,query,body}){
    const account=await store.get('account',accountId);if(!account)throw fail(404,'Conta desconhecida.');
    const dataId=query['data.id']||body?.data?.id,type=body?.type||body?.topic||query.type||query.topic;
    const secret=vault.open(account.webhookSecretEnc);
    if(!verifyMpSignature({secret,signature:headers['x-signature'],requestId:headers['x-request-id'],dataId}))throw fail(401,'Assinatura do webhook inválida.');
    const eventId='mp_'+sha256(accountId+':'+type+':'+dataId+':'+(body?.action||'')+':'+headers['x-request-id']).slice(0,40);
    const fresh=await store.insert('mp_event',{id:eventId,accountId,type,dataId:String(dataId),action:body?.action||null});
    return {fresh,run:async()=>{if(!fresh)return;const token=vault.open(account.accessTokenEnc);try{
      if(type==='payment')await applyPayment(token,dataId);
      else if(type==='subscription_preapproval')await applyPreapproval(token,dataId);
      else if(type==='subscription_authorized_payment'){const ap=await mp.getAuthorizedPayment(token,dataId);if(ap.payment?.id)await applyPayment(token,ap.payment.id);else if(ap.preapproval_id)await applyPreapproval(token,ap.preapproval_id);}
    }catch(e){log.error?.('[hubcash] webhook',type,dataId,e.message);}}};
  }

  return {createCheckout,createSubscription,cancelSubscription,receiveWebhook,notifyApp,applyPayment,applyPreapproval};
}
