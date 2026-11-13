import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { q } from './db.js';
import { Session } from './session.js';
import { logger } from './logger.js';
import { assertCanAddLine } from './clients.js';

const sessions = new Map();
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');
export const newToken = () => 'wae_' + randomBytes(24).toString('hex');

export const getSession = (id) => sessions.get(id);
export const allSessions = () => [...sessions.values()];

export function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && timingSafeEqual(x, y);
}

/** Token Bearer -> sessão */
export function sessionByToken(token) {
    if (!token) return null;
    const h = hashToken(token);
    return allSessions().find((s) => safeEqual(s.row.token_hash, h)) || null;
}

export async function bootSessions() {
    const { rows } = await q('SELECT * FROM wa_sessions ORDER BY created_at');
    for (const row of rows) {
        const s = new Session(row);
        sessions.set(row.id, s);
        // Só reconecta quem já foi pareado; as demais esperam /connect
        if (['open', 'connecting', 'closed'].includes(row.status)) {
            s.start().catch((e) => logger.error({ session: row.id, err: e.message }, 'falha ao iniciar'));
        }
    }
    logger.info({ total: rows.length }, 'sessões carregadas');
}

export async function createSession({ id, name, webhook_url, webhook_secret, pairing_phone, client_id }) {
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(id || '')) {
        const e = new Error('id inválido (use letras, números, - e _; 2 a 41 caracteres)');
        e.status = 400;
        throw e;
    }
    if (sessions.has(id)) {
        const e = new Error('Já existe uma linha com esse id');
        e.status = 409;
        throw e;
    }
    assertCanAddLine(client_id || null);
    const token = newToken();
    const secret = webhook_secret || randomBytes(16).toString('hex');
    const { rows } = await q(
        `INSERT INTO wa_sessions (id, name, token_hash, webhook_url, webhook_secret, pairing_phone, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, name || id, hashToken(token), webhook_url || null, secret, pairing_phone || null, client_id || null],
    );
    const s = new Session(rows[0]);
    sessions.set(id, s);
    await s.start();
    return { session: s, token, webhook_secret: secret };
}

export async function updateSession(s, patch) {
    if (patch.client_id !== undefined && (patch.client_id || null) !== (s.row.client_id || null)) {
        assertCanAddLine(patch.client_id || null, s.id);
    }
    const allowed = ['name', 'webhook_url', 'webhook_secret', 'pairing_phone', 'client_id'];
    const sets = [];
    const vals = [s.id];
    for (const k of allowed) {
        if (patch[k] === undefined) continue;
        vals.push(patch[k] || null);
        sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return s.row;
    const { rows } = await q(`UPDATE wa_sessions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
    Object.assign(s.row, rows[0]);
    return s.row;
}

export async function rotateToken(s) {
    const token = newToken();
    await q('UPDATE wa_sessions SET token_hash = $2, updated_at = now() WHERE id = $1', [s.id, hashToken(token)]);
    s.row.token_hash = hashToken(token);
    return token;
}

export async function deleteSession(s) {
    await s.logout();
    await q('DELETE FROM wa_sessions WHERE id = $1', [s.id]);
    sessions.delete(s.id);
}

export async function stopAll() {
    await Promise.all(allSessions().map((s) => s.stop()));
}

export function publicView(s) {
    const r = s.row;
    return {
        id: s.id,
        name: r.name,
        client_id: r.client_id || null,
        status: s.status,
        phone: r.phone,
        push_name: r.push_name,
        webhook_url: r.webhook_url,
        pairing_phone: r.pairing_phone,
        created_at: r.created_at,
        updated_at: r.updated_at,
    };
}
