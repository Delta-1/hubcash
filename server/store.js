// Armazenamento: uma tabela genérica (kind, id, data jsonb) no Supabase, ou memória em dev/testes.
import {createClient} from '@supabase/supabase-js';

const clone=v=>v==null?v:structuredClone(v);

export function memoryStore(){
  const db=new Map(),bucket=k=>{if(!db.has(k))db.set(k,new Map());return db.get(k);};
  return {
    kind:'memory',
    async get(kind,id){return clone(bucket(kind).get(id))||null;},
    async put(kind,obj){const now=new Date().toISOString(),prev=bucket(kind).get(obj.id),row={...obj,createdAt:obj.createdAt||prev?.createdAt||now,updatedAt:now};bucket(kind).set(obj.id,clone(row));return clone(row);},
    async insert(kind,obj){if(bucket(kind).has(obj.id))return false;await this.put(kind,obj);return true;},
    async list(kind,{where={},limit=200}={}){return [...bucket(kind).values()].filter(r=>Object.entries(where).every(([k,v])=>r[k]===v)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map(clone);},
    async findOne(kind,where){return (await this.list(kind,{where,limit:1}))[0]||null;},
    async health(){return true;},
  };
}

export function supabaseStore(url,serviceKey,table='hubcash_records'){
  const db=createClient(url,serviceKey,{auth:{persistSession:false}});
  const unwrap=({data,error})=>{if(error)throw new Error('Banco: '+error.message);return data;};
  const toObj=r=>r&&{...r.data,id:r.id,createdAt:r.created_at,updatedAt:r.updated_at};
  return {
    kind:'supabase',
    async get(kind,id){return toObj(unwrap(await db.from(table).select('*').eq('kind',kind).eq('id',id).maybeSingle()));},
    async put(kind,obj){const {id,createdAt,updatedAt,...data}=obj;const row={kind,id,data,updated_at:new Date().toISOString()};if(createdAt)row.created_at=createdAt;return toObj(unwrap(await db.from(table).upsert(row).select('*').single()));},
    async insert(kind,obj){const {id,createdAt,updatedAt,...data}=obj;const {error}=await db.from(table).insert({kind,id,data});if(error){if(error.code==='23505')return false;throw new Error('Banco: '+error.message);}return true;},
    async list(kind,{where={},limit=200}={}){let q=db.from(table).select('*').eq('kind',kind);for(const [k,v] of Object.entries(where))q=q.eq('data->>'+k,String(v));return unwrap(await q.order('created_at',{ascending:false}).limit(limit)).map(toObj);},
    async findOne(kind,where){return (await this.list(kind,{where,limit:1}))[0]||null;},
    async health(){const {error}=await db.from(table).select('id').limit(1);return !error;},
  };
}
