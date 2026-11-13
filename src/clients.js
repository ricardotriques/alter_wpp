import { randomBytes } from 'node:crypto';
import { q } from './db.js';
import { hashToken, safeEqual, allSessions } from './manager.js';

const clients = new Map();
const newKey = () => 'wac_' + randomBytes(24).toString('hex');

const fail = (status, message) => Object.assign(new Error(message), { status });

export const getClient = (id) => clients.get(id);
export const allClients = () => [...clients.values()];
export const linesOf = (clientId) => allSessions().filter((s) => s.row.client_id === clientId);

export async function loadClients() {
    const { rows } = await q('SELECT * FROM wa_clients ORDER BY created_at');
    clients.clear();
    for (const r of rows) clients.set(r.id, r);
}

/** Chave de cliente -> cliente (ou null) */
export function clientByKey(key) {
    if (!key || !String(key).startsWith('wac_')) return null;
    const h = hashToken(key);
    return allClients().find((c) => safeEqual(c.key_hash, h)) || null;
}

export function clientView(c) {
    return {
        id: c.id,
        name: c.name,
        max_lines: c.max_lines,
        lines_used: linesOf(c.id).length,
        active: c.active,
        notes: c.notes,
        created_at: c.created_at,
        updated_at: c.updated_at,
    };
}

export async function createClient({ id, name, max_lines, notes }) {
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(id || '')) throw fail(400, 'id do cliente inválido (letras, números, - e _)');
    if (clients.has(id)) throw fail(409, 'Já existe um cliente com esse id');
    const key = newKey();
    const { rows } = await q(
        'INSERT INTO wa_clients (id, name, key_hash, max_lines, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [id, name || id, hashToken(key), Math.max(0, parseInt(max_lines ?? 1, 10) || 0), notes || null],
    );
    clients.set(id, rows[0]);
    return { client: rows[0], key };
}

export async function updateClient(c, patch) {
    const sets = [];
    const vals = [c.id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.name !== undefined) add('name', patch.name || c.id);
    if (patch.max_lines !== undefined) add('max_lines', Math.max(0, parseInt(patch.max_lines, 10) || 0));
    if (patch.active !== undefined) add('active', !!patch.active);
    if (patch.notes !== undefined) add('notes', patch.notes || null);
    if (!sets.length) return c;
    const { rows } = await q(`UPDATE wa_clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
    clients.set(c.id, rows[0]);
    return rows[0];
}

export async function rotateClientKey(c) {
    const key = newKey();
    const { rows } = await q('UPDATE wa_clients SET key_hash = $2, updated_at = now() WHERE id = $1 RETURNING *', [c.id, hashToken(key)]);
    clients.set(c.id, rows[0]);
    return key;
}

export async function deleteClient(c) {
    if (linesOf(c.id).length) throw fail(409, 'Remova ou transfira as linhas deste cliente antes de excluí-lo');
    await q('DELETE FROM wa_clients WHERE id = $1', [c.id]);
    clients.delete(c.id);
}

/** Verifica se o cliente pode receber mais uma linha */
export function assertCanAddLine(clientId, exceptSessionId = null) {
    if (!clientId) return;
    const c = clients.get(clientId);
    if (!c) throw fail(400, `Cliente ${clientId} não existe`);
    const used = linesOf(clientId).filter((s) => s.id !== exceptSessionId).length;
    if (used >= c.max_lines) throw fail(409, `Cliente ${c.name} já usa ${used} de ${c.max_lines} linhas. Aumente o limite.`);
}
