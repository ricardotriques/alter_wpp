import * as B from 'baileys';
import { usePgAuthState } from './authState.js';
import { q } from './db.js';
import { config } from './config.js';
import { logger, baileysLogger } from './logger.js';
import { enqueue, envelope } from './webhooks.js';
import { toCloudMessage, fromCloudPayload, mapStatus, detectType, unwrap, digits, jidToWaId, isGroup, badRequest } from './mapper.js';

const makeWASocket = B.default?.default || B.default || B.makeWASocket;
const { DisconnectReason, BufferJSON, Browsers } = B;
const newMessageId = () => (B.generateMessageIDV2 ? B.generateMessageIDV2() : B.generateMessageID());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * Math.max(0, b - a));
const MENU_TTL = 60 * 60 * 1000; // opções numeradas valem 1h

let waVersion = null;

export class Session {
    constructor(row) {
        this.id = row.id;
        this.row = row;
        this.sock = null;
        this.status = row.status;
        this.qr = null;
        this.pairingCode = null;
        this.stopped = false;
        this.retries = 0;
        this.jidCache = new Map(); // wa_id -> jid (inclui LIDs)
        this.menus = new Map(); // jid -> { items, expires }
        this.queue = Promise.resolve();
        this.lastSend = 0;
        this.log = logger.child({ session: this.id });
    }

    get phone() { return this.row.phone; }

    async setStatus(status, extra = {}) {
        this.status = status;
        Object.assign(this.row, extra, { status });
        const sets = ['status = $2', 'updated_at = now()'];
        const vals = [this.id, status];
        for (const [k, v] of Object.entries(extra)) {
            vals.push(v);
            sets.push(`${k} = $${vals.length}`);
        }
        await q(`UPDATE wa_sessions SET ${sets.join(', ')} WHERE id = $1`, vals);
    }

    /** Evento extra (não existe na Cloud API) para avisar conexão/desconexão/QR */
    emitConnection(state, detail = {}) {
        return enqueue(this.id, envelope(this, 'connection', { connection: { state, ...detail, timestamp: String(Math.floor(Date.now() / 1000)) } }));
    }

