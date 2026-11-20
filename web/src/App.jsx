import {useCallback,useEffect,useState} from 'react';
import {Maquininha} from './Maquininha.jsx';
import {LayoutDashboard,Receipt,Boxes,Landmark,Code2,MessageCircle,LogOut,Plus,Copy,RefreshCw,Wallet,ShieldCheck,Smartphone} from 'lucide-react';

async function api(path,body,method=body?'POST':'GET'){
  const res=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'content-type':'application/json','x-hubcash':'1'},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(res.status===401)window.dispatchEvent(new Event('hubcash:logout'));
  if(!res.ok)throw new Error(data.error||'Erro '+res.status);return data;
}
const LOGIN_ERRORS={expirado:'O pedido de login expirou. Tente de novo.',recusado:'Você não autorizou o HubCash no LINKY.',linky:'Não foi possível concluir o login com o LINKY. Tente de novo.'};
const brl=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const date=v=>v?new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const STATUS={pending:'Aguardando',paid:'Pago',failed:'Falhou',refunded:'Estornado',active:'Ativa',paused:'Pausada',canceled:'Cancelada'};
const INTERVAL={1:'mês',2:'2 meses',3:'trimestre',6:'semestre',12:'ano'};
const fields=e=>Object.fromEntries(new FormData(e.currentTarget));
const copy=(t,notify)=>navigator.clipboard.writeText(t).then(()=>notify('Copiado.')).catch(()=>notify('Selecione e copie manualmente.'));

const Brand=()=><div className="hc-brand"><i><Wallet size={18}/></i><div>HubCash<br/><small>Pagamentos UWY</small></div></div>;
const Pill=({s})=><span className={'hc-pill '+s}>{STATUS[s]||s}</span>;
const Err=({e})=>e?<p className="hc-error">{e}</p>:null;

