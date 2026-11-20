// Cobrador: clientes da empresa, cobranças recorrentes e geração automática dos vencimentos.
// Cada vencimento vira uma cobrança do HubCash (link do Mercado Pago) com baixa automática.
import {randomId,sha256} from './crypto.js';
import {fail,publicCharge,effectiveStatus} from './billing.js';

export const FREQUENCIES={weekly:'Semanal',monthly:'Mensal',quarterly:'Trimestral',semiannual:'Semestral',yearly:'Anual'};

// "Hoje" no horário de Brasília, como AAAA-MM-DD.
export const todayBR=(now=Date.now())=>new Date(now-3*3600e3).toISOString().slice(0,10);
const isDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''))&&!Number.isNaN(Date.parse(s+'T00:00:00Z'));
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400e3).toISOString().slice(0,10);
export function nextDue(date,frequency,day){
  const d=new Date(date+'T00:00:00Z');
  if(frequency==='weekly')return addDays(date,7);
  const months={monthly:1,quarterly:3,semiannual:6,yearly:12}[frequency];
  const y=d.getUTCFullYear(),m=d.getUTCMonth()+months;
  return new Date(Date.UTC(y,m,Math.min(day||d.getUTCDate(),28))).toISOString().slice(0,10);
}
// Primeiro vencimento a partir da data de início, no dia escolhido.
export function firstDue(start,frequency,day){
  if(frequency==='weekly'||!day)return start;
  const s=new Date(start+'T00:00:00Z');let c=new Date(Date.UTC(s.getUTCFullYear(),s.getUTCMonth(),day));
  if(c.toISOString().slice(0,10)<start)c=new Date(Date.UTC(s.getUTCFullYear(),s.getUTCMonth()+1,day));
  return c.toISOString().slice(0,10);
}

const clean=(v,max)=>String(v??'').trim().slice(0,max);
const digits=v=>String(v||'').replace(/\D/g,'');

