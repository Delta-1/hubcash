# HubCash

Central de pagamentos da **UWY**, vendida como produto separado. Cada empresa cliente entra com a **conta LINKY**, ganha o próprio espaço e conecta a própria conta do Mercado Pago. Os apps dessa empresa (como o OLUNE, no caso da UWY) não falam direto com o Mercado Pago: eles pedem ao HubCash "cria uma assinatura de R$ 50 por mês para este cliente", e o HubCash cuida do resto.

- **Login e cadastro pelo LINKY** (OpenID Connect, Authorization Code + PKCE). No primeiro acesso, o HubCash cria o usuário (pelo `sub` do LINKY) e o espaço da empresa.
- **Conta administradora UWY:** os IDs LINKY em `HUBCASH_ADMIN_LINKY_IDS` veem a aba **Administração**, com todas as empresas, o plano de cada uma e a opção de suspender.
- **Dados separados por empresa:** contas, apps e cobranças pertencem a um espaço e não aparecem nos outros.

- Guarda as chaves do Mercado Pago **cifradas**, num lugar só.
- Cria **pagamentos únicos** (Checkout Pro: Pix, boleto, cartão parcelado) e **assinaturas recorrentes** (cartão).
- Recebe os **webhooks** do Mercado Pago, valida a assinatura HMAC e atualiza o status.
- **Avisa o app** que criou a cobrança (webhook assinado), por exemplo `charge.paid` ou `subscription.activated`.
- **Painel** para ver o caixa (recebido no mês, MRR, assinaturas), criar links de pagamento à mão, cadastrar apps e contas.

Próxima fase: o **Cobrador WhatsApp** (veja `docs/roadmap.md`).

## Como funciona

```
App da UWY ──(chave hc_...)──▶ HubCash ──(access token)──▶ Mercado Pago
     ▲                           │  ▲                            │
     └──── webhook assinado ─────┘  └──── webhook (x-signature) ─┘
```

## Rodar localmente

```bash
npm install
cp .env.example .env   # preencha os valores
npm run build          # painel web
npm start              # http://localhost:8080
```

Para entrar sem o LINKY em desenvolvimento, use `HUBCASH_DEV_LOGIN=true` (botão "Entrar como dev", desligado em produção).

Sem `DATABASE_URL` (ou Supabase), os dados ficam na memória. Para usar o Supabase, rode `supabase/migrations/001_hubcash_records.sql` no SQL Editor do projeto.

Testes: `npm test`. Eles usam um Mercado Pago falso, então não fazem chamadas reais.

## Primeiro uso

0. **LINKY:** o HubCash é um app da casa, então o LINKY o registra sozinho. Na Vercel do LINKY, defina `LINKY_HUBCASH_CLIENT_ID=uwy_hubcash_...` e `LINKY_HUBCASH_URL=https://SEU-HUBCASH`. No HubCash, use o mesmo valor em `LINKY_CLIENT_ID`. Não há segredo nem callback para cadastrar.
1. **Mercado Pago:** em *Suas integrações*, crie uma aplicação e copie o **access token** (comece pelas credenciais de teste). Em *Webhooks*, configure:
   - URL: a que o painel mostra em *Contas Mercado Pago* (`https://SEU-HUBCASH/webhooks/mercadopago/acc_...`)
   - Eventos: **Pagamentos** e **Planos e assinaturas**
   - Copie a **assinatura secreta**.
2. **Entre no HubCash com LINKY › Contas Mercado Pago:** cole o access token e a assinatura secreta.
3. **Painel › Apps:** crie o app (ex.: OLUNE). Guarde a **chave de API** e o **segredo do webhook**, que só aparecem uma vez.
4. **No app:** use o conector `sdk/hubcash.js`.

## API para os apps

Autenticação: `Authorization: Bearer hc_live_...` (ou `hc_test_...`). Envie `Idempotency-Key` nos `POST` para não duplicar cobranças. O SDK já faz isso.

| Método | Rota | O que faz |
|---|---|---|
| POST | `/v1/checkouts` | Pagamento único. Body: `amount`, `description`, `customer{email,name}`, `externalReference?`, `returnUrl?`, `maxInstallments?` (1–12), `mode?` (`once` ou `fixed`: link que recebe várias vezes), `expiresInMinutes?` (5 min a 30 dias, só para `once`) |
| POST | `/v1/subscriptions` | Assinatura. Body: `amount`, `description`, `intervalMonths` (1, 2, 3, 6, 12), `customer{email,name}`, `externalReference?`, `returnUrl?` |
| POST | `/v1/subscriptions/:id/cancel` | Cancela a assinatura no Mercado Pago |
| POST | `/v1/charges/:id/deactivate` | Desativa um link de pagamento (fixo ou temporário ainda aberto) |
| GET | `/v1/charges/:id` | Consulta uma cobrança |
| GET | `/v1/charges?externalReference=...&status=...` | Lista as cobranças do app |

A resposta traz `checkoutUrl`: mande o cliente para lá.

Status: `pending`, `paid`, `failed`, `refunded` (pagamento único) e `pending`, `active`, `paused`, `canceled` (assinatura).

### Exemplo (OLUNE)

```js
import {HubCash} from './hubcash.js';
const hubcash = new HubCash({apiKey: process.env.HUBCASH_API_KEY, baseUrl: process.env.HUBCASH_URL});

const sub = await hubcash.subscriptions.create({
  amount: 200, description: 'OLUNE · Plano Mensal', intervalMonths: 1,
  customer: {email: admin.email, name: company.name},
  externalReference: company.id,
  returnUrl: 'https://olune.app/?pagamento=ok',
});
res.json({url: sub.checkoutUrl});
```

### Webhook para o app

`POST` no `webhookUrl` do app, com o cabeçalho `x-hubcash-signature: t=...,v1=...`, que é o HMAC-SHA256 de `t + "." + corpo` com o segredo do app. Valide com `HubCash.verifyWebhook(corpoCru, cabecalho, segredo)`.

Eventos: `charge.paid`, `charge.failed`, `charge.refunded`, `charge.updated`, `subscription.activated`, `subscription.payment_succeeded`, `subscription.payment_failed`, `subscription.updated`, `subscription.canceled`.

## Deploy na Railway

1. Novo serviço apontando para este repositório.
2. Adicione um banco **PostgreSQL** no projeto (a Railway preenche `DATABASE_URL`; a tabela é criada sozinha).
3. Variáveis: `HUBCASH_MASTER_KEY`, `HUBCASH_PUBLIC_URL`, `LINKY_CLIENT_ID`, `HUBCASH_ADMIN_LINKY_IDS`, `DATABASE_URL`.
4. Gere um domínio e use-o em `HUBCASH_PUBLIC_URL`, em `LINKY_HUBCASH_URL` (no LINKY) e no webhook do Mercado Pago.

## Segurança

- Access tokens e segredos cifrados com AES-256-GCM (`HUBCASH_MASTER_KEY`), nunca devolvidos pelo painel.
- Chaves dos apps guardadas só como hash SHA-256, mostradas uma única vez e trocáveis no painel.
- Webhook do Mercado Pago validado por HMAC (`x-signature`). O status é sempre reconsultado na API, nunca tirado do corpo da notificação.
- Painel: sessão em cookie HttpOnly, SameSite=Lax e Secure (12 horas). Toda mutação exige o cabeçalho `x-hubcash`, e cada consulta confere o espaço da empresa.
- Login LINKY: state, nonce e PKCE S256. O pedido é consumido uma vez só e expira em 10 minutos. A conta é ligada pelo `sub`, nunca pelo e-mail.
