import http from 'node:http';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { config } from './config.js';
import { pool, q } from './db.js';
import { logger } from './logger.js';
import { migrate } from './migrate.js';
import { startWebhookWorker, stopWebhookWorker } from './webhooks.js';
import { buildSpec, swaggerHtml } from './openapi.js';
import {
    bootSessions, createSession, updateSession, rotateToken, deleteSession, stopAll,
    getSession, allSessions, sessionByToken, publicView, safeEqual,
} from './manager.js';
import {
    loadClients, getClient, allClients, clientByKey, clientView, createClient, updateClient,
    rotateClientKey, deleteClient, linesOf,
} from './clients.js';

const painelHtml = readFileSync(new URL('../public/painel.html', import.meta.url), 'utf8');

// ---------- utilitários HTTP ----------
class HttpError extends Error {
    constructor(status, message, code = 100) { super(message); this.status = status; this.code = code; }
}

function send(res, status, data, headers = {}) {
    const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(body);
}

/** Erro no formato da Graph API */
function sendError(res, err) {
    const status = err.status || 500;
    if (status >= 500) logger.error({ err: err.message, stack: err.stack }, 'erro interno');
    send(res, status, {
        error: {
            message: err.message || 'Erro interno',
            type: status === 401 ? 'OAuthException' : 'GraphMethodException',
            code: err.code || (status === 401 ? 190 : 100),
            fbtrace_id: Math.random().toString(36).slice(2, 12),
        },
    });
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 1_000_000) throw new HttpError(413, 'Corpo maior que 1 MB');
        chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

const bearer = (req, url) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || url.searchParams.get('access_token') || url.searchParams.get('token');
const isMaster = (token) => safeEqual(token, config.masterKey);

function requireMaster(req, url) {
    if (!isMaster(bearer(req, url))) throw new HttpError(401, 'Chave mestra inválida', 190);
}

function sessionOr404(id) {
    const s = getSession(id);
    if (!s) throw new HttpError(404, `Linha ${id} não encontrada`, 100);
    return s;
}

function assertClientActive(s) {
    const c = s.row.client_id ? getClient(s.row.client_id) : null;
    if (c && !c.active) throw new HttpError(403, `Cliente ${c.name} está suspenso`, 10);
}

/** Aceita: chave mestra, token da própria linha ou chave do cliente dono da linha */
function authSession(req, url, phoneId) {
    const token = bearer(req, url);
    const s = sessionOr404(phoneId);
    if (isMaster(token)) return s;
    const client = clientByKey(token);
    if (client) {
        if (s.row.client_id !== client.id) throw new HttpError(401, 'Esta linha não pertence ao cliente', 190);
        assertClientActive(s);
        return s;
    }
    if (sessionByToken(token)?.id !== s.id) throw new HttpError(401, 'Token inválido para esta linha', 190);
    assertClientActive(s);
    return s;
}

function clientOr404(id) {
    const c = getClient(id);
    if (!c) throw new HttpError(404, `Cliente ${id} não encontrado`, 100);
    return c;
}

const baseUrl = (req) => config.publicUrl || `http://${req.headers.host}`;

// ---------- rotas ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- Documentação (Swagger UI) ---
route('GET', /^\/openapi\.json$/, async (req) => [200, buildSpec(baseUrl(req)), { 'Access-Control-Allow-Origin': '*' }]);
route('GET', /^\/docs$/, async () => [200, swaggerHtml(), { 'Content-Type': 'text/html; charset=utf-8' }]);

// --- Painel de administração ---
route('GET', /^\/painel$/, async () => [200, painelHtml, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }]);

// --- Clientes ---
route('GET', /^\/admin\/clients$/, async (req, url) => { requireMaster(req, url); return { data: allClients().map(clientView) }; });

route('POST', /^\/admin\/clients$/, async (req, url) => {
    requireMaster(req, url);
    const { client, key } = await createClient(await readJson(req));
    return [201, { ...clientView(client), api_key: key, aviso: 'Guarde a api_key: ela não será exibida novamente.' }];
});

route('GET', /^\/admin\/clients\/([^/]+)$/, async (req, url, [id]) => {
    requireMaster(req, url);
    const c = clientOr404(id);
    return { ...clientView(c), lines: linesOf(c.id).map(publicView) };
});

route('PATCH', /^\/admin\/clients\/([^/]+)$/, async (req, url, [id]) => {
    requireMaster(req, url);
    return clientView(await updateClient(clientOr404(id), await readJson(req)));
});

route('DELETE', /^\/admin\/clients\/([^/]+)$/, async (req, url, [id]) => {
    requireMaster(req, url);
    await deleteClient(clientOr404(id));
    return { success: true };
});

route('POST', /^\/admin\/clients\/([^/]+)\/rotate-key$/, async (req, url, [id]) => {
    requireMaster(req, url);
    return { api_key: await rotateClientKey(clientOr404(id)) };
});

