// Conector do HubCash para os apps da UWY (Node 18+, sem dependências).
// Copie este arquivo para o seu app ou importe direto do repositório.
//
//   import {HubCash} from './hubcash.js';
//   const hubcash = new HubCash({apiKey: process.env.HUBCASH_API_KEY, baseUrl: process.env.HUBCASH_URL});
//   const sub = await hubcash.subscriptions.create({amount: 50, description: 'Plano Mensal', customer: {email: 'cliente@empresa.com'}});
//   // redirecione o cliente para sub.checkoutUrl
import crypto from 'node:crypto';

export class HubCashError extends Error{constructor(message,status,body){super(message);this.status=status;this.body=body;}}

export class HubCash{
  constructor({apiKey,baseUrl,fetch:fetchImpl=globalThis.fetch}={}){
    if(!apiKey)throw new Error('HubCash: informe apiKey (hc_live_... ou hc_test_...).');
    if(!baseUrl)throw new Error('HubCash: informe baseUrl (ex.: https://hubcash.up.railway.app).');
    this.apiKey=apiKey;this.baseUrl=String(baseUrl).replace(/\/$/,'');this.fetch=fetchImpl;
    this.checkouts={create:(body,opts)=>this.request('POST','/v1/checkouts',body,opts)};
    this.subscriptions={create:(body,opts)=>this.request('POST','/v1/subscriptions',body,opts),cancel:id=>this.request('POST',`/v1/subscriptions/${encodeURIComponent(id)}/cancel`)};
    this.charges={get:id=>this.request('GET',`/v1/charges/${encodeURIComponent(id)}`),list:(q={})=>this.request('GET','/v1/charges?'+new URLSearchParams(q))};
  }
  async request(method,path,body,{idempotencyKey}={}){
    const headers={authorization:'Bearer '+this.apiKey,accept:'application/json'};
    if(body)headers['content-type']='application/json';
    if(method==='POST')headers['idempotency-key']=idempotencyKey||crypto.randomUUID();
    const res=await this.fetch(this.baseUrl+path,{method,headers,body:body?JSON.stringify(body):undefined});
    const data=await res.json().catch(()=>null);
    if(!res.ok)throw new HubCashError(data?.error||'HubCash respondeu '+res.status,res.status,data);
    return data;
  }
  // Valida o webhook que o HubCash manda para o seu app. Passe o corpo CRU (string).
  static verifyWebhook(rawBody,signatureHeader,secret,toleranceSec=300){
    const parts=Object.fromEntries(String(signatureHeader||'').split(',').map(p=>p.split('=').map(s=>s.trim())));
    const ts=Number(parts.t);if(!ts||!parts.v1||Math.abs(Date.now()/1000-ts)>toleranceSec)return null;
    const expected=crypto.createHmac('sha256',secret).update(ts+'.'+rawBody).digest('hex');
    const a=Buffer.from(expected),b=Buffer.from(parts.v1);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
    return JSON.parse(rawBody);
  }
}
