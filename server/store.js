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

// Postgres direto (ex.: banco da Railway em DATABASE_URL). Cria a tabela sozinho.
export async function postgresStore(connectionString,table='hubcash_records'){
  const {default:pg}=await import('pg');
  const local=/@(localhost|127\.0\.0\.1|[\w-]+\.railway\.internal)(:|\/)/.test(connectionString);
  const pool=new pg.Pool({connectionString,max:5,ssl:local?false:{rejectUnauthorized:false}});
  await pool.query(`create table if not exists ${table} (kind text not null, id text not null, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (kind,id));
    create index if not exists ${table}_kind_created on ${table} (kind, created_at desc);
    create index if not exists ${table}_data on ${table} using gin (data jsonb_path_ops);`);
  const toObj=r=>r&&{...r.data,id:r.id,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()};
  const split=obj=>{const {id,createdAt,updatedAt,...data}=obj;return {id,createdAt,data};};
  return {
    kind:'postgres',
    async get(kind,id){const {rows}=await pool.query(`select * from ${table} where kind=$1 and id=$2`,[kind,id]);return toObj(rows[0])||null;},
    async put(kind,obj){const {id,createdAt,data}=split(obj);const {rows}=await pool.query(`insert into ${table} (kind,id,data,created_at) values ($1,$2,$3,coalesce($4::timestamptz,now())) on conflict (kind,id) do update set data=excluded.data, updated_at=now() returning *`,[kind,id,data,createdAt||null]);return toObj(rows[0]);},
    async insert(kind,obj){const {id,data}=split(obj);const {rowCount}=await pool.query(`insert into ${table} (kind,id,data) values ($1,$2,$3) on conflict do nothing`,[kind,id,data]);return rowCount===1;},
    async list(kind,{where={},limit=200}={}){const {rows}=await pool.query(`select * from ${table} where kind=$1 and data @> $2::jsonb order by created_at desc limit $3`,[kind,JSON.stringify(where),limit]);return rows.map(toObj);},
    async findOne(kind,where){return (await this.list(kind,{where,limit:1}))[0]||null;},
    async health(){try{await pool.query('select 1');return true;}catch{return false;}},
  };
}