function Login({onEnter}){
  const [cfg,setCfg]=useState(null),err=LOGIN_ERRORS[new URLSearchParams(location.search).get('erro')];
  useEffect(()=>{fetch('/auth/config').then(r=>r.json()).then(setCfg).catch(()=>setCfg({}));},[]);
  return <div className="hc-login"><div className="hc-login-card">
    <Brand/>
    <div><h1>O caixa da sua empresa, num só lugar.</h1><p className="hc-muted">Cobranças, assinaturas e links de pagamento com o Mercado Pago.</p></div>
    <Err e={err}/>
    <a className="hc-btn hc-linky" href="/auth/login"><span className="hc-linky-mark">L</span> Entrar com LINKY</a>
    <a className="hc-btn ghost" href="/auth/login?signup=1">Criar conta com LINKY</a>
    {cfg?.devLogin&&<button className="hc-btn ghost small" onClick={async()=>{await fetch('/auth/dev-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'dev@uwy.local',name:'Dev UWY'})});onEnter();}}>Entrar como dev (só local)</button>}
    <p className="hc-muted hc-fine">Seu login é a sua conta LINKY, a mesma dos apps da UWY. by UWY</p>
  </div></div>;
}

function Overview(){
  const [d,setD]=useState(null),[err,setErr]=useState('');
  useEffect(()=>{api('/overview').then(setD).catch(e=>setErr(e.message));},[]);
  if(!d)return <><Err e={err}/>{!err&&<p className="hc-muted">Carregando…</p>}</>;
  return <>
    <div className="hc-stats">
      <div className="hc-stat"><span>Recebido no mês</span><b>{brl(d.paidThisMonth)}</b></div>
      <div className="hc-stat"><span>Receita recorrente (MRR)</span><b>{brl(d.mrr)}</b></div>
      <div className="hc-stat"><span>Assinaturas ativas</span><b>{d.activeSubscriptions}</b></div>
      <div className="hc-stat"><span>Aguardando pagamento</span><b>{d.pending}</b></div>
    </div>
    {(!d.accounts||!d.apps)&&<div className="hc-panel"><h2>Primeiros passos</h2><p className="hc-muted">1. Em <b>Contas Mercado Pago</b>, cadastre o access token e o segredo do webhook. 2. Em <b>Apps</b>, crie um app (ex.: OLUNE) e guarde a chave. 3. No app, use o conector da aba <b>Integração</b>.</p></div>}
    <div className="hc-panel"><h2>Últimas cobranças</h2><Charges rows={d.recent}/></div>
  </>;
}

function Charges({rows,apps=[],onCancel}){
  if(!rows?.length)return <p className="hc-empty">Nenhuma cobrança ainda.</p>;
  const name=id=>apps.find(a=>a.id===id)?.name;
  return <table className="hc-table"><thead><tr><th>Cobrança</th><th>Cliente</th><th>Valor</th><th>Status</th><th>Criada</th>{onCancel&&<th/>}</tr></thead><tbody>{rows.map(c=><tr key={c.id}>
    <td>{c.description}<small>{c.object==='subscription'?'Assinatura':'Pagamento único'}{name(c.appId)?' · '+name(c.appId):''}{c.externalReference?' · '+c.externalReference:''}</small></td>
    <td>{c.customer?.name||c.customer?.email}<small>{c.customer?.name?c.customer.email:''}</small></td>
    <td>{brl(c.amount)}<small>{c.object==='subscription'?'por '+INTERVAL[c.intervalMonths]:''}</small></td>
    <td><Pill s={c.status}/>{c.checkoutUrl&&c.status==='pending'&&<small><a className="hc-link" href={c.checkoutUrl} target="_blank" rel="noreferrer">link de pagamento</a></small>}</td>
    <td>{date(c.createdAt)}</td>
    {onCancel&&<td>{c.object==='subscription'&&c.status!=='canceled'&&<button className="hc-btn ghost small" onClick={()=>onCancel(c)}>Cancelar</button>}</td>}
  </tr>)}</tbody></table>;
}

function ChargesPage({notify}){
  const [rows,setRows]=useState(null),[apps,setApps]=useState([]),[err,setErr]=useState(''),[open,setOpen]=useState(false),[kind,setKind]=useState('checkout'),[busy,setBusy]=useState(false),[created,setCreated]=useState(null);
  const load=useCallback(()=>Promise.all([api('/charges'),api('/apps')]).then(([c,a])=>{setRows(c.data);setApps(a.data);}).catch(e=>setErr(e.message)),[]);
  useEffect(()=>{load();},[load]);
  return <>
    <div className="hc-title"><div><h1>Cobranças</h1><p>Tudo o que os apps e você cobraram pelo HubCash.</p></div><div className="hc-row"><button className="hc-btn ghost" onClick={load}><RefreshCw size={15}/> Atualizar</button><button className="hc-btn" onClick={()=>setOpen(!open)}><Plus size={16}/> Nova cobrança</button></div></div>
    <Err e={err}/>
    {created&&<div className="hc-secret"><b>Link de pagamento criado. Envie para o cliente:</b><code>{created.checkoutUrl}</code><div className="hc-row"><button className="hc-btn small" onClick={()=>copy(created.checkoutUrl,notify)}><Copy size={14}/> Copiar link</button><button className="hc-btn ghost small" onClick={()=>setCreated(null)}>Fechar</button></div></div>}
    {open&&<form className="hc-panel" onSubmit={async e=>{e.preventDefault();setBusy(true);setErr('');const f=fields(e);try{const c=await api('/charges',{appId:f.appId,kind,amount:Number(String(f.amount).replace(',','.')),description:f.description,intervalMonths:Number(f.intervalMonths||1),customer:{email:f.email,name:f.name},externalReference:f.externalReference||undefined,returnUrl:f.returnUrl||undefined});setCreated(c);setOpen(false);load();}catch(x){setErr(x.message);}finally{setBusy(false);}}}>
      <h2>Nova cobrança</h2>
      {!apps.length?<p className="hc-muted">Crie um app antes, na aba Apps.</p>:<div className="hc-form">
        <label>Tipo<select value={kind} onChange={e=>setKind(e.target.value)}><option value="checkout">Pagamento único (Pix, boleto, cartão)</option><option value="subscription">Assinatura recorrente (cartão)</option></select></label>
        <label>App<select name="appId" required>{apps.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Descrição<input name="description" required maxLength={120} placeholder="Ex.: OLUNE · Plano Anual"/></label>
        <label>Valor (R$)<input name="amount" required inputMode="decimal" placeholder="200,00"/></label>
        {kind==='subscription'&&<label>Repetir a cada<select name="intervalMonths" defaultValue="1">{[1,2,3,6,12].map(m=><option key={m} value={m}>{INTERVAL[m]}</option>)}</select></label>}
        <label>E-mail do cliente<input name="email" type="email" required/></label>
        <label>Nome do cliente<input name="name" maxLength={120}/></label>
        <label>Referência <small>(opcional, ex.: id da empresa)</small><input name="externalReference" maxLength={120}/></label>
        <label className="full">Voltar para <small>(opcional, URL após o pagamento)</small><input name="returnUrl" type="url" placeholder="https://"/></label>
        <div className="full hc-row"><button className="hc-btn" disabled={busy}>{busy?'Criando…':'Gerar link de pagamento'}</button><button type="button" className="hc-btn ghost" onClick={()=>setOpen(false)}>Cancelar</button></div>
      </div>}
    </form>}
    <div className="hc-panel">{rows?<Charges rows={rows} apps={apps} onCancel={async c=>{if(!confirm('Cancelar a assinatura de '+(c.customer?.email)+'? O Mercado Pago para de cobrar.'))return;try{await api('/charges/'+c.id+'/cancel',{});notify('Assinatura cancelada.');load();}catch(x){setErr(x.message);}}}/>:<p className="hc-muted">Carregando…</p>}</div>
  </>;
}

function AppsPage({notify}){
  const [apps,setApps]=useState([]),[accounts,setAccounts]=useState([]),[err,setErr]=useState(''),[secret,setSecret]=useState(null),[busy,setBusy]=useState(false);
  const load=useCallback(()=>Promise.all([api('/apps'),api('/accounts')]).then(([a,b])=>{setApps(a.data);setAccounts(b.data);}).catch(e=>setErr(e.message)),[]);
  useEffect(()=>{load();},[load]);
  return <>
    <div className="hc-title"><div><h1>Apps</h1><p>Cada app da UWY que cobra pelo HubCash tem a sua chave de API.</p></div></div>
    <Err e={err}/>
    {secret&&<div className="hc-secret"><b>Guarde agora: estes valores não aparecem de novo.</b>
      {secret.apiKey&&<><span className="hc-muted">Chave de API (HUBCASH_API_KEY)</span><code>{secret.apiKey}</code></>}
      {secret.webhookSecret&&<><span className="hc-muted">Segredo do webhook (HUBCASH_WEBHOOK_SECRET)</span><code>{secret.webhookSecret}</code></>}
      <div className="hc-row">{secret.apiKey&&<button className="hc-btn small" onClick={()=>copy(secret.apiKey,notify)}><Copy size={14}/> Copiar chave</button>}{secret.webhookSecret&&<button className="hc-btn small" onClick={()=>copy(secret.webhookSecret,notify)}><Copy size={14}/> Copiar segredo</button>}<button className="hc-btn ghost small" onClick={()=>setSecret(null)}>Já guardei</button></div></div>}
    <form className="hc-panel" onSubmit={async e=>{e.preventDefault();setBusy(true);setErr('');const form=e.currentTarget,f=fields(e);try{setSecret(await api('/apps',{name:f.name,accountId:f.accountId,webhookUrl:f.webhookUrl||null}));form.reset();load();}catch(x){setErr(x.message);}finally{setBusy(false);}}}>
      <h2>Novo app</h2>
      {!accounts.length?<p className="hc-muted">Cadastre uma conta do Mercado Pago antes.</p>:<div className="hc-form">
        <label>Nome<input name="name" required placeholder="OLUNE"/></label>
        <label>Recebe na conta<select name="accountId">{accounts.map(a=><option key={a.id} value={a.id}>{a.name} ({a.mode==='live'?'produção':'teste'})</option>)}</select></label>
        <label className="full">Webhook do app <small>(opcional: o HubCash avisa aqui quando um pagamento muda)</small><input name="webhookUrl" type="url" placeholder="https://olune.up.railway.app/api/billing/hubcash"/></label>
        <div className="full"><button className="hc-btn" disabled={busy}>{busy?'Criando…':'Criar app e gerar chave'}</button></div>
      </div>}
    </form>
    <div className="hc-panel"><h2>Apps cadastrados</h2>{!apps.length?<p className="hc-empty">Nenhum app ainda.</p>:<table className="hc-table"><thead><tr><th>App</th><th>Chave</th><th>Webhook</th><th/></tr></thead><tbody>{apps.map(a=><tr key={a.id}><td>{a.name}<small>{accounts.find(x=>x.id===a.accountId)?.name}</small></td><td><code>{a.keyPrefix}…</code></td><td><small>{a.webhookUrl||'—'}</small></td><td><button className="hc-btn ghost small" onClick={async()=>{if(!confirm('Gerar uma chave nova para '+a.name+'? A antiga para de funcionar na hora.'))return;try{setSecret(await api('/apps/'+a.id+'/rotate-key',{}));load();}catch(x){setErr(x.message);}}}>Trocar chave</button></td></tr>)}</tbody></table>}</div>
  </>;
}

function AccountsPage({notify}){
  const [rows,setRows]=useState([]),[err,setErr]=useState(''),[busy,setBusy]=useState(false);
  const load=useCallback(()=>api('/accounts').then(d=>setRows(d.data)).catch(e=>setErr(e.message)),[]);
  useEffect(()=>{load();},[load]);
  return <>
    <div className="hc-title"><div><h1>Contas Mercado Pago</h1><p>As chaves ficam cifradas no servidor e nunca voltam para a tela.</p></div></div>
    <Err e={err}/>
    <form className="hc-panel" onSubmit={async e=>{e.preventDefault();setBusy(true);setErr('');const form=e.currentTarget;try{await api('/accounts',fields(e));form.reset();notify('Conta conectada.');load();}catch(x){setErr(x.message);}finally{setBusy(false);}}}>
      <h2>Conectar conta</h2>
      <div className="hc-form">
        <label>Nome<input name="name" required placeholder="UWY"/></label>
        <label>Ambiente<select name="mode"><option value="test">Teste (credenciais de teste)</option><option value="live">Produção (dinheiro real)</option></select></label>
        <label className="full">Access token <small>(Mercado Pago › Suas integrações › Credenciais. Começa com APP_USR-)</small><input name="accessToken" required autoComplete="off" spellCheck={false}/></label>
        <label className="full">Assinatura secreta do webhook <small>(opcional agora: dá para colar depois, quando o webhook estiver configurado)</small><input name="webhookSecret" autoComplete="off" spellCheck={false}/></label>
        <div className="full"><button className="hc-btn" disabled={busy}>{busy?'Verificando com o Mercado Pago…':'Conectar'}</button></div>
      </div>
    </form>
    <div className="hc-panel"><h2>Contas conectadas</h2>{!rows.length?<p className="hc-empty">Nenhuma conta ainda.</p>:<table className="hc-table"><thead><tr><th>Conta</th><th>Token</th><th>URL do webhook (cole no Mercado Pago)</th></tr></thead><tbody>{rows.map(a=><tr key={a.id}><td>{a.name}<small>{a.mode==='live'?'Produção':'Teste'}{a.mpUser?.nickname?' · '+a.mpUser.nickname:''}</small></td><td><code>{a.accessToken}</code></td><td><code>{a.webhookUrl}</code><button className="hc-btn ghost small" style={{marginTop:6}} onClick={()=>copy(a.webhookUrl,notify)}><Copy size={13}/> Copiar</button><small>Eventos: Pagamentos e Planos e assinaturas.</small>{a.webhookSecretSet?<small className="hc-ok-text">Assinatura secreta configurada.</small>:<form className="hc-row" style={{marginTop:8}} onSubmit={async e=>{e.preventDefault();const form=e.currentTarget,f=fields(e);try{await api('/accounts/'+a.id,{webhookSecret:f.webhookSecret},'PATCH');form.reset();notify('Assinatura secreta salva.');load();}catch(x){setErr(x.message);}}}><input name="webhookSecret" required placeholder="Cole a assinatura secreta" autoComplete="off" spellCheck={false} aria-label={'Assinatura secreta de '+a.name}/><button className="hc-btn small">Salvar</button></form>}{!a.webhookSecretSet&&<small className="hc-bad">Sem a assinatura, o HubCash recusa os avisos de pagamento.</small>}</td></tr>)}</tbody></table>}</div>
  </>;
}

const SNIPPET=`// No servidor do seu app (Node 18+). Copie sdk/hubcash.js do repositório.
import {HubCash} from './hubcash.js';

const hubcash = new HubCash({
  apiKey: process.env.HUBCASH_API_KEY,   // hc_live_... ou hc_test_...
  baseUrl: process.env.HUBCASH_URL,      // endereço do HubCash
});

// Assinatura de R$ 50 por mês
const sub = await hubcash.subscriptions.create({
  amount: 50,
  description: 'Plano Mensal',
  intervalMonths: 1,                      // 1, 2, 3, 6 ou 12
  customer: { email: 'cliente@empresa.com', name: 'Empresa X' },
  externalReference: 'empresa_123',       // seu id interno
  returnUrl: 'https://meuapp.com/obrigado',
});
// mande o cliente para sub.checkoutUrl

// Pagamento único (Pix, boleto ou cartão parcelado)
const pay = await hubcash.checkouts.create({
  amount: 2160, description: 'Plano Anual', maxInstallments: 12,
  customer: { email: 'cliente@empresa.com' }, externalReference: 'empresa_123',
});

// Webhook: o HubCash avisa o seu app (charge.paid, subscription.activated, ...)
app.post('/hooks/hubcash', express.text({ type: '*/*' }), (req, res) => {
  const event = HubCash.verifyWebhook(req.body, req.get('x-hubcash-signature'), process.env.HUBCASH_WEBHOOK_SECRET);
  if (!event) return res.status(401).end();
  // event.type, event.data.status, event.data.externalReference
  res.status(200).end();
});`;

function Integration({notify}){
  return <>
    <div className="hc-title"><div><h1>Integração</h1><p>Como um app da UWY cobra pelo HubCash.</p></div><button className="hc-btn ghost" onClick={()=>copy(SNIPPET,notify)}><Copy size={15}/> Copiar exemplo</button></div>
    <div className="hc-panel"><pre className="hc-code">{SNIPPET}</pre></div>
    <div className="hc-panel"><h2>Eventos enviados ao app</h2><table className="hc-table"><tbody>
      {[['charge.paid','Pagamento único aprovado'],['charge.failed','Pagamento recusado ou cancelado'],['charge.refunded','Estornado'],['subscription.activated','Cliente autorizou a assinatura'],['subscription.payment_succeeded','Cobrança recorrente aprovada'],['subscription.payment_failed','Cobrança recorrente recusada'],['subscription.canceled','Assinatura cancelada']].map(([k,v])=><tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>)}
    </tbody></table></div>
  </>;
}

const PLAN_NAMES={trial:'Teste',starter:'Starter',pro:'Pro',enterprise:'Enterprise'};
function AdminPage({notify,me}){
  const [d,setD]=useState(null),[err,setErr]=useState('');
  const load=useCallback(()=>api('/admin/workspaces').then(setD).catch(e=>setErr(e.message)),[]);
  useEffect(()=>{load();},[load]);
  const save=async(w,changes)=>{try{await api('/admin/workspaces/'+w.id,changes,'PATCH');notify('Empresa atualizada.');load();}catch(x){setErr(x.message);}};
  return <>
    <div className="hc-title"><div><h1>Administração UWY</h1><p>Todas as empresas que usam o HubCash. Acesso liberado pela sua conta LINKY.</p></div><button className="hc-btn ghost" onClick={load}><RefreshCw size={15}/> Atualizar</button></div>
    <Err e={err}/>
    {d&&<div className="hc-stats">
      <div className="hc-stat"><span>Empresas</span><b>{d.data.length}</b></div>
      <div className="hc-stat"><span>Pagantes</span><b>{d.data.filter(w=>w.plan!=='trial'&&!w.suspended).length}</b></div>
      <div className="hc-stat"><span>Suspensas</span><b>{d.data.filter(w=>w.suspended).length}</b></div>
      <div className="hc-stat"><span>Movimentado no mês</span><b>{brl(d.data.reduce((t,w)=>t+w.paidThisMonth,0))}</b></div>
    </div>}
    <div className="hc-panel">{!d?<p className="hc-muted">Carregando…</p>:<table className="hc-table"><thead><tr><th>Empresa</th><th>Responsável</th><th>Uso</th><th>Plano</th><th/></tr></thead><tbody>{d.data.map(w=><tr key={w.id}>
      <td>{w.name}<small>desde {date(w.createdAt)}</small></td>
      <td>{w.owner?.name||'—'}<small>{w.owner?.email}</small></td>
      <td>{w.apps} apps · {w.charges} cobranças<small>{brl(w.paidThisMonth)} no mês</small></td>
      <td><select value={w.plan} onChange={e=>save(w,{plan:e.target.value})}>{d.plans.map(p=><option key={p} value={p}>{PLAN_NAMES[p]||p}</option>)}</select></td>
      <td>{w.id===me.workspace.id?<small>sua empresa</small>:<button className="hc-btn ghost small" onClick={()=>{if(w.suspended||confirm('Suspender '+w.name+'? O painel e as chaves de API dela param de funcionar.'))save(w,{suspended:!w.suspended});}}>{w.suspended?'Reativar':'Suspender'}</button>}{w.suspended&&<small className="hc-bad">suspensa</small>}</td>
    </tr>)}</tbody></table>}</div>
  </>;
}

function QuickPage({notify}){const [accounts,setAccounts]=useState(null);useEffect(()=>{api('/accounts').then(d=>setAccounts(d.data)).catch(()=>setAccounts([]));},[]);return <Maquininha api={api} notify={notify} accounts={accounts}/>;}

const PAGES=[['maquininha','Cobrar agora',Smartphone],['overview','Visão geral',LayoutDashboard],['charges','Cobranças',Receipt],['apps','Apps',Boxes],['accounts','Contas Mercado Pago',Landmark],['integration','Integração',Code2]];

export function App(){
  const [me,setMe]=useState(undefined),[page,setPage]=useState('maquininha'),[toast,setToast]=useState('');
  const loadMe=useCallback(()=>api('/me').then(setMe).catch(()=>setMe(null)),[]);
  useEffect(()=>{loadMe();const out=()=>setMe(null);window.addEventListener('hubcash:logout',out);return()=>window.removeEventListener('hubcash:logout',out);},[loadMe]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),3000);return()=>clearTimeout(t);},[toast]);
  if(me===undefined)return <div className="hc-login"><Brand/></div>;
  if(!me)return <Login onEnter={loadMe}/>;
  if(location.search)history.replaceState(null,'','/');
  return <div className="hc-layout">
    <aside className="hc-side"><Brand/><nav>{[...PAGES,...(me.user.role==='admin'?[['admin','Administração',ShieldCheck]]:[])].map(([k,l,I])=><button key={k} className={page===k?'active':''} onClick={()=>setPage(k)}><I size={17}/>{l}</button>)}<button disabled title="Em breve: cobrança automática pelo WhatsApp"><MessageCircle size={17}/>Cobrador WhatsApp<span className="soon">em breve</span></button></nav>
      <div className="bottom hc-me"><b>{me.workspace.name}</b><small>{me.user.name||me.user.email}</small><button className="hc-btn ghost small" onClick={async()=>{await fetch('/auth/logout',{method:'POST'});setMe(null);}}><LogOut size={14}/> Sair</button></div></aside>
    <main className="hc-main">
      {me.workspace.suspended&&<p className="hc-error" style={{marginBottom:18}}>A conta HubCash desta empresa está suspensa. Fale com a UWY para reativar.</p>}
      {page==='maquininha'&&<><div className="hc-title"><div><h1>Cobrar agora</h1><p>Digite o valor e mostre o QR Code ou mande o link. Como uma maquininha.</p></div></div><QuickPage notify={setToast}/></>}
      {page==='overview'&&<><div className="hc-title"><div><h1>Visão geral</h1><p>O caixa da {me.workspace.name}.</p></div></div><Overview/></>}
      {page==='charges'&&<ChargesPage notify={setToast}/>}
      {page==='apps'&&<AppsPage notify={setToast}/>}
      {page==='accounts'&&<AccountsPage notify={setToast}/>}
      {page==='integration'&&<Integration notify={setToast}/>}
      {page==='admin'&&me.user.role==='admin'&&<AdminPage notify={setToast} me={me}/>}
    </main>
    {toast&&<div className="hc-toast" role="status">{toast}</div>}
  </div>;
}
