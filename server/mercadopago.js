// Cliente mínimo da API do Mercado Pago (Checkout Pro, Assinaturas e consultas).
import crypto from 'node:crypto';
import {hmacHex,safeEqual} from './crypto.js';

export const MP_API='https://api.mercadopago.com';

export function createMercadoPago({fetchImpl=globalThis.fetch,base=MP_API}={}){
  async function call(token,method,path,body,idempotencyKey){
    if(!token)throw Object.assign(new Error('Conta do Mercado Pago sem access token.'),{status:400});
    const headers={authorization:'Bearer '+token,'content-type':'application/json'};
    if(method!=='GET')headers['x-idempotency-key']=idempotencyKey||crypto.randomUUID();
    const res=await fetchImpl(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
    const text=await res.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data={raw:text};}
    if(!res.ok){const err=new Error('Mercado Pago recusou: '+(data?.message||data?.error||res.status));err.status=502;err.mp={status:res.status,body:data};throw err;}
    return data;
  }
  return {
    createPreference:(token,body,key)=>call(token,'POST','/checkout/preferences',body,key),
    updatePreference:(token,id,body)=>call(token,'PUT','/checkout/preferences/'+encodeURIComponent(id),body),
    createPreapproval:(token,body,key)=>call(token,'POST','/preapproval',body,key),
    getPreapproval:(token,id)=>call(token,'GET','/preapproval/'+encodeURIComponent(id)),
    updatePreapproval:(token,id,body)=>call(token,'PUT','/preapproval/'+encodeURIComponent(id),body),
    getPayment:(token,id)=>call(token,'GET','/v1/payments/'+encodeURIComponent(id)),
    getAuthorizedPayment:(token,id)=>call(token,'GET','/authorized_payments/'+encodeURIComponent(id)),
    whoami:token=>call(token,'GET','/users/me'),
  };
}

// Valida o cabeçalho x-signature de um webhook do Mercado Pago.
// Manifesto: "id:{data.id};request-id:{x-request-id};ts:{ts};" assinado com HMAC-SHA256.
export function verifyMpSignature({secret,signature,requestId,dataId}){
  if(!secret||!signature||!requestId||!dataId)return false;
  const parts=Object.fromEntries(String(signature).split(',').map(p=>p.split('=').map(s=>s.trim())));
  if(!parts.ts||!parts.v1)return false;
  const id=/[a-z]/i.test(String(dataId))?String(dataId).toLowerCase():String(dataId);
  return safeEqual(parts.v1,hmacHex(secret,`id:${id};request-id:${requestId};ts:${parts.ts};`));
}
