# wa-engine — motor de WhatsApp alternativo

Gateway Node.js + [Baileys](https://github.com/WhiskeySockets/Baileys) que conecta números de WhatsApp por **QR code** (ou código de pareamento) e expõe uma API **no mesmo formato da WhatsApp Cloud API da Meta**. Assim, FestaVibe, Lista de Convidados, Central de Atendimento e as demais soluções falam um único "idioma" e podem migrar para a API oficial trocando só URL base, `phone_number_id` e token.

> ⚠️ Conexão não oficial: o WhatsApp pode banir números que façam disparos em massa ou recebam muitas denúncias. Use números dedicados, envie principalmente para quem já conversa com você e mantenha o espaçamento entre envios ligado.

## O que tem

| Recurso | Como funciona |
|---|---|
| Várias linhas | Cada linha tem `id` (faz o papel do `phone_number_id`), token próprio e webhook próprio |
| Clientes | Agrupam linhas, com chave de API própria (`wac_...`), limite de linhas e suspensão |
| Painel | `/painel`: criar clientes e linhas, ler QR, ver status, gerar chaves, templates e webhooks com falha |
| Sessão no PostgreSQL | Nada em disco; reiniciar o serviço não pede QR de novo |
| Envio | texto, imagem, vídeo, áudio (voz), documento, figurinha, localização, contato, reação, resposta citada, marcar como lida |
| Botões / listas | Viram opções numeradas (1️⃣ 2️⃣ …). Quando a pessoa responde "2", o webhook chega como `interactive.button_reply`/`list_reply` com o **id original** do botão |
| Templates | Cadastrados localmente com `{{1}}`, `{{2}}`…; o envio `type: template` funciona igual à Meta |
| Webhooks | Formato idêntico ao da Meta, assinados com `X-Hub-Signature-256`, fila no banco com até 10 tentativas (backoff até 1 h) |
| Status | `sent`, `delivered`, `read`, `failed` |
| Mídia recebida | Baixada sob demanda (não ocupa disco): `GET /v21.0/{media_id}` → `url` → download |
| Anti-banimento | Fila por linha com 1,5–4 s entre envios e "digitando…" simulado |
| Brasil | Resolve o 9º dígito automaticamente (`onWhatsApp`) e converte LID em número |
| Evento extra | `field: "connection"` avisa quando a linha conecta, cai ou pede QR |

## Deploy no alwaysdata

No alwaysdata, um **Site** Node.js pode ser parado por inatividade — o que derrubaria a conexão do WhatsApp. Por isso o motor roda como **Service** (processo permanente, reiniciado automaticamente) e um **Site do tipo Reverse proxy** dá o endereço público.

1. **Banco**: em *Bancos de dados › PostgreSQL*, crie `CONTA_waengine` (pode ser no mesmo usuário dos outros projetos).
2. **Node**: em *Ambiente › Node.js*, escolha a versão **20 ou superior** (22 recomendada).
3. **Arquivos**: envie esta pasta para `~/wa-engine` (SFTP/SSH ou `git clone` do seu GitHub).
4. **Dependências** (SSH):
   ```bash
   cd ~/wa-engine
   npm install --omit=dev
   cp .env.example .env   # e edite DATABASE_URL, MASTER_KEY, PUBLIC_URL
   npm run migrate
   ```
   Gere a chave mestra com `openssl rand -hex 32`.
5. **Plano Free** (não permite Services): crie um site em *Web › Sites* do tipo **Node.js**, comando `node --max-old-space-size=200 src/server.js`, diretório `wa-engine`, e em *⚙ › Avançado* coloque o **tempo de inatividade em 0**. Não defina HOST/PORT no `.env`. Adicione uma *Tarefa agendada* a cada 5 min com `curl -s https://CONTA.alwaysdata.net/health` para religar o processo se ele for parado. Pule os passos 6 e 7.
   **Planos pagos — Service**: *Avançado › Serviços › Adicionar*
   - Comando: `node --max-old-space-size=200 src/server.js`
   - Diretório de trabalho: `/home/CONTA/wa-engine`
   - Comando de monitoramento: `curl -sf http://services-CONTA.alwaysdata.net:8300/health`
6. **Site Reverse proxy**: *Web › Sites › Adicionar*
   - Endereço: `CONTA.alwaysdata.net` (o alwaysdata não permite subdomínios de alwaysdata.net) ou um domínio seu, como `wa.seudominio.com.br` com CNAME para `CONTA.alwaysdata.net`. Não use subpasta (`/wa`): as rotas não batem.
   - Tipo: **Reverse proxy**
   - URL remota: `http://services-CONTA.alwaysdata.net:8300`
   - Ative o SSL.
7. Teste: `curl https://wa.seudominio.com.br/health` → `{"ok":true,...}`

**Capacidade no plano Free (256 MB / 0,25 CPU):** cada linha conectada usa ~40–80 MB. Conte com **2 a 3 linhas**; acima disso, suba de plano ou separe em outra conta.

## Primeiros passos

```bash
BASE=https://wa.seudominio.com.br
MASTER=sua-chave-mestra

# 1) Criar uma linha
curl -X POST $BASE/admin/sessions -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" -d '{
  "id": "festavibe-01",
  "name": "FestaVibe Convites",
  "webhook_url": "https://festavibe.com.br/api/wa-webhook.php"
}'
# Resposta traz access_token (guarde!), webhook_secret e qr_page

# 2) Abra qr_page no navegador e leia o QR pelo celular
#    (ou crie com "pairing_phone": "5511999999999" para receber um código de 8 letras)

# 3) Enviar mensagem — exatamente como na Cloud API
curl -X POST $BASE/v21.0/festavibe-01/messages -H "Authorization: Bearer wae_..." -H "Content-Type: application/json" -d '{
  "messaging_product": "whatsapp",
  "to": "5511988887777",
  "type": "text",
  "text": { "body": "Olá! Seu convite chegou 🎉" }
}'
```

## Painel de administração

Abra **`/painel`** e entre com a `MASTER_KEY`. Pelo painel você:

- cria **clientes** (com limite de linhas) e vê a chave de cada um — ela aparece uma única vez;
- cria **linhas** vinculadas a um cliente e conecta o número lendo o **QR** ali mesmo (ou por código de pareamento);
- acompanha o status de todas as linhas (atualiza sozinho a cada 10 s);
- gera chaves novas, suspende/reativa clientes, desconecta ou exclui linhas;
- cadastra **templates** e reenvia **webhooks** que falharam.

### Três tipos de chave

| Chave | Formato | Para quê |
|---|---|---|
| Mestra | `MASTER_KEY` do `.env` | Só você: painel e rotas `/admin` |
| Do cliente | `wac_...` | Sistema do cliente envia por **qualquer linha dele** |
| Da linha | `wae_...` | Envia só por **aquela linha** (ideal para cada produto) |

Cliente suspenso: as chaves dele e das linhas dele param de enviar (respondem 403), mas os números continuam conectados.

## Documentação interativa (Swagger)

- **`/docs`** — Swagger UI: clique em *Authorize*, cole o `access_token` da linha (ou a `MASTER_KEY` para as rotas /admin) e use *Try it out* para testar cada rota. Há exemplos prontos para todos os tipos de mensagem.
- **`/openapi.json`** — especificação OpenAPI 3.0 para importar no Postman, Insomnia ou gerar clientes.

O Swagger UI é carregado do CDN jsDelivr pelo navegador; o servidor não precisa de dependência extra.

## Referência da API

Autenticação: `Authorization: Bearer <token>` — token da linha ou chave mestra. Erros seguem o formato da Graph API: `{"error":{"message","type","code","fbtrace_id"}}`.

### Compatível com a Cloud API

| Método | Caminho | Descrição |
|---|---|---|
| POST | `/vXX.X/{phone_number_id}/messages` | Enviar (todos os tipos acima) ou `{"status":"read","message_id":"..."}` |
| GET | `/vXX.X/{phone_number_id}` | Dados da linha (`display_phone_number`, `status`) |
| GET | `/vXX.X/{media_id}` | Metadados e `url` de download de uma mídia recebida |
| GET | `/media/{phone_number_id}/{media_id}/download` | Conteúdo binário da mídia |

Mídia enviada: use `"link"` com URL pública, ou `"id"` de uma mensagem já existente (reencaminha). Upload direto (`POST /media`) ainda não existe.

### Administração (chave mestra)

| Método | Caminho | Descrição |
|---|---|---|
| GET/POST | `/admin/sessions` | Listar / criar linha |
| GET/PATCH/DELETE | `/admin/sessions/{id}` | Ver / alterar (`name`, `webhook_url`, `webhook_secret`, `pairing_phone`) / remover |
| POST | `/admin/sessions/{id}/connect` | Gerar novo QR (após `idle` ou `logged_out`) — aceita token da linha |
| POST | `/admin/sessions/{id}/logout` | Desconectar o número — aceita token da linha |
| POST | `/admin/sessions/{id}/rotate-token` | Novo token |
| GET/POST | `/admin/clients` | Listar / criar cliente `{id, name, max_lines, notes}` |
| GET/PATCH/DELETE | `/admin/clients/{id}` | Ver (com linhas) / alterar (`active: false` suspende) / excluir (só sem linhas) |
| POST | `/admin/clients/{id}/rotate-key` | Nova chave do cliente |
| GET | `/admin/sessions/{id}/qr` | QR em JSON (`qr_image` em data URL) e `pairing_code` |
| GET | `/admin/sessions/{id}/qr.html?token=...` | Página de conexão que se atualiza sozinha |
| GET/POST | `/admin/templates` | Listar / criar-atualizar `{name, language, header, body, footer}` |
| DELETE | `/admin/templates/{name}/{language}` | Remover template |
| GET | `/admin/webhooks/dead` | Webhooks que esgotaram as tentativas |
| POST | `/admin/webhooks/retry` | Recolocar os mortos na fila |

### Status da linha
`new` → `connecting` → `qr` → `open`. Quedas viram `closed` e reconectam sozinhas. `idle` = QR expirou sem leitura. `logged_out` = desconectado pelo celular (precisa de novo QR).

## Usando nas soluções PHP

`clients/php/WhatsAppEngine.php` encapsula tudo:

```php
require 'WhatsAppEngine.php';
$wa = new WhatsAppEngine('https://wa.seudominio.com.br', 'festavibe-01', getenv('WA_TOKEN'));

$wa->sendText('5511988887777', 'Olá!');
$wa->sendButtons('5511988887777', 'Você vai ao casamento?', ['sim' => 'Vou', 'nao' => 'Não vou']);
$wa->sendTemplate('5511988887777', 'convite_evento', ['Ana', 'Casamento', '10/12']);
$wa->sendMedia('5511988887777', 'document', 'https://.../convite.pdf', 'Seu convite', 'convite.pdf');
```

`clients/php/webhook.php` mostra como validar a assinatura e tratar mensagens, respostas de botão, status e o evento de conexão.

## Estrutura

```
src/server.js     HTTP + rotas
src/session.js    uma linha: conexão Baileys, eventos, envio, mídia
src/manager.js    cadastro das linhas e tokens
src/clients.js    clientes, chaves e limite de linhas
public/painel.html painel de administração
src/mapper.js     tradução Cloud API ⇄ Baileys
src/openapi.js    especificação OpenAPI + página do Swagger UI
src/webhooks.js   fila e entrega dos webhooks assinados
src/authState.js  sessão do Baileys no PostgreSQL
sql/              esquema do banco
clients/php/      cliente e exemplo de webhook
```

## Atualizar uma instalação existente

Envie os arquivos novos por cima (SFTP ou `git pull`), mantendo o `.env`, e reinicie o site em *Web › Sites*. As tabelas novas são criadas sozinhas na inicialização.

## Limitações conhecidas

- Não testado ainda contra um número real neste pacote — valide primeiro com um chip de teste.
- Botões/listas nativos não são enviados (viram texto numerado), pois não aparecem de forma confiável em contas comuns.
- Grupos são ignorados por padrão (`IGNORE_GROUPS=true`).
- Mensagens ficam guardadas por 7 dias (`MESSAGE_RETENTION_DAYS`); depois disso não dá para baixar mídia, reagir ou citar.
- Baileys 7 ainda está em release candidate; após o `npm install`, fixe a versão que funcionou no `package.json`.
