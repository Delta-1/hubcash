import {useCallback,useEffect,useState} from 'react';
import {Plus,ChevronLeft,Copy,MessageCircle,Pause,Play,X,Zap,Repeat} from 'lucide-react';

const brl=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const dmy=d=>d?d.split('-').reverse().join('/'):'—';
const fields=e=>Object.fromEntries(new FormData(e.currentTarget));
const SITUATION={ok:['Em dia','paid'],open:['Em aberto','pending'],overdue:['Atrasado','failed']};
const CSTATUS={pending:'Aguardando',paid:'Pago',overdue:'Atrasada',failed:'Recusada',refunded:'Estornada',expired:'Expirada',inactive:'Desativada'};
const RSTATUS={active:'Ativa',paused:'Pausada',finished:'Concluída',canceled:'Encerrada'};
const FREQ={monthly:'Mensal',weekly:'Semanal',quarterly:'Trimestral',semiannual:'Semestral',yearly:'Anual'};
const today=()=>new Date(Date.now()-3*3600e3).toISOString().slice(0,10);
const phoneView=p=>p?'+'+p.replace(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/,'$1 ($2) $3-$4'):'';

function waLink(customer,charge){
  const text=`Olá${customer.name?' '+customer.name.split(' ')[0]:''}! Segue a cobrança de ${brl(charge.amount)} (${charge.description}). Vencimento: ${dmy(charge.dueDate)}. Pague por Pix, cartão ou boleto: ${charge.checkoutUrl}`;
  return (customer.phone?'https://wa.me/'+customer.phone:'https://wa.me/')+'?text='+encodeURIComponent(text);
}

export function Cobrador({api,notify}){
  const [sum,setSum]=useState(null),[list,setList]=useState(null),[err,setErr]=useState(''),[open,setOpen]=useState(null),[adding,setAdding]=useState(false),[busy,setBusy]=useState(false);
  const load=useCallback(()=>Promise.all([api('/collector/summary'),api('/collector/customers')]).then(([s,l])=>{setSum(s);setList(l.data);}).catch(e=>setErr(e.message)),[api]);
  useEffect(()=>{load();},[load]);
  if(open)return <CustomerDetail api={api} notify={notify} id={open} onBack={()=>{setOpen(null);load();}}/>;
  return <>
    <div className="hc-title"><div><h1>Cobrador</h1><p>Seus clientes e as cobranças que se repetem. O HubCash gera cada vencimento sozinho, com link de pagamento.</p></div><button className="hc-btn" onClick={()=>setAdding(!adding)}><Plus size={16}/> Novo cliente</button></div>
    {err&&<p className="hc-error">{err}</p>}
    {sum&&<div className="hc-stats">
      <div className="hc-stat"><span>Clientes</span><b>{sum.customers}</b></div>
      <div className="hc-stat"><span>Recorrências ativas</span><b>{sum.activeRecurrings}</b></div>
      <div className="hc-stat"><span>Recebido no mês</span><b>{brl(sum.receivedThisMonth)}</b></div>
      <div className="hc-stat"><span>Em atraso</span><b className={sum.overdueCount?'hc-bad':''}>{brl(sum.overdueTotal)}</b><small className="hc-muted">{sum.overdueCount} cobrança{sum.overdueCount===1?'':'s'}</small></div>
    </div>}
    {adding&&<form className="hc-panel" onSubmit={async e=>{e.preventDefault();setBusy(true);setErr('');try{const c=await api('/collector/customers',fields(e));notify('Cliente cadastrado.');setAdding(false);setOpen(c.id);}catch(x){setErr(x.message);}finally{setBusy(false);}}}>
      <h2>Novo cliente</h2>
      <div className="hc-form">
        <label>Nome<input id="cus-name" name="name" required maxLength={120} placeholder="Ex.: Padaria Sol"/></label>
        <label>WhatsApp <small>(com DDD)</small><input id="cus-phone" name="phone" inputMode="tel" placeholder="(68) 99999-0000"/></label>
        <label>E-mail <small>(opcional)</small><input id="cus-email" name="email" type="email"/></label>
        <label>CPF ou CNPJ <small>(opcional)</small><input id="cus-doc" name="document" inputMode="numeric"/></label>
        <label className="full">Observações <small>(opcional)</small><input id="cus-notes" name="notes" maxLength={500}/></label>
        <div className="full hc-row"><button className="hc-btn" disabled={busy}>{busy?'Salvando…':'Cadastrar e criar cobrança'}</button><button type="button" className="hc-btn ghost" onClick={()=>setAdding(false)}>Cancelar</button></div>
      </div>
    </form>}
    <div className="hc-panel">{!list?<p className="hc-muted">Carregando…</p>:!list.length?<div className="hc-emptybox"><Repeat size={22}/><b>Nenhum cliente ainda</b><p className="hc-muted">Cadastre um cliente e crie uma cobrança recorrente, por exemplo uma mensalidade de R$ 150 todo dia 10.</p></div>:
      <table className="hc-table cb-table"><thead><tr><th>Cliente</th><th>Situação</th><th>Em aberto</th><th>Recebido</th><th>Recorrências</th></tr></thead><tbody>{list.map(c=><tr key={c.id} className="cb-row" onClick={()=>setOpen(c.id)} tabIndex={0} onKeyDown={e=>e.key==='Enter'&&setOpen(c.id)}>
        <td>{c.name}<small>{phoneView(c.phone)||c.email||'—'}</small></td>
        <td><span className={'hc-pill '+SITUATION[c.situation][1]}>{SITUATION[c.situation][0]}</span></td>
        <td>{brl(c.openTotal)}</td><td>{brl(c.paidTotal)}</td><td>{c.activeRecurrings}</td>
      </tr>)}</tbody></table>}</div>
  </>;
}