export function createCollector({store,billing,log=console}){
  const own=async(kind,id,ws)=>{const r=await store.get(kind,String(id||''));return r&&r.workspaceId===ws.id?r:null;};

  async function internalApp(ws,accountId){
    const accounts=await store.list('account',{where:{workspaceId:ws.id}});
    const account=accountId?accounts.find(a=>a.id===accountId):accounts.find(a=>a.mode==='live')||accounts[0];
    if(!account)throw fail(400,'Conecte uma conta do Mercado Pago antes de cobrar.');
    let app=(await store.list('app',{where:{workspaceId:ws.id,internal:true}})).find(a=>a.accountId===account.id);
    if(!app)app=await store.put('app',{id:randomId('app',8),workspaceId:ws.id,name:'Maquininha · '+account.name,internal:true,accountId:account.id,webhookUrl:null,keyHash:sha256(randomId('k',32)),keyPrefix:'interno',webhookSecretEnc:null});
    return app;
  }

  function customerInput(body,prev={}){
    const name=clean(body.name??prev.name,120);if(!name)throw fail(400,'Informe o nome do cliente.');
    const phone=digits(body.phone??prev.phone);if(phone&&(phone.length<10||phone.length>13))throw fail(400,'Telefone inválido. Use DDD + número, ex.: 68999990000.');
    const email=clean(body.email??prev.email,254).toLowerCase();if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail(400,'E-mail inválido.');
    const document=digits(body.document??prev.document);if(document&&![11,14].includes(document.length))throw fail(400,'CPF (11 números) ou CNPJ (14 números) inválido.');
    return {name,phone:phone?(phone.length<=11?'55'+phone:phone):'',email,document,notes:clean(body.notes??prev.notes,500)};
  }

  function recurringInput(body){
    const amount=Math.round(Number(String(body.amount).replace(',','.'))*100)/100;if(!(amount>0))throw fail(400,'Informe o valor.');
    const description=clean(body.description,120);if(!description)throw fail(400,'Informe a descrição (ex.: Mensalidade).');
    const frequency=FREQUENCIES[body.frequency]?body.frequency:'monthly';
    const day=frequency==='weekly'?null:Math.min(28,Math.max(1,Math.floor(Number(body.dayOfMonth)||1)));
    const startDate=isDate(body.startDate)?body.startDate:todayBR();
    const limit=body.limit==='count'?'count':body.limit==='until'?'until':'none';
    const occurrences=limit==='count'?Math.floor(Number(body.occurrences)):null;if(limit==='count'&&!(occurrences>=1&&occurrences<=600))throw fail(400,'Número de cobranças entre 1 e 600.');
    const endDate=limit==='until'?body.endDate:null;if(limit==='until'&&(!isDate(endDate)||endDate<startDate))throw fail(400,'A data final precisa ser depois do início.');
    const leadDays=Math.min(30,Math.max(0,Math.floor(Number(body.leadDays??5))));
    return {amount,description,frequency,dayOfMonth:day,startDate,limit,occurrences,endDate,leadDays};
  }

  const chargesOf=async(ws,where)=>(await store.list('charge',{where:{workspaceId:ws.id,source:'cobrador',...where},limit:1000}));

  function situation(charges){
    const st=charges.map(effectiveStatus);
    if(st.includes('overdue'))return 'overdue';
    if(st.includes('pending'))return 'open';
    return 'ok';
  }

  async function customerView(ws,c,{full=false}={}){
    const charges=await chargesOf(ws,{customerId:c.id}),recs=await store.list('recurring',{where:{workspaceId:ws.id,customerId:c.id}});
    const paid=charges.flatMap(x=>(x.payments||[]).filter(p=>p.status==='paid')).reduce((t,p)=>t+Number(p.amount||0),0);
    const open=charges.filter(x=>['pending','overdue'].includes(effectiveStatus(x))).reduce((t,x)=>t+x.amount,0);
    const out={...c,situation:situation(charges),paidTotal:Math.round(paid*100)/100,openTotal:Math.round(open*100)/100,activeRecurrings:recs.filter(r=>r.status==='active').length};
    if(full)Object.assign(out,{recurrings:recs.map(publicRecurring),charges:charges.sort((a,b)=>String(b.dueDate).localeCompare(String(a.dueDate))).map(publicCharge)});
    return out;
  }
  const publicRecurring=r=>({id:r.id,customerId:r.customerId,description:r.description,amount:r.amount,frequency:r.frequency,frequencyName:FREQUENCIES[r.frequency],dayOfMonth:r.dayOfMonth,startDate:r.startDate,limit:r.limit,occurrences:r.occurrences,endDate:r.endDate,leadDays:r.leadDays,generated:r.generated||0,nextDueDate:r.nextDueDate,status:r.status,createdAt:r.createdAt});

  // Gera a cobrança do próximo vencimento de uma recorrência e avança a data.
  async function generateNext(r,{force=false}={}){
    if(r.status!=='active')return null;
    const today=todayBR();
    if(!force&&addDays(today,r.leadDays)<r.nextDueDate)return null;
    const ws=await store.get('workspace',r.workspaceId);if(!ws||ws.suspended)return null;
    const customer=await store.get('customer',r.customerId);if(!customer||customer.archived)return null;
    const app=await internalApp(ws,r.accountId);
    const due=r.nextDueDate,label=due.split('-').reverse().slice(0,2).join('/');
    const charge=await billing.createCheckout(app,{amount:r.amount,description:`${r.description} · vence ${label}`,customer:{name:customer.name,email:customer.email||undefined},externalReference:r.id,source:'cobrador',extra:{customerId:customer.id,recurringId:r.id,dueDate:due}},`cobrador:${r.id}:${due}`);
    const generated=(r.generated||0)+1,next=nextDue(due,r.frequency,r.dayOfMonth);
    const done=(r.limit==='count'&&generated>=r.occurrences)||(r.limit==='until'&&next>r.endDate);
    await store.put('recurring',{...r,generated,nextDueDate:next,lastGeneratedAt:new Date().toISOString(),status:done?'finished':'active'});
    return charge;
  }

  // Varredura periódica: gera tudo o que entra na janela de antecedência.
  async function sweep(){
    let created=0;
    for(const r of await store.list('recurring',{where:{status:'active'},limit:5000})){
      try{for(let i=0;i<12;i++){const c=await generateNext(await store.get('recurring',r.id));if(!c)break;created++;}}
      catch(e){log.error?.('[cobrador] falhou ao gerar',r.id,e.message);}
    }
    return created;
  }

  function install(api,route){
    api.get('/collector/summary',route(async(req,res)=>{
      const customers=(await store.list('customer',{where:{workspaceId:req.ws.id},limit:5000})).filter(c=>!c.archived);
      const charges=await chargesOf(req.ws,{}),month=todayBR().slice(0,7);
      const st=c=>effectiveStatus(c);
      res.json({customers:customers.length,activeRecurrings:(await store.list('recurring',{where:{workspaceId:req.ws.id,status:'active'}})).length,
        dueThisMonth:charges.filter(c=>String(c.dueDate).startsWith(month)).reduce((t,c)=>t+c.amount,0),
        receivedThisMonth:charges.flatMap(c=>(c.payments||[]).filter(p=>p.status==='paid'&&String(p.at).startsWith(month))).reduce((t,p)=>t+Number(p.amount||0),0),
        overdueCount:charges.filter(c=>st(c)==='overdue').length,overdueTotal:charges.filter(c=>st(c)==='overdue').reduce((t,c)=>t+c.amount,0)});
    }));
    api.get('/collector/customers',route(async(req,res)=>{
      const list=(await store.list('customer',{where:{workspaceId:req.ws.id},limit:5000})).filter(c=>!c.archived);
      res.json({data:await Promise.all(list.map(c=>customerView(req.ws,c)))});
    }));
    api.post('/collector/customers',route(async(req,res)=>{
      const c=await store.put('customer',{id:randomId('cus',8),workspaceId:req.ws.id,...customerInput(req.body||{})});
      res.status(201).json(await customerView(req.ws,c));
    }));
    api.get('/collector/customers/:id',route(async(req,res)=>{const c=await own('customer',req.params.id,req.ws);if(!c)throw fail(404,'Cliente não encontrado.');res.json(await customerView(req.ws,c,{full:true}));}));
    api.patch('/collector/customers/:id',route(async(req,res)=>{
      const c=await own('customer',req.params.id,req.ws);if(!c)throw fail(404,'Cliente não encontrado.');
      const next=req.body?.archived?{...c,archived:true}:{...c,...customerInput(req.body||{},c)};
      if(next.archived)for(const r of await store.list('recurring',{where:{workspaceId:req.ws.id,customerId:c.id,status:'active'}}))await store.put('recurring',{...r,status:'canceled'});
      res.json(await customerView(req.ws,await store.put('customer',next)));
    }));
    api.post('/collector/recurrings',route(async(req,res)=>{
      const customer=await own('customer',req.body?.customerId,req.ws);if(!customer)throw fail(400,'Escolha o cliente.');
      const input=recurringInput(req.body||{});
      const r=await store.put('recurring',{id:randomId('rec',8),workspaceId:req.ws.id,customerId:customer.id,...input,nextDueDate:firstDue(input.startDate,input.frequency,input.dayOfMonth),generated:0,status:'active'});
      await generateNext(r).catch(e=>log.warn?.('[cobrador] primeira cobrança não gerada',e.message));
      res.status(201).json(publicRecurring(await store.get('recurring',r.id)));
    }));
    api.patch('/collector/recurrings/:id',route(async(req,res)=>{
      const r=await own('recurring',req.params.id,req.ws);if(!r)throw fail(404,'Cobrança recorrente não encontrada.');
      const map={pause:'paused',resume:'active',cancel:'canceled'},status=map[req.body?.action];
      if(!status)throw fail(400,'Ação inválida.');if(['finished','canceled'].includes(r.status))throw fail(400,'Esta cobrança recorrente já terminou.');
      res.json(publicRecurring(await store.put('recurring',{...r,status})));
    }));
    api.post('/collector/recurrings/:id/generate',route(async(req,res)=>{
      const r=await own('recurring',req.params.id,req.ws);if(!r)throw fail(404,'Cobrança recorrente não encontrada.');
      if(r.status!=='active')throw fail(400,'Retome a cobrança recorrente antes de gerar.');
      const c=await generateNext(r,{force:true});res.status(201).json(publicCharge(c));
    }));
  }

  return {install,sweep,generateNext};
}
