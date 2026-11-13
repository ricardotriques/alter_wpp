/**
 * Especificação OpenAPI 3.0 do wa-engine (servida em /openapi.json e /docs).
 */
const err = { $ref: '#/components/responses/Error' };
const pathId = (name, desc, example) => ({ name, in: 'path', required: true, description: desc, schema: { type: 'string', example } });
const phoneId = pathId('phone_number_id', 'Id da linha (equivale ao phone_number_id da Cloud API)', 'festavibe-01');
const version = pathId('version', 'Versão no estilo Graph API (qualquer uma é aceita)', 'v21.0');
const sessionId = pathId('id', 'Id da linha', 'festavibe-01');
const json = (schema, example) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const ok = (description, schema, example) => ({ description, content: json(schema, example) });
const master = [{ masterKey: [] }];
const both = [{ lineToken: [] }, { clientKey: [] }, { masterKey: [] }];

const sendExamples = {
    texto: { summary: 'Texto', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'text', text: { body: 'Olá! Seu convite chegou 🎉' } } },
    resposta: { summary: 'Texto respondendo (citando) uma mensagem', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'text', context: { message_id: '3EB0ABC123' }, text: { body: 'Combinado!' } } },
    imagem: { summary: 'Imagem por link', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'image', image: { link: 'https://exemplo.com/convite.jpg', caption: 'Seu convite' } } },
    documento: { summary: 'Documento por link', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'document', document: { link: 'https://exemplo.com/convite.pdf', filename: 'convite.pdf', caption: 'Convite em PDF' } } },
    audio: { summary: 'Áudio (mensagem de voz)', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'audio', audio: { link: 'https://exemplo.com/recado.ogg', voice: true } } },
    botoes: {
        summary: 'Botões (viram opções numeradas)',
        value: {
            messaging_product: 'whatsapp', to: '5511988887777', type: 'interactive',
            interactive: {
                type: 'button', header: { type: 'text', text: 'Casamento Ana & Léo' }, body: { text: 'Você vai comparecer?' }, footer: { text: 'FestaVibe' },
                action: { buttons: [{ type: 'reply', reply: { id: 'sim', title: 'Vou' } }, { type: 'reply', reply: { id: 'nao', title: 'Não vou' } }] },
            },
        },
    },
    lista: {
        summary: 'Lista (vira opções numeradas)',
        value: {
            messaging_product: 'whatsapp', to: '5511988887777', type: 'interactive',
            interactive: {
                type: 'list', body: { text: 'Escolha o setor:' },
                action: { button: 'Ver opções', sections: [{ title: 'Atendimento', rows: [{ id: 'vendas', title: 'Vendas' }, { id: 'suporte', title: 'Suporte', description: 'Dúvidas técnicas' }] }] },
            },
        },
    },
    template: {
        summary: 'Template local',
        value: {
            messaging_product: 'whatsapp', to: '5511988887777', type: 'template',
            template: { name: 'convite_evento', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: 'Casamento' }, { type: 'text', text: '10/12' }] }] },
        },
    },
    localizacao: { summary: 'Localização', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'location', location: { latitude: -23.5614, longitude: -46.6559, name: 'Espaço de Festas', address: 'Av. Paulista, 1000' } } },
    reacao: { summary: 'Reação', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'reaction', reaction: { message_id: '3EB0ABC123', emoji: '❤️' } } },
    contato: { summary: 'Contato', value: { messaging_product: 'whatsapp', to: '5511988887777', type: 'contacts', contacts: [{ name: { formatted_name: 'Cerimonial' }, phones: [{ phone: '+55 11 97777-6666', wa_id: '5511977776666' }] }] } },
    lida: { summary: 'Marcar como lida', value: { messaging_product: 'whatsapp', status: 'read', message_id: '3EB0ABC123' } },
};

