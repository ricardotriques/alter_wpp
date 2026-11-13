/**
 * Tradução entre o formato da WhatsApp Cloud API (Meta) e o Baileys.
 * Objetivo: as soluções falam "Cloud API" e podem trocar para a API oficial
 * mudando só a URL base e o token.
 */
import { proto } from 'baileys';

export const digits = (s) => String(s || '').replace(/\D/g, '');
export const jidToWaId = (jid) => String(jid || '').split('@')[0].split(':')[0];
export const isGroup = (jid) => String(jid || '').endsWith('@g.us');

/** Remove os invólucros (efêmera, view once, etc.) e devolve o conteúdo real */
export function unwrap(message) {
    let m = message;
    for (let i = 0; i < 5 && m; i++) {
        const inner =
            m.ephemeralMessage?.message ||
            m.viewOnceMessage?.message ||
            m.viewOnceMessageV2?.message ||
            m.viewOnceMessageV2Extension?.message ||
            m.documentWithCaptionMessage?.message ||
            m.editedMessage?.message;
        if (!inner) break;
        m = inner;
    }
    return m || {};
}

const MEDIA_KEYS = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    stickerMessage: 'sticker',
};

/** Identifica o tipo "Cloud API" de uma mensagem Baileys */
export function detectType(message) {
    const m = unwrap(message);
    if (m.conversation || m.extendedTextMessage) return 'text';
    for (const [k, t] of Object.entries(MEDIA_KEYS)) if (m[k]) return t;
    if (m.locationMessage || m.liveLocationMessage) return 'location';
    if (m.contactMessage || m.contactsArrayMessage) return 'contacts';
    if (m.reactionMessage) return 'reaction';
    if (m.buttonsResponseMessage || m.listResponseMessage || m.templateButtonReplyMessage || m.interactiveResponseMessage) return 'interactive';
    if (m.protocolMessage) return 'protocol';
    return 'unsupported';
}

/**
 * Converte uma mensagem recebida (WebMessageInfo) no objeto "message" do webhook da Cloud API.
 * `fromWaId` já deve vir resolvido (número, não LID).
 */
export function toCloudMessage(msg, fromWaId) {
    const m = unwrap(msg.message);
    const type = detectType(msg.message);
    const out = {
        from: fromWaId,
        id: msg.key.id,
        timestamp: String(Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)),
        type,
    };

    const ctx =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        m.stickerMessage?.contextInfo;
    if (ctx?.stanzaId) {
        out.context = { id: ctx.stanzaId, from: ctx.participant ? jidToWaId(ctx.participant) : undefined };
        if (ctx.isForwarded) out.context.forwarded = true;
    }

    switch (type) {
        case 'text':
            out.text = { body: m.conversation || m.extendedTextMessage?.text || '' };
            break;
        case 'image':
        case 'video':
        case 'audio':
        case 'document':
        case 'sticker': {
            const media = m[`${type}Message`];
            out[type] = {
                id: msg.key.id, // o id da mídia é o próprio id da mensagem (download sob demanda)
                mime_type: media.mimetype,
                sha256: media.fileSha256 ? Buffer.from(media.fileSha256).toString('base64') : undefined,
            };
            if (media.caption) out[type].caption = media.caption;
            if (type === 'document') out[type].filename = media.fileName;
            if (type === 'audio') out[type].voice = !!media.ptt;
            if (type === 'sticker') out[type].animated = !!media.isAnimated;
            break;
        }
        case 'location': {
            const l = m.locationMessage || m.liveLocationMessage;
            out.location = { latitude: l.degreesLatitude, longitude: l.degreesLongitude, name: l.name, address: l.address };
            break;
        }
        case 'contacts': {
            const list = m.contactsArrayMessage?.contacts || [m.contactMessage];
            out.contacts = list.map((c) => {
                const tel = (c.vcard || '').match(/waid=(\d+)/);
                const phone = (c.vcard || '').match(/TEL[^:]*:([+\d\s-]+)/);
                return {
                    name: { formatted_name: c.displayName },
                    phones: phone ? [{ phone: phone[1].trim(), wa_id: tel ? tel[1] : undefined }] : [],
                };
            });
            break;
        }
        case 'reaction':
            out.reaction = { message_id: m.reactionMessage.key?.id, emoji: m.reactionMessage.text || '' };
            break;
        case 'interactive': {
            if (m.buttonsResponseMessage) {
                out.interactive = { type: 'button_reply', button_reply: { id: m.buttonsResponseMessage.selectedButtonId, title: m.buttonsResponseMessage.selectedDisplayText } };
            } else if (m.listResponseMessage) {
                out.interactive = { type: 'list_reply', list_reply: { id: m.listResponseMessage.singleSelectReply?.selectedRowId, title: m.listResponseMessage.title } };
            } else if (m.templateButtonReplyMessage) {
                out.interactive = { type: 'button_reply', button_reply: { id: m.templateButtonReplyMessage.selectedId, title: m.templateButtonReplyMessage.selectedDisplayText } };
            } else {
                let params = {};
                try { params = JSON.parse(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}'); } catch { /* ignora */ }
                out.interactive = { type: 'button_reply', button_reply: { id: params.id, title: m.interactiveResponseMessage?.body?.text } };
            }
            break;
        }
        default:
            out.errors = [{ code: 131051, title: 'Message type unknown' }];
    }
    return out;
}