    async start() {
        this.stopped = false;
        if (this.sock) { try { this.sock.end(undefined); } catch { /* ignora */ } this.sock = null; }
        if (this.status === 'logged_out' || this.status === 'idle') this.pairingCode = null;
        if (!waVersion) {
            try { waVersion = (await B.fetchLatestBaileysVersion()).version; } catch { /* usa o padrão da lib */ }
        }
        const { state, saveCreds, clear } = await usePgAuthState(this.id);
        this.clearAuth = clear;
        this.registered = !!state.creds.registered;

        const sock = makeWASocket({
            version: waVersion || undefined,
            auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, baileysLogger) },
            logger: baileysLogger,
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            generateHighQualityLinkPreview: false,
            getMessage: async (key) => (await this.getStoredMessage(key.id))?.message || undefined,
        });
        this.sock = sock;
        await this.setStatus('connecting');

        // Cada handler só age se este socket ainda for o atual (evita eventos de sockets antigos)
        const guard = (name, fn) => (u) => {
            if (sock !== this.sock) return;
            fn.call(this, u).catch((e) => this.log.error({ err: e.message, stack: e.stack }, name));
        };
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', guard('connection.update', this.onConnection));
        sock.ev.on('messages.upsert', guard('messages.upsert', this.onUpsert));
        sock.ev.on('messages.update', guard('messages.update', this.onUpdate));
    }

    async onConnection({ connection, lastDisconnect, qr }) {
        if (qr) {
            this.qr = qr;
            if (this.status !== 'qr') {
                await this.setStatus('qr');
                await this.emitConnection('qr');
            }
            if (this.row.pairing_phone && !this.pairingCode) {
                try {
                    this.pairingCode = await this.sock.requestPairingCode(digits(this.row.pairing_phone));
                    this.log.info({ code: this.pairingCode }, 'código de pareamento gerado');
                } catch (e) {
                    this.log.warn({ err: e.message }, 'falha ao gerar código de pareamento');
                }
            }
        }

        if (connection === 'open') {
            this.qr = null;
            this.pairingCode = null;
            this.retries = 0;
            this.registered = true;
            const user = this.sock.user || {};
            await this.setStatus('open', { phone: jidToWaId(user.id), push_name: user.name || null });
            this.log.info({ phone: this.row.phone }, 'linha conectada');
            await this.emitConnection('open', { phone: this.row.phone });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            this.sock = null;
            if (this.stopped) return;

            if (code === DisconnectReason.loggedOut) {
                this.log.warn('linha desconectada pelo celular (logout)');
                await this.clearAuth();
                this.qr = null;
                await this.setStatus('logged_out', { phone: null });
                await this.emitConnection('logged_out');
                return;
            }
            if (!this.registered && code === DisconnectReason.timedOut) {
                // QR expirou sem leitura: para e espera um novo /connect
                this.qr = null;
                await this.setStatus('idle');
                await this.emitConnection('qr_timeout');
                return;
            }
            const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(2000 * 2 ** this.retries, 60_000);
            this.retries++;
            this.log.warn({ code, wait }, 'conexão fechada, reconectando');
            await this.setStatus('closed');
            if (this.retries === 3) await this.emitConnection('reconnecting', { code });
            setTimeout(() => !this.stopped && !this.sock && this.start().catch((e) => this.log.error(e, 'reconexão')), wait);
        }
    }

    /** Converte remetente (pode ser LID) em número */
    async resolveWaId(jid, alt) {
        if (jid?.endsWith('@s.whatsapp.net')) return jidToWaId(jid);
        if (alt?.endsWith('@s.whatsapp.net')) return jidToWaId(alt);
        if (jid?.endsWith('@lid')) {
            try {
                const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
                if (pn) return jidToWaId(pn);
            } catch { /* sem mapeamento */ }
        }
        return jidToWaId(jid);
    }

    async onUpsert({ messages, type }) {
        if (type !== 'notify') return;
        for (const msg of messages) {
            const jid = msg.key?.remoteJid;
            if (!msg.message || !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
            if (config.ignoreGroups && isGroup(jid)) continue;

            const mtype = detectType(msg.message);
            if (mtype === 'protocol') continue;
            await this.storeMessage(msg, mtype);
            if (msg.key.fromMe) continue; // enviada pelo próprio celular: a Cloud API não notifica

            const waId = await this.resolveWaId(jid, msg.key.remoteJidAlt);
            this.jidCache.set(waId, jid);

            let cloud = toCloudMessage(msg, waId);
            cloud = this.applyMenu(jid, cloud);

            await enqueue(
                this.id,
                envelope(this, 'messages', {
                    contacts: [{ profile: { name: msg.pushName || '' }, wa_id: waId }],
                    messages: [cloud],
                }),
            );
        }
    }

    /** Se havia menu numerado pendente e a pessoa respondeu "2", vira interactive */
    applyMenu(jid, cloud) {
        const menu = this.menus.get(jid);
        if (!menu || cloud.type !== 'text') return cloud;
        if (Date.now() > menu.expires) { this.menus.delete(jid); return cloud; }
        const n = parseInt(String(cloud.text.body).trim().replace(/[^\d]/g, ''), 10);
        const item = menu.items[n - 1];
        if (!item || !/^\s*\d{1,2}\s*[.)]?\s*$/.test(cloud.text.body)) return cloud;
        this.menus.delete(jid);
        const { text, ...rest } = cloud;
        return { ...rest, type: 'interactive', interactive: { type: item.kind, [item.kind]: { id: item.id, title: item.title } } };
    }

    async onUpdate(updates) {
        for (const { key, update } of updates) {
            if (!key.fromMe || update.status == null) continue;
            const status = mapStatus(update.status);
            if (!status) continue;
            const recipient = await this.resolveWaId(key.remoteJid, key.remoteJidAlt);
            const st = { id: key.id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient };
            if (status === 'failed') st.errors = [{ code: 131000, title: 'Something went wrong' }];
            await enqueue(this.id, envelope(this, 'messages', { statuses: [st] }));
        }
    }

    async storeMessage(msg, type) {
        await q(
            `INSERT INTO wa_messages (session_id, id, jid, from_me, type, raw) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id, id) DO UPDATE SET raw = EXCLUDED.raw`,
            [this.id, msg.key.id, msg.key.remoteJid, !!msg.key.fromMe, type || detectType(msg.message), JSON.stringify(msg, BufferJSON.replacer)],
        );
    }

    async getStoredMessage(id) {
        if (!id) return null;
        const r = await q('SELECT raw FROM wa_messages WHERE session_id = $1 AND id = $2', [this.id, id]);
        return r.rows[0] ? JSON.parse(r.rows[0].raw, BufferJSON.reviver) : null;
    }

    requireOpen() {
        if (this.status !== 'open' || !this.sock) {
            const e = new Error(`Linha ${this.id} não está conectada (status: ${this.status})`);
            e.status = 503;
            e.code = 131000;
            throw e;
        }
    }

    /** wa_id -> jid real (resolve o 9º dígito brasileiro via onWhatsApp) */
    async resolveJid(to) {
        const d = digits(to);
        if (!d) throw badRequest('Campo "to" inválido');
        if (this.jidCache.has(d)) return this.jidCache.get(d);
        const [res] = (await this.sock.onWhatsApp(d)) || [];
        if (!res?.exists) throw badRequest(`O número ${d} não tem WhatsApp`, 131026);
        this.jidCache.set(d, res.jid);
        if (this.jidCache.size > 5000) this.jidCache.delete(this.jidCache.keys().next().value);
        return res.jid;
    }

    /** Fila de envio por linha: espaça as mensagens para reduzir risco de banimento */
    schedule(fn) {
        const run = this.queue.then(async () => {
            const wait = this.lastSend + rand(config.sendMinDelay, config.sendMaxDelay) - Date.now();
            if (wait > 0) await sleep(wait);
            try { return await fn(); } finally { this.lastSend = Date.now(); }
        });
        this.queue = run.catch(() => {});
        return run;
    }

    /** POST /{phone_number_id}/messages */
    async send(body) {
        this.requireOpen();
        if (body.messaging_product && body.messaging_product !== 'whatsapp') throw badRequest('messaging_product deve ser "whatsapp"');

        // Marcar como lida: { messaging_product, status: "read", message_id }
        if (body.status === 'read') {
            const m = await this.getStoredMessage(body.message_id);
            if (m) await this.sock.readMessages([m.key]);
            return { success: true };
        }

        const jid = await this.resolveJid(body.to);
        const { content, options, menu } = await fromCloudPayload(body, {
            getTemplate: async (name, lang) => (await q('SELECT * FROM wa_templates WHERE name = $1 AND language = $2', [name, lang])).rows[0],
            getStoredMessage: (id) => this.getStoredMessage(id),
        });

        const messageId = newMessageId();
        // Envio assíncrono, como na Cloud API: responde já com o id e informa sent/failed por webhook
        this.schedule(async () => {
            try {
                if (config.simulateTyping && content.text) {
                    await this.sock.sendPresenceUpdate('composing', jid);
                    await sleep(Math.min(800 + content.text.length * 25, 3500));
                    await this.sock.sendPresenceUpdate('paused', jid);
                }
                const sent = await this.sock.sendMessage(jid, content, { ...options, messageId });
                if (sent) await this.storeMessage(sent);
                if (menu) this.menus.set(jid, { items: menu, expires: Date.now() + MENU_TTL });
            } catch (err) {
                this.log.error({ err: err.message, to: body.to }, 'falha no envio');
                await enqueue(this.id, envelope(this, 'messages', {
                    statuses: [{ id: messageId, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: jidToWaId(jid), errors: [{ code: 131000, title: String(err.message).slice(0, 200) }] }],
                }));
            }
        });

        return {
            messaging_product: 'whatsapp',
            contacts: [{ input: String(body.to), wa_id: jidToWaId(jid) }],
            messages: [{ id: messageId }],
        };
    }

    /** Baixa mídia de uma mensagem guardada */
    async downloadMedia(id) {
        this.requireOpen();
        const msg = await this.getStoredMessage(id);
        if (!msg) return null;
        const m = unwrap(msg.message);
        const media = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage;
        if (!media) return null;
        const buffer = await B.downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: this.sock.updateMediaMessage });
        return { buffer, mime: media.mimetype || 'application/octet-stream', filename: media.fileName };
    }

    async mediaInfo(id, baseUrl) {
        const msg = await this.getStoredMessage(id);
        if (!msg) return null;
        const m = unwrap(msg.message);
        const media = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage;
        if (!media) return null;
        return {
            messaging_product: 'whatsapp',
            url: `${baseUrl}/media/${this.id}/${id}/download`,
            mime_type: media.mimetype,
            sha256: media.fileSha256 ? Buffer.from(media.fileSha256).toString('hex') : undefined,
            file_size: media.fileLength ? Number(media.fileLength) : undefined,
            id,
        };
    }

    async stop() {
        this.stopped = true;
        try { this.sock?.end(undefined); } catch { /* ignora */ }
        this.sock = null;
    }

    async logout() {
        this.stopped = true;
        try { await this.sock?.logout(); } catch { /* ignora */ }
        this.sock = null;
        await q('DELETE FROM wa_auth WHERE session_id = $1', [this.id]);
        this.qr = null;
        this.registered = false;
        await this.setStatus('logged_out', { phone: null });
    }
}