export function buildSpec(serverUrl) {
    return {
        openapi: '3.0.3',
        info: {
            title: 'wa-engine — motor de WhatsApp alternativo',
            version: '0.1.0',
            description:
                'API no formato da **WhatsApp Cloud API** da Meta, sobre conexão não oficial (Baileys).\n\n' +
                '**Autenticação:** clique em *Authorize* e informe o `access_token` da linha ou a `api_key` do cliente (rotas de envio) ou a `MASTER_KEY` (rotas /admin).\n\n' +
                '**Painel:** a administração visual fica em `/painel`.\n\n' +
                '**Webhooks:** as mensagens recebidas e os status (`sent`, `delivered`, `read`, `failed`) são enviados por POST para o `webhook_url` da linha, ' +
                'no mesmo envelope da Meta e assinados com `X-Hub-Signature-256` (HMAC-SHA256 com o `webhook_secret`). Veja o schema **WebhookPayload**.',
        },
        servers: [{ url: serverUrl }],
        tags: [
            { name: 'Mensagens', description: 'Compatível com a Cloud API' },
            { name: 'Mídia', description: 'Download de mídias recebidas' },
            { name: 'Clientes', description: 'Agrupam linhas, com chave própria e limite de linhas' },
            { name: 'Linhas', description: 'Cadastro e conexão dos números' },
            { name: 'Templates', description: 'Templates locais com {{1}}, {{2}}…' },
            { name: 'Webhooks', description: 'Fila de entrega' },
            { name: 'Sistema' },
        ],
        components: {
            securitySchemes: {
                lineToken: { type: 'http', scheme: 'bearer', description: 'access_token da linha (wae_...)' },
                clientKey: { type: 'http', scheme: 'bearer', description: 'api_key do cliente (wac_...) — vale para todas as linhas do cliente' },
                masterKey: { type: 'http', scheme: 'bearer', description: 'MASTER_KEY do .env' },
            },
            responses: {
                Error: { description: 'Erro no formato da Graph API', content: json({ $ref: '#/components/schemas/Error' }) },
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string', example: 'OAuthException' }, code: { type: 'integer', example: 190 }, fbtrace_id: { type: 'string' } } } },
                },
                SendMessage: {
                    type: 'object',
                    required: ['messaging_product'],
                    description: 'Corpo igual ao da Cloud API. Informe `type` e o objeto correspondente.',
                    properties: {
                        messaging_product: { type: 'string', enum: ['whatsapp'] },
                        recipient_type: { type: 'string', enum: ['individual'] },
                        to: { type: 'string', description: 'Número com DDI e DDD, só dígitos', example: '5511988887777' },
                        type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts', 'reaction', 'interactive', 'template'] },
                        context: { type: 'object', properties: { message_id: { type: 'string', description: 'Mensagem a citar' } } },
                        text: { type: 'object', properties: { body: { type: 'string' }, preview_url: { type: 'boolean' } } },
                        image: { $ref: '#/components/schemas/MediaObject' },
                        video: { $ref: '#/components/schemas/MediaObject' },
                        audio: { $ref: '#/components/schemas/MediaObject' },
                        document: { $ref: '#/components/schemas/MediaObject' },
                        sticker: { $ref: '#/components/schemas/MediaObject' },
                        location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, name: { type: 'string' }, address: { type: 'string' } } },
                        reaction: { type: 'object', properties: { message_id: { type: 'string' }, emoji: { type: 'string' } } },
                        contacts: { type: 'array', items: { type: 'object' } },
                        interactive: { type: 'object', description: 'button, list ou cta_url — enviados como texto com opções numeradas' },
                        template: { type: 'object', properties: { name: { type: 'string' }, language: { type: 'object', properties: { code: { type: 'string', example: 'pt_BR' } } }, components: { type: 'array', items: { type: 'object' } } } },
                        status: { type: 'string', enum: ['read'], description: 'Use com message_id para marcar como lida' },
                        message_id: { type: 'string' },
                    },
                },
                MediaObject: {
                    type: 'object',
                    properties: {
                        link: { type: 'string', format: 'uri', description: 'URL pública do arquivo' },
                        id: { type: 'string', description: 'Id de uma mensagem com mídia já existente (reencaminha)' },
                        caption: { type: 'string' },
                        filename: { type: 'string', description: 'Só para document' },
                        mime_type: { type: 'string' },
                        voice: { type: 'boolean', description: 'Só para audio (padrão true)' },
                    },
                },
                SendResponse: {
                    type: 'object',
                    properties: {
                        messaging_product: { type: 'string', example: 'whatsapp' },
                        contacts: { type: 'array', items: { type: 'object', properties: { input: { type: 'string' }, wa_id: { type: 'string' } } } },
                        messages: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', example: '3EB0ABC123' } } } },
                    },
                },
                Session: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' }, name: { type: 'string' }, client_id: { type: 'string', nullable: true },
                        status: { type: 'string', enum: ['new', 'connecting', 'qr', 'open', 'closed', 'idle', 'logged_out'] },
                        phone: { type: 'string', nullable: true }, push_name: { type: 'string', nullable: true },
                        webhook_url: { type: 'string', nullable: true }, pairing_phone: { type: 'string', nullable: true },
                        created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
                    },
                },
                SessionInput: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'festavibe-01', description: 'Letras, números, - e _' },
                        name: { type: 'string', example: 'FestaVibe Convites' },
                        client_id: { type: 'string', example: 'buffet-alegria', description: 'Cliente dono da linha (respeita o limite de linhas)' },
                        webhook_url: { type: 'string', format: 'uri', example: 'https://festavibe.com.br/api/wa-webhook.php' },
                        webhook_secret: { type: 'string', description: 'Opcional; gerado se omitido' },
                        pairing_phone: { type: 'string', example: '5511999999999', description: 'Se informado, gera código de pareamento em vez de QR' },
                    },
                },
                Client: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'buffet-alegria' }, name: { type: 'string', example: 'Buffet Alegria' },
                        max_lines: { type: 'integer', example: 2 }, lines_used: { type: 'integer' }, active: { type: 'boolean' },
                        notes: { type: 'string', nullable: true }, created_at: { type: 'string', format: 'date-time' },
                    },
                },
                ClientInput: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'buffet-alegria' }, name: { type: 'string', example: 'Buffet Alegria' },
                        max_lines: { type: 'integer', example: 2 }, active: { type: 'boolean' }, notes: { type: 'string' },
                    },
                },
                Template: {
                    type: 'object',
                    required: ['name', 'body'],
                    properties: {
                        name: { type: 'string', example: 'convite_evento' },
                        language: { type: 'string', example: 'pt_BR' },
                        header: { type: 'string', example: 'Olá {{1}}!' },
                        body: { type: 'string', example: 'Você está convidado(a) para o {{2}} no dia {{3}}.' },
                        footer: { type: 'string', example: 'FestaVibe' },
                    },
                },
                WebhookPayload: {
                    type: 'object',
                    description: 'Enviado por POST ao webhook_url. field = "messages" (mensagens e status) ou "connection" (exclusivo do motor).',
                    example: {
                        object: 'whatsapp_business_account',
                        entry: [{
                            id: 'festavibe-01',
                            changes: [{
                                field: 'messages',
                                value: {
                                    messaging_product: 'whatsapp',
                                    metadata: { display_phone_number: '5511900000000', phone_number_id: 'festavibe-01' },
                                    contacts: [{ profile: { name: 'Ana' }, wa_id: '5511988887777' }],
                                    messages: [{ from: '5511988887777', id: '3EB0XYZ', timestamp: '1700000000', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'sim', title: 'Vou' } } }],
                                },
                            }],
                        }],
                    },
                },
            },
        },
        paths: {
            '/{version}/{phone_number_id}/messages': {
                post: {
                    tags: ['Mensagens'], summary: 'Enviar mensagem ou marcar como lida', security: both,
                    description: 'Envio assíncrono: responde na hora com o id; o resultado chega por webhook (sent/delivered/read/failed).',
                    parameters: [version, phoneId],
                    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SendMessage' }, examples: sendExamples } } },
                    responses: { 200: ok('Aceita para envio', { $ref: '#/components/schemas/SendResponse' }), 400: err, 401: err, 404: err, 503: err },
                },
            },
            '/{version}/{id}': {
                get: {
                    tags: ['Mídia'], summary: 'Dados da linha ou metadados de mídia', security: both,
                    description: 'Se `id` for uma linha, devolve os dados dela. Caso contrário, trata como `media_id` e devolve `url` para download (com a chave mestra, informe `phone_number_id`).',
                    parameters: [version, pathId('id', 'phone_number_id ou media_id', 'festavibe-01'), { name: 'phone_number_id', in: 'query', schema: { type: 'string' } }],
                    responses: { 200: ok('OK', { type: 'object' }), 401: err, 404: err },
                },
            },
            '/media/{phone_number_id}/{media_id}/download': {
                get: {
                    tags: ['Mídia'], summary: 'Baixar o arquivo de uma mídia recebida', security: both,
                    parameters: [phoneId, pathId('media_id', 'Id da mídia (veio no webhook)', '3EB0XYZ')],
                    responses: { 200: { description: 'Arquivo', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 404: err },
                },
            },
            '/admin/clients': {
                get: { tags: ['Clientes'], summary: 'Listar clientes', security: master, responses: { 200: ok('OK', { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Client' } } } }) } },
                post: {
                    tags: ['Clientes'], summary: 'Criar cliente', security: master,
                    requestBody: { required: true, content: json({ $ref: '#/components/schemas/ClientInput' }) },
                    responses: { 201: ok('Criado — guarde a api_key', { allOf: [{ $ref: '#/components/schemas/Client' }, { type: 'object', properties: { api_key: { type: 'string' } } }] }), 400: err, 409: err },
                },
            },
            '/admin/clients/{id}': {
                get: { tags: ['Clientes'], summary: 'Ver cliente e suas linhas', security: master, parameters: [pathId('id', 'Id do cliente', 'buffet-alegria')], responses: { 200: ok('OK', { $ref: '#/components/schemas/Client' }), 404: err } },
                patch: { tags: ['Clientes'], summary: 'Alterar (nome, limite, suspender com active=false)', security: master, parameters: [pathId('id', 'Id do cliente', 'buffet-alegria')], requestBody: { content: json({ $ref: '#/components/schemas/ClientInput' }) }, responses: { 200: ok('OK', { $ref: '#/components/schemas/Client' }) } },
                delete: { tags: ['Clientes'], summary: 'Excluir (só sem linhas)', security: master, parameters: [pathId('id', 'Id do cliente', 'buffet-alegria')], responses: { 200: ok('OK', { type: 'object' }), 409: err } },
            },
            '/admin/clients/{id}/rotate-key': {
                post: { tags: ['Clientes'], summary: 'Gerar nova api_key', security: master, parameters: [pathId('id', 'Id do cliente', 'buffet-alegria')], responses: { 200: ok('OK', { type: 'object', properties: { api_key: { type: 'string' } } }) } },
            },
            '/admin/sessions': {
                get: { tags: ['Linhas'], summary: 'Listar linhas', security: master, parameters: [{ name: 'client_id', in: 'query', schema: { type: 'string' }, description: 'Filtrar por cliente ("none" = sem cliente)' }], responses: { 200: ok('OK', { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } }), 401: err } },
                post: {
                    tags: ['Linhas'], summary: 'Criar linha (já inicia o QR)', security: master,
                    requestBody: { required: true, content: json({ $ref: '#/components/schemas/SessionInput' }) },
                    responses: {
                        201: ok('Criada — guarde o access_token, ele não aparece de novo', { allOf: [{ $ref: '#/components/schemas/Session' }, { type: 'object', properties: { access_token: { type: 'string' }, webhook_secret: { type: 'string' }, qr_page: { type: 'string' } } }] }),
                        400: err, 401: err, 409: err,
                    },
                },
            },
            '/admin/sessions/{id}': {
                get: { tags: ['Linhas'], summary: 'Ver linha', security: master, parameters: [sessionId], responses: { 200: ok('OK', { $ref: '#/components/schemas/Session' }), 404: err } },
                patch: {
                    tags: ['Linhas'], summary: 'Alterar linha', security: master, parameters: [sessionId],
                    requestBody: { content: json({ type: 'object', properties: { name: { type: 'string' }, client_id: { type: 'string' }, webhook_url: { type: 'string' }, webhook_secret: { type: 'string' }, pairing_phone: { type: 'string' } } }) },
                    responses: { 200: ok('OK', { $ref: '#/components/schemas/Session' }), 404: err },
                },
                delete: { tags: ['Linhas'], summary: 'Remover linha (desconecta o número)', security: master, parameters: [sessionId], responses: { 200: ok('OK', { type: 'object' }), 404: err } },
            },
            '/admin/sessions/{id}/connect': { post: { tags: ['Linhas'], summary: 'Gerar novo QR / reconectar', security: both, parameters: [sessionId], responses: { 200: ok('OK', { $ref: '#/components/schemas/Session' }) } } },
            '/admin/sessions/{id}/logout': { post: { tags: ['Linhas'], summary: 'Desconectar o número', security: both, parameters: [sessionId], responses: { 200: ok('OK', { $ref: '#/components/schemas/Session' }) } } },
            '/admin/sessions/{id}/rotate-token': { post: { tags: ['Linhas'], summary: 'Gerar novo access_token', security: master, parameters: [sessionId], responses: { 200: ok('OK', { type: 'object', properties: { access_token: { type: 'string' } } }) } } },
            '/admin/sessions/{id}/qr': {
                get: {
                    tags: ['Linhas'], summary: 'QR code em JSON', security: both, parameters: [sessionId],
                    responses: { 200: ok('OK', { type: 'object', properties: { status: { type: 'string' }, qr: { type: 'string', nullable: true }, qr_image: { type: 'string', nullable: true, description: 'data:image/png;base64,...' }, pairing_code: { type: 'string', nullable: true } } }) },
                },
            },
            '/admin/sessions/{id}/qr.html': {
                get: {
                    tags: ['Linhas'], summary: 'Página de conexão (abra no navegador)', parameters: [sessionId, { name: 'token', in: 'query', required: true, schema: { type: 'string' }, description: 'access_token da linha' }],
                    responses: { 200: { description: 'HTML', content: { 'text/html': {} } } },
                },
            },
            '/admin/templates': {
                get: { tags: ['Templates'], summary: 'Listar templates', security: master, responses: { 200: ok('OK', { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Template' } } } }) } },
                post: { tags: ['Templates'], summary: 'Criar ou atualizar template', security: master, requestBody: { required: true, content: json({ $ref: '#/components/schemas/Template' }) }, responses: { 201: ok('OK', { $ref: '#/components/schemas/Template' }), 400: err } },
            },
            '/admin/templates/{name}/{language}': {
                delete: { tags: ['Templates'], summary: 'Remover template', security: master, parameters: [pathId('name', 'Nome', 'convite_evento'), pathId('language', 'Idioma', 'pt_BR')], responses: { 200: ok('OK', { type: 'object' }) } },
            },
            '/admin/webhooks/dead': { get: { tags: ['Webhooks'], summary: 'Webhooks que esgotaram as tentativas', security: master, responses: { 200: ok('OK', { type: 'object' }) } } },
            '/admin/webhooks/retry': { post: { tags: ['Webhooks'], summary: 'Recolocar os webhooks mortos na fila', security: master, responses: { 200: ok('OK', { type: 'object', properties: { requeued: { type: 'integer' } } }) } } },
            '/health': { get: { tags: ['Sistema'], summary: 'Saúde do serviço', responses: { 200: ok('OK', { type: 'object' }) } } },
        },
    };
}

export function swaggerHtml() {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wa-engine — API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>body{margin:0}.topbar{display:none}</style></head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: location.pathname.replace(/\\/docs\\/?$/, '') + '/openapi.json', dom_id: '#ui', deepLinking: true, persistAuthorization: true, tryItOutEnabled: true, docExpansion: 'list' });</script>
</body></html>`;
}