function CustomerDetail({api,notify,id,onBack}){
  const [c,setC]=useState(null),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[limit,setLimit]=useState('none'),[freq,setFreq]=useState('monthly'),[showNew,setShowNew]=useState(false);
  const load=useCallback(()=>api('/collector/customers/'+id).then(d=>{setC(d);if(!d.recurrings.length)setShowNew(true);}).catch(e=>setErr(e.message)),[api,id]);
  useEffect(()=>{load();},[load]);
  const act=async(path,body,method,msg)=>{setErr('');try{await api(path,body,method);notify(msg);load();}catch(x){setErr(x.message);}};
  const copy=t=>navigator.clipboard.writeText(t).then(()=>notify('Link copiado.')).catch(()=>notify('Selecione e copie o link.'));
  if(!c)return <><button className="hc-btn ghost small" onClick={onBack}><ChevronLeft size={14}/> Clientes</button>{err?<p className="hc-error">{err}</p>:<p className="hc-muted">Carregando…</p>}</>;
  return <>
    <button className="hc-btn ghost small cb-back" onClick={onBack}><ChevronLeft size={14}/> Clientes</button>
    <div className="hc-title"><div><h1>{c.name}</h1><p>{[phoneView(c.phone),c.email,c.document].filter(Boolean).join(' · ')||'Sem contato cadastrado'}</p></div>
      <span className={'hc-pill '+SITUATION[c.situation][1]}>{SITUATION[c.situation][0]}</span></div>
    {err&&<p className="hc-error">{err}</p>}
    <div className="hc-stats cb-stats"><div className="hc-stat"><span>Em aberto</span><b>{brl(c.openTotal)}</b></div><div className="hc-stat"><span>Recebido</span><b>{brl(c.paidTotal)}</b></div></div>

    <div className="hc-panel">
      <div className="cb-head"><h2>Cobranças recorrentes</h2>{!showNew&&<button className="hc-btn small" onClick={()=>setShowNew(true)}><Plus size={14}/> Nova</button>}</div>
      {showNew&&<form className="cb-new" onSubmit={async e=>{e.preventDefault();setBusy(true);setErr('');const f=fields(e);try{await api('/collector/recurrings',{...f,customerId:c.id});notify('Cobrança recorrente criada.');setShowNew(false);load();}catch(x){setErr(x.message);}finally{setBusy(false);}}}>
        <div className="hc-form">
          <label>Descrição<input id="rec-desc" name="description" required maxLength={120} placeholder="Ex.: Mensalidade"/></label>
          <label>Valor (R$)<input id="rec-amount" name="amount" required inputMode="decimal" placeholder="150,00"/></label>
          <label>Repetir<select id="rec-freq" name="frequency" value={freq} onChange={e=>setFreq(e.target.value)}>{Object.entries(FREQ).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
          {freq!=='weekly'&&<label>Dia do vencimento<input id="rec-day" name="dayOfMonth" type="number" min={1} max={28} defaultValue={10}/></label>}
          <label>Começa em<input id="rec-start" name="startDate" type="date" defaultValue={today()}/></label>
          <label>Duração<select id="rec-limit" name="limit" value={limit} onChange={e=>setLimit(e.target.value)}><option value="none">Sem fim (até eu encerrar)</option><option value="count">Por um número de vezes</option><option value="until">Até uma data</option></select></label>
          {limit==='count'&&<label>Quantas cobranças<input id="rec-count" name="occurrences" type="number" min={1} max={600} defaultValue={12}/></label>}
          {limit==='until'&&<label>Até<input id="rec-end" name="endDate" type="date"/></label>}
          <label>Gerar com antecedência <small>(dias antes do vencimento)</small><input id="rec-lead" name="leadDays" type="number" min={0} max={30} defaultValue={5}/></label>
          <div className="full hc-row"><button className="hc-btn" disabled={busy}>{busy?'Criando…':'Criar cobrança recorrente'}</button>{c.recurrings.length>0&&<button type="button" className="hc-btn ghost" onClick={()=>setShowNew(false)}>Cancelar</button>}</div>
        </div>
      </form>}
      {c.recurrings.length>0&&<table className="hc-table"><thead><tr><th>Cobrança</th><th>Valor</th><th>Próximo vencimento</th><th>Situação</th><th/></tr></thead><tbody>{c.recurrings.map(r=><tr key={r.id}>
        <td>{r.description}<small>{r.frequencyName}{r.dayOfMonth?' · dia '+r.dayOfMonth:''} · {r.limit==='count'?`${r.generated} de ${r.occurrences}`:r.limit==='until'?'até '+dmy(r.endDate):'sem fim'}</small></td>
        <td>{brl(r.amount)}</td>
        <td>{['active','paused'].includes(r.status)?dmy(r.nextDueDate):'—'}<small>{r.status==='active'?`gera ${r.leadDays} dia${r.leadDays===1?'':'s'} antes`:''}</small></td>
        <td><span className={'hc-pill '+(r.status==='active'?'active':r.status==='paused'?'paused':'canceled')}>{RSTATUS[r.status]}</span></td>
        <td className="cb-actions">{r.status==='active'&&<><button className="hc-btn ghost small" title="Gerar a próxima cobrança agora" onClick={()=>act('/collector/recurrings/'+r.id+'/generate',{},undefined,'Cobrança gerada.')}><Zap size={13}/> Gerar agora</button><button className="hc-btn ghost small" onClick={()=>act('/collector/recurrings/'+r.id,{action:'pause'},'PATCH','Pausada.')}><Pause size={13}/> Pausar</button></>}
          {r.status==='paused'&&<button className="hc-btn ghost small" onClick={()=>act('/collector/recurrings/'+r.id,{action:'resume'},'PATCH','Retomada.')}><Play size={13}/> Retomar</button>}
          {['active','paused'].includes(r.status)&&<button className="hc-btn ghost small" onClick={()=>act('/collector/recurrings/'+r.id,{action:'cancel'},'PATCH','Encerrada.')}><X size={13}/> Encerrar</button>}</td>
      </tr>)}</tbody></table>}
    </div>

    <div className="hc-panel"><h2>Cobranças geradas</h2>
      {!c.charges.length?<p className="hc-empty">Nenhuma ainda. Elas aparecem aqui conforme os vencimentos chegam.</p>:
      <table className="hc-table"><thead><tr><th>Vencimento</th><th>Cobrança</th><th>Valor</th><th>Status</th><th/></tr></thead><tbody>{c.charges.map(ch=><tr key={ch.id}>
        <td>{dmy(ch.dueDate)}</td><td>{ch.description}</td><td>{brl(ch.amount)}</td>
        <td><span className={'hc-pill '+(ch.status==='overdue'?'failed':ch.status)}>{CSTATUS[ch.status]||ch.status}</span></td>
        <td className="cb-actions">{['pending','overdue'].includes(ch.status)&&<><button className="hc-btn ghost small" onClick={()=>copy(ch.checkoutUrl)}><Copy size={13}/> Link</button><a className="hc-btn ghost small" href={waLink(c,ch)} target="_blank" rel="noreferrer"><MessageCircle size={13}/> WhatsApp</a></>}</td>
      </tr>)}</tbody></table>}
      <p className="hc-muted cb-note">Por enquanto o envio pelo WhatsApp abre a conversa já com a mensagem pronta. Com a API de WhatsApp (MOW) ligada, os lembretes vão sozinhos.</p>
    </div>

    <button className="hc-btn ghost small cb-archive" onClick={()=>{act('/collector/customers/'+c.id,{archived:true},'PATCH','Cliente arquivado.').then(onBack);}}>Arquivar cliente</button>
  </>;
}
