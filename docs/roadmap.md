# HubCash: próximas fases

## Fase 1: central de pagamentos (pronta)
Contas do Mercado Pago, apps com chave de API, pagamento único (Checkout Pro), assinaturas, webhooks, painel e SDK.

## Fase 1.5: produto vendável (pronta em parte)
- Pronto: login e cadastro pelo LINKY, um espaço por empresa, dados separados.
- Falta: planos do próprio HubCash (cobrar as empresas que usam o HubCash, usando o próprio HubCash), convidar membros da equipe para o espaço, conferir a conexão no LINKY periodicamente (revogação).

## Fase 2: Cobrador (pronta, sem WhatsApp)
- Pronto: clientes, cobranças recorrentes (semanal, mensal, trimestral, semestral, anual), duração sem fim / por N vezes / até uma data, geração automática com antecedência, situação em dia / em aberto / atrasado, link e mensagem pronta para WhatsApp.
- Falta: importar clientes por planilha; envio automático pelo MOW (fase 3).

### Plano original
Para empresas que cobram os próprios clientes todo mês ou todo ano.
- **Empresas cobradoras:** cada empresa que usa o Cobrador tem a sua própria conta do Mercado Pago (o dinheiro cai direto para ela).
- **Clientes:** cadastro (nome, telefone, e-mail, documento) e importação por planilha.
- **Regras de cobrança:** valor, dia de vencimento, frequência (mensal, anual), multa e juros opcionais.
- **Agenda:** um job diário gera as cobranças do dia e o link de pagamento de cada cliente.

## Fase 3: Cobrador WhatsApp (com o hub de WhatsApp)
- Conexão com o hub de WhatsApp da UWY (nome a definir) por API e chave, igual aos apps.
- Aba **WhatsApp** no HubCash: lista os clientes e o status de cada cobrança.
- **Réguas de cobrança sem IA:** modelos de mensagem com variáveis (`{nome}`, `{valor}`, `{vencimento}`, `{link}`) e quando mandar. Exemplo: 3 dias antes, no dia, 2 dias depois.
- Quando o pagamento entra (webhook), o cliente para de receber lembretes e ganha uma mensagem de "pagamento confirmado".
- Respeitar horário comercial, limite de envios por minuto e a opção de o cliente pedir para parar.

## Decisões em aberto
- Nome e API do hub de WhatsApp.
- Fase 2: Mercado Pago Connect (OAuth, a empresa autoriza sem colar o token) ou o token colado no painel.
