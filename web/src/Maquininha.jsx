import {useEffect,useRef,useState} from 'react';
import QRCode from 'qrcode';
import {Copy,Delete,MessageCircle,RotateCcw,Check,ExternalLink,Power,Infinity as InfinityIcon,Timer} from 'lucide-react';

const brl=c=>(c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const KEYS=['1','2','3','4','5','6','7','8','9','00','0','del'];
const PRESETS=[1000,2000,5000,10000];
const VALIDITY=[[null,'Sem prazo'],[30,'30 min'],[120,'2 horas'],[1440,'24 horas'],[10080,'7 dias']];
const until=iso=>new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

// Maquininha: digita o valor, gera o link/QR do Mercado Pago na hora e acompanha até ficar pago.
export function Maquininha({api,notify,accounts}){
  const [cents,setCents]=useState(0),[description,setDescription]=useState(''),[name,setName]=useState(''),[email,setEmail]=useState('');
  const [busy,setBusy]=useState(false),[err,setErr]=useState(''),[charge,setCharge]=useState(null),[qr,setQr]=useState('');
  const [mode,setMode]=useState('once'),[validity,setValidity]=useState(null);
  const timer=useRef(null);

  const press=k=>setCents(c=>k==='del'?Math.floor(c/10):Math.min(99999999,Number(String(c)+k)));
  useEffect(()=>{const onKey=e=>{if(charge||['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;if(/^\d$/.test(e.key))press(e.key);else if(e.key==='Backspace')press('del');};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[charge]);

  // Acompanha o status até pagar (ou falhar).
  useEffect(()=>{clearInterval(timer.current);if(!charge||!['pending','active'].includes(charge.status))return;
    timer.current=setInterval(async()=>{try{const c=await api('/charges/'+charge.id);if(c.status!==charge.status||c.paidCount!==charge.paidCount){if(c.paidCount>charge.paidCount&&c.mode==='fixed')notify('Pagamento recebido: '+brl(Math.round(c.amount*100)));setCharge(c);}}catch{}},4000);
    return()=>clearInterval(timer.current);},[charge,api]);

  const generate=async()=>{
    if(cents<100){setErr('O valor mínimo é R$ 1,00.');return;}
    setBusy(true);setErr('');
    try{const c=await api('/quick-charge',{amount:cents/100,description,mode,...(mode==='once'&&validity?{expiresInMinutes:validity}:{}),customer:{name:name||undefined,email:email||undefined}});
      setCharge(c);setQr(await QRCode.toDataURL(c.checkoutUrl,{margin:1,width:520,errorCorrectionLevel:'M'}));}
    catch(e){setErr(e.message);}finally{setBusy(false);}
  };
  const reset=()=>{setCharge(null);setQr('');setCents(0);setDescription('');setName('');setEmail('');setErr('');};
  const deactivate=async()=>{try{setCharge(await api('/charges/'+charge.id+'/deactivate',{}));notify('Cobrança desativada.');}catch(e){setErr(e.message);}};
  const shareText=charge?`Olá${name?' '+name.split(' ')[0]:''}! Segue o link para pagamento de ${brl(Math.round(charge.amount*100))}${charge.description?' ('+charge.description+')':''}: ${charge.checkoutUrl}`:'';
  const copyLink=()=>navigator.clipboard.writeText(charge.checkoutUrl).then(()=>notify('Link copiado.')).catch(()=>notify('Selecione e copie o link.'));

  if(!accounts)return <p className="hc-muted">Carregando…</p>;
  if(!accounts.length)return <div className="hc-panel"><h2>Conecte o Mercado Pago</h2><p className="hc-muted">Para cobrar na hora, cadastre uma conta em <b>Contas Mercado Pago</b>.</p></div>;

  if(charge){
    const paid=charge.status==='paid',failed=charge.status==='failed',fixed=charge.mode==='fixed',closed=['expired','inactive'].includes(charge.status);
    return <div className="mq-wrap"><div className="mq-result hc-panel">
      {paid?<div className="mq-paid"><span><Check size={40}/></span><h2>Pago</h2><p>{brl(Math.round(charge.amount*100))} recebido.</p></div>
      :<>
        <p className="hc-muted mq-label">{charge.description}</p>
        <span className={'mq-kind'+(fixed?' fixed':'')}>{fixed?<><InfinityIcon size={14}/> Cobrança fixa · recebe quantas vezes precisar</>:charge.expiresAt?<><Timer size={14}/> Vale até {until(charge.expiresAt)}</>:'Cobrança única · sem prazo'}</span>
        <b className="mq-amount">{brl(Math.round(charge.amount*100))}</b>
        {qr&&<img className="mq-qr" src={qr} alt="QR Code do pagamento"/>}
        <p className="hc-muted mq-hint">{failed?'O pagamento foi recusado. Gere uma nova cobrança.':charge.status==='expired'?'O prazo desta cobrança acabou.':charge.status==='inactive'?'Esta cobrança foi desativada e não recebe mais pagamentos.':'Aponte a câmera do celular. Paga com Pix, cartão (até 12x) ou boleto.'}</p>
        {fixed&&<div className="mq-tally"><div><b>{charge.paidCount}</b><span>pagamentos</span></div><div><b>{brl(Math.round(charge.paidTotal*100))}</b><span>recebido</span></div></div>}
        {!failed&&!closed&&<p className="mq-status"><span className="mq-dot"/>{fixed?'Ativa, recebendo pagamentos':'Aguardando pagamento…'}</p>}
        <code className="mq-link">{charge.checkoutUrl}</code>
        <div className="hc-row mq-actions">
          <button className="hc-btn" onClick={copyLink}><Copy size={15}/> Copiar link</button>
          <a className="hc-btn ghost" href={'https://wa.me/?text='+encodeURIComponent(shareText)} target="_blank" rel="noreferrer"><MessageCircle size={15}/> Enviar no WhatsApp</a>
          <a className="hc-btn ghost" href={charge.checkoutUrl} target="_blank" rel="noreferrer"><ExternalLink size={15}/> Abrir</a>
          {!closed&&!failed&&<button className="hc-btn ghost" onClick={deactivate}><Power size={15}/> Desativar</button>}
        </div>
        {err&&<p className="hc-error">{err}</p>}
      </>}
      <button className="hc-btn ghost mq-new" onClick={reset}><RotateCcw size={15}/> Nova cobrança</button>
    </div></div>;
  }

  return <div className="mq-wrap"><div className="mq-card hc-panel">
    <span className="hc-muted mq-label">Valor a cobrar</span>
    <b className={'mq-amount'+(cents?'':' empty')} aria-live="polite">{brl(cents)}</b>
    <div className="mq-presets">{PRESETS.map(p=><button key={p} className="hc-btn ghost small" onClick={()=>setCents(p)}>{brl(p)}</button>)}</div>
    <div className="mq-pad" role="group" aria-label="Teclado numérico">{KEYS.map(k=><button key={k} className="mq-key" onClick={()=>press(k)} aria-label={k==='del'?'Apagar':k}>{k==='del'?<Delete size={20}/>:k}</button>)}</div>
    <div className="mq-seg" role="radiogroup" aria-label="Tipo de cobrança">
      <button role="radio" aria-checked={mode==='once'} className={mode==='once'?'on':''} onClick={()=>setMode('once')}><Timer size={15}/> Temporária<small>um pagamento</small></button>
      <button role="radio" aria-checked={mode==='fixed'} className={mode==='fixed'?'on':''} onClick={()=>setMode('fixed')}><InfinityIcon size={15}/> Fixa<small>recebe sempre</small></button>
    </div>
    {mode==='once'?<div className="mq-validity" role="radiogroup" aria-label="Prazo">{VALIDITY.map(([v,l])=><button key={l} role="radio" aria-checked={validity===v} className={'hc-btn ghost small'+(validity===v?' on':'')} onClick={()=>setValidity(v)}>{l}</button>)}</div>
    :<p className="hc-muted mq-hint">O mesmo QR Code e link ficam ativos até você desativar. Ideal para balcão, produto ou mensalidade avulsa.</p>}
    <label>Descrição <small>(opcional)</small><input id="mq-desc" value={description} onChange={e=>setDescription(e.target.value)} maxLength={120} placeholder="Ex.: Consultoria, Mensalidade de novembro"/></label>
    <div className="mq-two"><label>Cliente <small>(opcional)</small><input id="mq-name" value={name} onChange={e=>setName(e.target.value)} maxLength={120}/></label>
    <label>E-mail <small>(opcional)</small><input id="mq-email" type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label></div>
    {err&&<p className="hc-error">{err}</p>}
    <button className="hc-btn mq-go" disabled={busy||!cents} onClick={generate}>{busy?'Gerando…':(mode==='fixed'?'Criar cobrança fixa de ':'Cobrar ')+brl(cents)}</button>
  </div></div>;
}