/** Status do Baileys -> status da Cloud API */
export function mapStatus(s) {
    const S = proto.WebMessageInfo.Status;
    switch (s) {
        case S.ERROR: return 'failed';
        case S.SERVER_ACK: return 'sent';
        case S.DELIVERY_ACK: return 'delivered';
        case S.READ:
        case S.PLAYED: return 'read';
        default: return null;
    }
}

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Preenche {{1}}, {{2}}... com os parâmetros de um componente de template */
export function fillPlaceholders(text, params = []) {
    return String(text || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
        const p = params[Number(n) - 1];
        if (!p) return '';
        return p.text ?? p.currency?.fallback_value ?? p.date_time?.fallback_value ?? '';
    });
}

/**
 * Converte o corpo de POST /messages (Cloud API) em conteúdo do Baileys.
 * Retorna { content, options, menu } — "menu" são as opções numeradas
 * quando um interactive é convertido para texto.
 */
export async function fromCloudPayload(body, { getTemplate, getStoredMessage }) {
    const type = body.type || (body.text ? 'text' : undefined);
    const options = {};
    if (body.context?.message_id) {
        const quoted = await getStoredMessage(body.context.message_id);
        if (quoted) options.quoted = quoted;
    }

    const mediaFrom = async (obj) => {
        if (obj?.link) return { url: obj.link };
        if (obj?.id) {
            // reaproveita mídia recebida/enviada anteriormente: reencaminha pelo id
            const stored = await getStoredMessage(obj.id);
            if (stored) return { forward: stored };
        }
        throw badRequest('Mídia precisa de "link" (URL pública) ou "id" de uma mensagem existente');
    };

    switch (type) {
        case 'text':
            return { content: { text: body.text?.body ?? '' }, options };

        case 'image':
        case 'video':
        case 'audio':
        case 'document':
        case 'sticker': {
            const obj = body[type] || {};
            const src = await mediaFrom(obj);
            if (src.forward) return { content: { forward: src.forward }, options };
            const content = { [type]: src };
            if (obj.caption && type !== 'audio' && type !== 'sticker') content.caption = obj.caption;
            if (type === 'document') {
                content.fileName = obj.filename || 'arquivo';
                content.mimetype = obj.mime_type || 'application/octet-stream';
            }
            if (type === 'audio') {
                content.mimetype = obj.mime_type || 'audio/ogg; codecs=opus';
                content.ptt = obj.voice !== false; // padrão: mensagem de voz
            }
            if (type === 'video' && obj.mime_type) content.mimetype = obj.mime_type;
            return { content, options };
        }

        case 'location': {
            const l = body.location || {};
            return { content: { location: { degreesLatitude: Number(l.latitude), degreesLongitude: Number(l.longitude), name: l.name, address: l.address } }, options };
        }

        case 'reaction': {
            const r = body.reaction || {};
            const target = await getStoredMessage(r.message_id);
            if (!target) throw badRequest('message_id da reação não encontrado (só mensagens dos últimos dias)');
            return { content: { react: { text: r.emoji || '', key: target.key } }, options: {} };
        }

        case 'contacts': {
            const contacts = (body.contacts || []).map((c) => {
                const name = c.name?.formatted_name || c.name?.first_name || 'Contato';
                const tels = (c.phones || []).map((p) => `TEL;type=CELL;type=VOICE;waid=${digits(p.wa_id || p.phone)}:${p.phone}`).join('\n');
                return { displayName: name, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\n${tels}\nEND:VCARD` };
            });
            return { content: { contacts: { displayName: contacts[0]?.displayName, contacts } }, options };
        }

        case 'interactive': {
            // Botões e listas nativos não aparecem de forma confiável em contas não oficiais.
            // Convertemos para texto com opções numeradas; a resposta "1", "2"... volta
            // no webhook como interactive.button_reply / list_reply com o id original.
            const it = body.interactive || {};
            const lines = [];
            if (it.header?.text) lines.push(`*${it.header.text}*`);
            if (it.body?.text) lines.push(it.body.text);
            const menu = [];
            if (it.type === 'button') {
                for (const b of it.action?.buttons || []) menu.push({ id: b.reply?.id, title: b.reply?.title, kind: 'button_reply' });
            } else if (it.type === 'list') {
                for (const s of it.action?.sections || []) {
                    for (const r of s.rows || []) menu.push({ id: r.id, title: r.title, description: r.description, kind: 'list_reply' });
                }
            } else if (it.type === 'cta_url') {
                lines.push(`${it.action?.parameters?.display_text || 'Acessar'}: ${it.action?.parameters?.url || ''}`);
            }
            if (menu.length) {
                lines.push('');
                menu.forEach((o, i) => lines.push(`${NUM_EMOJI[i] || `${i + 1}.`} ${o.title}${o.description ? ` — ${o.description}` : ''}`));
            }
            if (it.footer?.text) lines.push('', `_${it.footer.text}_`);
            return { content: { text: lines.join('\n') }, options, menu: menu.length ? menu : null };
        }

        case 'template': {
            const t = body.template || {};
            const lang = t.language?.code || 'pt_BR';
            const tpl = await getTemplate(t.name, lang);
            if (!tpl) throw badRequest(`Template "${t.name}" (${lang}) não cadastrado. Use POST /admin/templates`);
            const comp = (k) => (t.components || []).find((c) => c.type === k)?.parameters || [];
            const parts = [];
            if (tpl.header) parts.push(`*${fillPlaceholders(tpl.header, comp('header'))}*`);
            parts.push(fillPlaceholders(tpl.body, comp('body')));
            if (tpl.footer) parts.push(`_${tpl.footer}_`);
            return { content: { text: parts.join('\n\n') }, options };
        }

        default:
            throw badRequest(`Tipo de mensagem não suportado: ${type}`);
    }
}

export function badRequest(message, code = 100) {
    const e = new Error(message);
    e.status = 400;
    e.code = code;
    return e;
}
