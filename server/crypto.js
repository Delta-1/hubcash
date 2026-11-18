// Segredos: chaves do Mercado Pago ficam cifradas (AES-256-GCM) com a HUBCASH_MASTER_KEY.
// Chaves de API dos apps ficam só como hash: são mostradas uma única vez.
import crypto from 'node:crypto';

export const randomId=(prefix,bytes=12)=>prefix+'_'+crypto.randomBytes(bytes).toString('base64url');
export const sha256=text=>crypto.createHash('sha256').update(String(text)).digest('hex');
export const hmacHex=(secret,text)=>crypto.createHmac('sha256',secret).update(text).digest('hex');
export function safeEqual(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);}

export function createVault(masterKey){
  if(!masterKey||String(masterKey).length<32)throw new Error('HUBCASH_MASTER_KEY precisa ter pelo menos 32 caracteres.');
  const key=crypto.createHash('sha256').update(String(masterKey)).digest();
  return {
    seal(plain){if(plain==null||plain==='')return null;const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const enc=Buffer.concat([c.update(String(plain),'utf8'),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),enc.toString('base64url')].join('.');},
    open(sealed){if(!sealed)return null;const [v,iv,tag,enc]=String(sealed).split('.');if(v!=='v1')throw new Error('Formato de segredo desconhecido.');const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(enc,'base64url')),d.final()]).toString('utf8');},
  };
}

// Token de sessão do painel: payload assinado com HMAC, sem estado no servidor.
export function signSession(secret,ttlMs=12*3600e3){const payload=Buffer.from(JSON.stringify({exp:Date.now()+ttlMs})).toString('base64url');return payload+'.'+hmacHex(secret,payload);}
export function verifySession(secret,token){const [payload,sig]=String(token||'').split('.');if(!payload||!sig||!safeEqual(sig,hmacHex(secret,payload)))return false;try{return JSON.parse(Buffer.from(payload,'base64url').toString()).exp>Date.now();}catch{return false;}}

// Assinatura dos eventos que o HubCash envia para os apps (mesmo formato t=,v1= do Mercado Pago).
export function signEvent(secret,body,ts=Math.floor(Date.now()/1000)){return `t=${ts},v1=${hmacHex(secret,ts+'.'+body)}`;}
export function verifyEvent(secret,body,header,toleranceSec=300){const parts=Object.fromEntries(String(header||'').split(',').map(p=>p.split('=').map(s=>s.trim())));const ts=Number(parts.t);if(!ts||!parts.v1||Math.abs(Date.now()/1000-ts)>toleranceSec)return false;return safeEqual(parts.v1,hmacHex(secret,ts+'.'+body));}
