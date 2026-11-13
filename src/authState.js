import { initAuthCreds, BufferJSON, proto } from 'baileys';
import { q } from './db.js';

/**
 * Estado de autenticação do Baileys guardado no PostgreSQL
 * (equivalente ao useMultiFileAuthState, sem usar disco).
 */
export async function usePgAuthState(sessionId) {
    const write = (key, value) =>
        q(
            `INSERT INTO wa_auth (session_id, key, value) VALUES ($1, $2, $3)
             ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [sessionId, key, JSON.stringify(value, BufferJSON.replacer)],
        );

    const remove = (key) => q('DELETE FROM wa_auth WHERE session_id = $1 AND key = $2', [sessionId, key]);

    const credsRow = await q('SELECT value FROM wa_auth WHERE session_id = $1 AND key = $2', [sessionId, 'creds']);
    const creds = credsRow.rows[0] ? JSON.parse(credsRow.rows[0].value, BufferJSON.reviver) : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const out = {};
                    if (!ids.length) return out;
                    const keys = ids.map((id) => `${type}-${id}`);
                    const r = await q('SELECT key, value FROM wa_auth WHERE session_id = $1 AND key = ANY($2)', [sessionId, keys]);
                    const map = new Map(r.rows.map((row) => [row.key, row.value]));
                    for (const id of ids) {
                        const raw = map.get(`${type}-${id}`);
                        if (!raw) continue;
                        let value = JSON.parse(raw, BufferJSON.reviver);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        out[id] = value;
                    }
                    return out;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? write(key, value) : remove(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => write('creds', creds),
        clear: () => q('DELETE FROM wa_auth WHERE session_id = $1', [sessionId]),
    };
}
