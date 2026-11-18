# HubCash: próximas fases

## Fase 1: central de pagamentos (pronta)
Contas do Mercado Pago, apps com chave de API, pagamento único (Checkout Pro), assinaturas, webhooks, painel e SDK.

## Fase 2: Cobrador (clientes e cobranças recorrentes)
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