route('GET', /^\/health$/, async () => {
    await q('SELECT 1');
    return { ok: true, sessions: allSessions().length, uptime: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576) };
});

// --- Administração das linhas ---
route('GET', /^\/admin\/sessions$/, async (req, url) => {
    requireMaster(req, url);
    const cid = url.searchParams.get('client_id');
    const list = cid ? allSessions().filter((s) => (s.row.client_id || '') === (cid === 'none' ? '' : cid)) : allSessions();
    return { data: list.map(publicView) };
});

route('POST', /^\/admin\/sessions$/, async (req, url) => {
    requireMaster(req, url);
    const body = await readJson(req);
    const { session, token, webhook_secret } = await createSession(body);
    return [201, {
        ...publicView(session),
        access_token: token,
        webhook_secret,
        qr_page: `${baseUrl(req)}/admin/sessions/${session.id}/qr.html?token=${token}`,
        aviso: 'Guarde o access_token: ele não será exibido novamente.',
    }];
});

route('GET', /^\/admin\/sessions\/([^/]+)$/, async (req, url, [id]) => { requireMaster(req, url); return publicView(sessionOr404(id)); });

route('PATCH', /^\/admin\/sessions\/([^/]+)$/, async (req, url, [id]) => {
    requireMaster(req, url);
    const s = sessionOr404(id);
    await updateSession(s, await readJson(req));
    return publicView(s);
});

route('DELETE', /^\/admin\/sessions\/([^/]+)$/, async (req, url, [id]) => {
    requireMaster(req, url);
    await deleteSession(sessionOr404(id));
    return { success: true };
});

route('POST', /^\/admin\/sessions\/([^/]+)\/connect$/, async (req, url, [id]) => {
    const s = authSession(req, url, id);
    if (s.sock && ['open', 'qr', 'connecting'].includes(s.status)) return publicView(s);
    await s.start();
    return publicView(s);
});

route('POST', /^\/admin\/sessions\/([^/]+)\/logout$/, async (req, url, [id]) => {
    const s = authSession(req, url, id);
    await s.logout();
    return publicView(s);
});

route('POST', /^\/admin\/sessions\/([^/]+)\/rotate-token$/, async (req, url, [id]) => {
    requireMaster(req, url);
    return { access_token: await rotateToken(sessionOr404(id)) };
});

route('GET', /^\/admin\/sessions\/([^/]+)\/qr$/, async (req, url, [id]) => {
    const s = authSession(req, url, id);
    return {
        status: s.status,
        qr: s.qr,
        qr_image: s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 320 }) : null,
        pairing_code: s.pairingCode,
    };
});

