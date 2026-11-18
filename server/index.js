import {createApp} from './app.js';
import {createVault} from './crypto.js';
import {createMercadoPago} from './mercadopago.js';
import {memoryStore,supabaseStore} from './store.js';

const env=process.env;
for(const k of ['HUBCASH_MASTER_KEY','HUBCASH_ADMIN_PASSWORD','HUBCASH_PUBLIC_URL'])if(!env[k]){console.error(`[hubcash] Falta a variável ${k}. Veja .env.example.`);process.exit(1);}
const store=env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY?supabaseStore(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY):(console.warn('[hubcash] Sem Supabase: usando memória (os dados somem ao reiniciar).'),memoryStore());
const app=createApp({store,mp:createMercadoPago(),vault:createVault(env.HUBCASH_MASTER_KEY),env});
const port=Number(env.PORT||8080);
app.listen(port,()=>console.log(`[hubcash] no ar na porta ${port} (${store.kind})`));
