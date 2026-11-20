import {createApp} from './app.js';
import {createVault} from './crypto.js';
import {createMercadoPago} from './mercadopago.js';
import {memoryStore,supabaseStore,postgresStore} from './store.js';
import {createLinky,LINKY_ISSUER} from './linky.js';

const env=process.env;
for(const k of ['HUBCASH_MASTER_KEY','HUBCASH_PUBLIC_URL'])if(!env[k]){console.error(`[hubcash] Falta a variável ${k}. Veja .env.example.`);process.exit(1);}
if(env.NODE_ENV==='production'&&!env.DATABASE_URL&&!(env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY)){console.error('[hubcash] Produção sem banco: configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou DATABASE_URL).');process.exit(1);}
const store=env.DATABASE_URL?await postgresStore(env.DATABASE_URL):env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY?supabaseStore(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY):(console.warn('[hubcash] Sem banco: usando memória (os dados somem ao reiniciar).'),memoryStore());
let linky=null;
if(env.LINKY_CLIENT_ID)linky=createLinky({issuer:env.LINKY_ISSUER||LINKY_ISSUER,clientId:env.LINKY_CLIENT_ID,clientSecret:env.LINKY_CLIENT_SECRET||undefined,appUrl:env.HUBCASH_PUBLIC_URL});
else console.warn('[hubcash] Entrar com LINKY desligado: configure LINKY_CLIENT_ID.');
const app=createApp({store,mp:createMercadoPago(),vault:createVault(env.HUBCASH_MASTER_KEY),env,linky});
const port=Number(env.PORT||8080);
// Cobrador: gera os vencimentos que entram na janela de antecedência.
const sweep=()=>app.collector.sweep().then(n=>n&&console.log(`[cobrador] ${n} cobrança(s) gerada(s)`)).catch(e=>console.error('[cobrador]',e.message));
setTimeout(sweep,30e3);setInterval(sweep,15*60e3);
app.listen(port,()=>console.log(`[hubcash] no ar na porta ${port} (${store.kind}). Callback do LINKY: ${new URL('/auth/callback',env.HUBCASH_PUBLIC_URL).href}`));