route('GET', /^\/admin\/sessions\/([^/]+)\/qr\.html$/, async (req, url, [id]) => {
    const s = authSession(req, url, id);
    const img = s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 320 }) : null;
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${s.status === 'open' ? 30 : 5}"><title>Conectar ${esc(s.row.name)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f0f2f5;color:#111b21}
.c{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 3px #0002;text-align:center;max-width:360px}
.s{display:inline-block;padding:4px 10px;border-radius:99px;background:#e9edef;font-size:14px}.ok{background:#d9fdd3;color:#0a7a2f}
code{font-size:28px;letter-spacing:4px}</style></head><body><div class="c">
<h2>${esc(s.row.name)}</h2><p><span class="s ${s.status === 'open' ? 'ok' : ''}">${esc(s.status)}</span></p>
${s.status === 'open' ? `<p>Conectado como <b>+${esc(s.row.phone)}</b></p>`
        : s.pairingCode ? `<p>No celular: <b>Aparelhos conectados › Conectar com número</b> e digite:</p><code>${esc(s.pairingCode)}</code>`
        : img ? `<img src="${img}" width="280" height="280" alt="QR code"><p>WhatsApp › <b>Aparelhos conectados</b> › Conectar aparelho</p>`
        : `<p>Aguardando QR… Se o status for <b>idle</b> ou <b>logged_out</b>, chame POST /connect.</p>`}
<p style="color:#667781;font-size:13px">A página se atualiza sozinha.</p></div></body></html>`;
    return [200, html, { 'Content-Type': 'text/html; charset=utf-8' }];
});

// --- Templates locais ---
route('GET', /^\/admin\/templates$/, async (req, url) => {
    requireMaster(req, url);
    return { data: (await q('SELECT * FROM wa_templates ORDER BY name, language')).rows };
});
route('POST', /^\/admin\/templates$/, async (req, url) => {
    requireMaster(req, url);
    const t = await readJson(req);
    if (!t.name || !t.body) throw new HttpError(400, 'name e body são obrigatórios');
    const { rows } = await q(
        `INSERT INTO wa_templates (name, language, header, body, footer) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, language) DO UPDATE SET header = EXCLUDED.header, body = EXCLUDED.body, footer = EXCLUDED.footer
         RETURNING *`,
        [t.name, t.language || 'pt_BR', t.header || null, t.body, t.footer || null],
    );
    return [201, rows[0]];
});
route('DELETE', /^\/admin\/templates\/([^/]+)\/([^/]+)$/, async (req, url, [name, lang]) => {
    requireMaster(req, url);
    await q('DELETE FROM wa_templates WHERE name = $1 AND language = $2', [decodeURIComponent(name), lang]);
    return { success: true };
});

// --- Webhooks que falharam ---
route('GET', /^\/admin\/webhooks\/dead$/, async (req, url) => {
    requireMaster(req, url);
    return { data: (await q('SELECT id, session_id, attempts, last_error, created_at FROM wa_webhook_queue WHERE dead ORDER BY id DESC LIMIT 100')).rows };
});
route('POST', /^\/admin\/webhooks\/retry$/, async (req, url) => {
    requireMaster(req, url);
    const r = await q('UPDATE wa_webhook_queue SET dead = false, attempts = 0, next_attempt_at = now() WHERE dead');
    return { requeued: r.rowCount };
});

// --- Compatível com a Cloud API: /vXX.X/{phone_number_id}/messages ---
route('POST', /^\/v\d+(?:\.\d+)?\/([^/]+)\/messages$/, async (req, url, [phoneId]) => {
    const s = authSession(req, url, phoneId);
    return s.send(await readJson(req));
});

// Informações da linha (GET /vXX.X/{phone_number_id}) ou da mídia (GET /vXX.X/{media_id})
route('GET', /^\/v\d+(?:\.\d+)?\/([^/]+)$/, async (req, url, [id]) => {
    const s0 = getSession(id);
    if (s0) {
        const s = authSession(req, url, id);
        return {
            id: s.id,
            display_phone_number: s.row.phone ? `+${s.row.phone}` : null,
            verified_name: s.row.push_name || s.row.name,
            quality_rating: 'UNKNOWN',
            platform_type: 'NOT_APPLICABLE',
            status: s.status === 'open' ? 'CONNECTED' : 'DISCONNECTED',
        };
    }
    // mídia: a sessão vem do token (ou ?phone_number_id= com a chave mestra)
    const token = bearer(req, url);
    let s;
    const client = clientByKey(token);
    if (isMaster(token)) s = getSession(url.searchParams.get('phone_number_id'));
    else if (client) {
        s = getSession(url.searchParams.get('phone_number_id'));
        if (s && s.row.client_id !== client.id) s = null;
    } else s = sessionByToken(token);
    if (!s) throw new HttpError(401, 'Token inválido (com chave mestra ou de cliente, informe ?phone_number_id=)', 190);
    assertClientActive(s);
    const info = await s.mediaInfo(id, baseUrl(req));
    if (!info) throw new HttpError(404, 'Mídia não encontrada', 100);
    return info;
});

route('GET', /^\/media\/([^/]+)\/([^/]+)\/download$/, async (req, url, [phoneId, mediaId]) => {
    const s = authSession(req, url, phoneId);
    const media = await s.downloadMedia(mediaId);
    if (!media) throw new HttpError(404, 'Mídia não encontrada', 100);
    const headers = { 'Content-Type': media.mime, 'Content-Length': media.buffer.length };
    if (media.filename) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(media.filename)}"`;
    return [200, media.buffer, headers];
});

// ---------- servidor ----------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
        for (const r of routes) {
            if (r.method !== req.method) continue;
            const m = path.match(r.pattern);
            if (!m) continue;
            const out = await r.handler(req, url, m.slice(1).map(decodeURIComponent));
            if (Array.isArray(out)) return send(res, out[0], out[1], out[2]);
            return send(res, 200, out);
        }
        throw new HttpError(404, `Rota não encontrada: ${req.method} ${path}`);
    } catch (err) {
        sendError(res, err);
    }
});

// Limpeza periódica de mensagens antigas e webhooks mortos
function startJanitor() {
    const t = setInterval(async () => {
        try {
            await q(`DELETE FROM wa_messages WHERE created_at < now() - ($1 || ' days')::interval`, [String(config.retentionDays)]);
            await q(`DELETE FROM wa_webhook_queue WHERE dead AND created_at < now() - interval '7 days'`);
        } catch (e) { logger.warn({ err: e.message }, 'limpeza falhou'); }
    }, 60 * 60 * 1000);
    t.unref();
}

async function main() {
    await migrate();
    await loadClients();
    await bootSessions();
    startWebhookWorker();
    startJanitor();
    server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'wa-engine no ar'));
}

async function shutdown(sig) {
    logger.info({ sig }, 'encerrando');
    server.close();
    stopWebhookWorker();
    await stopAll(); // fecha sockets SEM deslogar: ao voltar, reconecta sem QR
    await pool.end().catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => logger.error({ err: e?.message, stack: e?.stack }, 'unhandledRejection'));

main().catch((e) => { logger.fatal(e, 'falha ao iniciar'); process.exit(1); });
